// CodexClient — driver for `codex app-server` (JSON-RPC over stdio).
// Thread/turn lifecycle + approval interception relayed to a human via IM.
// Starts are serialized process-wide (sqlite state runtime dislikes concurrency).
const {spawn} = require('node:child_process');
const readline = require('node:readline');

class CodexClient {
  static _startChain = Promise.resolve();

  // opts: {codex, cwd, env, threadParams, resumeThreadId,
  //        onApproval(method,params,respond), onLog(str)}
  // respond(decision): 'accept' | 'acceptForSession' | 'decline' | 'cancel' | amendment object
  constructor(opts) {
    Object.assign(this, opts);
    this.clientInfo = this.clientInfo || {name: 'lark-codex-tasks', title: 'Lark Codex Tasks Bridge', version: '3.0.0'};
    this.id = 0;
    this.pending = new Map();
    this.approvals = new Map();
    this.finished = false;
    this.disposed = false;   // 资源已释放（进程 killed）；幂等
    this.cancelSource = null; // 主动取消来源（user-cancel/dispose）；null 表示非主动
    this.exitInfo = null;     // close 事件原始记录 {code,signal,origin,at}
    this.turnSubmissionAttempted = false; // 请求写出后，即使响应丢失也不得盲目重发
    this.executionStarted = false;
    this.providerRetryCount = 0;
    this.turnSubmitted = false; // turn/start 已被服务端受理（结果未知时禁止盲目重发）
    this.lastMessage = '';
  }

  start() {
    const run = CodexClient._startChain.then(() => {
      // 排队等待启动期间被取消/释放：不得晚启动（R04）
      if (this.disposed || this.finished) throw new Error('client disposed before start');
      return this._startInner();
    });
    CodexClient._startChain = run.catch(() => {});
    return run;
  }

  _send(obj) { this.child.stdin.write(JSON.stringify(obj) + '\n'); }

  _req(method, params, timeoutMs = 30000) {
    return new Promise((res, rej) => {
      const n = ++this.id;
      this.pending.set(n, {res, rej});
      this._send({id: n, method, params});
      setTimeout(() => { if (this.pending.has(n)) { this.pending.delete(n); rej(new Error('request timeout: ' + method)); } }, timeoutMs).unref();
    });
  }

  async _startInner() {
    this.child = spawn(this.codex, ['app-server', '--stdio'], {cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe']});
    readline.createInterface({input: this.child.stdout}).on('line', l => this._onLine(l));
    this.child.on('close', (code, signal) => {
      // 复核#4：区分 用户取消/外部终止/未知退出；退出码 0 不等于 turn 成功（无 turn/completed 即失败）
      const origin = this.cancelSource || (this.disposed ? 'dispose' : 'external/unknown');
      this.exitInfo = {code, signal: signal || null, origin, at: Date.now()};
      const desc = 'app-server exited (code=' + code + ', signal=' + (signal || 'none') + ', origin=' + origin + ')';
      this._log('[exit] ' + desc + ' thread=' + (this.threadId || '-') + ' turn=' + (this.turnId || '-'));
      if (!this.finished) this._finish('failed', new Error(desc));
    });
    this.child.on('error', e => { if (!this.finished) this._finish('failed', e); });
    this.child.stderr.on('data', d => {
      const s = String(d).replace(/\n+$/, '');
      if (s && !/WARNING|Read-only file system/.test(s)) this._log('[codex] ' + s);
    });
    await this._req('initialize', {clientInfo: this.clientInfo, capabilities: {experimentalApi: true}}, 30000);
    this._send({method: 'initialized', params: {}});
    const tp = this.threadParams || {};
    const t = this.resumeThreadId
      ? await this._req('thread/resume', {threadId: this.resumeThreadId, cwd: this.cwd, sandbox: tp.sandbox, approvalPolicy: tp.approvalPolicy, developerInstructions: tp.developerInstructions || null}, 30000)
      : await this._req('thread/start', tp, 30000);
    this.thread = t.thread;
    this.threadId = t.thread.id;
    return this.threadId;
  }

  _onLine(line) {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && m.method) { this._onServerRequest(m); return; }
    if (m.id !== undefined && this.pending.has(m.id)) {
      const p = this.pending.get(m.id); this.pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return;
    }
    if (m.method) this._onEvent(m.method, m.params || {});
  }

  _onServerRequest(m) {
    if (/requestApproval$/.test(m.method)) {
      let responded = false;
      const isPermissions = m.method === 'item/permissions/requestApproval';
      // 返回 true=决定已写入执行端；false=已响应过或连接已断（调用方不得虚报生效）
      const respond = (decision) => {
        if (responded) return false; responded = true;
        this.approvals.delete(m.id);
        try {
          if (isPermissions) {
            const granted = (decision === 'accept' || decision === 'acceptForSession') ? (m.params && m.params.permissions) || {} : {};
            const scope = decision === 'acceptForSession' ? 'session' : undefined;
            this._send({id: m.id, result: {permissions: granted, ...(scope ? {scope} : {})}});
          } else {
            this._send({id: m.id, result: {decision}});
          }
        } catch (e) { this._log('[approval] respond send failed: ' + (e && e.message)); return false; }
        return true;
      };
      this.approvals.set(m.id, respond);
      Promise.resolve(this.onApproval ? this.onApproval(m.method, m.params, respond, {client: this, reqId: m.id}) : null)
        .catch(() => respond('decline'));
    } else if (m.method === 'item/tool/requestUserInput' || m.method === 'mcpServer/elicitation/request') {
      this._send({id: m.id, result: null});
      this._log('[unsupported-server-request] ' + m.method);
    } else {
      this._send({id: m.id, result: {}});
    }
  }

  _onEvent(method, p) {
    // Scope checks precede all bookkeeping, including retry notifications.
    if (p.threadId && this.threadId && p.threadId !== this.threadId) return;
    if (p.turnId && this.turnId && p.turnId !== this.turnId) return;
    if (method === 'turn/started' && p.turn) {
      this.turnId = p.turn.id; this.turnSubmitted = true;
    } else if (method === 'item/started' || method === 'item/completed') {
      if (['commandExecution','fileChange','mcpToolCall','dynamicToolCall'].includes((p.item || {}).type)) this.executionStarted = true;
    }
    if (method === 'item/completed') {
      const it = p.item || {};
      if (p.threadId && this.threadId && p.threadId !== this.threadId) return;
      if (p.turnId && this.turnId && p.turnId !== this.turnId) return;
      if (it.type === 'agentMessage') this.lastMessage = it.text || (it.content || []).map(c => c.text || '').join('');
    } else if (method === 'turn/completed') {
      if (this.turnId && p.turn && p.turn.id === this.turnId) {
        const ams = (p.turn.items || []).filter(i => i.type === 'agentMessage');
        const finals = ams.filter(i => i.phase === 'final_answer');
        const pick = finals.length ? finals[finals.length-1] : ams[ams.length-1];
        if (pick && pick.text) this.lastMessage = pick.text;
        const st = p.turn.status || (p.turn.error ? 'failed' : 'completed');
        this._finish(st === 'completed' ? 'completed' : (st === 'interrupted' ? 'cancelled' : 'failed'), p.turn.error || null);
      }
    } else if (method === 'error') {
      const e = p.error || {};
      if (p.willRetry === true || e.willRetry === true) { this.providerRetryCount++; this._log('[net] ' + (e.message || 'retrying') + ' | ' + JSON.stringify({codexErrorInfo:e.codexErrorInfo || null, retryCount:this.providerRetryCount})); return; }
      if (p.threadId && this.threadId && p.threadId !== this.threadId) return;
      if (p.turnId && this.turnId && p.turnId !== this.turnId) return;
      this._finish('failed', e.message ? e : new Error('turn error'));
    }
  }

  run(task, options = {}) {
    return new Promise((res, rej) => {
      if (this.finished || this.disposed) { rej(new Error('client finished, run rejected')); return; } // 不得悬挂（R04）
      this.runResolve = res; this.runReject = rej;
      this.turnSubmissionAttempted = true;
      this._req('turn/start', {threadId: this.threadId, input: [{type: 'text', text: task, text_elements: []}], cwd: this.cwd, ...(options.outputSchema ? {outputSchema: options.outputSchema} : {})}, 30000)
        .then(r => { this.turnId = r.turn.id; this.turnSubmitted = true; })
        .catch(e => this._finish('failed', e));
    });
  }

  _finish(status, error) {
    if (this.finished) return; this.finished = true;
    if (error) {
      const original = error;
      error = error instanceof Error ? error : new Error(String(error.message || error));
      if (original.codexErrorInfo !== undefined) error.codexErrorInfo = original.codexErrorInfo;
      Object.assign(error, {turnSubmitted:!!this.turnSubmitted, turnSubmissionAttempted:!!this.turnSubmissionAttempted, executionStarted:!!this.executionStarted});
      if (status === 'failed') this._log('[error] ' + error.message + ' | ' + JSON.stringify({codexErrorInfo:error.codexErrorInfo || null, turnSubmitted:this.turnSubmitted, turnSubmissionAttempted:this.turnSubmissionAttempted, executionStarted:this.executionStarted, providerRetryCount:this.providerRetryCount}));
    }
    for (const [, respond] of this.approvals) { try { respond('cancel'); } catch {} }
    this.approvals.clear();
    for (const [, pr] of this.pending) { try { pr.rej(new Error('client finished: ' + status)); } catch {} }
    this.pending.clear();
    if (this.onFinish) { try { this.onFinish(this); } catch {} }
    const payload = {message: this.lastMessage || '', error: error || null, status};
    if (status === 'completed' && this.runResolve) this.runResolve(payload);
    else if (status === 'cancelled') { if (this.runReject) this.runReject(Object.assign(new Error('interrupted'), {interrupted: true})); }
    else if (this.runReject) this.runReject(error || new Error('turn failed'));
  }

  // 幂等释放进程与挂起资源：无论 finished 与否都会终止子进程（R01）。
  async dispose() {
    if (this.disposed) return; this.disposed = true;
    if (!this.finished) this._finish('cancelled', new Error('disposed'));
    for (const [, respond] of this.approvals) { try { respond('cancel'); } catch {} }
    this.approvals.clear();
    clearTimeout(this.killTimer);
    try { this.child && this.child.kill('SIGTERM'); } catch {}
    this.killTimer = setTimeout(() => { try { this.child && this.child.kill('SIGKILL'); } catch {} }, 10000); this.killTimer.unref();
  }

  async cancel() {
    this.cancelSource = this.cancelSource || 'user-cancel';
    if (!this.finished) {
      try { if (this.turnId) await this._req('turn/interrupt', {threadId: this.threadId, turnId: this.turnId}, 8000); } catch {}
      this._finish('cancelled', new Error('cancelled by user'));
    }
    await this.dispose();
  }

  _log(s) { if (this.onLog) { try { this.onLog(s); } catch {} } }
}
module.exports = {CodexClient};

// 会话隔离回归测试（SESSION_ISOLATION_REVIEW.md 验收条件）
// 断言修复后的正确行为：私聊/任务群 session 严格隔离，未绑定群不发模型 turn。
// 全部使用合成的 fake Lark/模型，不触真实聊天、凭证或生产状态。
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const sup=require('./supervisor.cjs');
const {CodexClient}=require('./codex-client.cjs');

const until=async(fn,ms=3000)=>{const t0=Date.now();while(Date.now()-t0<ms){if(fn())return true;await new Promise(r=>setTimeout(r,10));}return false;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// bridge harness：vm 加载真实 lark-bridge.cjs；homedir 重定向到临时目录；lark 全部拦截
function bridge(t,{seed}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lct-iso-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const state=path.join(root,'.local/state/lark-codex-tasks');fs.mkdirSync(state,{recursive:true});
 fs.mkdirSync(path.join(root,'.config/lark-codex-tasks'),{recursive:true});
 fs.mkdirSync(path.join(root,'workspace/a'),{recursive:true});
 fs.mkdirSync(path.join(root,'workspace/scratch'),{recursive:true});
 sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{a:path.join(root,'workspace','a')});
 fs.writeFileSync(path.join(root,'.config/lark-codex-tasks','persona.md'),'你是 TESTBOT，测试环境助手。称呼用户为 TESTCOMMANDER。');
 if(seed)for(const [rel,data] of Object.entries(seed)){const f=path.join(state,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,typeof data==='string'?data:JSON.stringify(data));}
 const proc=new EventEmitter();proc.env={LARK_OWNER_OPEN_ID:'owner'};
 const calls=[],logs=[],errs=[];
 const context=vm.createContext({
  __dirname,
  require:n=>n==='node:os'?{...os,homedir:()=>root}:require(n),
  module:{},process:proc,console:{log(...a){logs.push(a.map(String).join(' '));},error(...a){errs.push(a.map(String).join(' '));}},
  setTimeout,clearTimeout,setInterval,clearInterval,calls});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'lark-bridge.cjs'),'utf8')+`
 lark=async(args)=>{calls.push(args);return {ok:true,data:{message_id:'om_fake',chat_id:'oc_new'}};};
 globalThis.api={handle,handleCardAction,askApproval,decide,settle,reopen,respond,groupContext,auditSessionIsolation,dmSession,dmThreadIds,supervisor,pendingByChat,pendingByToken,pump,enqueueItem,
  consts:{DM_INSTR_VERSION,TASK_INSTR_VERSION,DM_INSTRUCTIONS,TASK_INSTRUCTIONS},
  get groups(){return groups;},get sessions(){return sessions;},get dmChats(){return dmChats;},get queues(){return queues;},
  enqueue(fn){queue=queue.then(fn);return queue;},patch(code){return eval(code);}};
 `,context);
 return {a:context.api,calls,logs,errs,root,context};
}
// 可控 CodexClient：记录 start 参数；run 默认立即成功
function mockCodex(t,runImpl){
 const starts=[],runs=[];
 const oS=CodexClient.prototype.start,oR=CodexClient.prototype.run;
 t.after(()=>{CodexClient.prototype.start=oS;CodexClient.prototype.run=oR;});
 CodexClient.prototype.start=async function(){starts.push({resume:this.resumeThreadId||null,instr:(this.threadParams&&this.threadParams.developerInstructions)||null,cwd:this.cwd});this.threadId=this.resumeThreadId||'thread-'+starts.length;return this.threadId;};
 CodexClient.prototype.run=function(){runs.push(this);return runImpl?runImpl.call(this):Promise.resolve({message:'ok'});};
 return {starts,runs};
}
const msg=(chat_type,chat_id,content,id)=>({chat_type,chat_id,content,message_id:id||('om_'+Math.random().toString(36).slice(2)),sender_id:'owner',sender_type:'user',message_type:'text'});

// ── 验收 1：私聊新建/恢复均注入配置人格，session 记录完整元数据 ──
test('ISO1: DM chat injects persona and records namespaced session; resume reuses own thread',async t=>{
 const {a,calls}=bridge(t);const {starts}=mockCodex(t);
 await a.respond(msg('p2p','oc_dm','你好'));
 assert(await until(()=>calls.some(c=>c.includes('oc_dm')&&c.includes('ok'))),'第一轮回复应送达');
 assert.equal(starts.length,2);assert.equal(starts[0].resume,null);
 assert.equal(starts[1].resume,null,'独立动作复核线程不续接私聊');
 assert(starts[0].instr.includes('TESTBOT')&&starts[0].instr.includes('TESTCOMMANDER'),'DM 必须注入配置人格');
 assert(starts[0].instr.includes('安全约束'),'DM 必须含安全约束');
 const s=a.sessions['dm:oc_dm'];
 assert(s&&s.kind==='dm'&&s.chat==='oc_dm'&&s.thread==='thread-1'&&s.instr==='dm-persona-v3','session 元数据完整');
 await a.respond(msg('p2p','oc_dm','继续'));
 assert(await until(()=>calls.filter(c=>c.includes('oc_dm')&&c.includes('ok')).length===2),'第二轮回复应送达');
 assert.equal(starts.length,4);assert.equal(starts[2].resume,'thread-1','私聊恢复自己的线程');
 assert.equal(starts[3].resume,null,'第二轮动作复核仍使用独立线程');
});

// ── 验收 1b：旧版 chat-thread.json 迁移后被首个 p2p 认领，原文件保留 ──
test('ISO2: legacy chat-thread.json migrates and is adopted by first p2p chat',async t=>{
 const {a,root}=bridge(t,{seed:{'chat-thread.json':{threadId:'01a0e0a2-bc90-7311-9046-e0b752f2b91a'}}});
 const {starts}=mockCodex(t);
 await a.respond(msg('p2p','oc_dm','你好'));await until(()=>starts.length===1);
 assert.equal(starts[0].resume,'01a0e0a2-bc90-7311-9046-e0b752f2b91a','旧私聊线程被认领恢复');
 assert.equal(a.sessions['dm:legacy'],undefined);
 assert.equal(a.sessions['dm:oc_dm'].adoptedFrom,'legacy');
 assert(fs.existsSync(path.join(root,'.local/state/lark-codex-tasks/chat-thread.json')),'原文件不得删除');
});

// ── 验收 3：未绑定群不发模型 turn，不报私聊，不给任务派发 ──
test('ISO3: unbound group gets binding notice; no model turn, no dispatch, no DM fallback',async t=>{
 const {a}=bridge(t);const {starts}=mockCodex(t);
 const r1=await a.respond(msg('group','oc_stray','你好'));
 assert(/未绑定任务/.test(r1)&&/相互独立/.test(r1),'应明确报未绑定且说明隔离');
 const r2=await a.respond(msg('group','oc_stray','crashai 修复登录'));
 assert(/未绑定任务/.test(r2),'自然语言派活也必须阻断');
 assert.equal(starts.length,0,'未绑定群不得发起模型 turn');
 assert.equal(a.supervisor.jobs.size,0,'不得新建任务');
 assert(!Object.keys(a.sessions).some(k=>k.includes('oc_stray')),'不得建立私聊 session 映射');
});

// ── 验收 3b：anchor 丢失 → bind-broken 报障并给出恢复路径 ──
test('ISO4: broken anchor marks bind-broken with recovery path; no model turn',async t=>{
 const {a}=bridge(t);const {starts}=mockCodex(t);
 a.groups['oc_gX']={anchor:'ffffffffffff',alias:'a',status:'active'};
 const r=await a.respond(msg('group','oc_gX','继续'));
 assert(/绑定已失效/.test(r)&&/anchor-missing/.test(r)&&/\/reopen/.test(r),'报障并给恢复路径');
 assert.equal(a.groups['oc_gX'].status,'bind-broken');
 assert.equal(a.groups['oc_gX'].reason,'anchor-missing');
 assert.equal(starts.length,0);
});

// ── 验收 1+2：绑定群继续本群 chain；任务群无私聊人格；两群线程互不相同 ──
test('ISO5: bound groups continue own chain with safety-only instructions; threads independent',async t=>{
 const {a}=bridge(t);const {starts}=mockCodex(t);
 a.supervisor.jobs.set('aaaa11110000',{id:'aaaa11110000',alias:'a',chat:'oc_gB',threadId:'thread-B',status:'completed',cwd:'/tmp',mode:'auto',started:1});
 a.supervisor.jobs.set('cccc22221111',{id:'cccc22221111',alias:'a',chat:'oc_gC',threadId:'thread-C',status:'completed',cwd:'/tmp',mode:'auto',started:2});
 a.groups['oc_gB']={anchor:'aaaa11110000',alias:'a',status:'active'};
 a.groups['oc_gC']={anchor:'cccc22221111',alias:'a',status:'active'};
 const rB=await a.respond(msg('group','oc_gB','继续修 B'));
 assert(/收到/.test(rB),rB); // 受理回执；调度器异步接续本群 chain
 assert(await until(()=>starts.length===1),'B 群任务应自动启动');
 assert.equal(starts[0].resume,'thread-B','B 群恢复自己的线程');
 assert(starts[0].instr.includes('安全约束'),'任务群必须含安全约束');
 assert(!starts[0].instr.includes("TESTBOT"),"任务群不得注入私聊人格");
 const rC=await a.respond(msg('group','oc_gC','继续修 C'));
 assert(/收到/.test(rC),rC);
 assert(await until(()=>starts.length===2),'C 群任务应自动启动');
 assert.equal(starts[1].resume,'thread-C','C 群恢复自己的线程');
 const gB=a.groups['oc_gB'];
 assert(gB.kind==='group_task'&&gB.thread==='thread-B'&&gB.chain==='aaaa11110000'&&gB.instr==='group-task-v2','群 session 元数据完整');
 assert(!Object.keys(a.sessions).some(k=>k.includes('oc_g')),'群聊不得写入私聊注册表');
 assert(await until(()=>[...a.supervisor.jobs.values()].filter(j=>j.continuedFrom).length===2),'两群各产生接续任务');
 const newJobs=[...a.supervisor.jobs.values()].filter(j=>j.continuedFrom);
 assert(newJobs.every(j=>j.chat==='oc_gB'||j.chat==='oc_gC'),'接续任务留在本群');
});

// ── 验收 4：运行中任务群提问走纠偏，不改走私聊 ──
test('ISO6: question to running job is queued (FIFO next round), stays in group, no DM',async t=>{
 const {a}=bridge(t);const {starts}=mockCodex(t);
 a.supervisor.jobs.set('aaaa11110000',{id:'aaaa11110000',alias:'a',chat:'oc_gB',threadId:'thread-B',status:'running',cwd:'/tmp',mode:'auto',started:1});
 a.groups['oc_gB']={anchor:'aaaa11110000',alias:'a',status:'active'};
 const r=await a.respond(msg('group','oc_gB','进度如何'));
 assert(/已排队：前面 1 条正在执行/.test(r),r); // TASK_QUEUE 契约：保存输入并明确前方数量
 assert.equal(starts.length,0,'运行中不发新模型 turn');
 const q=a.queues['oc_gB'];
 assert(q&&q.items.length===1&&q.items[0].status==='queued'&&q.items[0].kind==='task','指令持久入队');
 assert(!Object.keys(a.sessions).some(k=>k.includes('oc_gB')),'不进入私聊命名空间');
});

// ── 验收 2b：/resume 不得把私聊线程续进任务群 ──
test('ISO7: /resume with a DM thread id is blocked',async t=>{
 const {a,calls}=bridge(t,{seed:{'sessions.json':{'dm:oc_dm':{kind:'dm',chat:'oc_dm',thread:'01a0e0a2-bc90-7311-9046-e0b752f2b91a',instr:'dm-persona-v1',updated:1}}}});
 const {starts}=mockCodex(t);
 const r=await a.respond(msg('p2p','oc_dm','/resume a 01a0e0a2-bc90-7311-9046-e0b752f2b91a 继续'));
 assert(/续接部署中，稍后回报/.test(r),r); // 立即受理回执
 assert(await until(()=>calls.some(c=>c.some(x=>typeof x==='string'&&/续接启动失败/.test(x)&&/私聊线程/.test(x)))),'失败应异步回报且说明私聊线程阻断');
 assert.equal(starts.length,0,'不得创建 client');
 assert(!a.groups['oc_new'],'失败建群不得注册');
});

// ── 验收：并发锁按会话隔离，不再全局 busy ──
test('ISO8: per-session FIFO queue, no global busy, no drop-and-reask',async t=>{
 const gate=[];const {a,calls}=bridge(t);
 const {starts,runs}=mockCodex(t,function(){if(this.threadParams?.name==='lct-router')return Promise.resolve({message:'ok'});return new Promise(res=>gate.push(res));});
 const dmRuns=()=>runs.filter(c=>c.threadParams?.name==='lct-chat');
 const r1=await a.respond(msg('p2p','oc_dm1','第一条'));assert(/处理中，稍后回报/.test(r1),'N04：空闲也即时受理回执（NEW_TASK_ROUTING_REVIEW）');
 await until(()=>dmRuns().length===1);
 await a.respond(msg('p2p','oc_dm2','别的会话'));
 assert(await until(()=>dmRuns().length===2),'别的会话不被阻塞');
 const r3=await a.respond(msg('p2p','oc_dm1','同会话再来一条'));
 assert(/已排队：前面 1 条/.test(r3),r3); // 保存输入并确认排队，绝不叫用户重发
 assert.equal(dmRuns().length,2,'同会话不并发执行');
 assert(a.queues['oc_dm1'].items.some(i=>i.status==='queued'&&i.text==='同会话再来一条'),'排队项持久保存');
 gate.forEach(res=>res({message:'ok'}));
 assert(await until(()=>dmRuns().length===3),'前序结束后自动执行排队项，无需用户重发');
 assert.equal(starts.filter(s=>s.instr.includes('你是 TESTBOT')).length,3,'两个会话各自独立线程，同会话串行');
});

// ── 验收 5：审批卡片绑定 chat，跨聊天点击被拒 ──
test('ISO9: card approval is bound to originating chat',async t=>{
 const {a,calls}=bridge(t);
 let decision;
 await a.askApproval(Object.freeze({id:'chat-t9',alias:'对话',chat:'oc_dm',mode:'auto',kind:'dm'}),'item/commandExecution/requestApproval',{command:'true'},d=>decision=d);
 const token=[...a.pendingByToken.keys()][0];
 await a.handleCardAction(JSON.stringify({type:'card.action.trigger',event_id:'e1',operator_id:'owner',action_tag:'button',token:'ct',action_value:{t:token,d:'accept'},chat_id:'oc_group'}));
 assert.equal(decision,undefined,'跨聊天点击不得生效');
 assert(a.pendingByToken.has(token),'entry 保留');
 assert(await until(()=>calls.some(c=>c.includes('oc_group')&&c.some(x=>typeof x==='string'&&x.includes('不匹配')))),'应提示不匹配');
 await a.handleCardAction(JSON.stringify({type:'card.action.trigger',event_id:'e2',operator_id:'owner',action_tag:'button',token:'ct',action_value:{t:token,d:'accept'},chat_id:'oc_dm'}));
 assert.equal(decision,'accept','原会话点击生效');
});

// ── 验收 6：线程交叉引用 → 私聊映射隔离 + 群 bind-broken + 证据落盘，不删历史 ──
test('ISO10: polluted thread quarantined at startup; group bind-broken; evidence kept',async t=>{
 const {a,root}=bridge(t,{seed:{
  'sessions.json':{'dm:oc_dm':{kind:'dm',chat:'oc_dm',thread:'01a0bad0-0000-7000-8000-000000000000',instr:'dm-persona-v1',updated:1}},
  'groups.json':{'oc_gP':{anchor:'abcdef012345',alias:'a',status:'active',title:'x'}},
  'jobs/abcdef012345/state.json':{id:'abcdef012345',alias:'a',chat:'oc_gP',threadId:'01a0bad0-0000-7000-8000-000000000000',status:'completed',cwd:'/tmp',mode:'auto',started:1,notifyPending:false},
 }});
 const {starts}=mockCodex(t);
 assert(!a.sessions['dm:oc_dm'],'被污染私聊映射已移出');
 assert(a.sessions['quarantine:dm:oc_dm']&&/thread-owned-by-job:abcdef012345/.test(a.sessions['quarantine:dm:oc_dm'].reason),'隔离区保留证据');
 assert.equal(a.groups['oc_gP'].status,'bind-broken');
 assert.equal(a.groups['oc_gP'].reason,'thread-polluted');
 const ev=fs.readdirSync(path.join(root,'.local/state/lark-codex-tasks')).filter(f=>f.startsWith('session-audit-'));
 assert.equal(ev.length,1,'证据文件落盘');
 const r=await a.respond(msg('group','oc_gP','继续'));
 assert(/绑定已失效/.test(r)&&/thread-polluted/.test(r),'群报障且不恢复污染线程');
 await a.respond(msg('p2p','oc_dm','新对话'));await until(()=>starts.length===1);
 assert.equal(starts[0].resume,null,'私聊开干净新线程');
});

// ── 验收 6b：/reopen 重建绑定并写入元数据；污染任务阻断重开 ──
test('ISO11: reopen rebuilds binding metadata; polluted job blocked',async t=>{
 const {a}=bridge(t);
 a.supervisor.jobs.set('aaaa11110000',{id:'aaaa11110000',alias:'a',chat:'oc_old',threadId:'thread-R',status:'completed',cwd:'/tmp',mode:'auto',started:1});
 const chat=await a.reopen('aaaa11110000');
 const g=a.groups[chat];
 assert(g&&g.anchor==='aaaa11110000'&&g.kind==='group_task'&&g.thread==='thread-R'&&g.chain==='aaaa11110000'&&g.instr==='group-task-v2','reopen 元数据完整');
 assert.equal(a.supervisor.jobs.get('aaaa11110000').chat,chat,'job.chat 指向新群');
 a.supervisor.jobs.set('bbbb22221111',{id:'bbbb22221111',alias:'a',chat:'oc_x',threadId:'01a0e0a2-bc90-7311-9046-e0b752f2b91a',status:'completed',cwd:'/tmp',mode:'auto',started:2});
 a.patch(`sessions['dm:oc_dm']={kind:'dm',chat:'oc_dm',thread:'01a0e0a2-bc90-7311-9046-e0b752f2b91a',instr:'dm-persona-v1',updated:Date.now()};`);
 await assert.rejects(a.reopen('bbbb22221111'),/私聊会话冲突/,'污染任务不得重开进群');
});

// ── Supervisor 层：绑定一致性与私聊线程阻断 ──
function fixture(t,opts={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lct-isosup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const workspace=path.join(root,'workspace');fs.mkdirSync(path.join(workspace,'a'),{recursive:true});
 const config=path.join(root,'projects.json');sup.atomic(config,{a:path.join(workspace,'a')});
 const clients=[];
 const s=new sup.Supervisor({state:path.join(root,'jobs'),root:workspace,config,env:{},codex:'codex',send:async()=>{},...opts,
 clientFactory:o=>{const c={o,child:{kill(){}},async start(){return 'thread-new';},run(){return new Promise((res,rej)=>{c.resolve=res;c.reject=rej;});},async cancel(){}};clients.push(c);return c;}});
 return {s,clients,workspace};
}
test('ISO12: supervisor injects task instructions on start/continue/retry and blocks cross-chat continuation',async t=>{
 const {s,clients}=fixture(t);
 const id=await s.start('a','task','oc_gA','om_1');
 assert(clients[0].o.threadParams.developerInstructions.includes('安全约束'),'任务线程注入安全约束');
 assert(!clients[0].o.threadParams.developerInstructions.includes('TESTBOT'),'任务线程无人格');
 clients[0].resolve({message:'done'});await sleep(5);
 s.jobs.get(id).threadId='thread-A';s.save(s.jobs.get(id));
 await assert.rejects(s.continueJob(id,'x','oc_OTHER','om_2'),/不一致/,'跨群接续被阻断');
 assert.equal(clients.length,1);
 const id2=await s.continueJob(id,'x','oc_gA','om_3');
 assert(clients[1].o.resumeThreadId==='thread-A'&&clients[1].o.threadParams.developerInstructions.includes('安全约束'));
 clients[1].reject(new Error('network timeout')); // 触发重试路径
 assert(await until(()=>clients.length===3),'重试应创建接替 client');
 assert(clients[2].o.threadParams.developerInstructions.includes('安全约束'),'重试线程同样注入安全约束');
 clients[2].resolve({message:'retry done'});await sleep(5);
});
test('ISO13: supervisor refuses DM thread as resume source in both paths',async t=>{
 const {s}=fixture(t,{isDmThread:()=>true});
 await assert.rejects(s.start('a','task','oc_g','om_1',{resumeThread:'01a0e0a2-bc90-7311-9046-e0b752f2b91a'}),/私聊线程/);
 assert.equal(s.jobs.size,0,'阻断在建 job 之前');
 const {s:s2,clients}=fixture(t,{isDmThread:()=>true});
 const id=await s2.start('a','task','oc_g','om_1');
 clients[0].resolve({message:'d'});await sleep(5);
 s2.jobs.get(id).threadId='01a0e0a2-bc90-7311-9046-e0b752f2b91a';s2.save(s2.jobs.get(id));
 await assert.rejects(s2.continueJob(id,'x','oc_g','om_2'),/私聊会话冲突/);
});
test('ISO14: chainId walks continuedFrom to chain root',t=>{
 const {s}=fixture(t);
 s.jobs.set('aa',{id:'aa'});
 s.jobs.set('bb',{id:'bb',continuedFrom:'aa'});
 s.jobs.set('cc',{id:'cc',continuedFrom:'bb'});
 assert.equal(s.chainId(s.jobs.get('cc')),'aa');
 assert.equal(s.chainId(s.jobs.get('aa')),'aa');
});

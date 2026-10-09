const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {CodexClient} = require('./codex-client.cjs');
const {classifyFailure,failureHint}=require('./task-failure.cjs');
const {buildConfig}=require('./config.cjs');

const MODES = {
  auto: {sandbox: 'danger-full-access', approvalPolicy: 'on-request'}, // 日常任务直接执行，确需人工判断时申请
  safe: {sandbox: 'workspace-write', approvalPolicy: 'untrusted'},  // 能问都问
  yolo: {sandbox: 'danger-full-access', approvalPolicy: 'never'},   // 全自动
};
// 任务群线程的默认通用安全约束（无人格）。调用方可经 options.taskInstructions 覆盖。
function defaultTaskInstructions(env){const c=buildConfig(env||process.env);return [
 '你是 '+c.brand+' 任务群的 Codex 执行单元，在任务群绑定的任务链内工作。',
 c.safety,
'工作场所纪律：禁止自行调用飞书 CLI（lark-cli）或飞书开放平台 API 建群、解散群、修改群信息、发消息；建群、通知、归档、解散由宿主 bridge 完成。任务文本中"建一个群讨论 X"类表述意为在当前本群讨论推进 X。',
].join('\n');}

function sanitizeEnv(env){const out={...env};for(const k of Object.keys(out))if(/^LARK_|^FEISHU_/i.test(k))delete out[k];return out;}
function atomic(file, value) { fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o700}); fs.writeFileSync(file+'.tmp', JSON.stringify(value,null,2),{mode:0o600}); fs.renameSync(file+'.tmp',file); }
function redact(value, env=process.env, limit=3500) {
  let s=String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
  for(const [k,v] of Object.entries(env)) if(/KEY|TOKEN|SECRET|PASSWORD/i.test(k)&&v&&v.length>5) s=s.split(v).join('[REDACTED]');
  s=s.replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,]+/ig,'$1[REDACTED]').replace(/sk-[A-Za-z0-9_-]{12,}/g,'[REDACTED]');
  return s.length>limit?'[truncated]\n'+s.slice(-limit):s;
}
function parse(text) {
 if(typeof text!=='string'||text.length>8000||text.includes('\0')) throw Error('消息太长或包含非法字符。');
 // 非斜杠命令形态（普通正文、绝对路径、斜杠后空格、中文斜杠等）返回 natural 标记，由路由按正文处理；不再用内部异常字符串做分流（R08）
 const m=text.trim().match(/^(\/\w+)(?:\s+([\s\S]*))?$/); if(!m) return {cmd:null,natural:true};
 const cmd=m[1].toLowerCase(), rest=m[2]||'';
 if(cmd==='/run'){const mm=rest.match(/^([a-z][a-z0-9_-]{0,31})\s+([\s\S]+)$/);if(!mm||!mm[2].trim())throw Error('用法: /run <项目> <任务>');return {cmd,alias:mm[1],task:mm[2].trim()};}
 if(cmd==='/group'){if(!rest)return {cmd,alias:'scratch',task:null};const mm=rest.match(/^([a-z][a-z0-9_-]{0,31})(?:\s+([\s\S]+))?$/);if(!mm)throw Error('用法: /group [项目] [任务]');return {cmd,alias:mm[1],task:mm[2]?.trim()||null};}
 if(cmd==='/resume'){const mm=rest.match(/^([a-z][a-z0-9_-]{0,31})\s+(0[0-9a-f]{3}[0-9a-f-]{30,})\s+([\s\S]+)$/);if(!mm)throw Error('用法: /resume <项目> <会话ID> <任务>');return {cmd,alias:mm[1],thread:mm[2],task:mm[3].trim()};}
 if(['/cancel','/logs','/reopen','/done'].includes(cmd)){
   if(cmd==='/done'||cmd==='/logs'){ if(rest&&!/^[a-f0-9]{12}$/.test(rest)) throw Error('任务 ID 格式不正确。'); return rest?{cmd,id:rest}:{cmd}; }
   if(cmd==='/cancel'&&!rest)return {cmd}; // 裸 /cancel：私聊取消本会话执行中的对话（N02）
   if(!rest||!/^[a-f0-9]{12}$/.test(rest))throw Error('用法: '+cmd+' <任务ID>');return {cmd,id:rest};}
 if(cmd==='/qdrop'){if(!rest||!/^\d{1,4}$/.test(rest))throw Error('用法: /qdrop <排队序号>');return {cmd,seq:parseInt(rest,10)};}
 if(cmd==='/adopt'){const mm=rest.match(/^(oc_[\w-]+)\s+([a-z][a-z0-9_-]{0,31})\s+([\s\S]+)$/);if(!mm||!mm[3].trim())throw Error('用法: /adopt <群ID> <项目> <任务>');return {cmd,chat:mm[1],alias:mm[2],task:mm[3].trim()};}
 if(cmd==='/outbox'){
   if(!rest)return {cmd};
   const m=rest.match(/^(show|retry|resolve)\s+(ob[a-z0-9]+)(?:\s+(delivered|obsolete))?(\s+--checked)?$/);
   if(!m||(m[1]==='show'&&(m[3]||m[4]))||(m[1]==='retry'&&(m[3]||!m[4]))||(m[1]==='resolve'&&(!m[3]||!m[4])))throw Error('用法: /outbox [show <ID> | retry <ID> --checked | resolve <ID> delivered|obsolete --checked]');
   return {cmd,action:m[1],id:m[2],resolution:m[3]||null};
 }
 if(!['/ping','/status','/projects','/jobs','/help','/groups','/cleanup','/queue','/qpause','/qresume','/qclear','/auditgroups'].includes(cmd)||rest)throw Error('未知命令。输入 /help 查看帮助。');return {cmd};
}
function parseRun(text){ // natural dispatch: "<alias> <task>" possibly with --yolo/--safe tail
 const m=text.trim().match(/^([a-z][a-z0-9_-]{0,31})\s+([\s\S]+)$/); if(!m) return null;
 let task=m[2].trim(); let mode='auto';
 const tail=task.match(/\s+--(yolo|safe)$/i); if(tail){mode=tail[1].toLowerCase(); task=task.slice(0,tail.index).trim();}
 if(!task) return null; return {alias:m[1], task, mode};
}
function projects(file,root) {
 const data=JSON.parse(fs.readFileSync(file,'utf8')); if(!data||Array.isArray(data)||typeof data!=='object')throw Error('Invalid projects config');
 const resolved={}; const rr=fs.realpathSync(root);
 for(const [alias,dir]of Object.entries(data)){if(!/^[a-z][a-z0-9_-]{0,31}$/.test(alias)||typeof dir!=='string'||!path.isAbsolute(dir))throw Error('Invalid project alias/path');
 if(!fs.existsSync(dir))continue; const real=fs.realpathSync(dir);if(!real.startsWith(rr+path.sep)||!fs.statSync(real).isDirectory())throw Error('Project must be inside workspace');resolved[alias]=real;}
 return resolved;
}
function worktreeFor(dir,root,alias,id,base){
 dir=fs.realpathSync(dir);
 const workspace=fs.realpathSync(root);
 if(!dir.startsWith(workspace+path.sep))throw Error('项目必须位于 workspace 内。');
 const git=(args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000}).trim();
 let repo;try{repo=git(['rev-parse','--show-toplevel']);}catch(e){if(alias==='scratch'||String(e.stderr).includes('not a git repository'))return {cwd:dir};throw Error('无法检查项目 Git 仓库。');}
 repo=fs.realpathSync(repo);if(!repo.startsWith(workspace+path.sep))throw Error('项目仓库必须位于 workspace 内。');
 if(git(['status','--porcelain','--untracked-files=normal']))throw Error('主仓库有未提交更改；请先提交或同步再派活。');
 let commit;
 if(base){try{
   // 接续前先在上一个 worktree 里做 checkpoint 提交，保证后续任务基于真实工作状态
   const wtList=git(['worktree','list','--porcelain']);
   for(const block of wtList.split('\n\n')){
     const lines=block.split('\n');
     const br=lines.find(l=>l.startsWith('branch refs/heads/'));
     if(br&&br.slice(18)===base&&lines[0].startsWith('worktree ')){
       const wtPath=lines[0].slice(9);
       const g2=(a)=>execFileSync('git',['-C',wtPath,...a],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000}).trim();
       if(g2(['status','--porcelain'])){
         g2(['add','-A']);
         try{const _cfg=buildConfig();g2(['-c','user.name='+_cfg.brand+' Bridge','-c','user.email='+_cfg.serviceName+'@local','commit','-m',_cfg.serviceName+' checkpoint: 后续任务接续点']);}
         catch(e){throw Error('接续点提交失败: '+String(e.message||e).slice(0,120));}
       }
       break;
     }
   }
   commit=git(['rev-parse',base]);
 }catch{throw Error('接续分支不存在: '+base);}}
 else commit=git(['rev-parse','HEAD']);
 const branch='agent/'+id;const parent=path.join(workspace,'worktrees');fs.mkdirSync(parent,{recursive:true});if(fs.realpathSync(parent)!==parent)throw Error('Worktree 目录不允许是符号链接。');
 const worktree=path.join(parent,alias+'-'+id);git(['worktree','add','--detach',worktree,commit]);
 git(['-C',worktree,'checkout','-b',branch]);
 const cwd=path.join(worktree,path.relative(repo,dir));if(!fs.existsSync(cwd))throw Error('项目内容不在已提交 HEAD 中。');return {cwd,worktree,branch,baseCommit:commit};
}
class Supervisor {
 constructor(options){Object.assign(this,options);this.taskInstructions=this.taskInstructions||defaultTaskInstructions(this.env);this._cfg=buildConfig(this.env||process.env);this.threadPrefix=this.threadPrefix||this._cfg.threadPrefix;this.clients=new Map();this.jobs=new Map();this.stopping=false;fs.mkdirSync(this.state,{recursive:true,mode:0o700});
 for(const name of fs.readdirSync(this.state)){if(!/^[a-f0-9]{12}$/.test(name))continue;const file=path.join(this.state,name,'state.json');if(!fs.existsSync(file))continue;
 const job=JSON.parse(fs.readFileSync(file,'utf8'));if(['running','cancelling'].includes(job.status)){job.status='interrupted';job.finished=Date.now();job.exit=null;job.notifyPending=true;atomic(file,job);}this.jobs.set(job.id,job);}
 }
 get children(){return this.clients;}
 save(j){atomic(path.join(this.state,j.id,'state.json'),j);}
 chainId(job){let cur=job,guard=0;while(cur&&cur.continuedFrom&&guard++<50){const nxt=this.jobs.get(cur.continuedFrom);if(!nxt)break;cur=nxt;}return cur?cur.id:null;}
 list(){return [...this.jobs.values()].sort((a,b)=>b.started-a.started).slice(0,15).map(j=>`${j.id} ${j.alias} ${j.status}${j.mode&&j.mode!=='auto'?'('+j.mode+')':''} (${Math.round(((j.finished||Date.now())-j.started)/1000)}s)${j.branch?'\n  '+j.branch+' '+j.worktree:''}`).join('\n')||'暂无任务。';}
 tail(id){const j=this.jobs.get(id);if(!j)throw Error('未知任务。');const file=path.join(this.state,id,'output.log');if(!fs.existsSync(file))return '暂无输出。';const fd=fs.openSync(file,'r');try{const size=fs.fstatSync(fd).size,b=Buffer.alloc(Math.min(size,16000));fs.readSync(fd,b,0,b.length,Math.max(0,size-b.length));return redact(b.toString(),this.env);}finally{fs.closeSync(fd);}}
 appendLog(id,s){const file=path.join(this.state,id,'output.log');fs.appendFileSync(file,redact(s,this.env)+'\n',{mode:0o600});}
 async start(alias,task,chat,message,opts={}){
 if(this.stopping)throw Error('Bridge 正在停止。');if(this.clients.size>=2)throw Error('已有 2 个任务在运行，请稍后再派。');
 if(opts.resumeThread&&this.isDmThread&&this.isDmThread(opts.resumeThread))throw Error('目标会话属于私聊线程，禁止续接到任务群。');
 const dirs=projects(this.config,this.root);if(!dirs[alias])throw Error('未知或不可用项目: '+alias+'。用 /projects 查看。');
 if(alias!=='scratch'&&[...this.jobs.values()].some(j=>j.alias===alias&&['running','cancelling'].includes(j.status)))throw Error('该项目已有运行中的任务。');
 const mode=MODES[opts.mode]?opts.mode:'auto';
 const id=crypto.randomBytes(6).toString('hex'),dir=path.join(this.state,id);
 if(opts.resumeThread){
   const job={id,alias,chat,message,mode,task,resume:opts.resumeThread,started:Date.now(),status:'running',notifyPending:false,retried:false};
   this.jobs.set(id,job);fs.mkdirSync(dir,{recursive:true,mode:0o700});this.save(job);
   fs.closeSync(fs.openSync(path.join(dir,'output.log'),'a',0o600));
   const env={...sanitizeEnv(this.env),LCT_JOB_ID:id,LCT_JOB_CHAT_ID:chat};
   const factory=this.clientFactory||(o=>new CodexClient(o));
   const client=factory({codex:this.codex,cwd:dirs[alias],env,resumeThreadId:opts.resumeThread,
    threadParams:{name:this.threadPrefix+'-'+id,cwd:dirs[alias],sandbox:MODES[mode].sandbox,approvalPolicy:MODES[mode].approvalPolicy,developerInstructions:this.taskInstructions},
    onApproval:(method,params,respond,ctx)=>this.onApproval?this.onApproval(job,method,params,respond,ctx):respond('decline'),
    onLog:x=>{try{this.appendLog(id,x);}catch{}}});
   this.clients.set(id,client);
   try{
     job.threadId=await client.start();
     const envs=(client.thread&&client.thread.environments)||[];
     job.cwd=(envs[0]&&envs[0].cwd)||dirs[alias];job.worktree=null;job.branch=null;
     this.save(job);
     client.run(task).then(r=>{job.lastMessage=redact(r&&r.message||'',this.env,Number.MAX_SAFE_INTEGER);this._done(id,null);},e=>this._done(id,e));
   }catch(e){this.clients.delete(id);job.status='failed';job.finished=Date.now();job.error=String(e.message||e);job.notifyPending=false;this.save(job);try{client.child&&client.child.kill('SIGKILL');}catch{}throw e;}
   return id;
 }
 const checkout=worktreeFor(dirs[alias],this.root,alias,id,opts.base||null);fs.mkdirSync(dir,{mode:0o700});
 const job={id,alias,chat,message,mode,task,...checkout,started:Date.now(),status:'running',notifyPending:false,retried:false};this.jobs.set(id,job);this.save(job);
 const out=fs.openSync(path.join(dir,'output.log'),'a',0o600);fs.closeSync(out);
 const env={...sanitizeEnv(this.env),LCT_JOB_ID:id,LCT_JOB_CHAT_ID:chat};
 const factory=this.clientFactory||(o=>new CodexClient(o));
 const client=factory({codex:this.codex,cwd:checkout.cwd,env,threadParams:{name:this.threadPrefix+'-'+id,cwd:checkout.cwd,sandbox:MODES[mode].sandbox,approvalPolicy:MODES[mode].approvalPolicy,developerInstructions:this.taskInstructions},
  onApproval:(method,params,respond,ctx)=>this.onApproval?this.onApproval(job,method,params,respond,ctx):respond('decline'),
  onLog:s=>{try{this.appendLog(id,s);}catch{}}});
 this.clients.set(id,client);
 try{
   job.threadId=await client.start();this.save(job);
   client.run(task).then(r=>{job.lastMessage=redact(r&&r.message||'',this.env,Number.MAX_SAFE_INTEGER);this._done(id,null);},e=>this._done(id,e));
 }catch(e){this.clients.delete(id);job.status='failed';job.finished=Date.now();job.error=String(e.message||e);job.notifyPending=false;this.save(job);try{client.child&&client.child.kill('SIGKILL');}catch{}throw e;}
 return id;
 }
 async continueJob(jobId,task,chat,message){
 const j0=this.jobs.get(jobId);if(!j0)throw Error('未知任务。');
 if(['running','cancelling'].includes(j0.status))throw Error('任务还在运行，等它完成或 /cancel 后再接续。');
 if(this.clients.size>=2)throw Error('已有 2 个任务在运行。');
 if(j0.chat&&chat&&j0.chat!==chat)throw Error('任务绑定群与当前群不一致，已阻断接续。可私聊 /reopen '+jobId+' 重建绑定。');
 if(j0.threadId&&this.isDmThread&&this.isDmThread(j0.threadId))throw Error('任务线程与私聊会话冲突，已阻断接续。');
 if(j0.alias!=='scratch'&&[...this.jobs.values()].some(j=>j.alias===j0.alias&&j.id!==jobId&&['running','cancelling'].includes(j.status)))throw Error('该项目已有运行中的任务。');
 if(!j0.threadId)throw Error('该任务没有可续接的会话线程。');
 const cwd=j0.cwd||j0.worktree||j0.contentDir;if(!cwd)throw Error('任务工作目录缺失。');
 const id=crypto.randomBytes(6).toString('hex'),dir=path.join(this.state,id);
 const job={id,alias:j0.alias,chat,message,mode:j0.mode||'auto',task,threadId:null,resume:j0.threadId,cwd,worktree:j0.worktree||null,branch:j0.branch||null,started:Date.now(),status:'running',notifyPending:false,retried:false,continuedFrom:jobId};
 this.jobs.set(id,job);fs.mkdirSync(dir,{recursive:true,mode:0o700});this.save(job);
 fs.closeSync(fs.openSync(path.join(dir,'output.log'),'a',0o600));
 const env={...sanitizeEnv(this.env),LCT_JOB_ID:id,LCT_JOB_CHAT_ID:chat};
 const factory=this.clientFactory||(o=>new CodexClient(o));
 const client=factory({codex:this.codex,cwd,env,resumeThreadId:j0.threadId,
  threadParams:{name:this.threadPrefix+'-'+id,cwd,sandbox:MODES[job.mode].sandbox,approvalPolicy:MODES[job.mode].approvalPolicy,developerInstructions:this.taskInstructions},
  onApproval:(method,params,respond,ctx)=>this.onApproval?this.onApproval(job,method,params,respond,ctx):respond('decline'),
  onLog:x=>{try{this.appendLog(id,x);}catch{}}});
 this.clients.set(id,client);
 try{
   job.threadId=await client.start();this.save(job);
   client.run(task).then(r=>{job.lastMessage=redact(r&&r.message||'',this.env,Number.MAX_SAFE_INTEGER);this._done(id,null);},e=>this._done(id,e));
 }catch(e){this.clients.delete(id);job.status='failed';job.finished=Date.now();job.error=String(e.message||e);job.notifyPending=false;this.save(job);try{client.child&&client.child.kill('SIGKILL');}catch{}throw e;}
 return id;
 }
 _done(id,error){const client=this.clients.get(id),j=this.jobs.get(id);if(!j)return;
 if(client&&!this._isRetrying(error,j)){client.cancelSource=client.cancelSource||'job-finished';try{client.child.kill('SIGTERM');}catch{}}
 if(error&&j.status==='running'&&!j.retried&&client&&!client.turnSubmitted&&!client.turnSubmissionAttempted&&/network|reconnect|timeout|stream|econn|eai_again/i.test(String(error.message||error))){
   try{client&&client.child.kill('SIGTERM');}catch{}
   j.retried=true;this.save(j);console.error('[bridge] transient failure, retrying job '+id+': '+error.message);
   const factory=this.clientFactory||(o=>new CodexClient(o));
   const c2=factory({codex:this.codex,cwd:j.cwd||j.worktree,env:{...sanitizeEnv(this.env),LCT_JOB_ID:id,LCT_JOB_CHAT_ID:j.chat},resumeThreadId:j.threadId||undefined,threadParams:{name:this.threadPrefix+'-'+id+'-r2',cwd:j.cwd||j.worktree,sandbox:MODES[j.mode].sandbox,approvalPolicy:MODES[j.mode].approvalPolicy,developerInstructions:this.taskInstructions},
    onApproval:(method,params,respond,ctx)=>this.onApproval?this.onApproval(j,method,params,respond,ctx):respond('decline'),
    onLog:x=>{try{this.appendLog(id,'[retry] '+x);}catch{}}});
   this.clients.set(id,c2);
   c2.start().then(threadId=>{j.threadId=threadId;this.save(j);return c2.run(j.task);}).then(r=>{j.lastMessage=redact(r&&r.message||'',this.env,Number.MAX_SAFE_INTEGER);this._done(id,null);},e2=>this._done(id,e2));
   return;}
 if(this.terminalPending&&this.terminalPending.has(id))return;
 if(error){
   j.turnSubmitted=!!(client&&client.turnSubmitted);
   j.turnSubmissionAttempted=!!(client&&client.turnSubmissionAttempted);
   j.executionStarted=!!(client&&client.executionStarted);
   j.providerRetryCount=client&&client.providerRetryCount||0;
   j.failureKind=classifyFailure(error);
   j.retryBlocked=j.turnSubmitted?'turn-submitted':j.turnSubmissionAttempted?'submission-uncertain':null;
   if(error.codexErrorInfo!==undefined)j.codexErrorInfo=error.codexErrorInfo;
   if(client&&client.lastMessage)j.lastMessage=redact(client.lastMessage,this.env,Number.MAX_SAFE_INTEGER);
 }
 const terminal={...j,status:j.status==='cancelling'?'cancelled':(error&&error.interrupted)?'cancelled':error?'failed':'completed',exit:error?1:0,finished:Date.now(),error:error?redact(String(error.message||error),this.env,600):null,notifyPending:true};
 (this.terminalPending||(this.terminalPending=new Map())).set(id,terminal);
 this._commitTerminal(id);}
 _commitTerminal(id){const terminal=this.terminalPending&&this.terminalPending.get(id);if(!terminal)return;
 try{this.save(terminal);}catch(e){console.error('[bridge] terminal save failed for '+id+':',e.message);const timer=setTimeout(()=>this._commitTerminal(id),5000);timer.unref?.();return;}
 this.terminalPending.delete(id);const job=this.jobs.get(id);Object.assign(job,terminal);this.clients.delete(id);
 this.flush().catch(()=>{});if(this.onSettled)try{this.onSettled(job);}catch(e){console.error('[bridge] onSettled failed:',e&&e.message);}}
 _isRetrying(error,j){const client=this.clients.get(j.id);return !!(error&&j.status==='running'&&!j.retried&&client&&!client.turnSubmitted&&!client.turnSubmissionAttempted&&/network|reconnect|timeout|stream|econn|eai_again/i.test(String(error.message||error)));}
 cancel(id){if(this.terminalPending?.has(id))throw Error('任务已结束，终态正在等待存储恢复，不能再取消。');const client=this.clients.get(id),j=this.jobs.get(id);if(!client||!j)throw Error('没有该 ID 的运行中任务。');j.status='cancelling';this.save(j);client.cancel().catch(()=>{});return `正在取消 ${id}`;}
 async flush(){if(this.flushing)return;this.flushing=true;try{for(const j of this.jobs.values()){if(!j.notifyPending)continue;try{await this.send(j.chat,this._report(j),'job-'+j.id,j);j.notifyPending=false;this.save(j);}catch{console.error('[bridge] notification pending for '+j.id);}}}finally{this.flushing=false;}}
 _report(j){const msg=(j.lastMessage||'').trim();const icon=j.status==='completed'?'✅':j.status==='cancelled'?'🛑':'⚠️';const st=j.status==='completed'?'完成':j.status==='cancelled'?'已取消':j.status==='interrupted'?'被中断':'失败';return `${icon} 任务${st} · ${j.alias} · ${j.id.slice(0,6)} · ${j.mode||'auto'}\n${j.error?'错误: '+j.error+'\n':''}${failureHint(j)?'\n'+failureHint(j)+'\n':''}${msg?'\n结论: '+msg+'\n':''}\n分支: ${j.branch||'-'}${j.threadId?'\n接管: codex resume '+j.threadId+'\n':''}回复 /done 结算归档并解散本群`;}
 stop(){this.stopping=true;for(const id of this.clients.keys()){const c=this.clients.get(id);if(c)c.cancelSource=c.cancelSource||'service-stop';try{this.cancel(id);}catch{}}}
}
module.exports={Supervisor,parse,parseRun,projects,redact,atomic,worktreeFor,MODES,sanitizeEnv,defaultTaskInstructions};

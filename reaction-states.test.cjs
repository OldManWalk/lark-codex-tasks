// 指令表情三态回归测试（v0.2.0）：入队=OneSecond、执行=Typing、完成=DONE、失败=CrossMark。
// 断言贴新删旧、顺序严格、API 失败不影响任务、LCT_REACTIONS=0 全量关闭。全部使用合成 fake，不触真实聊天。
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const sup=require('./supervisor.cjs');
const {CodexClient}=require('./codex-client.cjs');

const until=async(fn,ms=4000)=>{const t0=Date.now();while(Date.now()-t0<ms){if(fn())return true;await new Promise(r=>setTimeout(r,10));}return false;};

function bridge(t,{seed,env,failReact}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lct-r-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const state=path.join(root,'.local/state/lark-codex-tasks');fs.mkdirSync(state,{recursive:true});
 fs.mkdirSync(path.join(root,'.config/lark-codex-tasks'),{recursive:true});
 fs.mkdirSync(path.join(root,'workspace/a'),{recursive:true});
 fs.mkdirSync(path.join(root,'workspace/scratch'),{recursive:true});
 sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{a:path.join(root,'workspace/a')});
 if(seed)for(const [rel,data] of Object.entries(seed)){const f=path.join(state,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,typeof data==='string'?data:JSON.stringify(data));}
 const proc=new EventEmitter();proc.env={LARK_OWNER_OPEN_ID:'owner',...(env||{})};
 const calls=[],logs=[],errs=[];
 const context=vm.createContext({
  require:n=>n==='node:os'?{...os,homedir:()=>root}:require(n),
  __dirname,module:{},process:proc,console:{log(...a){logs.push(a.map(String).join(' '));},error(...a){errs.push(a.map(String).join(' '));}},
  setTimeout,clearTimeout,setInterval,clearInterval,calls});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'lark-bridge.cjs'),'utf8')+`
 const FAIL_REACT=${failReact?'true':'false'};
 lark=async(args)=>{calls.push(args);
  if(args[0]==='im'&&args[1]==='reactions'&&args[2]==='create'){if(FAIL_REACT)throw new Error('emoji disabled for test');return {ok:true,data:{reaction_id:'rid_'+calls.length}};}
  if(args[0]==='im'&&args[1]==='reactions'&&args[2]==='delete')return {ok:true,data:{}};
  return {ok:true,data:{message_id:'om_fake',chat_id:'oc_new'}};};
 globalThis.api={handle,handleCardAction,askApproval,decide,settle,reopen,respond,groupContext,auditSessionIsolation,dmSession,dmThreadIds,supervisor,pendingByChat,pendingByToken,pump,enqueueItem,
  consts:{DM_INSTR_VERSION,TASK_INSTR_VERSION,DM_INSTRUCTIONS,TASK_INSTRUCTIONS},
  get groups(){return groups;},get sessions(){return sessions;},get dmChats(){return dmChats;},get queues(){return queues;},
  enqueue(fn){queue=queue.then(fn);return queue;},patch(code){return eval(code)}};
 `,context);
 return {a:context.api,calls,logs,errs,root,context};
}
function mockCodex(t,runImpl){
 const starts=[],runs=[];
 const oS=CodexClient.prototype.start,oR=CodexClient.prototype.run;
 t.after(()=>{CodexClient.prototype.start=oS;CodexClient.prototype.run=oR;});
 CodexClient.prototype.start=async function(){starts.push({resume:this.resumeThreadId||null});this.threadId=this.resumeThreadId||'thread-'+starts.length;return this.threadId;};
 CodexClient.prototype.run=function(task){const rec={task,resume:this.resumeThreadId||null};runs.push(rec);return runImpl?runImpl.call(this,task,rec):Promise.resolve({message:'ok'});};
 return {starts,runs};
}
const msg=(chat_type,chat_id,content,id)=>({type:'im.message.receive_v1',chat_type,chat_id,content,message_id:id||('om_'+Math.random().toString(36).slice(2)),sender_id:'owner',sender_type:'user',message_type:'text'});
function bindGroup(a,chat,jobId,threadId){
 a.supervisor.jobs.set(jobId,{id:jobId,alias:'a',chat,threadId,status:'completed',cwd:'/tmp',mode:'auto',started:1});
 a.groups[chat]={anchor:jobId,alias:'a',status:'active'};
}
const reactCreates=calls=>calls.filter(c=>c[0]==='im'&&c[1]==='reactions'&&c[2]==='create').map(c=>JSON.parse(c[6]).reaction_type.emoji_type);
const reactDeletes=calls=>calls.filter(c=>c[0]==='im'&&c[1]==='reactions'&&c[2]==='delete').map(c=>JSON.parse(c[4]).reaction_id);

// ── R1：群任务指令 等待→处理中→完成，贴新删旧、顺序严格 ──
test('R1: group task follows OneSecond -> Typing -> DONE with old-reaction cleanup',async t=>{
 const gate=[];const {a,calls}=bridge(t);
 const {runs}=mockCodex(t,function(){return new Promise(res=>gate.push(res));});
 bindGroup(a,'oc_gR','aaaa11110000','thread-T');
 await a.respond(msg('group','oc_gR','任务A','om_RA'));
 assert(await until(()=>reactCreates(calls).includes('OneSecond')),'入队应贴 OneSecond');
 assert(await until(()=>runs.length===1),'任务启动');
 assert(await until(()=>reactCreates(calls).includes('Typing')),'claim 应换 Typing');
 gate.shift()({message:'done'});
 assert(await until(()=>reactCreates(calls).includes('DONE')),'完成应换 DONE');
 assert(await until(()=>reactDeletes(calls).length>=2),'每次切换应删除旧表情');
 assert.deepEqual(reactCreates(calls),['OneSecond','Typing','DONE'],'状态顺序严格不乱');
});

// ── R2：任务失败贴 CrossMark ──
test('R2: failed run ends with CrossMark',async t=>{
 const {a,calls}=bridge(t);
 mockCodex(t,function(){return Promise.reject(new Error('boom-synthesis'));});
 bindGroup(a,'oc_gR','aaaa11110000','thread-T');
 await a.respond(msg('group','oc_gR','会失败的任务','om_RF'));
 assert(await until(()=>reactCreates(calls).includes('CrossMark')),'失败应贴 CrossMark');
 assert(await until(()=>a.queues['oc_gR'].items[0].status==='failed'),'队列项落定 failed');
});

// ── R3：名额竞态退回等待，表情回到 OneSecond；名额恢复后自动完成 ──
test('R3: capacity race requeues item and reaction returns to OneSecond',async t=>{
 const {a,calls}=bridge(t);
 const oS=CodexClient.prototype.start,oR=CodexClient.prototype.run;
 t.after(()=>{CodexClient.prototype.start=oS;CodexClient.prototype.run=oR;});
 let rejectStart=true;
 CodexClient.prototype.start=async function(){if(rejectStart){rejectStart=false;throw new Error('已有 2 个任务正在运行');}this.threadId='thread-r3';return this.threadId;};
 CodexClient.prototype.run=()=>Promise.resolve({message:'ok'});
 bindGroup(a,'oc_gR','aaaa11110000','thread-T');
 await a.respond(msg('group','oc_gR','任务A','om_RQ'));
 assert(await until(()=>reactCreates(calls).length>=3),'退回等待应重新贴 OneSecond');
 assert(await until(()=>a.queues['oc_gR'].items[0].status==='done'),'名额恢复后自动执行完成');
 assert.deepEqual(reactCreates(calls),['OneSecond','Typing','OneSecond','Typing','DONE'],'等待→处理中→重新等待→处理中→完成');
});

// ── R4：LCT_REACTIONS=0 全量关闭，任务照常 ──
test('R4: LCT_REACTIONS=0 disables all reaction calls, task unaffected',async t=>{
 const {a,calls}=bridge(t,{env:{LCT_REACTIONS:'0'}});
 const {runs}=mockCodex(t);
 bindGroup(a,'oc_gR','aaaa11110000','thread-T');
 await a.respond(msg('group','oc_gR','任务A','om_R4'));
 assert(await until(()=>runs.length===1&&a.queues['oc_gR'].items[0].status==='done'),'任务正常完成');
 assert.equal(calls.filter(c=>c[1]==='reactions').length,0,'不应有任何表情调用');
});

// ── R5：表情 API 失败仅记日志，任务照常完成 ──
test('R5: reaction API failure is logged but never blocks the task',async t=>{
 const {a,calls,errs}=bridge(t,{failReact:true});
 const {runs}=mockCodex(t);
 bindGroup(a,'oc_gR','aaaa11110000','thread-T');
 await a.respond(msg('group','oc_gR','任务A','om_R5'));
 assert(await until(()=>runs.length===1&&a.queues['oc_gR'].items[0].status==='done'),'任务应正常完成');
 assert(await until(()=>errs.some(e=>e.includes('表情标记失败'))),'失败应记日志');
 assert(reactCreates(calls).length>=1,'尝试过表情调用');
});

// ── R6：私聊对话受理贴 OneSecond，回复完成贴 DONE，指令版本随任务群纪律升级 ──
test('R6: dm conversation gets OneSecond on accept and DONE on reply; task instr v2 carries discipline',async t=>{
 const {a,calls}=bridge(t);
 mockCodex(t); // run 立即成功 → dmDecision 走 reply 兜底
 await a.respond(msg('p2p','oc_dm','你好','om_R6'));
 assert(await until(()=>reactCreates(calls).includes('OneSecond')),'受理应贴 OneSecond');
 assert(await until(()=>reactCreates(calls).includes('DONE')),'回复完成应贴 DONE');
 assert(!reactCreates(calls).includes('CrossMark'),'正常回复不应贴失败表情');
 assert(a.consts.TASK_INSTR_VERSION==='group-task-v2','任务群指令版本应升级');
 assert(/禁止自行调用飞书 CLI/.test(a.consts.TASK_INSTRUCTIONS)&&/在当前本群讨论推进/.test(a.consts.TASK_INSTRUCTIONS),'指令含工作场所纪律');
});

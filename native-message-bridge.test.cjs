const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const sup=require('./supervisor.cjs');
const {CodexClient}=require('./codex-client.cjs');

const until=async(fn,ms=4000)=>{const t0=Date.now();while(Date.now()-t0<ms){if(fn())return true;await new Promise(r=>setTimeout(r,10));}return false;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function bridge(t,{seed}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lct-q-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const state=path.join(root,'.local/state/lark-codex-tasks');fs.mkdirSync(state,{recursive:true});
 fs.mkdirSync(path.join(root,'.config/lark-codex-tasks'),{recursive:true});
 fs.mkdirSync(path.join(root,'workspace/a'),{recursive:true});
 fs.mkdirSync(path.join(root,'workspace/scratch'),{recursive:true});
 sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{a:path.join(root,'workspace','a')});
 if(seed)for(const [rel,data] of Object.entries(seed)){const f=path.join(state,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,typeof data==='string'?data:JSON.stringify(data));}
 const proc=new EventEmitter();proc.env={LARK_OWNER_OPEN_ID:'owner',LCT_NATIVE_MESSAGE_SYNC:'1',LCT_PLATFORM:'linux',LCT_SANDBOX_KIND:'bwrap'};
 const calls=[],logs=[],errs=[];
 const context=vm.createContext({
  require:n=>n==='node:os'?{...os,homedir:()=>root}:require(n),
  __dirname,module:{},process:proc,console:{log(...a){logs.push(a.map(String).join(' '));},error(...a){errs.push(a.map(String).join(' '));}},
  setTimeout,clearTimeout,setInterval,clearInterval,calls});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'lark-bridge.cjs'),'utf8')+`
 lark=async(args)=>{calls.push(args);return {ok:true,data:{message_id:'om_fake',chat_id:'oc_new'}};};
 globalThis.api={syncNative,scanNative,nativeTargets,instructions,get dispatches(){return dispatches;},handle,handleCardAction,askApproval,decide,settle,reopen,respond,groupContext,auditSessionIsolation,dmSession,dmThreadIds,supervisor,pendingByChat,pendingByToken,pump,enqueueItem,
  consts:{DM_INSTR_VERSION,TASK_INSTR_VERSION,DM_INSTRUCTIONS,TASK_INSTRUCTIONS},
  get groups(){return groups;},get sessions(){return sessions;},get dmChats(){return dmChats;},get queues(){return queues;},
  enqueue(fn){queue=queue.then(fn);return queue;},patch(code){return eval(code);}};
 `,context);
 return {a:context.api,calls,logs,errs,root,context};
}
// 可控 CodexClient：记录 start/run 参数；run 行为由 runImpl 控制（默认立即成功）
function mockCodex(t,runImpl){
 const starts=[],runs=[];
 const oS=CodexClient.prototype.start,oR=CodexClient.prototype.run;
 t.after(()=>{CodexClient.prototype.start=oS;CodexClient.prototype.run=oR;});
 CodexClient.prototype.start=async function(){starts.push({resume:this.resumeThreadId||null,instr:(this.threadParams&&this.threadParams.developerInstructions)||null,cwd:this.cwd});this.threadId=this.resumeThreadId||'thread-'+starts.length;return this.threadId;};
 CodexClient.prototype.run=function(task){const rec={task,resume:this.resumeThreadId||null,cwd:this.cwd};runs.push(rec);return runImpl?runImpl.call(this,task,rec):Promise.resolve({message:'ok'});};
 return {starts,runs};
}
const msg=(chat_type,chat_id,content,id)=>({type:'im.message.receive_v1',chat_type,chat_id,content,message_id:id||('om_'+Math.random().toString(36).slice(2)),sender_id:'owner',sender_type:'user',message_type:'text'});
function bindGroup(a,chat,jobId,threadId){
 a.supervisor.jobs.set(jobId,{id:jobId,alias:'a',chat,threadId,status:'completed',cwd:'/tmp',mode:'auto',started:1});
 a.groups[chat]={anchor:jobId,alias:'a',status:'active'};
}


function raw(id,text="old",extra={}){return {message_id:id,chat_id:"oc_native",sender:{id:"owner",sender_type:"user"},msg_type:"text",create_time:"10",update_time:"10",body:{content:JSON.stringify({text})},...extra};}
function source(a,m){a.patch("lark=async(args)=>{calls.push(args);if(args[0]===\"api\"&&args[1]===\"GET\")return {ok:true,data:{items:["+JSON.stringify(m)+"]}};return {ok:true,data:{message_id:\"om_fake\",chat_id:\"oc_new\"}};}");}
test("NB1 native queued edits retain FIFO; recalls leave durable tombstones",async t=>{
 const {a}=bridge(t);bindGroup(a,"oc_native","aaaaaaaaaaaa","thread-T");a.patch("qOf(\"oc_native\").paused=true");
 source(a,raw("om_native"));await a.handle(JSON.stringify(msg("group","oc_native","old","om_native")));
 const item=a.queues.oc_native.items[0];assert.equal(item.status,"queued");
 source(a,raw("om_native","latest",{updated:true,update_time:"20"}));await a.syncNative("om_native");assert.equal(item.text,"latest");assert.equal(item.seq,1);assert.equal(a.queues.oc_native.paused,true);
 source(a,raw("om_native","",{deleted:true,update_time:"30"}));await a.syncNative("om_native");assert.equal(item.status,"withdrawn");assert.equal(a.nativeTargets().length,0);
});
test("NB2 recall before receive does not admit a task",async t=>{
 const {a}=bridge(t);bindGroup(a,"oc_native","aaaaaaaaaaaa","thread-T");source(a,raw("om_recalled","",{deleted:true}));
 await a.handle(JSON.stringify(msg("group","oc_native","stale","om_recalled")));assert.equal(a.queues.oc_native?.items.length||0,0);
});
test("NB3 API failure blocks startup while preserving queue for retry",async t=>{
 const {a}=bridge(t);bindGroup(a,"oc_native","aaaaaaaaaaaa","thread-T");a.patch("qOf(\"oc_native\").paused=true");source(a,raw("om_wait"));await a.handle(JSON.stringify(msg("group","oc_native","old","om_wait")));
 a.patch("lark=async()=>{throw Error(\"offline\")};queues.oc_native.paused=false");await a.pump();const i=a.queues.oc_native.items[0];assert.equal(i.status,"queued");assert(i.nativeRetryAt>Date.now());assert.equal(i.runJobId,null);
});
test("NB4 initial direct job is found by original DM message and edited via confirmed stop",async t=>{
 const {a}=bridge(t);bindGroup(a,"oc_task","aaaaaaaaaaaa","thread-T");
 a.patch("supervisor.jobs.set(\"bbbbbbbbbbbb\",{id:\"bbbbbbbbbbbb\",alias:\"a\",chat:\"oc_task\",message:\"om_direct\",status:\"running\",task:\"old\",started:10});dispatches.om_direct={messageId:\"om_direct\",chat:\"oc_native\",status:\"done\",alias:\"a\",jobId:\"bbbbbbbbbbbb\"};supervisor.cancel=id=>{supervisor.jobs.get(id).status=\"cancelling\";};groups.oc_task.anchor=\"bbbbbbbbbbbb\"");
 source(a,raw("om_direct","/run a new task",{updated:true,update_time:"20"}));await a.syncNative("om_direct");
 const item=a.queues.oc_task.items[0];assert.equal(item.change.text,"new task");assert.equal(item.nativeMessage.chat,"oc_native");assert.equal(item.status,"active");
 a.patch("supervisor.jobs.get(\"bbbbbbbbbbbb\").status=\"cancelled\";supervisor.jobs.get(\"bbbbbbbbbbbb\").stopConfirmed=true");a.instructions().reconcile("oc_task");assert.equal(item.text,"new task");assert.equal(item.status,"queued");assert.equal(a.queues.oc_task.paused,false);
});

test("NB5 pending dispatch edits refresh task, and recall suppresses group creation",async t=>{
 const {a}=bridge(t);a.patch("dispatches.om_pending={messageId:\"om_pending\",chat:\"oc_native\",status:\"pending\",alias:\"a\",kind:\"run\",task:\"old\"}");
 source(a,raw("om_pending","/run a newest",{updated:true,update_time:"20"}));await a.syncNative("om_pending");assert.equal(a.dispatches.om_pending.task,"newest");
 source(a,raw("om_pending","",{deleted:true,update_time:"30"}));await a.syncNative("om_pending");assert.equal(a.dispatches.om_pending.status,"withdrawn");assert.equal(a.dispatches.om_pending.groupChat,undefined);
});
test("NB6 source edit at preflight starts latest text once",async t=>{
 const {a}=bridge(t);bindGroup(a,"oc_native","aaaaaaaaaaaa","thread-T");a.patch("qOf(\"oc_native\").paused=true");source(a,raw("om_gate"));await a.handle(JSON.stringify(msg("group","oc_native","old","om_gate")));
 const {runs}=mockCodex(t);source(a,raw("om_gate","newest",{updated:true,update_time:"20"}));a.patch("queues.oc_native.paused=false");await a.pump();assert(await until(()=>runs.length));assert.equal(runs[0].task,"newest");assert(await until(()=>a.queues.oc_native.items[0].status==="done"));assert.equal(runs.length,1);
});
test("NB7 identity mismatch cannot replace content or start a queued task",async t=>{
 const {a}=bridge(t);bindGroup(a,"oc_native","aaaaaaaaaaaa","thread-T");a.patch("qOf(\"oc_native\").paused=true");source(a,raw("om_owner"));await a.handle(JSON.stringify(msg("group","oc_native","old","om_owner")));
 source(a,raw("om_owner","injected",{sender:{id:"other",sender_type:"user"},updated:true,update_time:"20"}));a.patch("queues.oc_native.paused=false");await a.pump();assert.equal(a.queues.oc_native.items[0].text,"old");assert.equal(a.queues.oc_native.items[0].status,"queued");
});

test("NB8 archived-resume instruction tracks original message through synthetic queue ID",async t=>{
 const {a}=bridge(t);bindGroup(a,"oc_native","aaaaaaaaaaaa","thread-T");a.patch("qOf(\"oc_native\").paused=true");
 a.enqueueItem("oc_native","task","old","resume-om_archived");
 a.queues.oc_native.items[0].nativeMessage={messageId:"om_archived",chat:"oc_native",signature:"old",updatedAt:10};
 source(a,raw("om_archived","",{deleted:true,update_time:"30"}));a.patch("queues.oc_native.paused=false");await a.pump();assert.equal(a.queues.oc_native.items[0].status,"withdrawn");assert.equal(a.queues.oc_native.items[0].runJobId,null);
});

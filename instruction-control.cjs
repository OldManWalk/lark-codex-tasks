'use strict';
const crypto=require('node:crypto');
const ACTIVE=new Set(['running','cancelling']);
const interrupted=()=>Object.assign(Error('指令已请求撤回或修改，未继续提交'),{cancelled:true,instructionChange:true});
// All durable mutations use the bridge's store transaction. Bodies never enter snapshots or operation receipts.
function createInstructionControl({queues,qOf,jobs,tx,redact=x=>x,textParts=()=>null,inFlight=()=>false,stoppingDm=()=>false,cancelJob,cancelDm,changed=()=>{},beforeFinish=()=>{},settled=()=>{},replaceNative=()=>{},clock=Date.now}){
 const parts=i=>textParts(i)||{text:i.inputText??i.text??'',attachmentContext:i.attachmentContext||''};
 const jobFor=(chat,i)=>jobs.get(i.runJobId)||[...jobs.values()].find(j=>j.chat===chat&&j.message===(i.runMessageId||i.messageId));
 function locate(b){
  if(!b||typeof b.target!=='string')throw Error('缺少指令目标');
  if(b.seq!==undefined){
   if(!Number.isSafeInteger(b.seq)||b.seq<1)throw Error('指令序号无效');
   const i=queues()[b.target]?.items.find(i=>i.seq===b.seq);if(!i)throw Error('指令不存在，请刷新');
   return {chat:b.target,item:i,job:jobFor(b.target,i)};
  }
  const j=jobs.get(b.target);if(!j||!j.chat)throw Error('任务不存在或没有绑定会话');
  const existing=queues()[j.chat]?.items.find(i=>i.runJobId===j.id||(i.runMessageId||i.messageId)===j.message);
  if(existing)return {chat:j.chat,item:existing,job:j};
  return {chat:j.chat,job:j,virtual:true,item:{seq:0,kind:'task',messageId:j.message||'job-'+j.id,text:j.task||'',inputText:j.task||'',images:j.images||[],mediaPrepared:true,status:ACTIVE.has(j.status)?'active':'done',enqueuedAt:j.started,startedAt:j.started,runJobId:j.id}};
 }
 function version(r){return crypto.createHash('sha256').update(JSON.stringify([r.chat,r.item.seq,r.item.text,r.item.status,r.item.revision||0,r.item.change,r.job?.id,r.job?.status])).digest('hex').slice(0,24);}
 function detail(b){const r=locate(b),i=r.item;return {target:b.target,seq:b.seq,chat:r.chat,status:i.change?.status==='stopping'?'stopping':i.status,itemRevision:version(r),text:redact(parts(i).text),draft:i.change?.text?redact(i.change.text):null,attachmentCount:i.media?.length||i.images?.length||0,editable:['active','queued'].includes(i.status)&&!i.change,historyCount:i.history?.length||0,history:(i.history||[]).map(h=>({at:h.at,action:h.action,text:redact(h.text||'')}))};}
 function audit(i,action){(i.history||(i.history=[])).push({action,at:clock(),text:parts(i).text,runJobId:i.runJobId||null,revision:i.revision||0});i.history=i.history.slice(-20);i.revision=(i.revision||0)+1;}
 function replaceText(i,text){i.attachmentContext=parts(i).attachmentContext;i.inputText=text;i.text=text+i.attachmentContext;}
 function guard(i){if(i.change||i.status!=='active')throw interrupted();}
 function apply(b,native=false){
  const r=locate(b),i=r.item,kind=b.action?.slice('instruction.'.length);
  if(!['withdraw','edit'].includes(kind))throw Error('未知指令操作');
  if(b.itemRevision!==version(r))throw Error('指令已变化，请重新打开并确认');
  if(native&&i.change?.status==='stopping'&&i.change.source==='feishu'){
   if(i.change.kind==='withdraw')return {status:'accepted'};
   if(kind==='edit'&&(typeof b.text!=='string'||!b.text.trim()||b.text.length>4000))throw Error('新指令须为 1–4000 字符');
   tx(()=>{i.change.kind=kind;i.change.text=kind==='edit'?redact(b.text.trim()):undefined;i.change.requestId=b.requestId;i.change.nativeMessage=b.nativeMessage;i.nativeMessage=b.nativeMessage;});
   return {status:'accepted'};
  }
  if(i.change||!['queued','active'].includes(i.status))throw Error('指令已结束或正在停止，请刷新');
  if(r.job&&i.status==='active'&&!ACTIVE.has(r.job.status))throw Error('执行已经结束，无法撤回或替换；请刷新后发送新的后续指令');
  let text;
  if(kind==='edit'){
   if(typeof b.text!=='string'||!b.text.trim()||b.text.length>4000)throw Error('新指令须为 1–4000 字符');
   text=redact(b.text.trim());
   if(!native&&text===parts(i).text)throw Error('内容没有变化');
  }
  tx(()=>{
   const q=qOf(r.chat);
   if(r.virtual){i.seq=++q.seq;q.items.unshift(i);}
   if(native)i.nativeMessage=b.nativeMessage;
   if(i.status==='queued'){
    audit(i,kind);
    if(kind==='edit'){replaceText(i,text);if(native)replaceNative(i,b.nativeMessage);}
    else {i.status='withdrawn';i.finishedAt=clock();}
   }else{
    i.change={kind,text,requestId:b.requestId,requestedAt:clock(),status:'stopping',...(native?{source:'feishu',autoResume:!q.paused&&!b.nativeHoldReason,holdReason:b.nativeHoldReason,nativeMessage:b.nativeMessage}:{})};
    q.paused=true;q.pauseReason='instruction-stop:#'+i.seq;
   }
  });
  if(i.change){
   try{if(r.job)cancelJob(r.job.id);else if(i.kind==='dm')cancelDm(r.chat,i);}
   catch(e){tx(()=>{i.change.error=redact(String(e.message));});}
  }
  changed(r.chat,i);
  return {status:i.change?'accepted':'succeeded',message:i.change?'已受理，正在停止本轮执行。队列已暂停；停止确认后'+(kind==='edit'?'保存修改后的指令，核查已有修改后恢复队列。':'标记已撤回，核查已有修改后可恢复后续队列。'):kind==='edit'?'修改已保存，保留原排队位置。':'已撤回，本条不会执行。',seq:i.seq,chat:r.chat};
 }
 function finish(chat,i){
  const c=i.change;if(!c||c.status!=='stopping')return;
  const j=jobFor(chat,i);beforeFinish(chat,i,j);
  tx(()=>{
   audit(i,c.kind);
   i.lastChange={kind:c.kind,requestId:c.requestId,requestedAt:c.requestedAt,finishedAt:clock(),status:'succeeded',source:c.source,holdReason:c.holdReason};
   if(c.kind==='edit'){
    replaceText(i,c.text);if(c.source==='feishu')replaceNative(i,c.nativeMessage);i.status='queued';i.runMessageId='edit-'+crypto.randomBytes(12).toString('hex');i.runJobId=null;i.startedAt=null;i.finishedAt=null;i.error=null;i.queuedAck=true;
   }else{i.status='withdrawn';i.finishedAt=clock();}
   // Startup cancellation can leave threadId empty; the bridge still reconciles the anchor to the original resumable thread.
   if(j)i.lastRunJobId=j.id;
   delete i.change;
   const q=qOf(chat);if(c.source==='feishu'&&c.autoResume&&q.paused&&q.pauseReason==='instruction-stop:#'+i.seq&&!q.items.some(x=>x.change?.status==='stopping')){q.paused=false;q.pauseReason=null;i.lastChange.autoResumed=true;}
   settled(chat,i);
  });changed(chat,i);
 }
 function reconcile(chat){
  for(const i of queues()[chat]?.items||[]){
   if(i.change?.status!=='stopping'||inFlight(chat,i))continue;
   const j=jobFor(chat,i);
   if(j&&ACTIVE.has(j.status)||!j&&stoppingDm(chat,i))continue;
   if(j?.status==='cancelled'&&j.stopConfirmed||!j&&i.change.stopConfirmed){finish(chat,i);continue;}
   tx(()=>{i.status=j?.status==='completed'?'done':'failed';i.finishedAt=clock();i.change.status=j?.status==='completed'?'too-late':'unknown';i.lastChange={kind:i.change.kind,requestId:i.change.requestId,status:j?.status==='completed'?'failed':'unknown',finishedAt:clock()};i.error=j?.status==='completed'?'原指令已完成，撤回未生效；修改稿未执行。':'停止结果需核查；未自动执行修改稿。请核查执行记录后另发新指令。';qOf(chat).paused=true;settled(chat,i);});changed(chat,i);
  }
 }
 function prestartStopped(chat,i){
  if(!i.change||jobFor(chat,i))return;
  if(i.kind==='dm'&&!i.change.stopConfirmed&&i.change.stopPending)return;
  tx(()=>{i.change.stopConfirmed=true;});
 }
 function canResume(chat){if(queues()[chat]?.items.some(i=>i.change?.status==='stopping'))throw Error('仍在等待执行停止，暂不能恢复队列');}
 return {detail,apply:b=>apply(b),applyNative:b=>apply(b,true),guard,reconcile,prestartStopped,canResume,jobFor};
}
module.exports={createInstructionControl};

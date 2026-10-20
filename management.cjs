'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const channel=require('./control-channel.cjs');
function atomic(file,v){const tmp=file+'.tmp',fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(v));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
function runCLI(ctx,cmd){return new Promise((resolve,reject)=>{
 execFile(process.execPath,[path.join(__dirname,'lct.cjs'),cmd,'--json'],{env:{...ctx.fileEnv,...ctx.env},timeout:45000,maxBuffer:1024*1024},(err,out)=>{
  if(err)return reject(Error('服务管理命令失败，请查看主机服务日志（'+cmd+'）'));
  try{resolve(JSON.parse(out));}catch{reject(Error('服务管理器返回了无效结果'));}
 });
});}
const ACTIONS=new Set(['service.start','service.stop','service.restart','queue.pause','queue.resume','queue.clear','queue.drop','job.cancel','job.reopen','outbox.retry','outbox.delivered','outbox.obsolete']);
function createManagement({ctx,cli=cmd=>runCLI(ctx,cmd),rpc=(route,body)=>channel.request(channel.socketPath(ctx.CFG.stateDir),route,body,30000)}){
 const dir=path.join(ctx.CFG.stateDir,'management');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chmodSync(dir,0o700);
 const historyFile=path.join(dir,'operations.json'),cacheFile=path.join(dir,'snapshot.json');
 let operations=[],cached=null,busy=false,refreshPromise=null,lastRefresh=0,lastView=null,diagnosticLogs='',logsAt=0;
 if(fs.existsSync(historyFile)){operations=JSON.parse(fs.readFileSync(historyFile,'utf8'));if(!Array.isArray(operations))throw Error('操作记录损坏，拒绝启动管理后台');}
 for(const op of operations)if(op.status==='running'){op.status='unknown';op.message='管理后台上次退出时操作未完成确认，请核查实际状态，不会自动重放。';op.finishedAt=Date.now();}
 const persist=()=>atomic(historyFile,operations);persist();
 try{cached=JSON.parse(fs.readFileSync(cacheFile,'utf8'));}catch{}
 async function snapshot(force=false){
  if(refreshPromise)return refreshPromise;
  if(!force&&lastView&&Date.now()-lastRefresh<1000)return {...lastView,operations:[...operations].reverse()};
  refreshPromise=(async()=>{
   let runtime,live=null,error='';
   try{runtime=await cli('status');}catch(e){runtime={running:null,manager:'unknown'};error=e.message;}
   if(runtime.running!==false){try{live=await rpc('/state');cached=live;try{atomic(cacheFile,cached);}catch{error='在线数据已读取，但离线快照无法保存，请检查磁盘。';}}catch{error=error||'无法连接机器人控制接口。请检查服务日志、版本与 LCT_WEB_MODE=managed 配置。';}}
   if(Date.now()-logsAt>15000){logsAt=Date.now();try{const l=await cli('logs');diagnosticLogs=require('./supervisor.cjs').redact(String(l.text||''),{...ctx.fileEnv,...ctx.env});}catch{diagnosticLogs='无法读取服务日志';}}
   const data=live||cached||{jobs:[],queues:{},groups:[],outbox:[],counts:{},health:{},attention:[],attachments:[],events:[],logs:''};
   const view={...data,observedAt:Date.now(),online:!!live,stale:!live,runtime,error,serviceLogs:diagnosticLogs,managed:true,operations:[...operations].reverse()};
   view.controlRevision=channel.revision(data);view.serviceRevision=crypto.createHash('sha256').update(JSON.stringify([runtime.running,runtime.pid,view.controlRevision])).digest('hex').slice(0,24);
   lastView=view;lastRefresh=Date.now();return view;
  })();
  try{return await refreshPromise;}finally{refreshPromise=null;}
 }
 async function execute(b){
  const v=await snapshot(true);
  if(b.action.startsWith('service.')){
   if(b.expected!==v.serviceRevision)throw Error('服务状态已变化，请刷新后重新确认');
   if(v.runtime.running===null)throw Error('服务状态未知，请先查看主机服务管理器');
   if(b.action==='service.start'){
    if(v.runtime.running)throw Error('服务已在运行');await cli('up');
   }else{
    if(!v.online)throw Error('机器人控制接口离线，无法安全检查执行状态');
    await rpc('/action',{action:'service.prepare',expected:v.controlRevision});
    try{await cli('down');if(b.action==='service.restart')await cli('up');}
    catch(e){await rpc('/action',{action:'service.release'}).catch(()=>{});throw e;}
   }
   const want=b.action!=='service.stop';
   for(let i=0;i<30;i++){
    const after=await snapshot(true);
    if(want?after.runtime.running&&after.online:after.runtime.running===false)return {message:want?'机器人已启动，控制接口已连通。':'机器人已停止。管理后台保持运行，可随时启动。'};
    await new Promise(r=>setTimeout(r,500));
   }
   throw Error('已执行服务命令，但未在期限内确认目标状态；请查看诊断，不要重复操作');
  }
  if(!v.online)throw Error('机器人离线；历史快照仅供查看，无法执行操作');
  return rpc('/action',b);
 }
 async function submit(b){
  if(!b||!ACTIONS.has(b.action)||!/^[-\w]{12,80}$/.test(b.requestId||'')||typeof b.expected!=='string'||b.confirmed!==true)throw Object.assign(Error('请求无效或尚未确认影响'),{status:400});
  if(!b.action.startsWith('service.')&&(typeof b.target!=='string'||!/^[-\w]{1,100}$/.test(b.target)))throw Object.assign(Error('目标 ID 无效'),{status:400});
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify([b.action,b.target,b.seq,b.expected])).digest('hex');
  const prev=operations.find(o=>o.id===b.requestId);if(prev){if(prev.fingerprint!==fingerprint)throw Object.assign(Error('请求 ID 已用于不同操作'),{status:409});return prev;}
  if(busy)throw Object.assign(Error('另一项操作正在执行，请等待结果'),{status:409});
  const op={id:b.requestId,action:b.action,target:b.target||'',fingerprint,status:'running',createdAt:Date.now(),message:'正在核查并执行'};
  operations.push(op);try{persist();}catch(e){operations.pop();throw e;}busy=true;
  // Keep accepted records across restart. Never retry an ambiguous external side effect automatically.
  Promise.resolve().then(()=>execute(b)).then(r=>{op.status='succeeded';op.message=r.message;},e=>{op.status=/超时|期限|结果需核查/.test(e.message)?'unknown':'failed';op.message=require('./supervisor.cjs').redact(e.message,{...ctx.fileEnv,...ctx.env});}).finally(()=>{
   op.finishedAt=Date.now();try{persist();}catch{op.status='unknown';op.message='结果记录无法落盘，请检查磁盘并核查实际状态。';}busy=false;lastRefresh=0;
  });
  return op;
 }
 return {snapshot,submit};
}
module.exports={createManagement,ACTIONS,runCLI};

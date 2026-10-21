'use strict';
const crypto=require('node:crypto'),path=require('node:path');
const {workspaceSocketPath,request}=require('./control-channel.cjs');
function createAccess({enabled,stateDir,getJob,getChain,getBinding,execute,toolPath=__filename}){
 const leases=new Map();
 function envFor(jobId,chat){
  if(!enabled())return {};
  for(const key of leases.keys())if(getJob(key)?.status!=='running')leases.delete(key);
  const token='lctw_'+crypto.randomBytes(32).toString('hex');leases.set(jobId,{token,chat});
  return {LCT_WORKSPACE_TOKEN:token,LCT_WORKSPACE_SOCKET:workspaceSocketPath(stateDir),LCT_WORKSPACE_TOOL:toolPath};
 }
 async function act(b){
  if(!enabled()||!b||!['workspace.probe','workspace.create','workspace.sync'].includes(b.action))throw Error('不支持的工作台动作');
  const lease=leases.get(b.jobId),job=getJob(b.jobId),token=String(b.token||'');
  if(!lease||!job||job.status!=='running'||token.length!==lease.token.length||!crypto.timingSafeEqual(Buffer.from(token),Buffer.from(lease.token)))throw Error('工作台执行凭证无效或本轮已结束');
  const bound=getBinding(lease.chat);
  if(job.chat!==lease.chat||!bound||bound.status!=='active'||bound.chain!==getChain(job))throw Error('工作台会话绑定已变化');
  // Worker cannot select a session, chat, document ID, or administrative action.
  if(Object.keys(b).some(k=>!['jobId','token','action','requestId','summary'].includes(k)))throw Error('工作台请求含越权字段');
  if(b.summary!==undefined&&(typeof b.summary!=='string'||b.summary.length>3000))throw Error('工作台摘要无效');
  return execute({action:b.action,target:job.id,requestId:b.requestId,summary:b.summary},job);
 }
 return {envFor,act};
}
async function main(env=process.env){
 const fs=require('node:fs');const payload=JSON.parse(fs.readFileSync(0,'utf8'));
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(k=>!['action','requestId','summary'].includes(k)))throw Error('stdin 只接受 action、requestId、summary');
 const requestId=payload.requestId||crypto.randomUUID();
 if(!env.LCT_WORKSPACE_TOKEN||!env.LCT_WORKSPACE_SOCKET||!env.LCT_JOB_ID)throw Error('当前执行未启用工作台动作');
 let receipt;
 try{receipt=await request(env.LCT_WORKSPACE_SOCKET,'/workspace',{...payload,requestId,jobId:env.LCT_JOB_ID,token:env.LCT_WORKSPACE_TOKEN},180000);}
 catch{receipt={requestId,status:'unknown',message:'未取得最终回执，请按请求 ID 核查工作台记录；不要自动重放。'};}
 process.stdout.write(JSON.stringify(receipt)+'\n');if(receipt.status!=='succeeded')process.exitCode=2;
}
if(require.main===module)main().catch(()=>{console.error('工作台请求无效或执行环境未就绪；未确认完成。');process.exitCode=2;});
module.exports={createAccess};

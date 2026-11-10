'use strict';
const path=require('node:path');

function nodeInfo(node){
 if(!node||typeof node.id!=='string'||!node.id)throw Error('执行节点缺少稳定 ID');
 const role=node.role||(node.platform==='darwin'?'local':'server');
 if(!['local','server'].includes(role))throw Error('执行节点角色必须是 local 或 server');
 return {id:node.id,role,label:node.label||node.id,platform:node.platform||null};
}

function normalizeAttachment({group,job,chain,node,at=Date.now()}){
 if(!group||!job)throw Error('群绑定与任务记录必须同时存在');
 const current=nodeInfo(node),previous=group.attachment||{};
 const state=group.status==='active'?'attached':group.status;
 const attachment={
  schemaVersion:1,
  state,
  chainId:chain,
  threadId:job.threadId||group.thread||null,
  threadNode:previous.threadNode||current,
  ownerNode:state==='attached'?current:null,
  generation:Number.isSafeInteger(previous.generation)&&previous.generation>0?previous.generation:1,
  updatedAt:previous.updatedAt||at,
  resume:state==='parked'?previous.resume||null:null,
 };
 return {...group,thread:attachment.threadId,chain,attachment};
}

function parkAttachment({group,job,chain,node,at=Date.now()}){
 if(group.status==='parked'&&group.attachment?.resume)return {group,resume:group.attachment.resume};
 if(!group||group.status!=='active'||group.anchor!==job.id)throw Error('只有当前 active 群绑定可以释放');
 if(!job.threadId)throw Error('任务没有可恢复的 Codex thread');
 const normalized=normalizeAttachment({group,job,chain,node,at}),base=normalized.attachment;
 const resume={
  schemaVersion:1,
  kind:'codex-resume',
  chainId:chain,
  jobId:job.id,
  threadId:job.threadId,
  threadNode:base.threadNode,
  sourceCwd:job.cwd||job.worktree||null,
  generation:base.generation+1,
  releasedAt:at,
 };
 const attachment={...base,state:'parked',ownerNode:null,generation:resume.generation,updatedAt:at,resume};
 return {group:{...normalized,status:'parked',attachment},resume};
}

function resumeInstruction(resume,currentNode){
 if(!resume||resume.schemaVersion!==1||resume.kind!=='codex-resume'||!resume.threadId)throw Error('Resume 包无效');
 const source=nodeInfo(resume.threadNode),current=nodeInfo(currentNode);
 if(source.id!==current.id)return {
  strategy:'remote-result-handoff',command:null,reason:'thread-node-mismatch',sourceNode:source,currentNode:current,
  required:['fetch-result','restore-local-context'],
 };
 if(!resume.sourceCwd||!path.isAbsolute(resume.sourceCwd))return {
  strategy:'manual-resume-review',command:null,reason:'source-cwd-missing',sourceNode:source,currentNode:current,required:['verify-cwd'],
 };
 return {
  strategy:'same-node-thread',sourceNode:source,currentNode:current,
  command:{cwd:resume.sourceCwd,args:['codex','resume',resume.threadId]},
 };
}

function assertThreadAvailable(groups,threadId){
 if(!threadId)return;
 for(const [chat,group] of Object.entries(groups||{})){
  if(group.status==='active'&&(group.thread===threadId||group.attachment?.threadId===threadId))
   throw Error('该 Codex thread 已附着到任务群 '+chat+'；请先 /release 原群，不能创建第二个执行入口');
 }
}

module.exports={nodeInfo,normalizeAttachment,parkAttachment,resumeInstruction,assertThreadAvailable};

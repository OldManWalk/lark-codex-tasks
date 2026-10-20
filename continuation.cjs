'use strict';
const fs=require('node:fs'),path=require('node:path');
// Thread identifiers only have meaning within the originating runtime's stored sessions.
function localCwd(thread,{expectedCwd}={}){
 const cwd=thread?.cwd||thread?.environments?.[0]?.cwd;
 if(typeof cwd!=='string'||!path.isAbsolute(cwd)||/^[A-Za-z]:[\\/]/.test(cwd))throw Error('原会话没有本机可用的绝对工作目录，不能原地续接');
 const status=typeof thread.status==='string'?thread.status:thread.status?.type;
 if(['active','running','inProgress'].includes(status))throw Error('原会话仍在执行，请先在原窗口停止当前任务');
 let real;try{real=fs.realpathSync(cwd);if(!fs.statSync(real).isDirectory())throw Error();}catch{throw Error('原会话工作目录不存在，未改用其他项目目录');}
 if(expectedCwd&&real!==fs.realpathSync(expectedCwd))throw Error('原会话目录与交接声明不同');return real;
}
function validatePlan(p,{nodeId,projectDir}){
 if(!p||p.version!==1||!['local','remote'].includes(p.mode))throw Error('交接版本或模式无效');
 if(typeof p.id!=='string'||!/^[-\w]{12,80}$/.test(p.id)||!p.source?.nodeId||!p.target?.nodeId||p.target.nodeId!==nodeId)throw Error('交接目标实例不匹配');
 if(p.sourceReleased!==true)throw Error('源端尚未交出执行权，请先停止源端任务');
 if(typeof p.task!=='string'||!p.task.trim()||p.task.length>16000)throw Error('交接需要明确的后续任务');
 if(p.mode==='local'){
  if(p.source.nodeId!==nodeId||!p.source.threadId||!p.source.cwd)throw Error('同机续接必须来自同一实例并包含原会话和目录');
  return {kind:'resume',thread:p.source.threadId,cwd:p.source.cwd,task:p.task};
 }
 if(p.source.nodeId===nodeId)throw Error('跨机交接应选择不同目标实例');
 if(!p.input?.commit||!/^[a-f0-9]{40,64}$/.test(p.input.commit)||typeof p.summary!=='string'||!p.summary.trim())throw Error('跨机交接需要固定输入提交和交接摘要');
 if(!Array.isArray(p.requiredCapabilities)||!p.requiredCapabilities.every(x=>typeof x==='string'))throw Error('请列出目标所需能力');
 if(!projectDir||!fs.existsSync(projectDir))throw Error('目标项目目录不存在');
 return {kind:'new-thread',sourceThreadReference:p.source.threadId||null,baseCommit:p.input.commit,cwd:projectDir,task:p.task,summary:p.summary,requiredCapabilities:p.requiredCapabilities};
}
module.exports={localCwd,validatePlan};

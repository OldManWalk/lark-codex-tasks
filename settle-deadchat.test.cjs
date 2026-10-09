// 结算容错回归测试（v0.2.1）：群已解散（232009/230002）时 /done 应照常清账；
// 真实异常仍失败并保留绑定可重试；通知/解散双失败但群已死时仍完成清账。全部使用合成 fake。
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {execFileSync}=require('node:child_process');
const {EventEmitter}=require('node:events');
const sup=require('./supervisor.cjs');

function bridge(t,{deleteCode,sendCode}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lct-s-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const state=path.join(root,'.local/state/lark-codex-tasks');fs.mkdirSync(state,{recursive:true});
 fs.mkdirSync(path.join(root,'.config/lark-codex-tasks'),{recursive:true});
 fs.mkdirSync(path.join(root,'workspace/a'),{recursive:true});
 const kb=path.join(root,'workspace/knowledge/content');fs.mkdirSync(kb,{recursive:true});
 execFileSync('git',['init','-q',kb]); // 归档目录需要是 git 仓库
 sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{a:path.join(root,'workspace/a')});
 const proc=new EventEmitter();proc.env={LARK_OWNER_OPEN_ID:'owner'};
 const calls=[],logs=[],errs=[];
 const context=vm.createContext({
  require:n=>n==='node:os'?{...os,homedir:()=>root}:require(n),
  __dirname,module:{},process:proc,console:{log(...a){logs.push(a.map(String).join(' '));},error(...a){errs.push(a.map(String).join(' '));}},
  setTimeout,clearTimeout,setInterval,clearInterval,calls});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'lark-bridge.cjs'),'utf8')+`
 const DEL_CODE=${deleteCode||'null'},SEND_CODE=${sendCode||'null'};
 lark=async(args)=>{calls.push(args);
  if(args[0]==='api'&&args[1]==='DELETE'&&DEL_CODE){const e=new Error('lark-cli: dissolve failed');e.larkError={code:DEL_CODE,message:DEL_CODE===232009?'Your request specifies a chat which has already been dissolved.':'server busy, try later'};throw e;}
  if(args[0]==='im'&&args[1]==='+messages-send'&&SEND_CODE){const e=new Error('lark-cli: send failed');e.larkError={code:SEND_CODE,message:'Bot/User can NOT be out of the chat.'};throw e;}
  if(args[0]==='im'&&args[1]==='reactions')return {ok:true,data:{reaction_id:'rid_x'}};
  return {ok:true,data:{message_id:'om_fake',chat_id:'oc_new'}};};
 globalThis.api={settle,reopen,supervisor,pump,
  get groups(){return groups;},get queues(){return queues;}};
 `,context);
 return {a:context.api,calls,logs,errs,root,context};
}
function bindJob(a,chat,jobId){
 a.supervisor.jobs.set(jobId,{id:jobId,alias:'a',chat,threadId:'thread-T',status:'completed',cwd:'/tmp',mode:'auto',started:1,finished:2,lastMessage:'任务完成'});
 a.groups[chat]={anchor:jobId,alias:'a',status:'active'};
 return a.supervisor.jobs.get(jobId);
}

// ── S1：解散返回 232009（群已解散）→ 照常清账：绑定移除、settledAt 落盘、归档生成 ──
test('S1: dissolve 232009 (already dissolved) settles cleanly',async t=>{
 const {a,root}=bridge(t,{deleteCode:232009});
 const job=bindJob(a,'oc_gS','aaaa11110000');
 const r=await a.settle(job);
 assert(/已结算/.test(r),r);
 assert.equal(a.groups['oc_gS'],undefined,'失效绑定应移除');
 assert(job.settledAt>0,'settledAt 应落盘');
 const f=path.join(root,'workspace/knowledge/content/任务归档/aaaa11-a.md');
 assert(fs.existsSync(f),'归档文件应生成');
});

// ── S2：真实异常（非群已死）→ 结算失败、绑定保留、可重试 ──
test('S2: genuine dissolve failure keeps binding for retry',async t=>{
 const {a}=bridge(t,{deleteCode:999999});
 const job=bindJob(a,'oc_gS','aaaa11110000');
 await assert.rejects(a.settle(job),/群解散失败.*server busy/,'错误消息应含真实原因而非被截断的命令行');
 assert(a.groups['oc_gS'],'绑定应保留');
 assert(!job.settledAt,'settledAt 不应落盘');
});

// ── S3：通知 230002 + 解散 232009（群早已死透）→ 仍完成清账 ──
test('S3: send 230002 + dissolve 232009 (group long gone) still settles',async t=>{
 const {a}=bridge(t,{deleteCode:232009,sendCode:230002});
 const job=bindJob(a,'oc_gS','aaaa11110000');
 const r=await a.settle(job);
 assert(/已结算/.test(r),r);
 assert.equal(a.groups['oc_gS'],undefined,'失效绑定应移除');
 assert(job.settledAt>0,'settledAt 应落盘');
});

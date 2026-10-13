// 结果投递链路验收（2026-10-13 真实故障复盘）：
// R1 长报告先发文件（PDF/MD）再发摘要卡，卡片标注完整报告去向
// R2 卡片被内容类错误（230099 表格超限等）拒绝时降级富文本，结论必达
// R3 全部格式失败时保持待通知并记录真实原因，不静默卡死
// 全部使用合成 fake Lark 与临时目录，不触真实聊天、凭证或生产状态。
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const sup=require('./supervisor.cjs');

function bridge(t,{env}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lct-rd-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const state=path.join(root,'.local/state/lark-codex-tasks');fs.mkdirSync(state,{recursive:true});
 fs.mkdirSync(path.join(root,'.config/lark-codex-tasks'),{recursive:true});
 fs.mkdirSync(path.join(root,'workspace/scratch'),{recursive:true});
 sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{scratch:path.join(root,'workspace/scratch')});
 const proc=new EventEmitter();proc.env={LARK_OWNER_OPEN_ID:'owner',LCT_REPORT_PDF:'0',...(env||{})};
 const calls=[],logs=[],errs=[];
 const context=vm.createContext({
  __dirname,
  require:n=>n==='node:os'?{...os,homedir:()=>root}:require(n),
  module:{},process:proc,console:{log(...a){logs.push(a.map(String).join(' '));},error(...a){errs.push(a.map(String).join(' '));}},
  setTimeout,clearTimeout,setInterval,clearInterval,calls});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'lark-bridge.cjs'),'utf8')+`
 lark=async(args)=>{calls.push(args);return {ok:true,data:{message_id:'om_fake',chat_id:'oc_new'}};};
 globalThis.api={supervisor,patch(code){return eval(code);}};
 `,context);
 return {a:context.api,calls,logs,errs,root};
}
function pendingJob(a,id,lastMessage){
 const job={id,alias:'scratch',chat:'oc_rep',status:'completed',mode:'auto',started:Date.now(),finished:Date.now(),notifyPending:true,lastMessage};
 a.supervisor.jobs.set(id,job);
 return job;
}
const cardCall=calls=>calls.find(c=>c.includes('interactive'));
const cardJson=calls=>JSON.parse(cardCall(calls)[cardCall(calls).indexOf('--content')+1]);

test('R1: long report is delivered as a file followed by an excerpt card',async t=>{
 const {a,calls,root}=bridge(t);
 const full='## 调研结论\n\n'+'正文。'.repeat(1200);
 const job=pendingJob(a,'rr1111111111',full);
 await a.supervisor.flush();
 assert.equal(job.notifyPending,false,'投递成功后清除待通知标记');
 const file=calls.find(c=>c.includes('--file'));
 assert(file,'长报告应先发送文件消息');
 assert.match(file[file.indexOf('--file')+1],/任务报告-scratch-rr1111111111\.md$/);
 const saved=fs.readdirSync(path.join(root,'workspace/persist/lark-codex-tasks/reports'));
 assert(saved.some(f=>f.endsWith('.md')),'报告文件真实落盘在 reports 目录');
 const body=cardJson(calls).body.elements[1].content;
 assert.match(body,/完整报告共 \d+ 字，已作为文件发送/,'卡片标注完整报告去向');
 assert(body.length<full.length,'卡片只展示开头摘要');
});

test('R1b: short report skips file delivery and stays a full card',async t=>{
 const {a,calls}=bridge(t);
 const job=pendingJob(a,'rr2222222222','## 短结论\n\n就这些。');
 await a.supervisor.flush();
 assert.equal(job.notifyPending,false);
 assert(!calls.some(c=>c.includes('--file')),'短报告不发文件');
 assert.match(cardJson(calls).body.elements[1].content,/就这些。/);
});

test('R2: card rejected by content error (230099 table limit) falls back to markdown',async t=>{
 const {a,calls}=bridge(t);
 const job=pendingJob(a,'rr3333333333','| 列A | 列B |\n| --- | --- |\n| 1 | 2 |');
 a.patch(`lark=async(args)=>{calls.push(args);
  if(args.includes('interactive')){const e=new Error('lark-cli: Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit');e.larkError={message:'Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit'};throw e;}
  return {ok:true,data:{message_id:'om_fake'}};};`);
 await a.supervisor.flush();
 assert.equal(job.notifyPending,false,'富文本兜底成功后清除待通知');
 assert(calls.some(c=>c.includes('--markdown')),'降级为富文本发送');
});

test('R2b: card and markdown both rejected falls back to plain text with a distinct key',async t=>{
 const {a,calls}=bridge(t);
 const job=pendingJob(a,'rr5555555555','结论');
 a.patch(`lark=async(args)=>{calls.push(args);
  if(args.includes('interactive')||args.includes('--markdown')){const e=new Error('lark-cli: rejected');e.larkError={message:'rejected by server'};throw e;}
  return {ok:true,data:{message_id:'om_fake'}};};`);
 await a.supervisor.flush();
 assert.equal(job.notifyPending,false,'纯文本兜底成功后清除待通知');
 const plain=calls.find(c=>c.includes('--text'));
 assert(plain,'最终降级为纯文本');
 const key=plain[plain.indexOf('--idempotency-key')+1];
 assert.match(key,/-plain$/,'纯文本使用独立幂等键');
});

test('R3: transport failure never falls back; job stays pending with the real reason logged',async t=>{
 const {a,errs}=bridge(t);
 const job=pendingJob(a,'rr4444444444','结论');
 a.patch(`lark=async(args)=>{calls.push(args);const e=new Error('lark-cli: network unreachable');throw e;};`);
 // supervisor.cjs 运行在宿主域，其 console 不经 vm 沙盒；需 stub 宿主 console.error 捕获 flush 日志
 const hostErrs=[],orig=console.error;console.error=(...x)=>hostErrs.push(x.map(String).join(' '));
 t.after(()=>{console.error=orig;});
 await a.supervisor.flush();
 assert.equal(job.notifyPending,true,'投递失败保持待通知，下轮重试');
 assert(!errs.some(x=>x.includes('fallback')),'传输层未知不降级补发');
 assert(hostErrs.some(x=>x.includes('notification pending for rr4444444444')&&x.includes('network unreachable')),'flush 日志含真实失败原因');
});

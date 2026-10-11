// 图片/文件消息验收（v0.3.0）：附件下载到 scratch/inbox 并把本地路径交给 worker；
// 下载失败明确告知重发、不入队；重复投递幂等。全部使用合成 fake，不触真实聊天。
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const sup=require('./supervisor.cjs');
const {CodexClient}=require('./codex-client.cjs');

const until=async(fn,ms=4000)=>{const t0=Date.now();while(Date.now()-t0<ms){if(fn())return true;await new Promise(r=>setTimeout(r,10));}return false;};

function bridge(t,{failDownload}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lct-m-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const state=path.join(root,'.local/state/lark-codex-tasks');fs.mkdirSync(state,{recursive:true});
 fs.mkdirSync(path.join(root,'.config/lark-codex-tasks'),{recursive:true});
 fs.mkdirSync(path.join(root,'workspace/a'),{recursive:true});
 fs.mkdirSync(path.join(root,'workspace/scratch'),{recursive:true});
 sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{a:path.join(root,'workspace/a')});
 const proc=new EventEmitter();proc.env={LARK_OWNER_OPEN_ID:'owner'};
 const calls=[],logs=[],errs=[];
 const context=vm.createContext({
  require:n=>n==='node:os'?{...os,homedir:()=>root}:require(n),
  __dirname,module:{},process:proc,console:{log(...a){logs.push(a.map(String).join(' '));},error(...a){errs.push(a.map(String).join(' '));}},
  setTimeout,clearTimeout,setInterval,clearInterval,calls});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'lark-bridge.cjs'),'utf8')+`
 const FAIL_DL=${failDownload?'true':'false'};
 lark=async(args,t,o)=>{calls.push(args);
  if(args[1]==='+messages-resources-download'){
   if(FAIL_DL)throw new Error('lark-cli: 404 resource not found');
   const out=args[args.indexOf('--output')+1];
   require('node:fs').writeFileSync(require('node:path').join(o.cwd,out),'fake-media-bytes');
   return {ok:true,data:{saved_path:out}};
  }
  if(args[0]==='im'&&args[1]==='reactions')return {ok:true,data:{reaction_id:'rid_x'}};
  return {ok:true,data:{message_id:'om_fake',chat_id:'oc_new'}};};
 globalThis.api={handle,respond,supervisor,pump,enqueueItem,groupContext,
  get groups(){return groups;},get queues(){return queues;},get dmChats(){return dmChats;},
  enqueue(fn){queue=queue.then(fn);return queue;}};
 `,context);
 return {a:context.api,calls,logs,errs,root,context};
}
function mockCodex(t){
 const runs=[];const oS=CodexClient.prototype.start,oR=CodexClient.prototype.run;
 t.after(()=>{CodexClient.prototype.start=oS;CodexClient.prototype.run=oR;});
 CodexClient.prototype.start=async function(){this.threadId=this.resumeThreadId||'thread-m';return this.threadId;};
 CodexClient.prototype.run=function(task){runs.push({task,resume:this.resumeThreadId||null});return Promise.resolve({message:'ok'});};
 return {runs};
}
const evt=(chat_type,chat_id,message_type,content,id)=>({type:'im.message.receive_v1',chat_type,chat_id,content:JSON.stringify(content),message_id:id||('om_'+Math.random().toString(36).slice(2)),sender_id:'owner',sender_type:'user',message_type});
function bindGroup(a,chat,jobId){
 a.supervisor.jobs.set(jobId,{id:jobId,alias:'a',chat,threadId:'thread-T',status:'completed',cwd:'/tmp',mode:'auto',started:1});
 a.groups[chat]={anchor:jobId,alias:'a',status:'active',title:'🔵 a ·aaaa11'};
}

// ── M1：群内图片消息 → 下载到 inbox → 任务正文携带本地路径 → worker 收到路径 ──
test('M1: group image is downloaded to inbox and its path reaches the worker',async t=>{
 const {a,calls,root}=bridge(t);const {runs}=mockCodex(t);
 bindGroup(a,'oc_gM','aaaa11110000');
 await a.enqueue(()=>a.handle(JSON.stringify(evt('group','oc_gM','image',{image_key:'img_v3_test1'},'om_IMG1'))));
 assert(await until(()=>runs.length===1),'附件应触发任务执行');
 const item=a.queues['oc_gM'].items[0];
 const m=item.text.match(/已保存到: (\S+)/);
 assert(m,'任务正文应携带保存路径');
 assert(m[1].includes(path.join('scratch','inbox')),'路径应在 scratch/inbox');
 assert(fs.existsSync(m[1])&&fs.readFileSync(m[1],'utf8')==='fake-media-bytes','文件真实落盘');
 assert(runs[0].task.includes(m[1]),'worker 收到的任务含图片路径');
});

// ── M2：私聊文件消息 → DM 队列正文携带路径（DM 沙箱可读取 scratch）──
test('M2: p2p file message queues dm item with local path',async t=>{
 const {a}=bridge(t);mockCodex(t);
 await a.enqueue(()=>a.handle(JSON.stringify(evt('p2p','oc_dm','file',{file_key:'file_v3_doc',file_name:'报告 终版.pdf'},'om_FILE1'))));
 assert(await until(()=>{const q=a.queues['oc_dm'];return q&&q.items.length===1;}),'DM 队列应受理附件');
 const item=a.queues['oc_dm'].items[0];
 assert(item.text.includes('报告_终版.pdf'),'文件名保留可读形式: '+item.text);
 assert(item.text.includes('已保存到'),'正文携带路径');
});

// ── M3：下载失败 → 明确告知重发，不入队、不静默 ──
test('M3: download failure replies with explicit error and never enqueues',async t=>{
 const {a,calls}=bridge(t,{failDownload:true});
 bindGroup(a,'oc_gM','aaaa11110000');
 await a.enqueue(()=>a.handle(JSON.stringify(evt('group','oc_gM','image',{image_key:'img_v3_gone'},'om_IMG3'))));
 assert(await until(()=>calls.some(c=>c.some(x=>typeof x==='string'&&/附件接收失败/.test(x)))),'失败应明确告知');
 assert(!a.queues['oc_gM']||a.queues['oc_gM'].items.length===0,'失败附件不得入队');
});

// ── M4：相同 message_id 图片重投 → 只受理一次 ──
test('M4: duplicate image delivery is idempotent',async t=>{
 const {a}=bridge(t);const {runs}=mockCodex(t);
 bindGroup(a,'oc_gM','aaaa11110000');
 const line=JSON.stringify(evt('group','oc_gM','image',{image_key:'img_v3_dup'},'om_DUPIMG'));
 await a.enqueue(()=>a.handle(line));await a.enqueue(()=>a.handle(line));
 assert(await until(()=>runs.length===1),'只执行一次');
 assert.equal(a.queues['oc_gM'].items.length,1,'只入队一次');
});

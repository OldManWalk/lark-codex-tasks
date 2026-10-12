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
 let FAIL_DL=${failDownload?'true':'false'};
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
  get groups(){return groups;},get queues(){return queues;},get dmChats(){return dmChats;},get seen(){return seen;},get attachments(){return attachments;},setDownloadFailure(value){FAIL_DL=value;},patch:code=>eval(code),
  enqueue(fn){queue=queue.then(fn);return queue;}};
 `,context);
 return {a:context.api,calls,logs,errs,root,context};
}
function mockCodex(t){
 const runs=[];const oS=CodexClient.prototype.start,oR=CodexClient.prototype.run;
 t.after(()=>{CodexClient.prototype.start=oS;CodexClient.prototype.run=oR;});
 CodexClient.prototype.start=async function(){this.threadId=this.resumeThreadId||'thread-m';return this.threadId;};
 CodexClient.prototype.run=function(task,options={}){runs.push({task,images:options.images||[],resume:this.resumeThreadId||null});return Promise.resolve({message:'ok'});};
 return {runs};
}
const evt=(chat_type,chat_id,message_type,content,id)=>({type:'im.message.receive_v1',chat_type,chat_id,content:JSON.stringify(content),message_id:id||('om_'+Math.random().toString(36).slice(2)),sender_id:'owner',sender_type:'user',message_type});
function bindGroup(a,chat,jobId){
 a.supervisor.jobs.set(jobId,{id:jobId,alias:'a',chat,threadId:'thread-T',status:'completed',cwd:'/tmp',mode:'auto',started:1});
 a.groups[chat]={anchor:jobId,alias:'a',status:'active',title:'🔵 a ·aaaa11'};
}

// ── M1：群内图片消息 → 下载到 inbox → 任务正文携带本地路径 → worker 收到路径 ──
test('M1: group image is downloaded to cache and its path reaches the worker',async t=>{
 const {a,calls,root}=bridge(t);const {runs}=mockCodex(t);
 bindGroup(a,'oc_gM','aaaa11110000');
 await a.enqueue(()=>a.handle(JSON.stringify(evt('group','oc_gM','image',{image_key:'img_v3_test1'},'om_IMG1'))));
 assert(await until(()=>runs.length===1),'附件应触发任务执行');
 const item=a.queues['oc_gM'].items[0];
 const m=item.text.match(/已保存到: (\S+)/);
 assert(m,'任务正文应携带保存路径');
 assert(m[1].includes(path.join('.cache','lark-codex-tasks','attachments')),'路径应在受管 cache/attachments');
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
test('M3: download failure is recorded without model submission and permits redelivery',async t=>{
 const {a,calls}=bridge(t,{failDownload:true});const {runs}=mockCodex(t);
 bindGroup(a,'oc_gM','aaaa11110000');
 await a.enqueue(()=>a.handle(JSON.stringify(evt('group','oc_gM','image',{image_key:'img_v3_gone'},'om_IMG3'))));
 assert(await until(()=>calls.some(c=>c.some(x=>typeof x==='string'&&/附件接收失败/.test(x)))),'失败应明确告知');
 assert(await until(()=>a.queues['oc_gM'].items[0].status==='failed'));assert.equal(runs.length,0,'失败附件不得提交模型');assert(!a.seen.has('om_IMG3'),'下载失败可重投');
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


test('M5: failed attachment redelivery succeeds once download recovers',async t=>{
 const {a}=bridge(t,{failDownload:true}),{runs}=mockCodex(t);bindGroup(a,'oc_gM','aaaa11110000');
 const line=JSON.stringify(evt('group','oc_gM','image',{image_key:'img_recover'},'om_RECOVER'));
 await a.enqueue(()=>a.handle(line));assert(await until(()=>a.queues.oc_gM.items[0].status==='failed'));assert(!a.seen.has('om_RECOVER'));
 a.setDownloadFailure(false);await a.enqueue(()=>a.handle(line));assert(await until(()=>runs.length===1));assert(a.seen.has('om_RECOVER'));assert.equal(runs[0].images.length,1);
});

test('M6: mixed post preserves title and text while downloading every embedded image',async t=>{
 const {a}=bridge(t),{runs}=mockCodex(t);bindGroup(a,'oc_post','aaaa11110000');
 await a.enqueue(()=>a.handle(JSON.stringify(evt('group','oc_post','post',{zh_cn:{title:'检查截图',content:[[{tag:'text',text:'比较这两张图'},{tag:'img',image_key:'img_one'},{tag:'img',image_key:'img_two'}]]}},'om_POST'))));
 assert(await until(()=>runs.length===1));assert(runs[0].task.includes('检查截图'));assert(runs[0].task.includes('比较这两张图'));assert.equal(runs[0].images.length,2);assert.notEqual(runs[0].images[0],runs[0].images[1]);assert(runs[0].images.every(p=>fs.existsSync(p)));
});

test('M7: image-only post enters the normal queue with a native image',async t=>{
 const {a}=bridge(t),{runs}=mockCodex(t);bindGroup(a,'oc_post','aaaa11110000');
 await a.enqueue(()=>a.handle(JSON.stringify(evt('group','oc_post','post',{content:[[{tag:'img',image_key:'img_only'}]]},'om_ONLY'))));
 assert(await until(()=>runs.length===1));assert.equal(runs[0].images.length,1);
});

test('M8: slow download does not block control messages or another group; same group stays FIFO',async t=>{
 const {a,context}=bridge(t),{runs}=mockCodex(t);bindGroup(a,'oc_slow','aaaa11110000');bindGroup(a,'oc_other','bbbb22220000');
 let release;context.downloadGate=new Promise(r=>release=r);t.after(()=>release());
 a.patch('globalThis.originalLark=lark;lark=async(...args)=>{if(args[0][1]==="+messages-resources-download")await globalThis.downloadGate;return globalThis.originalLark(...args);};');
 await a.enqueue(()=>a.handle(JSON.stringify(evt('group','oc_slow','image',{image_key:'img_slow'},'om_SLOW'))));
 const stored=JSON.parse(fs.readFileSync(path.join(context.api.supervisor.state,'..','store.json')));assert.equal(stored.queues.oc_slow.items[0].media[0].key,'img_slow','下载完成前已持久受理');
 await a.enqueue(()=>a.handle(JSON.stringify(evt('group','oc_slow','text',{text:'接着处理第二步'},'om_NEXT'))));
 const status=await a.respond(evt('group','oc_slow','text',{text:'/queue'},'om_Q'));assert(status.includes('1'),'控制指令立即返回');
 await a.enqueue(()=>a.handle(JSON.stringify(evt('group','oc_other','text',{text:'其他群的工作'},'om_OTHER'))));assert(await until(()=>runs.length===1));assert(runs[0].task.includes('其他群'));
 release();assert(await until(()=>runs.length===3));assert(runs[1].images.length===1);assert(runs[2].task.includes('第二步'));
});

test('M9: cancellation during DM download prevents model submission and keeps cancellation dedup',async t=>{
 const {a,context}=bridge(t),{runs}=mockCodex(t);let release;context.downloadGate=new Promise(r=>release=r);t.after(()=>release());
 a.patch('globalThis.originalLark=lark;lark=async(...args)=>{if(args[0][1]==="+messages-resources-download")await globalThis.downloadGate;return globalThis.originalLark(...args);};');
 await a.enqueue(()=>a.handle(JSON.stringify(evt('p2p','oc_dm','image',{image_key:'img_slow'},'om_CANCELIMAGE'))));
 const result=await a.respond(evt('p2p','oc_dm','text',{text:'/cancel'},'om_CANCEL'));assert(result.includes('取消'));release();
 assert(await until(()=>a.queues.oc_dm.items[0].status==='failed'));assert.equal(runs.length,0);assert(a.seen.has('om_CANCELIMAGE'));assert(a.queues.oc_dm.paused);
});

test('M10: queue storage failure performs no download and leaves redelivery available',async t=>{
 const {a,calls}=bridge(t);bindGroup(a,'oc_gM','aaaa11110000');a.patch('persistStore=()=>{throw Error("ENOSPC");};');
 await a.enqueue(()=>a.handle(JSON.stringify(evt('group','oc_gM','image',{image_key:'img_no_save'},'om_NOSAVE'))));
 assert.equal(calls.filter(c=>c[1]==='+messages-resources-download').length,0);assert(!a.seen.has('om_NOSAVE'));
});

test('M11: attachment count limit rejects before download',async t=>{
 const {a,calls}=bridge(t);bindGroup(a,'oc_gM','aaaa11110000');a.patch('CFG.attachmentMaxCount=1;');
 await a.enqueue(()=>a.handle(JSON.stringify(evt('group','oc_gM','post',{content:[[{tag:'img',image_key:'img_a'},{tag:'img',image_key:'img_b'}]]},'om_LIMIT'))));
 assert.equal(calls.filter(c=>c[1]==='+messages-resources-download').length,0);assert(!a.queues.oc_gM);
});

test('M12: oversized file is removed, never submitted, and can be resent',async t=>{
 const {a}=bridge(t),{runs}=mockCodex(t);bindGroup(a,'oc_gM','aaaa11110000');a.patch('CFG.attachmentMaxBytes=1;');
 await a.enqueue(()=>a.handle(JSON.stringify(evt('group','oc_gM','file',{file_key:'file_large',file_name:'large.pdf'},'om_LARGE'))));
 assert(await until(()=>a.queues.oc_gM.items[0].status==='failed'));assert.equal(runs.length,0);assert(!a.seen.has('om_LARGE'));assert(!fs.existsSync(a.attachments['om_LARGE-0'].cachePath));
});

test('M13: custom cache symlink is rejected before CLI can write outside it',async t=>{
 const {a,calls,root}=bridge(t),{runs}=mockCodex(t);bindGroup(a,'oc_gM','aaaa11110000');
 const cache=path.join(root,'cache'),outside=path.join(root,'outside');fs.mkdirSync(cache);fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(cache,'attachments'));a.patch('CFG.cacheDir='+JSON.stringify(cache)+';');
 await a.enqueue(()=>a.handle(JSON.stringify(evt('group','oc_gM','image',{image_key:'img_link'},'om_LINK'))));assert(await until(()=>a.queues.oc_gM.items[0].status==='failed'));assert.equal(calls.filter(c=>c[1]==='+messages-resources-download').length,0);assert.equal(runs.length,0);assert.equal(fs.readdirSync(outside).length,0);
});


test('M14: binding removed during download cannot start a stale group task',async t=>{
 const {a,context}=bridge(t),{runs}=mockCodex(t);bindGroup(a,'oc_slow','aaaa11110000');let release;context.downloadGate=new Promise(r=>release=r);t.after(()=>release());
 a.patch('globalThis.originalLark=lark;lark=async(...args)=>{if(args[0][1]==="+messages-resources-download")await globalThis.downloadGate;return globalThis.originalLark(...args);};');
 await a.enqueue(()=>a.handle(JSON.stringify(evt('group','oc_slow','image',{image_key:'img_slow'},'om_LOSTBIND'))));delete a.groups.oc_slow;release();
 assert(await until(()=>a.queues.oc_slow.items[0].status==='failed'));assert.equal(runs.length,0);assert(a.queues.oc_slow.paused);assert.match(a.queues.oc_slow.items[0].error,/群绑定已变化/);
});

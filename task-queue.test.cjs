// 任务队列/受理回执回归测试（TASK_QUEUE_REVIEW.md / TASK_ACK_REVIEW.md 验收）
// 断言修复后的正确行为：持久 FIFO、ACK 数量精确、自动消费、幂等、崩溃恢复、控制面独立。
// 全部使用合成 fake Lark/模型，不触真实聊天、凭证或生产状态。
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
 const proc=new EventEmitter();proc.env={LARK_OWNER_OPEN_ID:'owner'};
 const calls=[],logs=[],errs=[];
 const context=vm.createContext({
  require:n=>n==='node:os'?{...os,homedir:()=>root}:require(n),
  __dirname,module:{},process:proc,console:{log(...a){logs.push(a.map(String).join(' '));},error(...a){errs.push(a.map(String).join(' '));}},
  setTimeout,clearTimeout,setInterval,clearInterval,calls});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'lark-bridge.cjs'),'utf8')+`
 lark=async(args)=>{calls.push(args);return {ok:true,data:{message_id:'om_fake',chat_id:'oc_new'}};};
 globalThis.api={handle,handleCardAction,askApproval,decide,settle,reopen,respond,groupContext,auditSessionIsolation,dmSession,dmThreadIds,supervisor,pendingByChat,pendingByToken,pump,enqueueItem,
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

// ── 验收1+2：barrier 挂住 A，B/C/D ACK 数量精确；放开后自动按序排空，每条恰好一次 ──
test('Q1: FIFO queue ACKs exact ahead-counts and auto-drains in order without user resend',async t=>{
 const gate=[];const {a}=bridge(t);
 const {runs}=mockCodex(t,function(){return new Promise(res=>gate.push(res));});
 bindGroup(a,'oc_gQ','aaaa11110000','thread-T');
 const rA=await a.respond(msg('group','oc_gQ','任务A','om_A'));
 assert(/收到，正在启动本群任务。/.test(rA),rA); // 空闲：启动中
 await until(()=>runs.length===1);
 const rB=await a.respond(msg('group','oc_gQ','任务B','om_B'));
 assert.equal(rB,'收到，已排队：前面 1 条正在执行。完成后自动处理。',rB);
 const rC=await a.respond(msg('group','oc_gQ','任务C','om_C'));
 assert.equal(rC,'收到，已排队：前面共 2 条（1 条执行中、1 条等待）。轮到后自动处理。',rC);
 const rD=await a.respond(msg('group','oc_gQ','任务D','om_D'));
 assert.equal(rD,'收到，已排队：前面共 3 条（1 条执行中、2 条等待）。轮到后自动处理。',rD);
 assert.equal(runs.length,1,'A 未结束时不得并发执行后续');
 assert(await until(()=>a.queues['oc_gQ'].items.filter(i=>i.status==='queued').length===3),'B/C/D 持久入队');
 gate.shift()({message:'A done'}); // A 完成 → 自动推进
 assert(await until(()=>runs.length===2),'B 自动开始，无需用户再发消息');
 gate.shift()({message:'B done'});
 assert(await until(()=>runs.length===3),'C 自动开始');
 gate.shift()({message:'C done'});
 assert(await until(()=>runs.length===4),'D 自动开始');
 gate.shift()({message:'D done'});
 assert.deepEqual(runs.map(r=>r.task),['任务A','任务B','任务C','任务D'],'严格 FIFO，每条恰好一次');
 assert(runs.every(r=>r.resume==='thread-T'),'全部续接本群 chain 线程');
 assert(await until(()=>a.queues['oc_gQ'].items.every(i=>i.status==='done')),'全部落定');
 assert.equal(a.supervisor.jobs.size,5,'anchor + 4 个接续 job');
});

// ── 验收3：相同 message_id 重投不新增、不重复执行、不重复回执 ──
test('Q2: duplicate message_id delivery is idempotent',async t=>{
 const {a,calls}=bridge(t);const {runs}=mockCodex(t);
 bindGroup(a,'oc_gQ','aaaa11110000','thread-T');
 const line=JSON.stringify(msg('group','oc_gQ','查下状态','om_DUP'));
 await a.enqueue(()=>a.handle(line));await a.enqueue(()=>a.handle(line));await a.enqueue(()=>a.handle(line));
 assert(await until(()=>runs.length===1),'只执行一次');
 assert.equal(a.queues['oc_gQ'].items.length,1,'只入队一次');
 assert(await until(()=>calls.some(c=>c.includes('oc_gQ')&&c.some(x=>typeof x==='string'&&/收到，正在启动/.test(x)))),'回执经 outbox 送达');
 const acks=calls.filter(c=>c.includes('oc_gQ')&&c.some(x=>typeof x==='string'&&/收到，正在启动/.test(x)));
 assert.equal(acks.length,1,'只回执一次');
});

// ── 验收4：重启后 waiting 保留；active 先对账（interrupted→failed+暂停），不盲目重放；/qresume 恢复 ──
test('Q3: restart reconciles active run, keeps waiting items, resumes only via /qresume',async t=>{
 const seed={
  'queue.json':{'oc_gQ':{seq:2,paused:false,pauseReason:null,items:[
   {seq:1,messageId:'om_A',text:'任务A',kind:'task',status:'active',enqueuedAt:1,startedAt:2,runJobId:'bbbb22221111',queuedAck:false},
   {seq:2,messageId:'om_B',text:'任务B',kind:'task',status:'queued',enqueuedAt:3,queuedAck:true}]}},
  'groups.json':{'oc_gQ':{anchor:'bbbb22221111',alias:'a',status:'active'}},
  'jobs/bbbb22221111/state.json':{id:'bbbb22221111',alias:'a',chat:'oc_gQ',threadId:'thread-R',status:'running',cwd:'/tmp',mode:'auto',started:1},
 };
 const {a,calls}=bridge(t,{seed});const {runs}=mockCodex(t);
 assert.equal(a.supervisor.jobs.get('bbbb22221111').status,'interrupted','Supervisor 重启即标 interrupted');
 await a.pump(); // 启动对账
 const q=a.queues['oc_gQ'];
 assert.equal(q.items[0].status,'failed','结果未知的 active 项不重放');
 assert.equal(q.paused,true,'队列持久阻断');
 assert.equal(q.items[1].status,'queued','等待项保留，不丢指令');
 assert.equal(runs.length,0,'未盲目执行');
 assert(await until(()=>calls.some(c=>c.includes('oc_gQ')&&c.some(x=>typeof x==='string'&&/队列已暂停/.test(x)))),'暂停通知送达');
 const r=await a.respond(msg('group','oc_gQ','/qresume','om_RS'));
 assert(/队列已恢复/.test(r),r);
 assert(await until(()=>runs.length===1&&runs[0].task==='任务B'),'恢复后自动执行 B');
});

// ── 验收5：群 A 忙时群 B（不同项目等价：此处同 alias 受互斥约束；换群不同 anchor）独立受理 ──
test('Q4: busy group A does not block independent group B; ACKs stay per-group',async t=>{
 const gate=[];const {a}=bridge(t);
 const {runs}=mockCodex(t,function(){return new Promise(res=>gate.push(res));});
 a.supervisor.jobs.set('aaaa11110000',{id:'aaaa11110000',alias:'a',chat:'oc_gA',threadId:'thread-A',status:'completed',cwd:'/tmp',mode:'auto',started:1});
 a.supervisor.jobs.set('bbbb22221111',{id:'bbbb22221111',alias:'bproj',chat:'oc_gB',threadId:'thread-B',status:'completed',cwd:'/tmp',mode:'auto',started:1});
 a.groups['oc_gA']={anchor:'aaaa11110000',alias:'a',status:'active'};
 a.groups['oc_gB']={anchor:'bbbb22221111',alias:'bproj',status:'active'};
 // continueJob 只校验 jobs/互斥，不查 projects 注册表，bproj 可直接续接
 const rA=await a.respond(msg('group','oc_gA','A 群任务','om_A1'));
 assert(/正在启动/.test(rA),rA);
 await until(()=>runs.length===1);
 const rB=await a.respond(msg('group','oc_gB','B 群任务','om_B1'));
 assert(/正在启动|等待执行名额/.test(rB),rB);
 assert(await until(()=>runs.length===2),'B 群独立执行，不被 A 群阻塞');
 assert.equal(runs[0].resume,'thread-A');assert.equal(runs[1].resume,'thread-B','线程各归各群');
 gate.forEach(res=>res({message:'ok'}));
});

// ── 验收8：/done 在队列未空时拒绝且不静默删队列；/qclear 后放行 ──
test('Q5: /done refuses while queue has pending items; never silently drops them',async t=>{
 const gate=[];const {a}=bridge(t);
 const {runs}=mockCodex(t,function(){return new Promise(res=>gate.push(res));});
 bindGroup(a,'oc_gQ','aaaa11110000','thread-T');
 await a.respond(msg('group','oc_gQ','任务A','om_A'));await until(()=>runs.length===1);
 gate.shift()({message:'A done'}); // A 完成
 await a.respond(msg('group','oc_gQ','/qpause','om_P'));
 await a.respond(msg('group','oc_gQ','任务B','om_B')); // 暂停中：queued 不执行
 await a.respond(msg('group','oc_gQ','任务C','om_C'));
 await assert.rejects(a.respond(msg('group','oc_gQ','/done','om_D')),/还有排队\/执行中的指令/,'队列保护应拒绝 /done（真实路径由 handle 转成 ❌ 提示）');
 assert.equal(a.queues['oc_gQ'].items.filter(i=>i.status==='queued').length,2,'排队项原样保留，未静默删除');
 const rc=await a.respond(msg('group','oc_gQ','/qclear','om_C'));
 assert(/已丢弃 2 条/.test(rc),rc);
 const rd=await a.respond(msg('group','oc_gQ','/done','om_D2'));
 assert(/结算中/.test(rd),rd); // 队列已空：放行（结算后台进行）
});

// ── 验收6：/queue /qpause /qresume /qdrop 控制面；控制指令不排在模型任务后 ──
test('Q6: queue control commands work while a run is in flight',async t=>{
 const gate=[];const {a}=bridge(t);
 const {runs}=mockCodex(t,function(){return new Promise(res=>gate.push(res));});
 bindGroup(a,'oc_gQ','aaaa11110000','thread-T');
 await a.respond(msg('group','oc_gQ','任务A','om_A'));await until(()=>runs.length===1);
 await a.respond(msg('group','oc_gQ','任务B','om_B'));
 await a.respond(msg('group','oc_gQ','任务C','om_C'));
 const rq=await a.respond(msg('group','oc_gQ','/queue','om_Q'));
 assert(/#2 等待中/.test(rq)&&/#3 等待中/.test(rq),rq);
 const rd=await a.respond(msg('group','oc_gQ','/qdrop 3','om_QD'));
 assert(/已丢弃排队指令 #3/.test(rd),rd);
 const rp=await a.respond(msg('group','oc_gQ','/qpause','om_QP'));
 assert(/队列已暂停/.test(rp),rp);
 gate.shift()({message:'A done'});await sleep(30);
 assert.equal(runs.length,1,'暂停时不自动推进');
 const rr=await a.respond(msg('group','oc_gQ','/qresume','om_QR'));
 assert(/队列已恢复/.test(rr),rr);
 assert(await until(()=>runs.length===2),'恢复后 B 自动执行');
 assert.deepEqual(runs.map(r=>r.task),['任务A','任务B'],'C 已被丢弃，不执行');
 gate.forEach(res=>res({message:'ok'}));
});

// ── 验收：run 失败 → 项 failed + 队列暂停 + 通知；/qresume 后继续 ──
test('Q7: failed run pauses queue with notice; later items kept until /qresume',async t=>{
 const {a,calls}=bridge(t);let fail=true;
 const {runs}=mockCodex(t,function(){return fail?Promise.reject(new Error('boom-synthesis')):Promise.resolve({message:'ok'});});
 bindGroup(a,'oc_gQ','aaaa11110000','thread-T');
 await a.respond(msg('group','oc_gQ','会失败的任务','om_A'));
 await a.respond(msg('group','oc_gQ','后续任务','om_B'));
 assert(await until(()=>a.queues['oc_gQ'].paused===true),'失败后队列暂停');
 const q=a.queues['oc_gQ'];
 assert.equal(q.items[0].status,'failed');assert.equal(q.items[1].status,'queued','后续指令保留');
 assert(/prev-failed/.test(q.pauseReason),q.pauseReason);
 assert(await until(()=>calls.some(c=>c.includes('oc_gQ')&&c.some(x=>typeof x==='string'&&/队列已暂停/.test(x)))),'暂停通知');
 fail=false;
 await a.respond(msg('group','oc_gQ','/qresume','om_R'));
 assert(await until(()=>runs.length===2&&runs[1].task==='后续任务'),'恢复后继续');
});

// ── R08：绝对路径开头文本在任务群按正文入队执行；用户不再看到 __NATURAL__ ──
test('Q8: absolute-path-leading text routes as group task body (R08), unknown command gets usage',async t=>{
 const {a,calls}=bridge(t);const {runs}=mockCodex(t);
 bindGroup(a,'oc_gQ','aaaa11110000','thread-T');
 await a.enqueue(()=>a.handle(JSON.stringify(msg('group','oc_gQ','/home/alice/workspace/demo/README.md 你看下最新的复核建议','om_P'))));
 assert(await until(()=>runs.length===1),'路径正文应入队并执行');
 assert(/README\.md 你看下最新的复核建议/.test(runs[0].task),'原文完整传给模型');
 assert(!calls.some(c=>c.some(x=>typeof x==='string'&&x.includes('__NATURAL__'))),'不再泄漏内部标记');
 await a.enqueue(()=>a.handle(JSON.stringify(msg('p2p','oc_dm','/unknown','om_U'))));
 assert(await until(()=>calls.some(c=>c.includes('oc_dm')&&c.some(x=>typeof x==='string'&&/未知命令/.test(x)))),'未知命令给用法');
 await a.enqueue(()=>a.handle(JSON.stringify(msg('group','oc_gQ','/ run a 检查','om_S'))));
 assert(await until(()=>runs.length===2),'斜杠后空格按正文处理');
});

// ── TASK_ACK：初始化挂起 60s（模拟）时 ACK 仍先行；任务状态可查可取消 ──
test('Q9: ACK precedes slow model initialization (barrier-held start)',async t=>{
 const startGate=[];const {a}=bridge(t);
 const oS=CodexClient.prototype.start,oR=CodexClient.prototype.run;
 t.after(()=>{CodexClient.prototype.start=oS;CodexClient.prototype.run=oR;});
 CodexClient.prototype.start=function(){const p=new Promise(res=>startGate.push(res));return p.then(()=>{this.threadId=this.resumeThreadId||'thread-slow';return this.threadId;});};
 CodexClient.prototype.run=()=>new Promise(()=>{}); // 永不返回
 bindGroup(a,'oc_gQ','aaaa11110000','thread-T');
 const t0=Date.now();
 const r=await a.respond(msg('group','oc_gQ','任务A','om_A'));
 assert(Date.now()-t0<1000,'受理回执不等待模型初始化');
 assert(/收到，正在启动本群任务。/.test(r),r);
 const q=a.queues['oc_gQ'];
 assert.equal(q.items[0].status,'active','状态可查：已 claim，启动中');
 const rB=await a.respond(msg('group','oc_gQ','任务B','om_B'));
 assert(/前面 1 条正在执行/.test(rB),rB); // 初始化未完成仍正确计数
 startGate.forEach(res=>res());
});

// ── 队列满：明确"未入队"，不假称受理 ──
test('Q10: full queue refuses with explicit not-saved notice',async t=>{
 const items=Array.from({length:50},(_,i)=>({seq:i+1,messageId:'om_f'+i,text:'积压'+i,kind:'task',status:'queued',enqueuedAt:i,queuedAck:true}));
 const seed={'queue.json':{'oc_gQ':{seq:50,paused:false,pauseReason:null,items}},'groups.json':{'oc_gQ':{anchor:'aaaa11110000',alias:'a',status:'active'}},'jobs/aaaa11110000/state.json':{id:'aaaa11110000',alias:'a',chat:'oc_gQ',threadId:'thread-T',status:'running',cwd:'/tmp',mode:'auto',started:1}};
 const {a}=bridge(t,{seed});const {runs}=mockCodex(t);
 const r=await a.respond(msg('group','oc_gQ','新指令','om_NEW'));
 assert(/排队已满/.test(r)&&/未保存/.test(r),r);
 assert.equal(a.queues['oc_gQ'].items.length,50,'没有新增');
 assert.equal(runs.length,0,'不执行');
});

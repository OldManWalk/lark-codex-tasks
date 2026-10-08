// RESTART_REVIEW_2026-09-28 验收测试：F01 持久受理失败拒绝 / F02 去重与受理同事务 /
// F03 审批生命周期 / F04 outbox 解耦事件链 / F05 /ping 人格边界 / F06 私聊进程生命周期。
// 全部使用合成 fake Lark/模型与临时目录，不触真实聊天、凭证或生产状态。
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const sup=require('./supervisor.cjs');
const {CodexClient}=require('./codex-client.cjs');

const until=async(fn,ms=4000)=>{const t0=Date.now();while(Date.now()-t0<ms){if(fn())return true;await new Promise(r=>setTimeout(r,10));}return false;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function bridge(t,{seed,env}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lct-f-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const state=path.join(root,'.local/state/lark-codex-tasks');fs.mkdirSync(state,{recursive:true});
 fs.mkdirSync(path.join(root,'.config/lark-codex-tasks'),{recursive:true});
 fs.mkdirSync(path.join(root,'workspace/a'),{recursive:true});
 fs.mkdirSync(path.join(root,'workspace/scratch'),{recursive:true});
 sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{a:path.join(root,'workspace','a')});
 if(seed)for(const [rel,data] of Object.entries(seed)){const f=path.join(state,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,typeof data==='string'?data:JSON.stringify(data));}
 const proc=new EventEmitter();proc.env={LARK_OWNER_OPEN_ID:'owner',LCT_BRAND:'TestBrand',LCT_DM_GREETING:'测试助手在线，老板。',...(env||{})};
 const calls=[],logs=[],errs=[];
 const context=vm.createContext({
  __dirname,
  require:n=>n==='node:os'?{...os,homedir:()=>root}:require(n),
  module:{},process:proc,console:{log(...a){logs.push(a.map(String).join(' '));},error(...a){errs.push(a.map(String).join(' '));}},
  setTimeout,clearTimeout,setInterval,clearInterval,calls});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'lark-bridge.cjs'),'utf8')+`
 lark=async(args)=>{calls.push(args);return {ok:true,data:{message_id:'om_fake',chat_id:'oc_new'}};};
 globalThis.api={handle,handleCardAction,askApproval,decide,settle,reopen,respond,groupContext,auditSessionIsolation,dmSession,dmThreadIds,supervisor,pendingByChat,pendingByToken,pump,enqueueItem,post,drainChat,
  consts:{DM_INSTR_VERSION,TASK_INSTR_VERSION,DM_INSTRUCTIONS,TASK_INSTRUCTIONS},
  get groups(){return groups;},get sessions(){return sessions;},get dmChats(){return dmChats;},get queues(){return queues;},
  get seen(){return seen;},get outbox(){return outbox;},get dispatches(){return dispatches;},get chatClients(){return chatClients;},get pendingByClient(){return pendingByClient;},
  enqueue(fn){queue=queue.then(fn);return queue;},patch(code){return eval(code);}};
 `,context);
 return {a:context.api,calls,logs,errs,root,context};
}
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

// ── F01：EACCES/ENOSPC/rename 失败注入 → 明确拒绝受理、零模型调用、内存不残留、去重未提交 ──
test('F01: queue persist failure rejects acceptance; zero model calls; recovery allows redelivery',async t=>{
 const {a,calls,root}=bridge(t);
 const {runs}=mockCodex(t);
 bindGroup(a,'oc_gF','aaaa11110000','thread-T');
 const storePath=path.join(root,'.local/state/lark-codex-tasks/store.json');
 fs.mkdirSync(storePath); // 注入 rename 失败：store.json 是目录
 await assert.rejects(a.respond(msg('group','oc_gF','任务X','om_F1')),/未保存、未受理/,'明确拒绝受理');
 assert.equal(runs.length,0,'零模型调用');
 assert(!a.queues['oc_gF']||!a.queues['oc_gF'].items.length,'内存视图已回滚，不保留未受理任务');
 assert(!a.seen.has('om_F1'),'去重未提交，重投不被吞');
 // handle 路径：回复"未保存"且仍不提交去重
 await a.enqueue(()=>a.handle(JSON.stringify(msg('group','oc_gF','任务X','om_F1'))));
 assert(await until(()=>calls.some(c=>c.includes('oc_gF')&&c.some(x=>typeof x==='string'&&/未保存、未受理/.test(x)))),'用户收到未保存告知');
 assert(!a.seen.has('om_F1'),'重投仍未被吞');
 assert.equal(runs.length,0);
 // 恢复存储：同 message_id 正确重投受理并执行
 fs.rmSync(storePath,{recursive:true,force:true});
 const r=await a.respond(msg('group','oc_gF','任务X','om_F1'));
 assert(/收到，正在启动本群任务。/.test(r),r);
 assert(await until(()=>runs.length===1),'恢复存储后同 message_id 正确重投');
 assert(a.seen.has('om_F1'),'受理与去重同事务提交');
});

// ── F02：派活意图与去重同一事务；崩溃 pending 意图重启幂等重投；已受理不重复执行 ──
test('F02: dispatch intent commits with dedup atomically; pending intent replays idempotently after restart',async t=>{
 const {a}=bridge(t);
 const {runs}=mockCodex(t);
 const r=await a.respond(msg('p2p','oc_dm','/run a 修复登录','om_RUN1'));
 assert(/新任务已保存/.test(r),r);
 assert(await until(()=>runs.length===1),'任务启动');
 assert(a.seen.has('om_RUN1'),'去重已提交');
 assert.equal(a.dispatches['om_RUN1'].status,'done','意图落定');
 const r2=await a.respond(msg('p2p','oc_dm','/run a 修复登录','om_RUN1'));
 assert(/已受理/.test(r2)&&/无需重发/.test(r2),'重投幂等拒绝: '+r2);
 assert.equal(runs.length,1,'不重复执行');
});
test('F02b: boot reconciliation resumes pending intent exactly once (job-scan idempotent)',async t=>{
 const seed={'store.json':{version:1,seen:['om_CRASH'],queues:{},outbox:[],dispatches:{'om_CRASH':{kind:'run',alias:'a',task:'崩溃前任务',mode:'auto',chat:'oc_dm',messageId:'om_CRASH',status:'pending',createdAt:1,updatedAt:1}}}};
 const {a}=bridge(t,{seed});
 const {runs}=mockCodex(t);
 const reconcile=()=>a.patch(`(async()=>{for(const intent of Object.values(dispatches))if(intent.status==='pending')await executeIntent(intent);})()`);
 await reconcile();
 assert(await until(()=>runs.length===1),'崩溃前未完成的派活被恢复');
 assert.equal(runs[0].task,'崩溃前任务');
 assert(await until(()=>a.dispatches['om_CRASH'].status==='done'));
 await reconcile();
 assert.equal(runs.length,1,'done 意图不重投');
 // 崩溃于 job 已建、意图未落定：重投经 job 扫描幂等，不重复启动
 a.patch(`dispatches['om_CRASH'].status='pending';`);
 await reconcile();
 assert.equal(runs.length,1,'job 已存在则不重复启动');
 assert(await until(()=>a.dispatches['om_CRASH'].status==='done'));
});

// ── F03：决议未送达不虚报；client 终态统一回收并更新卡片；终态后点击明确失效 ──
test('F03a: undeliverable decision shown as not-delivered, never as success',async t=>{
 const {a,calls}=bridge(t);
 await a.askApproval({id:'aaaaaaaaaaaa',alias:'a',chat:'oc_gA'},'item/commandExecution/requestApproval',{command:'rm -rf /tmp/x'},()=>{throw new Error('dead pipe');});
 const token=[...a.pendingByToken.keys()][0];
 await a.handleCardAction(JSON.stringify({type:'card.action.trigger',event_id:'ev1',operator_id:'owner',action_tag:'button',action_value:{t:token,d:'accept'},chat_id:'oc_gA'}));
 const patch=calls.find(c=>c.includes('patch'));
 assert(patch,'卡片被更新');
 assert(patch.some(x=>typeof x==='string'&&x.includes('决定未送达')),'显示未送达');
 assert(!patch.some(x=>typeof x==='string'&&x.includes('✅ 已通过')),'不虚报已通过');
});
test('F03b: client finish revokes pending approvals and expires the card',async t=>{
 const {a,calls}=bridge(t);
 const fakeClient={finished:false,approvals:new Map(),onFinish:null};
 let delivered=null;const respondFn=d=>{delivered=d;return true;};
 fakeClient.approvals.set(7,respondFn);
 await a.askApproval({id:'bbbbbbbbbbbb',alias:'a',chat:'oc_gB'},'item/commandExecution/requestApproval',{command:'apt install x'},respondFn,{client:fakeClient,reqId:7});
 assert.equal(a.pendingByToken.size,1);
 assert.equal(typeof fakeClient.onFinish,'function','onFinish 已接线');
 const token=[...a.pendingByToken.keys()][0];
 fakeClient.finished=true;fakeClient.approvals.clear();
 fakeClient.onFinish(fakeClient); // client 终态
 assert.equal(a.pendingByToken.size,0,'pending registry 统一清理');
 assert.equal(delivered,null,'未向执行端送达任何决定');
 assert(await until(()=>calls.some(c=>c.includes('patch')&&c.some(x=>typeof x==='string'&&x.includes('审批已失效')))),'卡片置为已失效');
 delivered=null;
 await a.handleCardAction(JSON.stringify({type:'card.action.trigger',event_id:'ev2',operator_id:'owner',action_tag:'button',action_value:{t:token,d:'accept'},chat_id:'oc_gB'}));
 assert.equal(delivered,null,'终态后点击不产生决定');
 assert(await until(()=>calls.some(c=>c.includes('oc_gB')&&c.some(x=>typeof x==='string'&&/该审批已失效/.test(x)))),'旧卡点击明确失效');
});
test('F03c: decide on finished client is rejected by validity precheck',async t=>{
 const {a,calls}=bridge(t);
 const fakeClient={finished:false,approvals:new Map(),onFinish:null};
 let delivered=null;const respondFn=d=>{delivered=d;return true;};
 fakeClient.approvals.set(9,respondFn);
 await a.askApproval({id:'cccccccccccc',alias:'a',chat:'oc_gC'},'item/commandExecution/requestApproval',{command:'x'},respondFn,{client:fakeClient,reqId:9});
 const token=[...a.pendingByToken.keys()][0];
 fakeClient.finished=true;fakeClient.approvals.clear(); // 终态但未触发 onFinish：decide 前置校验兜底
 await a.handleCardAction(JSON.stringify({type:'card.action.trigger',event_id:'ev3',operator_id:'owner',action_tag:'button',action_value:{t:token,d:'accept'},chat_id:'oc_gC'}));
 assert.equal(delivered,null,'未送达');
 assert(await until(()=>calls.some(c=>c.includes('patch')&&c.some(x=>typeof x==='string'&&x.includes('审批已失效')))),'卡片显示已失效而非已通过');
});

// ── F04：慢投递不阻塞事件链；跨会话独立 drain；同会话保序；恢复后补投不丢 ──
test('F04: blocked delivery in chat A neither blocks chat B nor approvals; per-chat order preserved',async t=>{
 const {a,calls,context}=bridge(t);
 mockCodex(t);
 a.patch(`globalThis.gate=[];lark=async(args)=>{calls.push(args);if(args.includes('oc_slow')){await new Promise(r=>gate.push(r));}return {ok:true,data:{message_id:'om_fake',chat_id:'oc_new'}};};`);
 bindGroup(a,'oc_fast','aaaa11110000','thread-T');
 const t0=Date.now();
 await a.enqueue(()=>a.handle(JSON.stringify(msg('p2p','oc_slow','你好','om_S1'))));
 assert(Date.now()-t0<1000,'受理不等待投递');
 assert(await until(()=>context.gate.length===1),'oc_slow 回复投递挂起');
 await a.enqueue(()=>a.handle(JSON.stringify(msg('p2p','oc_slow','第二句','om_S2')))); // 同会话第二条：受理+执行不受阻
 assert(await until(()=>{const q=a.queues['oc_slow'];const it=q&&q.items.find(x=>x.messageId==='om_S2');return it&&it.status==='done';}),'同会话后续消息照常执行');
 assert.equal(context.gate.length,1,'保序：首条未投达，第二条不抢跑');
 await a.enqueue(()=>a.handle(JSON.stringify(msg('group','oc_fast','任务','om_F3'))));
 assert(await until(()=>calls.some(c=>c.includes('oc_fast')&&c.some(x=>typeof x==='string'&&/收到，正在启动/.test(x)))),'oc_fast 回执独立送达');
 let decision=null;
 await a.askApproval({id:'dddddddddddd',alias:'a',chat:'oc_fast'},'item/commandExecution/requestApproval',{command:'x'},d=>{decision=d;return true;});
 const token=[...a.pendingByToken.keys()][0];
 await a.handleCardAction(JSON.stringify({type:'card.action.trigger',event_id:'ev4',operator_id:'owner',action_tag:'button',action_value:{t:token,d:'accept'},chat_id:'oc_fast'}));
 assert.equal(decision,'accept','审批不被慢投递连坐');
 context.gate.forEach(r=>r()); // 回执恢复
 assert(await until(()=>context.gate.length>=2),'首条完成后按序补投');
 for(let i=0;i<20;i++){context.gate.forEach(r=>r());if(await until(()=>a.outbox.filter(x=>x.state==='pending').length===0,300))break;await sleep(20);} // 持续放行直至排空
 assert.equal(a.outbox.filter(x=>x.state==='pending').length,0,'补投完成不丢消息');
});
test('F04b: outbox retries with bounded attempts then dead-letters observably',async t=>{
 const {a,errs}=bridge(t,{env:{LCT_OB_MAX_ATTEMPTS:'2',LCT_OB_BACKOFF_MS:'1'}});
 a.patch(`lark=async()=>{throw new Error('dns server misbehaving');};`);
 a.post('oc_x','测试消息','dk-1');
 assert(await until(()=>a.outbox[0]&&a.outbox[0].attempts===1),'首次失败计数');
 assert.equal(a.outbox[0].state,'pending','有限重试中');
 await sleep(20);await a.drainChat('oc_x');
 assert(await until(()=>a.outbox[0].state==='failed'),'达到上限后死信');
 assert(errs.some(l=>/dead-letter/.test(l)),'死信可观测（日志）');
});

// ── F07：富文本(post)消息受理——群/私聊均解析，@提及剔除，纯媒体明确提示，重投去重 ──
const postMsg=(chat_type,chat_id,post,id)=>({type:'im.message.receive_v1',chat_type,chat_id,content:JSON.stringify(post),message_id:id,sender_id:'owner',sender_type:'user',message_type:'post'});
test('F07a: rich-text post in bound group is parsed, mention stripped, enqueued once',async t=>{
 const {a}=bridge(t);mockCodex(t);
 bindGroup(a,'oc_gPost','cccc33334444','thread-P');
 const r=await a.respond(postMsg('group','oc_gPost',{title:'',content:[[{tag:'at',user_id:'ou_bot',user_name:'小任'},{tag:'text',text:' 查一下路由器状态 '},{tag:'a',text:'文档',href:'http://x'}],[{tag:'text',text:'第二行内容'}],[{tag:'img',image_key:'img_x'}]]},'om_POST1'));
 assert(/收到，正在启动本群任务。/.test(r),r);
 const item=a.queues['oc_gPost'].items[0];
 assert.equal(item.kind,'task');
 assert.equal(item.text,'查一下路由器状态 文档\n第二行内容','text/a 段拼接、段落换行、图片段忽略');
 assert(!item.text.includes('小任'),'@提及剔除');
});
test('F07b: post message in DM enqueues as dialog',async t=>{
 const {a}=bridge(t);mockCodex(t);
 const r=await a.respond(postMsg('p2p','oc_dmPost',{content:[[{tag:'text',text:'你好助手'}]]},'om_POST2'));
 assert(/收到，处理中/.test(r),r);
 assert.equal(a.queues['oc_dmPost'].items[0].kind,'dm');
 assert.equal(a.queues['oc_dmPost'].items[0].text,'你好助手');
});
test('F07c: media-only post gets explicit hint, no queue entry, no model run',async t=>{
 const {a}=bridge(t);const {runs}=mockCodex(t);
 bindGroup(a,'oc_gImg','dddd44445555','thread-I');
 const r=await a.respond(postMsg('group','oc_gImg',{content:[[{tag:'img',image_key:'img_x'}]]},'om_POST3'));
 assert(/没有从这条富文本消息中提取到文字/.test(r),r);
 assert(!a.queues['oc_gImg']||!a.queues['oc_gImg'].items.length,'未入队');
 await new Promise(r2=>setTimeout(r2,50));assert.equal(runs.length,0,'零模型调用');
});
test('F07d: full handle path accepts post and dedups redelivery',async t=>{
 const {a}=bridge(t);mockCodex(t);
 bindGroup(a,'oc_gH','eeee55556666','thread-H');
 const ev=postMsg('group','oc_gH',{content:[[{tag:'text',text:'富文本任务'}]]},'om_POST4');
 await a.enqueue(()=>a.handle(JSON.stringify(ev)));
 assert(await until(()=>a.queues['oc_gH']&&a.queues['oc_gH'].items.length===1),'post 事件入队');
 assert(a.seen.has('om_POST4'),'受理后提交去重');
 await a.enqueue(()=>a.handle(JSON.stringify(ev)));
 assert.equal(a.queues['oc_gH'].items.length,1,'重投不重复入队');
});
test('F07e: locale-wrapped post body is parsed',async t=>{
 const {a}=bridge(t);mockCodex(t);
 bindGroup(a,'oc_gL','ffff66667777','thread-L');
 const r=await a.respond(postMsg('group','oc_gL',{zh_cn:{title:'标题',content:[[{tag:'text',text:'本地化正文'}]]}},'om_POST5'));
 assert(/收到，正在启动本群任务。/.test(r),r);
 assert.equal(a.queues['oc_gL'].items[0].text,'标题\n本地化正文');
});

// ── F05：群内中性身份；私聊配置人格；健康信息依据真实组件状态 ──
test('F05: /ping uses neutral identity in groups, persona only in DM, real component health',async t=>{
 const {a}=bridge(t);
 const rg=await a.respond(msg('group','oc_gP','/ping','om_PG'));
 assert(/^TestBrand 在线。/.test(rg)&&!rg.includes('TESTBOT'),'群内中性任务身份: '+rg);
 assert(/运行 0\/2 · 待审批 0 · 待发消息 \d+/.test(rg),'真实组件状态: '+rg);
 assert(!/一切正常/.test(rg),'不无条件承诺一切正常');
 const rp=await a.respond(msg('p2p','oc_dmp','/ping','om_PP'));
 assert(/^测试助手在线，老板。/.test(rp),'私聊保持配置人格: '+rp);
 assert(/运行 \d\/2 · 待审批 \d · 待发消息 \d+/.test(rp),'私聊同样基于真实状态');
});

// ── F06：dispose 幂等释放（R01）；排队启动取消不晚启动（R04）；turn 已提交绝不盲目重发 ──
test('F06a/R01: dispose releases finished client process; idempotent',async()=>{
 let kills=0;const c=new CodexClient({});c.child={kill(){kills++;}};c._req=async()=>({turn:{id:'turn'}});
 const result=c.run('task');await sleep(0);
 c._onEvent('turn/completed',{turn:{id:'turn',status:'completed',items:[]}});
 await result;
 await c.dispose();
 assert(kills>=1,'finished 的 client 也释放进程（R01 修复）');
 const k=kills;await c.dispose();assert.equal(kills,k,'dispose 幂等');
 clearTimeout(c.killTimer);
});
test('F06b/R04: cancel during queued start prevents late start; run on finished client rejects',async()=>{
 let release;CodexClient._startChain=new Promise(r=>release=r);
 let started=0;const c=new CodexClient({});c._startInner=async()=>{started++;return 'thread';};
 const startP=c.start();
 await c.cancel(); // 启动链排队期间取消
 release();
 await assert.rejects(startP,/disposed before start/,'取消后不得晚启动');
 assert.equal(started,0,'_startInner 未执行');
 await assert.rejects(c.run('task'),/finished/,'已结束 client 的 run 立即拒绝，不悬挂');
 CodexClient._startChain=Promise.resolve();
});
test('F06c: DM resume start-failure retries on fresh thread (turn never submitted)',async t=>{
 const {a}=bridge(t);
 const starts=[];const modes=['fail','ok'];
 const oS=CodexClient.prototype.start,oR=CodexClient.prototype.run;
 t.after(()=>{CodexClient.prototype.start=oS;CodexClient.prototype.run=oR;});
 CodexClient.prototype.start=async function(){starts.push(this.resumeThreadId||null);if(modes.shift()==='fail')throw new Error('network timeout');this.threadId='thread-new';return this.threadId;};
 CodexClient.prototype.run=async()=>({message:'ok'});
 a.patch(`saveDmSession('oc_dmr','thread-old');`);
 const r=await a.patch(`runChatTurn('你好','oc_dmr')`);
 assert.equal(r,'ok');
 assert.deepEqual(starts,['thread-old',null],'仅 start 阶段失败才开新线程重跑');
 assert.equal(a.chatClients.size,0,'实例释放');
});
test('F06d: turn-submitted failure is never blind-retried (side-effect safe)',async t=>{
 const {a}=bridge(t);
 let runs=0;
 const oS=CodexClient.prototype.start,oR=CodexClient.prototype.run;
 t.after(()=>{CodexClient.prototype.start=oS;CodexClient.prototype.run=oR;});
 CodexClient.prototype.start=async function(){this.threadId='thread-x';return this.threadId;};
 CodexClient.prototype.run=async function(){this.turnSubmitted=true;runs++;throw new Error('network stream reset');};
 await assert.rejects(a.patch(`runChatTurn('执行副作用','oc_dmt')`),/network/);
 assert.equal(runs,1,'turn 已提交：不重跑');
 await a.respond(msg('p2p','oc_dmt','再来一条','om_DT1'));
 assert(await until(()=>{const q=a.queues['oc_dmt'];return q&&q.items[0]&&q.items[0].status==='failed';}),'条目落定失败');
 assert(/结果未知，未自动重发/.test(a.queues['oc_dmt'].items[0].error),'明确标注未重发');
 assert.equal(runs,2,'新指令执行恰好一次；其已提交 turn 失败后外层未重放（runs 不为 3）');
});
test('F06d2: DM turn/start response timeout is not blind-replayed',async t=>{
 const {a}=bridge(t);let runs=0;
 const oS=CodexClient.prototype.start,oR=CodexClient.prototype.run;
 t.after(()=>{CodexClient.prototype.start=oS;CodexClient.prototype.run=oR;});
 CodexClient.prototype.start=async function(){this.threadId='thread-timeout';return this.threadId;};
 CodexClient.prototype.run=async function(){this.turnSubmissionAttempted=true;runs++;throw Error('request timeout: turn/start');};
 await a.respond(msg('p2p','oc_dm_timeout','执行一次副作用','om_DT_TIMEOUT'));
 assert(await until(()=>a.queues['oc_dm_timeout']?.items[0]?.status==='failed'));
 assert.equal(runs,1,'请求已写出、响应丢失：外层不能重新执行');
 assert.match(a.queues['oc_dm_timeout'].items[0].error,/结果未知，未自动重发/);
});
test('F06e: sequential DM turns return client count to baseline (no leak)',async t=>{
 const {a}=bridge(t);
 mockCodex(t);
 for(const id of ['om_L1','om_L2','om_L3']){
  await a.respond(msg('p2p','oc_dml','第'+id+'句',id));
  assert(await until(()=>{const q=a.queues['oc_dml'];const it=q&&q.items.find(x=>x.messageId===id);return it&&it.status==='done';}),id+' 完成');
 }
 assert.equal(a.chatClients.size,0,'私聊执行实例回到基线');
});

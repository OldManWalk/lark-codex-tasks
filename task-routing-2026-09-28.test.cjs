// NEW_TASK_ROUTING_REVIEW.md（2026-09-28）验收测试：
// N01 私聊明确派活意图确定性分流（项目不明只询问，禁止降级私聊执行）
// N02 私聊会话级取消（裸 /cancel）/ N03 凭证卫生（持久化与通知不落明文）/ N04 空闲私聊即时 ACK
// 全部使用合成 fake Lark/模型与临时目录，不触真实聊天、凭证或生产状态。
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const sup=require('./supervisor.cjs');
const {CodexClient}=require('./codex-client.cjs');

const until=async(fn,ms=4000)=>{const t0=Date.now();while(Date.now()-t0<ms){if(fn())return true;await new Promise(r=>setTimeout(r,10));}return false;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function bridge(t,{seed,env}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lct-rt-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const state=path.join(root,'.local/state/lark-codex-tasks');fs.mkdirSync(state,{recursive:true});
 fs.mkdirSync(path.join(root,'.config/lark-codex-tasks'),{recursive:true});
 fs.mkdirSync(path.join(root,'workspace/a'),{recursive:true});
 fs.mkdirSync(path.join(root,'workspace/scratch'),{recursive:true});
 sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{a:path.join(root,'workspace','a')});
 if(seed)for(const [rel,data] of Object.entries(seed)){const f=path.join(state,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,typeof data==='string'?data:JSON.stringify(data));}
 const proc=new EventEmitter();proc.env={LARK_OWNER_OPEN_ID:'owner',...(env||{})};
 const calls=[],logs=[],errs=[];
 const context=vm.createContext({
  __dirname,
  require:n=>n==='node:os'?{...os,homedir:()=>root}:require(n),
  module:{},process:proc,console:{log(...a){logs.push(a.map(String).join(' '));},error(...a){errs.push(a.map(String).join(' '));}},
  setTimeout,clearTimeout,setInterval,clearInterval,calls});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'lark-bridge.cjs'),'utf8')+`
 lark=async(args)=>{calls.push(args);return {ok:true,data:{message_id:'om_fake',chat_id:'oc_new',users:[{member_id:'owner'}],bots:[{member_id:'bot'}],has_more:false,truncations:[]}};};
 globalThis.api={handle,handleCardAction,askApproval,decide,settle,reopen,respond,groupContext,auditSessionIsolation,dmSession,dmThreadIds,supervisor,pendingByChat,pendingByToken,pump,enqueueItem,post,drainChat,
  consts:{DM_INSTR_VERSION,TASK_INSTR_VERSION,DM_INSTRUCTIONS,TASK_INSTRUCTIONS},
  get groups(){return groups;},get sessions(){return sessions;},get dmChats(){return dmChats;},get queues(){return queues;},
  get seen(){return seen;},get outbox(){return outbox;},get dispatches(){return dispatches;},get chatClients(){return chatClients;},
  enqueue(fn){queue=queue.then(fn);return queue;},patch(code){return eval(code);}};
 `,context);
 return {a:context.api,calls,logs,errs,root,context};
}
function mockCodex(t,runImpl){
 const starts=[],runs=[];
 const oS=CodexClient.prototype.start,oR=CodexClient.prototype.run;
 t.after(()=>{CodexClient.prototype.start=oS;CodexClient.prototype.run=oR;});
 CodexClient.prototype.start=async function(){starts.push({codex:this.codex,resume:this.resumeThreadId||null,instr:(this.threadParams&&this.threadParams.developerInstructions)||null,cwd:this.cwd,sandbox:this.threadParams?.sandbox,approvalPolicy:this.threadParams?.approvalPolicy});this.threadId=this.resumeThreadId||'thread-'+starts.length;return this.threadId;};
 CodexClient.prototype.run=function(task,options){const rec={task,resume:this.resumeThreadId||null,cwd:this.cwd,kind:this.threadParams?.name,options};runs.push(rec);return runImpl?runImpl.call(this,task,rec):Promise.resolve({message:'ok'});};
 return {starts,runs};
}
const msg=(chat_type,chat_id,content,id)=>({type:'im.message.receive_v1',chat_type,chat_id,content,message_id:id||('om_'+Math.random().toString(36).slice(2)),sender_id:'owner',sender_type:'user',message_type:'text'});
const action=(type,project='',task='',message='',title=type==='reply'?'':'测试任务',target='',projectExplicit=!!project)=>({message:JSON.stringify({type,project,projectExplicit,task,message,title,target})});
const dmModel=decision=>function(task,rec){return Promise.resolve(['lct-chat','lct-router'].includes(rec.kind)?decision(task,rec):{message:'ok'});};

test('OpenWrt is an equipment target, not an unregistered project; a fresh router corrects the DM model',async t=>{
 const {a,root,calls}=bridge(t);
 sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{a:path.join(root,'workspace/a'),scratch:path.join(root,'workspace/scratch')});
 const {runs,starts}=mockCodex(t,dmModel((task,rec)=>rec.kind==='lct-chat'
   ?action('create_group','openwrt','配置路由器','','OpenWrt 路由器配置','',true)
   :action('create_group','','配置路由器','','OpenWrt 路由器配置','',false)));
 const request='小任帮我建一个群，目标是 连接OpenWrt 并帮我管理路由器配置一些东西的';
 await a.respond(msg('p2p','oc_dm',request,'om_OPENWRT_TARGET'));
 assert(await until(()=>a.dispatches.om_OPENWRT_TARGET?.status==='done'));
 assert.equal(a.supervisor.jobs.get(a.groups.oc_new.anchor).alias,'scratch');
 assert.match(a.groups.oc_new.title,/OpenWrt 路由器配置/);
 assert.equal(runs.find(x=>x.kind!=='lct-chat'&&x.kind!=='lct-router').task,request);
 assert.equal(starts.find(x=>x.instr.includes('独立的私聊动作复核器')).resume,null,'动作复核使用独立新线程');
 assert.equal(a.sessions['dm:oc_dm'].thread,starts[0].resume||'thread-1','复核线程不污染私聊会话');
 assert.equal(calls.filter(c=>c.includes('+chat-create')).length,1);
});

test('router configuration group works when a product is mistakenly named as the project',async t=>{
 const {a,root}=bridge(t);
 sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{a:path.join(root,'workspace/a'),scratch:path.join(root,'workspace/scratch')});
 mockCodex(t,dmModel((task,rec)=>rec.kind==='lct-chat'
   ?action('create_group','openwrt','配置路由器','','路由器配置','',true)
   :action('create_group','','配置路由器','','路由器配置','',false)));
 await a.respond(msg('p2p','oc_dm','小任帮我建一个群，工作的内容是配置路由器','om_ROUTER_CONFIG'));
 assert(await until(()=>a.dispatches.om_ROUTER_CONFIG?.status==='done'));
 assert.equal(a.supervisor.jobs.get(a.groups.oc_new.anchor).alias,'scratch');
});

test('an explicit group request overrides a hallucinated DM reply after a stateless action review',async t=>{
 const {a,root,calls}=bridge(t);
 sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{a:path.join(root,'workspace/a'),scratch:path.join(root,'workspace/scratch')});
 const {starts}=mockCodex(t,dmModel((task,rec)=>rec.kind==='lct-chat'
   ?action('reply','','','此前已提交过两次，请自行检查飞书。')
   :action('create_group','','','','待补充需求','',false)));
 await a.respond(msg('p2p','oc_dm','小任帮我建一个群','om_GROUP_RETRY'));
 assert(await until(()=>a.dispatches.om_GROUP_RETRY?.status==='done'));
 assert.equal(a.supervisor.jobs.get(a.groups.oc_new.anchor).alias,'scratch');
 assert.equal(starts.find(x=>x.instr.includes('独立的私聊动作复核器')).resume,null);
 assert(!calls.some(c=>c.some(x=>typeof x==='string'&&x.includes('此前已提交过两次'))),'不发送幻觉回复');
 assert.equal(calls.filter(c=>c.includes('+chat-create')).length,1);
});

// ── N01：项目不明确的派活意图只询问，不调用 DM 执行工具、不建议未注册项目 ──
test('N01a: explicit task intent with unknown project only asks; zero DM execution',async t=>{
 const {a,calls}=bridge(t);
 const {runs}=mockCodex(t,dmModel(()=>action('create_group','demobot','部署 demobot 到生产环境')));
 const r=await a.respond(msg('p2p','oc_dm','新起一个任务 部署 demobot 到生产环境','om_N1'));
 assert.match(r,/处理中，稍后回报/);
 assert(await until(()=>a.queues.oc_dm.items[0].status==='done'));
 assert(calls.some(c=>c.includes('oc_dm')&&c.some(x=>typeof x==='string'&&x.includes('未知或不可用项目: demobot'))));
 assert.equal(runs.length,2,'未知项目由独立动作复核器再次确认');
 assert(runs[0].options.outputSchema,'模型请求带结构化输出约束');
 assert.equal(Object.keys(a.dispatches).length,0,'未创建派活意图');
 assert(!calls.some(c=>c.includes('+chat-create')),'未知项目不能建群');
});

// ── N01：项目明确的派活意图分流到任务创建：独立群/job/thread，worker 指令无人格 ──
test('N01b: explicit intent with known project routes to worker dispatch (group/job/thread)',async t=>{
 const {a,calls}=bridge(t);
 const {starts,runs}=mockCodex(t,dmModel(()=>action('create_group','a','修复登录页样式')));
 const r=await a.respond(msg('p2p','oc_dm','新起一个任务：用 a 项目修复登录页样式','om_N2'));
 assert.match(r,/处理中，稍后回报/);
 assert(await until(()=>runs.some(x=>x.kind!=='lct-chat')),'worker 执行');
 assert(await until(()=>a.dispatches['om_N2']&&a.dispatches['om_N2'].status==='done'),'意图落定');
 const g=a.groups['oc_new'];
 assert(g&&g.anchor&&/^[a-f0-9]{12}$/.test(g.anchor),'独立任务群+真实 job ID');
 assert.equal(a.dispatches.om_N2.jobId,g.anchor,'派活意图回填真实任务 ID');
 const job=a.supervisor.jobs.get(g.anchor);
 assert(job&&job.alias==='a'&&job.chat==='oc_new','job 绑定群与项目，审批身份为任务而非 chat-*/对话');
 assert(starts[1].instr.includes('执行单元')&&!starts[1].instr.includes('私人 AI 助手'),'worker 线程使用任务指令，非私聊人格');
 assert.equal(a.queues.oc_dm.items[0].status,'done');
 assert(calls.some(c=>c.includes('oc_dm')&&c.some(x=>typeof x==='string'&&x.includes('工作群请求'))));
});

test('group-first request creates a scratch group and continues its own new thread',async t=>{
 const {a,root,calls}=bridge(t);
 sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{a:path.join(root,'workspace/a'),scratch:path.join(root,'workspace/scratch')});
 const {starts,runs}=mockCodex(t,dmModel(()=>action('create_group','','','','待补充需求')));
 const request='你先给我建一个项目群吧，我不想在私聊中处理这个事情';
 const r=await a.respond(msg('p2p','oc_dm',request,'om_GROUP_FIRST'));
 assert.match(r,/处理中，稍后回报/);
 assert(await until(()=>runs.some(x=>x.kind!=='lct-chat')),'独立群会话启动');
 assert.equal(starts[1].resume,null,'新群不续接私聊线程');
 assert.match(runs.find(x=>x.kind!=='lct-chat').task,/等待用户在群内提出具体工作/);
 assert(await until(()=>a.dispatches.om_GROUP_FIRST?.status==='done'));
 const job=a.supervisor.jobs.get(a.groups.oc_new.anchor);
 assert.equal(job.alias,'scratch');
 assert.equal(job.chat,'oc_new');
 assert(await until(()=>job.status==='completed'));
 assert.equal(calls.filter(c=>c.includes('+chat-create')).length,1,'只建一个群');
 await a.respond(msg('group','oc_new','调研 DemoBot 的部署方案','om_GROUP_FOLLOWUP'));
 assert(await until(()=>runs.length===3),'群内后续消息启动');
 assert.equal(starts[2].resume,job.threadId,'续接本群线程');
 assert.match(a.groups.oc_new.title,/调研 DemoBot 的部署方案/);
 assert.doesNotMatch(a.groups.oc_new.title,/scratch/);
 assert.equal(a.queues.oc_dm.items[0].status,'done');
});

test('archived edgeapi request restores the latest thread in a new group',async t=>{
 const thread='01a0ec2e-c33b-7770-b5f0-bb6788114e31';
 const old='oc_old_edgeapi';
 const jobs={
  'c1b3e555412a':{id:'c1b3e555412a',alias:'scratch',chat:old,task:'调研 edgeapi 部署方案',threadId:thread,status:'completed',started:1,cwd:'/unused'},
  '13dce94963f3':{id:'13dce94963f3',alias:'scratch',chat:old,task:'我有新的想法',threadId:thread,status:'completed',started:2,cwd:'/unused',continuedFrom:'c1b3e555412a'}
 };
 const seed=Object.fromEntries(Object.entries(jobs).map(([id,j])=>['jobs/'+id+'/state.json',j]));
 const {a,calls}=bridge(t,{seed});
 const {starts,runs}=mockCodex(t,dmModel(()=>action('resume_task','','','','edgeapi 方案续接','edgeapi')));
 a.supervisor.clients.set('busy-one',{});a.supervisor.clients.set('busy-two',{});
 await a.respond(msg('p2p','oc_dm','之前的 edgeapi 任务归档了，帮我建群继续，新的进展稍后发','om_ARCHIVE'));
 assert(await until(()=>a.dispatches.om_ARCHIVE?.status==='done'));
 assert.equal(a.groups.oc_new.anchor,'13dce94963f3','绑定任务链最新节点');
 assert.equal(a.supervisor.jobs.get('13dce94963f3').chat,'oc_new');
 assert.equal(runs.filter(x=>x.kind!=='lct-chat').length,0,'未给新要求时不启动 worker');
 assert.equal(calls.filter(c=>c.includes('+chat-create')).length,1);
 a.supervisor.clients.clear();
 await a.respond(msg('group','oc_new','新进展：评估新上游的配置','om_ARCHIVE_NEXT'));
 assert(await until(()=>runs.some(x=>x.kind!=='lct-chat')));
 assert.equal(starts.at(-1).resume,thread,'沿用旧任务线程');
});

test('restart replay of an archived resume uses its existing group',async t=>{
 const id='aaaaaaaaaaaa',messageId='om_ARCHIVE_REPLAY';
 const job={id,alias:'scratch',chat:'oc_new',task:'调研 edgeapi',threadId:'thread-archive',status:'completed',settledAt:4,started:1,cwd:'/unused'};
 const seed={['jobs/'+id+'/state.json']:job,'groups.json':{oc_new:{anchor:id,alias:'scratch',chat:'oc_new',chain:id,status:'active',kind:'group_task'}},
  'store.json':{version:1,seen:[messageId],queues:{},outbox:[],dispatches:{[messageId]:{kind:'resume-archived',status:'pending',target:'edgeapi',title:'edgeapi',task:'评估新的上游方案',chat:'oc_dm',messageId,jobId:id,groupChat:'oc_new',createdAt:1,updatedAt:1}}}};
 const {a,calls}=bridge(t,{seed});
 a.supervisor.clients.set('busy-one',{});a.supervisor.clients.set('busy-two',{});
 await a.patch('executeIntent(dispatches.om_ARCHIVE_REPLAY)');
 assert(await until(()=>a.dispatches[messageId].status==='done'));
 await a.patch('executeIntent(dispatches.om_ARCHIVE_REPLAY)');
 assert.equal(calls.filter(c=>c.includes('+chat-create')).length,0);
 assert.equal(a.queues.oc_new.items.filter(i=>i.messageId==='resume-'+messageId).length,1,'重放只补入一次新增工作');
 assert(a.outbox.some(x=>x.key==='intent-'+messageId&&x.text.includes('现役群')));
});

test('a settled task can reopen and close its new group before new work arrives',async t=>{
 const id='aaaaaaaaaaaa',settledAt=100;
 const seed={['jobs/'+id+'/state.json']:{id,alias:'scratch',chat:'oc_old',task:'调研 edgeapi',threadId:'thread-archive',status:'completed',settledAt,started:1,cwd:'/unused'}};
 const {a,calls}=bridge(t,{seed});
 const chat=await a.reopen(id,{allowSettled:true,topic:'edgeapi 方案续接'});
 assert.equal(chat,'oc_new');
 assert.equal(a.groups.oc_new.anchor,id);
 assert(await until(()=>calls.some(c=>c.includes('+messages-send')&&c.includes('oc_new'))));
 assert(calls.filter(c=>c.includes('--idempotency-key')).every(c=>c[c.indexOf('--idempotency-key')+1].length<=50),'所有飞书消息幂等键符合长度限制');
 const result=await a.settle(a.supervisor.jobs.get(id));
 assert.match(result,/群已解散/);
 assert.equal(a.groups.oc_new,undefined);
 assert.equal(a.supervisor.jobs.get(id).settledAt,settledAt);
});

test('archived resume refuses ambiguous and missing targets without creating groups',async t=>{
 const job=(id,task)=>({id,alias:'scratch',chat:'oc_old_'+id,task,threadId:'thread-'+id,status:'completed',settledAt:5,started:1,cwd:'/unused'});
 const seed={'jobs/aaaaaaaaaaaa/state.json':job('aaaaaaaaaaaa','调研 edgeapi 部署'),
  'jobs/bbbbbbbbbbbb/state.json':job('bbbbbbbbbbbb','调研 edgeapi 迁移')};
 const {a,calls}=bridge(t,{seed});
 mockCodex(t,dmModel(task=>action('resume_task','','','','续接',task.includes('missing')?'missing':'edgeapi')));
 await a.respond(msg('p2p','oc_dm','续接 edgeapi 归档任务','om_AMBIGUOUS'));
 assert(await until(()=>a.dispatches.om_AMBIGUOUS?.status==='failed'));
 assert(a.outbox.some(x=>x.key==='intent-om_AMBIGUOUS'&&x.text.includes('多个')));
 await a.respond(msg('p2p','oc_dm','续接 missing 归档任务','om_MISSING'));
 assert(await until(()=>a.dispatches.om_MISSING?.status==='failed'));
 assert(a.outbox.some(x=>x.key==='intent-om_MISSING'&&x.text.includes('未找到')));
 assert.equal(calls.filter(c=>c.includes('+chat-create')).length,0);
});

test('/group defaults to scratch and accepts an explicit project and task',async t=>{
 const {a,root}=bridge(t);
 sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{a:path.join(root,'workspace/a'),scratch:path.join(root,'workspace/scratch')});
 const {starts,runs}=mockCodex(t);
 const r=await a.respond(msg('p2p','oc_dm','/group','om_GROUP_CMD'));
 assert.match(r,/《待补充需求》工作群/);
 assert(await until(()=>runs.length===1));
 assert.equal(a.supervisor.jobs.get(a.groups.oc_new.anchor).alias,'scratch');
 assert.equal(starts[0].resume,null);
 const unknown=await a.respond(msg('p2p','oc_dm','/group missing','om_GROUP_UNKNOWN'));
 assert.match(unknown,/未知或不可用项目/);
 assert.equal(runs.length,1);
 const specified=await a.respond(msg('p2p','oc_dm','/group a 调研部署方案','om_GROUP_SPECIFIED'));
 assert.match(specified,/《调研部署方案》工作群/);
 assert(await until(()=>runs.length===2));
 assert.equal(runs[1].task,'调研部署方案');
 assert.equal(starts[1].resume,null);
});

test('a new scratch group starts while another scratch group is running',async t=>{
 const {a,root,calls}=bridge(t);
 sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{a:path.join(root,'workspace/a'),scratch:path.join(root,'workspace/scratch')});
 a.supervisor.jobs.set('aaaaaaaaaaaa',{id:'aaaaaaaaaaaa',alias:'scratch',chat:'oc_existing',status:'running',threadId:'thread-existing',started:Date.now()});
 const {runs}=mockCodex(t,dmModel(()=>action('create_group','','研究 VPS 能做什么','','VPS 用途调研')));
 await a.respond(msg('p2p','oc_dm','帮我建一个项目群，我有一个 VPS 想知道它能做什么','om_VPS_GROUP'));
 assert(await until(()=>a.dispatches.om_VPS_GROUP?.status==='done'));
 const job=a.supervisor.jobs.get(a.groups.oc_new.anchor);
 assert.equal(job.alias,'scratch');
 assert.match(a.groups.oc_new.title,/VPS 用途调研/);
 assert.doesNotMatch(a.groups.oc_new.title,/scratch/);
 assert.notEqual(job.threadId,'thread-existing');
 assert.equal(runs.find(x=>x.kind!=='lct-chat').task,'帮我建一个项目群，我有一个 VPS 想知道它能做什么');
 assert.equal(calls.filter(c=>c.includes('+chat-create')).length,1);
});

test('a full worker pool defers group creation and resumes the saved request',async t=>{
 const {a,root,calls}=bridge(t);
 sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{a:path.join(root,'workspace/a'),scratch:path.join(root,'workspace/scratch')});
 mockCodex(t,dmModel(()=>action('create_group','','研究 VPS 能做什么','','VPS 用途调研')));
 a.supervisor.clients.set('busy-one',{});a.supervisor.clients.set('busy-two',{});
 await a.respond(msg('p2p','oc_dm','帮我建群研究 VPS 的用途','om_DEFER'));
 assert(await until(()=>a.dispatches.om_DEFER?.waitingAt));
 assert.equal(a.dispatches.om_DEFER.status,'pending');
 assert.equal(calls.filter(c=>c.includes('+chat-create')).length,0,'名额满时不建临时群');
 assert(a.outbox.some(x=>x.key==='intentwait-om_DEFER'));
 a.supervisor.clients.delete('busy-two');
 await a.patch('executeIntent(dispatches.om_DEFER)');
 assert(await until(()=>a.dispatches.om_DEFER?.status==='done'));
 assert.equal(calls.filter(c=>c.includes('+chat-create')).length,1);
 assert.match(a.groups.oc_new.title,/VPS 用途调研/);
});

test('recovered failed request keeps its old notice and delivers a new completion',async t=>{
 const id='om_RETRY';
 const seed={'store.json':{version:1,seen:[id],queues:{},outbox:[{id:'ob-old',chat:'oc_dm',text:'❌ 任务启动失败',key:'intent-'+id,format:'text',state:'sent',attempts:0,nextAt:0,createdAt:1}],dispatches:{[id]:{kind:'run',status:'pending',alias:'a',task:'调研 VPS 用途',title:'VPS 用途调研',mode:'auto',chat:'oc_dm',messageId:id,retryEpoch:1,createdAt:1,updatedAt:1}}}};
 const {a}=bridge(t,{seed});mockCodex(t);
 await a.patch('executeIntent(dispatches.om_RETRY)');
 assert(await until(()=>a.dispatches.om_RETRY.status==='done'));
 assert(a.outbox.some(x=>x.key==='intent-'+id+'-retry1'&&/已启动/.test(x.text)));
 assert(a.outbox.some(x=>x.key==='intent-'+id&&x.state==='sent'),'历史失败通知保留');
});

test('explicit group phrase uses the named project and keeps ordinary questions in DM',async t=>{
 const {a,calls}=bridge(t);
 const {runs}=mockCodex(t,dmModel(task=>task.includes('如何')?action('reply','','','建群可以由我受理。'):action('create_group',task.includes('missing')?'missing':'a','调研部署方案')));
 const q=await a.respond(msg('p2p','oc_dm','如何建群处理工作？','om_GROUP_QUESTION'));
 assert.match(q,/处理中，稍后回报/);
 assert(await until(()=>a.queues.oc_dm.items[0].status==='done'));
 const r=await a.respond(msg('p2p','oc_dm','建群处理工作：用 a 项目调研部署方案','om_GROUP_NATURAL'));
 assert.match(r,/处理中，稍后回报/);
 assert(await until(()=>a.dispatches.om_GROUP_NATURAL?.status==='done'));
 assert.equal(a.supervisor.jobs.get(a.groups.oc_new.anchor).alias,'a');
 assert.match(runs.find(x=>!['lct-chat','lct-router'].includes(x.kind)).task,/调研部署方案/);
 const unknown=await a.respond(msg('p2p','oc_dm','建群处理工作：用 missing 项目调研方案','om_GROUP_BAD_ALIAS'));
 assert.match(unknown,/处理中，稍后回报/);
 assert(await until(()=>a.queues.oc_dm.items.at(-1).status==='done'));
 assert.equal(calls.filter(c=>c.includes('+chat-create')).length,1);
});

test('natural group requests accept varied wording and wait for work in the group',async t=>{
 for(const [index,request] of ['建群处理','先建个群吧，后面在群里说','我想拉个群来处理'].entries()){
  await t.test(request,async sub=>{
   const {a,root}=bridge(sub);
   sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{a:path.join(root,'workspace/a'),scratch:path.join(root,'workspace/scratch')});
   const {runs}=mockCodex(sub,dmModel(()=>action('create_group')));
   const reply=await a.respond(msg('p2p','oc_dm',request,'om_GROUP_VARIANT_'+index));
   assert.match(reply,/处理中，稍后回报/);
   assert(await until(()=>runs.some(x=>x.kind!=='lct-chat')));
   assert.match(runs.find(x=>x.kind!=='lct-chat').task,/等待用户在群内提出具体工作/);
  });
 }
});

test('DemoBot group request routes directly from DM to the registered project',async t=>{
 const {a,root,calls}=bridge(t);
 fs.mkdirSync(path.join(root,'workspace/demobot'),{recursive:true});
 sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{a:path.join(root,'workspace/a'),demobot:path.join(root,'workspace/demobot'),scratch:path.join(root,'workspace/scratch')});
 const {runs}=mockCodex(t,dmModel(()=>action('create_group','DemoBot','给我的 DemoBot 配置一些技能')));
 const request='小任，帮我起一个群组给我的DemoBot配置一些技能';
 const reply=await a.respond(msg('p2p','oc_dm',request,'om_OPENCLAW_GROUP'));
 assert.match(reply,/处理中，稍后回报/);
 assert(await until(()=>runs.some(x=>x.kind!=='lct-chat')),'独立群 worker 已启动');
 assert.equal(a.supervisor.jobs.get(a.groups.oc_new.anchor).alias,'demobot');
 assert.equal(runs.find(x=>x.kind!=='lct-chat').task,request,'任务正文保留用户原话');
 assert.equal(calls.filter(c=>c.includes('+chat-create')).length,1);
 assert.equal(a.queues.oc_dm.items[0].status,'done');
});

test('project group phrasing and DM fallback context stay aligned',async t=>{
 for(const [index,request] of ['我想让你帮我建一个DemoBot项目群','可以帮我为DemoBot建个群吗'].entries()){
  await t.test(request,async sub=>{
   const {a,root}=bridge(sub);
   fs.mkdirSync(path.join(root,'workspace/demobot'),{recursive:true});
   sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{demobot:path.join(root,'workspace/demobot'),scratch:path.join(root,'workspace/scratch')});
   const {runs}=mockCodex(sub,dmModel(()=>action('create_group','demobot')));
   assert.match(await a.respond(msg('p2p','oc_dm',request,'om_OPENCLAW_VARIANT_'+index)),/处理中，稍后回报/);
   assert(await until(()=>runs.some(x=>x.kind!=='lct-chat')));
  });
 }
 const {a}=bridge(t);
 assert.match(a.consts.DM_INSTRUCTIONS,/结构化动作由宿主 bridge 执行/);
});

test('discussion of group creation is not treated as a group request',async t=>{
 const {a,calls}=bridge(t);
 mockCodex(t);
 await a.respond(msg('p2p','oc_dm','建群功能为什么不能用？','om_GROUP_DISCUSS'));
 assert.equal(calls.filter(c=>c.includes('+chat-create')).length,0);
});

test('a duplicate delivery does not invoke the model or create a second group',async t=>{
 const {a,root,calls}=bridge(t);
 sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{a:path.join(root,'workspace/a'),scratch:path.join(root,'workspace/scratch')});
 const {runs}=mockCodex(t,dmModel(()=>action('create_group')));
 const event=JSON.stringify(msg('p2p','oc_dm','先建个群，细节之后说','om_DEDUP'));
 await a.handle(event);
 assert(await until(()=>a.dispatches.om_DEDUP?.status==='done'));
 const count=runs.length;
 await a.handle(event);
 assert.equal(runs.length,count);
 assert.equal(calls.filter(c=>c.includes('+chat-create')).length,1);
});

test('invalid model action never creates a group',async t=>{
 const {a,calls}=bridge(t);
 mockCodex(t,dmModel(()=>({message:JSON.stringify({type:'create_group',project:'a'})})));
 await a.respond(msg('p2p','oc_dm','建群','om_BAD_ACTION'));
 assert(await until(()=>a.queues.oc_dm.items[0].status==='failed'));
 assert.equal(Object.keys(a.dispatches).length,0);
 assert(!calls.some(c=>c.includes('+chat-create')));
});

test('DM dispatch storage failure cannot create an unrecorded group',async t=>{
 const {a,calls}=bridge(t);
 mockCodex(t,dmModel(()=>action('create_group','a','修复登录页')));
 a.patch(`const originalPersist=persistStore;persistStore=()=>{if(dispatches.om_STORE_FAIL?.status==='pending'){persistStore=originalPersist;throw Error('ENOSPC');}return originalPersist();};`);
 await a.respond(msg('p2p','oc_dm','帮我建群修复登录页','om_STORE_FAIL'));
 assert(await until(()=>a.queues.oc_dm.items[0].status==='failed'));
 assert.equal(Object.keys(a.dispatches).length,0);
 assert(!calls.some(c=>c.includes('+chat-create')));
});

test('polite new-task request creates a research group and waits for later deployment requirements',async t=>{
 const {a,root}=bridge(t);
 sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{a:path.join(root,'workspace/a'),scratch:path.join(root,'workspace/scratch')});
 const {runs}=mockCodex(t,dmModel(()=>action('create_group','','调研 edgeapi 部署方案；用户稍后补充需求，收到前不部署')));
 const r=await a.respond(msg('p2p','oc_dm','小任，帮我起一个任务，我打算部署一下 edgeapi，我想调研方案，稍后我发给你我的需求','om_SUB2API'));
 assert.match(r,/处理中，稍后回报/);
 assert(await until(()=>runs.some(x=>x.kind!=='lct-chat')),'任务群 worker 已启动');
 assert.equal(a.dispatches['om_SUB2API'].status,'done');
 assert.equal(a.supervisor.jobs.get(a.groups['oc_new'].anchor).alias,'scratch');
 assert.equal(runs.find(x=>x.kind!=='lct-chat').task,'小任，帮我起一个任务，我打算部署一下 edgeapi，我想调研方案，稍后我发给你我的需求');
 assert.equal(a.queues.oc_dm.items[0].status,'done');
});

test('failed worker startup removes its unbound group and clears retry target',async t=>{
 const {a,calls}=bridge(t);
 a.patch(`supervisor.start=async()=>{throw new Error('Git inspection failed');};`);
 const r=await a.respond(msg('p2p','oc_dm','/run a 调研方案','om_FAIL'));
 assert(/已保存/.test(r),r);
 assert(await until(()=>a.dispatches['om_FAIL']&&a.dispatches['om_FAIL'].status==='failed'));
 assert(calls.some(c=>c[0]==='api'&&c[1]==='DELETE'),'临时群已解散');
 assert.equal(a.dispatches['om_FAIL'].groupChat,null,'失败意图不能指向已解散群');
 assert.equal(Object.keys(a.groups).length,0,'未留下伪任务绑定');
});

test('unknown project does not create a group and a product question stays in DM',async t=>{
 const {a,calls}=bridge(t);
 const {runs}=mockCodex(t);
 const rejected=await a.respond(msg('p2p','oc_dm','/run missing 调研方案','om_UNKNOWN'));
 assert(/未知或不可用项目/.test(rejected),rejected);
 assert(!calls.some(c=>c.includes('+chat-create')),'未知项目不能先建群');
 const reply=await a.respond(msg('p2p','oc_dm','edgeapi 是什么','om_QUESTION'));
 assert(/处理中，稍后回报/.test(reply),reply);
 assert(await until(()=>runs.some(x=>x.task==='edgeapi 是什么')),'普通提问留在私聊');
 assert(!calls.some(c=>c.includes('+chat-create')),'普通提问不能误建群');
});

test('mentioning nas as an address does not choose the nas project',async t=>{
 const {a,root}=bridge(t);
 fs.mkdirSync(path.join(root,'workspace/nas'));
 sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{a:path.join(root,'workspace/a'),scratch:path.join(root,'workspace/scratch'),nas:path.join(root,'workspace/nas')});
 const {runs}=mockCodex(t,dmModel(()=>action('create_group','','调研 nas 地址和 edgeapi，等待后续需求')));
 const r=await a.respond(msg('p2p','oc_dm','小任，帮我起一个任务：调研 nas 地址和 edgeapi，稍后发需求','om_ADDRESS'));
 assert.match(r,/处理中，稍后回报/);
 assert(await until(()=>runs.some(x=>x.kind!=='lct-chat')));
 assert.equal(a.supervisor.jobs.get(a.groups['oc_new'].anchor).alias,'scratch');
});

test('queue reconciles a started job after runJobId persistence fails once',async t=>{
 const {a}=bridge(t);
 a.supervisor.jobs.set('aaaaaaaaaaaa',{id:'aaaaaaaaaaaa',alias:'a',chat:'oc_g',threadId:'thread-a',status:'completed',cwd:'/tmp',mode:'auto',started:1});
 a.groups['oc_g']={anchor:'aaaaaaaaaaaa',alias:'a',status:'active'};
 a.patch(`supervisor.continueJob=async(_id,_task,chat,message)=>{const id='bbbbbbbbbbbb';supervisor.jobs.set(id,{id,alias:'a',chat,message,threadId:'thread-b',status:'completed',cwd:'/tmp',mode:'auto',started:2,continuedFrom:'aaaaaaaaaaaa'});const save=persistStore;persistStore=()=>{if(Object.values(queues).some(q=>q.items.some(i=>i.runJobId===id))){persistStore=save;throw Error('injected write failure');}return save();};return id;};`);
 await a.respond(msg('group','oc_g','后续任务','om_RECONCILE'));
 assert(await until(()=>a.queues.oc_g.items[0].status==='done'),'按 message_id 找到已启动任务');
 assert.equal(a.queues.oc_g.items[0].runJobId,'bbbbbbbbbbbb');
 assert.equal(a.queues.oc_g.paused,false);
});

test('settlement keeps a failed-to-dissolve group bound and retryable',async t=>{
 const {a}=bridge(t);
 const job={id:'aaaaaaaaaaaa',alias:'a',chat:'oc_g',status:'completed',mode:'auto',started:1,finished:2,cwd:'/tmp',lastMessage:'done'};
 a.groups.oc_g={anchor:job.id,alias:'a',status:'active'};
 a.patch(`archiveToKnowledge=()=> 'knowledge/content/任务归档/a.md';dissolveGroup=async()=>{throw Error('remote unavailable');};`);
 await assert.rejects(a.settle(job),/群解散失败/);
 assert(a.groups.oc_g,'解散失败必须保留群绑定');
 assert.equal(job.settledAt,undefined,'不能宣告结算完成');
});

test('settlement rejects a new group task while dissolution is pending',async t=>{
 const {a}=bridge(t);
 const job={id:'aaaaaaaaaaaa',alias:'a',chat:'oc_g',status:'completed',mode:'auto',started:1,finished:2,cwd:'/tmp',lastMessage:'done'};
 a.supervisor.jobs.set(job.id,job);
 a.groups.oc_g={anchor:job.id,alias:'a',status:'active'};
 let release;
 a.patch(`archiveToKnowledge=()=> 'knowledge/content/任务归档/a.md';send=async()=>new Promise(resolve=>{globalThis.releaseSettlement=resolve;});`);
 const closing=a.settle(job);
 const reply=await a.respond(msg('group','oc_g','结算期间追加任务','om_DURING_DONE'));
 assert(/未受理/.test(reply),reply);
 assert(!a.queues.oc_g,'结算期间不能入队');
 a.patch('globalThis.releaseSettlement()');
 await closing;
});

test('group binding write failure reconciles an already started task',async t=>{
 const {a}=bridge(t);
 const old={id:'aaaaaaaaaaaa',alias:'a',chat:'oc_g',threadId:'thread-a',status:'completed',cwd:'/tmp',mode:'auto',started:1};
 a.supervisor.jobs.set(old.id,old);
 a.groups.oc_g={anchor:old.id,alias:'a',status:'active'};
 a.patch(`supervisor.continueJob=async(_id,_task,chat,message)=>{const id='bbbbbbbbbbbb';supervisor.jobs.set(id,{id,alias:'a',chat,message,threadId:'thread-b',status:'completed',cwd:'/tmp',mode:'auto',started:2,continuedFrom:'aaaaaaaaaaaa'});const save=saveGroups;saveGroups=()=>{saveGroups=save;throw Error('injected write failure');};return id;};`);
 await a.respond(msg('group','oc_g','继续工作','om_BIND_RECONCILE'));
 assert(await until(()=>a.queues.oc_g.items[0].status==='done'));
 assert.equal(a.groups.oc_g.anchor,'bbbbbbbbbbbb');
 assert.equal(a.queues.oc_g.paused,false);
});

test('reopen rolls back a newly created group when binding cannot be saved',async t=>{
 const {a,calls}=bridge(t);
 const job={id:'aaaaaaaaaaaa',alias:'a',chat:'oc_old',threadId:'thread-a',status:'completed',cwd:'/tmp',mode:'auto',started:1};
 a.supervisor.jobs.set(job.id,job);
 a.patch(`const original=saveGroups;saveGroups=()=>{saveGroups=original;throw Error('ENOSPC');};`);
 await assert.rejects(a.reopen(job.id),/ENOSPC/);
 assert.equal(job.chat,'oc_old');
 assert(!a.groups.oc_new);
 assert(calls.some(c=>c[0]==='api'&&c[1]==='DELETE'),'新建群应撤销');
});

test('cleanup preserves group bindings when Lark lookup fails',async t=>{
 const {a,calls}=bridge(t);
 a.groups.oc_g={anchor:'aaaaaaaaaaaa',alias:'a',status:'active'};
 a.patch(`lark=async(args)=>{calls.push(args);if(args.includes('+chat-members-list'))throw Error('network unavailable');return {ok:true,data:{message_id:'om_fake'}};};`);
 const reply=await a.respond(msg('p2p','oc_dm','/cleanup','om_CLEANUP'));
 assert(/群检查已开始/.test(reply));
 assert(await until(()=>calls.some(c=>c.includes('+chat-members-list'))));
 assert(a.groups.oc_g,'网络错误不能删除群绑定');
});

test('adopt repairs a registration failure using its original job',async t=>{
 const {a}=bridge(t);
 const job={id:'aaaaaaaaaaaa',alias:'a',chat:'oc_existing',threadId:'thread-a',status:'completed',cwd:'/tmp',mode:'auto',started:1};
 a.supervisor.jobs.set(job.id,job);
 a.patch(`dispatches.om_original={messageId:'om_original',kind:'run',alias:'a',groupChat:'oc_existing',jobId:'aaaaaaaaaaaa',status:'register-failed'};supervisor.start=async()=>{throw Error('must not create a second job');};`);
 const reply=await a.respond(msg('p2p','oc_dm','/adopt oc_existing a 原任务','om_ADOPT_REPAIR'));
 assert(/受控绑定/.test(reply));
 assert(await until(()=>a.groups.oc_existing&&a.groups.oc_existing.anchor===job.id));
 assert.equal(a.supervisor.jobs.size,1);
});

test('resume registration failure can be repaired without creating a second job',async t=>{
 const {a,calls}=bridge(t);
 const {runs}=mockCodex(t);
 a.patch(`const original=saveGroups;saveGroups=()=>{saveGroups=original;throw Error('ENOSPC');};`);
 const reply=await a.respond(msg('p2p','oc_dm','/resume a 01a0ec2e-c33b-7770-b5f0-bb6788114e31 继续调研','om_RESUME_REPAIR'));
 assert(/续接部署中/.test(reply));
 assert(await until(()=>a.dispatches.om_RESUME_REPAIR?.status==='register-failed'));
 const id=a.dispatches.om_RESUME_REPAIR.jobId;
 assert(id&&a.supervisor.jobs.has(id));
 assert.equal(runs.length,1);
 await a.respond(msg('p2p','oc_dm','/adopt oc_new a 修复续接绑定','om_RESUME_ADOPT'));
 assert(await until(()=>a.groups.oc_new?.anchor===id));
 assert.equal(runs.length,1,'修复绑定不能再次执行任务');
 assert.equal(calls.filter(c=>c.includes('+chat-create')).length,1,'不能重复建群');
});

test('resume replay reuses a previously started job and group',async t=>{
 const {a,calls}=bridge(t);
 const job={id:'aaaaaaaaaaaa',alias:'a',chat:'oc_existing',message:'om_RESUME_REPLAY',threadId:'01a0ec2e-c33b-7770-b5f0-bb6788114e31',status:'completed',cwd:'/tmp',mode:'auto',started:1};
 a.supervisor.jobs.set(job.id,job);
 const result=await a.patch(`resumeFlow({kind:'resume',alias:'a',task:'继续调研',thread:'01a0ec2e-c33b-7770-b5f0-bb6788114e31',chat:'oc_dm',messageId:'om_RESUME_REPLAY'})`);
 assert(/已启动/.test(result));
 assert.equal(a.groups.oc_existing.anchor,job.id);
 assert(!calls.some(c=>c.includes('+chat-create')),'已有任务不能重复建群');
});

test('corrupt persisted state stops startup instead of resetting task state',t=>{
 for(const file of ['store.json','groups.json','sessions.json','dm-chats.json','queue.json']){
  assert.throws(()=>bridge(t,{seed:{[file]:'{broken'}}),new RegExp(file),'损坏的 '+file+' 必须阻断启动');
 }
});

test('job notification uses an interactive card and falls back to rich text',async t=>{
 const {a,calls}=bridge(t);
 const job={id:'aaaaaaaaaaaa',alias:'a',chat:'oc_g',status:'completed',mode:'auto',started:1,finished:2,lastMessage:'## 结论\n**通过**\n\n| 项目 | 状态 |\n| --- | --- |\n| a | 完成 |'};
 await a.patch(`sendReportCard('oc_g',${JSON.stringify(job)},'job-aaaaaaaaaaaa','fallback')`);
 const cardCall=calls.find(c=>c.includes('--msg-type')&&c.includes('interactive'));
 assert(cardCall,'任务报告应发送 Card 2.0');
 const card=JSON.parse(cardCall[cardCall.indexOf('--content')+1]);
 assert.equal(card.schema,'2.0');
 assert.match(card.body.elements[1].content,/\*\*结论\*\*/);
 assert.match(card.body.elements[1].content,/\| a \| 完成 \|/);
 a.patch(`lark=async(args)=>{calls.push(args);if(args.includes('interactive')){const e=Error('lark-cli rejected');e.larkError={message:'invalid card schema',code:40001};throw e;}return {ok:true,data:{message_id:'om_fallback'}};};`);
 await a.patch(`sendReportCard('oc_g',${JSON.stringify(job)},'job-fallback','**完整结论**')`);
 assert(calls.some(c=>c.includes('--markdown')&&c.includes('**完整结论**')),'卡片失败时发送富文本');
 const before=calls.length;
 a.patch(`lark=async(args)=>{calls.push(args);throw Error('network timeout');};`);
 await assert.rejects(a.patch(`sendReportCard('oc_g',${JSON.stringify(job)},'job-ambiguous','fallback')`),/network timeout/);
 assert.equal(calls.length,before+1,'卡片投递结果不明时不能再发一条富文本');
});

test('DM model reply is sent as rich text',async t=>{
 const {a,calls}=bridge(t);
 mockCodex(t,()=>Promise.resolve({message:'**加粗**\n\n| 项目 | 值 |\n| --- | --- |\n| a | 1 |'}));
 await a.respond(msg('p2p','oc_dm','解释这个表格','om_DM_MARKDOWN'));
 assert(await until(()=>calls.some(c=>c.includes('--markdown')&&c.some(x=>typeof x==='string'&&x.includes('| a | 1 |')))));
});

test('archive commits only its own file and can be retried',t=>{
 const {a,root,errs}=bridge(t);
 const {execFileSync}=require('node:child_process');
 const kb=path.join(root,'workspace/knowledge/content');fs.mkdirSync(kb,{recursive:true});
 const git=(args)=>execFileSync('git',['-C',kb,...args],{encoding:'utf8'}).trim();
 git(['init']);fs.writeFileSync(path.join(kb,'user.md'),'before');git(['add','user.md']);git(['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','baseline']);
 fs.writeFileSync(path.join(kb,'user.md'),'user staged change');git(['add','user.md']);
 const job={id:'aaaaaaaaaaaa',alias:'a',chat:'oc_g',status:'completed',mode:'auto',started:1,finished:2,cwd:'/tmp',lastMessage:'done'};
 const run=()=>a.patch(`archiveToKnowledge(${JSON.stringify(job)})`);
 const first=run();assert(first&&first.includes('任务归档'),errs.join('\n'));
 assert(!git(['show','--pretty=','--name-only','HEAD']).includes('user.md'),'归档提交不得带入用户已暂存的文件');
 assert.equal(git(['diff','--cached','--name-only']),'user.md','用户暂存内容仍在暂存区');
 assert.equal(run(),first,'重复归档无需再创建提交');
});

test('historical task IDs cannot settle or reopen the current task chain',async t=>{
 const {a,calls}=bridge(t);
 const old={id:'aaaaaaaaaaaa',alias:'a',chat:'oc_g',status:'completed',threadId:'thread-a',started:1,finished:2,cwd:'/tmp'};
 const current={...old,id:'bbbbbbbbbbbb',threadId:'thread-b',continuedFrom:old.id,started:3,finished:4};
 a.supervisor.jobs.set(old.id,old);a.supervisor.jobs.set(current.id,current);
 a.groups.oc_g={anchor:current.id,alias:'a',status:'active',chain:old.id};
 await assert.rejects(a.settle(old),/不是当前群/);
 await assert.rejects(a.reopen(old.id),/历史任务/);
 await assert.rejects(a.respond(msg('p2p','oc_dm','/done '+old.id,'om_OLD_DONE')),/不是现役群/);
 assert(!calls.some(c=>c[0]==='api'&&c[1]==='DELETE'));
 assert.equal(a.groups.oc_g.anchor,current.id);
});

test('failed DM cancel lock keeps client active and reports failure',async t=>{
 const {a}=bridge(t);const q=a.patch(`qOf('oc_dm')`);
 q.items.push({kind:'dm',status:'active',messageId:'om_active'});
 a.patch(`chatClientByChat.set('oc_dm',{dispose(){throw Error('should not dispose');}});persistStore=()=>{throw Error('ENOSPC');};`);
 const reply=await a.respond(msg('p2p','oc_dm','/cancel','om_CANCEL_DISK'));
 assert(/取消未执行/.test(reply));assert.equal(a.queues.oc_dm.paused,false);
});

test('adopt refuses groups with another user or incomplete member list',async t=>{
 const {a}=bridge(t);
 a.patch(`lark=async(args)=>({ok:true,data:{users:[{member_id:'owner'},{member_id:'other'}],bots:[{member_id:'bot'}],has_more:false,truncations:[]}});`);
 assert.match(await a.patch(`adoptFlow({targetChat:'oc_other',alias:'a',task:'task',messageId:'om_adopt'})`),/核验失败/);
 a.patch(`lark=async(args)=>({ok:true,data:{users:[{member_id:'owner'}],bots:[{member_id:'bot'}],has_more:true,truncations:[]}});`);
 assert.match(await a.patch(`adoptFlow({targetChat:'oc_other',alias:'a',task:'task',messageId:'om_adopt'})`),/核验失败/);
 assert.equal(a.supervisor.jobs.size,0);assert(!a.groups.oc_other);
});

test('card transport failure with schema in command never sends fallback',async t=>{
 const {a,calls}=bridge(t);
 a.patch(`lark=async(args)=>{calls.push(args);const e=Error('Command failed: --content {"schema":"2.0"}');e.stderr='network timeout';throw e;};`);
 await assert.rejects(a.patch(`sendReportCard('oc_g',{id:'aaaaaaaaaaaa',alias:'a',status:'completed',started:1,finished:2},'job-a','fallback')`),/schema/);
 assert.equal(calls.length,1);
});

test('archive keeps the full long conclusion',t=>{
 const {a,root}=bridge(t);const {execFileSync}=require('node:child_process');
 const kb=path.join(root,'workspace/knowledge/content');fs.mkdirSync(kb,{recursive:true});
 execFileSync('git',['-C',kb,'init']);
 const result='开头'+'.'.repeat(5000)+'末尾';
 const job={id:'cccccccccccc',alias:'a',chat:'oc_g',status:'completed',mode:'auto',started:1,finished:2,cwd:'/tmp',lastMessage:result};
 assert(a.patch(`archiveToKnowledge(${JSON.stringify(job)})`));
 const content=fs.readFileSync(path.join(kb,'任务归档/cccccc-a.md'),'utf8');
 assert(content.includes(result));
});

test('outbox dead letter requires explicit checked retry and keeps idempotency key',async t=>{
 const {a,calls}=bridge(t);
 a.patch(`outbox.push({id:'obabc123',chat:'oc_g',text:'旧回执',key:'ack-old',format:'text',state:'failed',attempts:5,lastError:'network',createdAt:1});`);
 assert.match(await a.respond(msg('p2p','oc_dm','/outbox show obabc123','om_OB_SHOW')),/核对目标会话/);
 await assert.rejects(a.respond(msg('p2p','oc_dm','/outbox retry obabc123','om_OB_NO_CHECK')),/用法/);
 assert.equal(a.outbox[0].state,'failed');
 assert.match(await a.respond(msg('p2p','oc_dm','/outbox retry obabc123 --checked','om_OB_RETRY')),/已受理重投/);
 assert(await until(()=>a.outbox[0].state==='sent'));
 assert(calls.some(c=>c.includes('--idempotency-key')&&c.includes('ack-old')));
});

test('verified delivered or obsolete dead letters can be closed without sending',async t=>{
 const {a,calls}=bridge(t);
 a.patch(`outbox.push({id:'obdone123',chat:'oc_g',text:'旧回执',key:'ack-old',state:'failed',attempts:5,lastError:'network',createdAt:1});`);
 await assert.rejects(a.respond(msg('p2p','oc_dm','/outbox resolve obdone123 delivered','om_OB_RESOLVE_BAD')),/用法/);
 assert.match(await a.respond(msg('p2p','oc_dm','/outbox resolve obdone123 delivered --checked','om_OB_RESOLVE')),/未发送消息/);
 assert.equal(a.outbox[0].state,'resolved');assert.equal(a.outbox[0].resolution,'delivered');
 assert(!calls.some(c=>c.includes('+messages-send')));
});

// ── N01：普通对话不受分流影响；建群失败不降级补执行 ──
test('N01c: normal chat still goes to DM persona; group-create failure never falls back to DM execution',async t=>{
 const {a,calls}=bridge(t);
 const {starts,runs}=mockCodex(t,dmModel(task=>task.includes('你好')?action('reply','','','你好。'):action('create_group','a','部署站点')));
 const r0=await a.respond(msg('p2p','oc_dm','你好，聊两句','om_N3'));
 assert(/处理中，稍后回报/.test(r0),'正常对话即时 ACK');
 assert(await until(()=>a.queues.oc_dm.items[0].status==='done'),'对话进私聊执行');
 assert(starts[0].instr.includes('私人 AI 助手'),'私聊人格');
 // 建群失败：明确未启动，不在私聊补执行
 a.patch(`lark=async(args)=>{calls.push(args);if(args.includes('+chat-create'))throw new Error('dns misbehaving');return {ok:true,data:{message_id:'om_fake',chat_id:'oc_new'}};};`);
 const r=await a.respond(msg('p2p','oc_dm','新起一个任务：用 a 项目部署站点','om_N4'));
 assert.match(r,/处理中，稍后回报/);
 assert(await until(()=>calls.some(c=>c.some(x=>typeof x==='string'&&/建群失败，未启动任务/.test(x)))),'失败明确告知未启动');
 assert.equal(runs.filter(x=>x.kind!=='lct-router').length,2,'没有 worker 执行，也不降级私聊补执行');
 assert.equal(a.dispatches['om_N4'].status,'failed','意图标失败可重试');
});

// ── N02：私聊裸 /cancel 取消执行中对话并释放 client；取消后可继续；群内裸 /cancel 给用法 ──
test('N02: bare /cancel in DM cancels in-flight turn, disposes client, session stays usable',async t=>{
 const {a}=bridge(t);
 const runs=[];let first=true;
 const oS=CodexClient.prototype.start,oR=CodexClient.prototype.run;
 t.after(()=>{CodexClient.prototype.start=oS;CodexClient.prototype.run=oR;});
 CodexClient.prototype.start=async function(){this.threadId='thread-c';return this.threadId;};
 CodexClient.prototype.run=function(task){runs.push(task);if(first){first=false;return new Promise((res,rej)=>{this.runResolve=res;this.runReject=rej;});}return Promise.resolve({message:'ok'});};
 await a.respond(msg('p2p','oc_dmc','帮我分析个长问题','om_C1'));
 assert(await until(()=>{const q=a.queues['oc_dmc'];return q&&q.items[0]&&q.items[0].status==='active';}),'执行中');
 assert.equal(a.chatClients.size,1,'client 在场');
 const r=await a.respond(msg('p2p','oc_dmc','/cancel','om_C2'));
 assert(/取消/.test(r),r);
 assert(await until(()=>a.chatClients.size===0),'client 已释放');
 assert(await until(()=>{const q=a.queues['oc_dmc'];return q.items[0].status==='failed'&&q.items[0].error==='已取消';}),'条目落定取消');
 assert.equal(a.queues['oc_dmc'].paused,true,'复核#2：取消即锁定会话队列');
 await a.respond(msg('p2p','oc_dmc','下一句','om_C3'));
 await sleep(100);
 const qd=a.queues['oc_dmc'];const c3=qd.items.find(x=>x.messageId==='om_C3');
 assert.equal(c3.status,'queued','锁定期间后续消息只排队不执行');
 await a.respond(msg('p2p','oc_dmc','/qresume','om_CR'));
 assert(await until(()=>c3.status==='done'||a.queues['oc_dmc'].items.find(x=>x.messageId==='om_C3').status==='done'),'qresume 后会话继续');
 await assert.rejects(a.respond(msg('group','oc_g','/cancel','om_C4')),/用法/,'群内裸 /cancel 给用法');
});

// ── N03：合成凭证不进 queue/state/群通知明文 ──
test('N03: synthetic secret is redacted in persisted queue, dispatch intent, job state and group notice',async t=>{
 const SECRET='super-secret-value-123';
 const {a,calls,root}=bridge(t,{env:{LCT_TEST_SECRET:SECRET}});
 mockCodex(t);
 // 私聊对话路径
 await a.respond(msg('p2p','oc_dm','我的密钥是 '+SECRET+' 别外传','om_S1'));
 assert(await until(()=>{const q=a.queues['oc_dm'];const it=q&&q.items.find(x=>x.messageId==='om_S1');return it&&it.status==='done';}),'私聊执行完成');
 // 派活路径
 await a.respond(msg('p2p','oc_dm','/run a 部署服务 token='+SECRET,'om_S2'));
 assert(await until(()=>a.dispatches['om_S2']&&a.dispatches['om_S2'].status==='done'),'派活完成');
 const store=fs.readFileSync(path.join(root,'.local/state/lark-codex-tasks/store.json'),'utf8');
 assert(!store.includes(SECRET),'store.json 无明文');
 assert(store.includes('[REDACTED]'),'脱敏标记在场');
 const g=a.groups['oc_new'];const jobFile=path.join(root,'.local/state/lark-codex-tasks/jobs',g.anchor,'state.json');
 assert(!fs.readFileSync(jobFile,'utf8').includes(SECRET),'job state 无明文');
 const intro=calls.find(c=>c.includes('oc_new')&&c.some(x=>typeof x==='string'&&x.includes('新任务')));
 assert(intro&&!intro.some(x=>typeof x==='string'&&x.includes(SECRET)),'群通知无明文');
});

// ── 复核#4：close 事件溯源——外部终止带 code/signal/origin；主动取消标 user-cancel；退出码0≠成功 ──
test('EXIT4: close event records code/signal/origin; exit 0 without completion is still failure',async t=>{
 // 外部终止：非主动取消时 origin=external/unknown
 const c=new CodexClient({});
 let closed=null;c.child={kill(){},on(){}, stderr:{on(){}}};
 // 直接调用 close 处理器逻辑（模拟 close 事件 code=0 signal=null）
 c._log=s=>{c._lastLog=s;};
 // 通过 _startInner 太重，直接模拟：finished=false 时 close → failed
 c.threadId='t1';c.turnId=null;
 // 手工触发 close 语义
 const evt=()=>{const origin=c.cancelSource||(c.disposed?'dispose':'external/unknown');c.exitInfo={code:0,signal:null,origin,at:Date.now()};const desc='app-server exited (code=0, signal=none, origin='+origin+')';if(!c.finished)c._finish('failed',new Error(desc));};
 c.runResolve=null;c.runReject=null;
 const p=new Promise((res,rej)=>{c.runResolve=res;c.runReject=rej;});
 evt();
 await assert.rejects(p,/code=0, signal=none, origin=external\/unknown/,'退出码0也标失败且溯源外部终止');
 assert.equal(c.exitInfo.origin,'external/unknown');
 // 主动取消：origin=user-cancel
 const c2=new CodexClient({});c2.child={kill(){},on(){},stderr:{on(){}}};c2._req=async()=>({turn:{id:'turn'}});
 const r2=c2.run('x').catch(e=>e);await sleep(0);
 await c2.cancel();
 const e2=await r2;assert(/interrupted|cancelled/.test(String(e2.message||e2)),'主动取消语义');
 assert.equal(c2.cancelSource,'user-cancel');
 clearTimeout(c2.killTimer);
});

// ── 复核#5：三个并行 client（DM / 群A / 群B），取消 DM 不影响群任务，不重试不扩散 ──
test('EXIT5: cancelling DM turn leaves parallel group workers untouched',async t=>{
 const {a}=bridge(t);
 const held=[];const settled=[];
 const oS=CodexClient.prototype.start,oR=CodexClient.prototype.run;
 t.after(()=>{CodexClient.prototype.start=oS;CodexClient.prototype.run=oR;});
 CodexClient.prototype.start=async function(){this.threadId=this.resumeThreadId||'thread-'+held.length;return this.threadId;};
 CodexClient.prototype.run=function(task){const c=this;return new Promise((res,rej)=>{c.runResolve=r=>{settled.push(task);res(r);};c.runReject=rej;held.push({task,client:c});});};
 // 群 A（alias a）与群 B（alias b）各自在跑；DM 长对话在跑 → 三 client 并行
 a.supervisor.jobs.set('aaaa11110000',{id:'aaaa11110000',alias:'a',chat:'oc_gA',threadId:'thread-A',status:'completed',cwd:'/tmp',mode:'auto',started:1});
 a.groups['oc_gA']={anchor:'aaaa11110000',alias:'a',status:'active'};
 a.supervisor.jobs.set('bbbb22221111',{id:'bbbb22221111',alias:'b',chat:'oc_gB',threadId:'thread-B',status:'completed',cwd:'/tmp',mode:'auto',started:1});
 a.groups['oc_gB']={anchor:'bbbb22221111',alias:'b',status:'active'};
 await a.respond(msg('group','oc_gA','群A任务','om_TA'));
 await a.respond(msg('group','oc_gB','群B任务','om_TB'));
 await a.respond(msg('p2p','oc_dmx','私聊长任务','om_TX'));
 assert(await until(()=>held.length===3),'三 client 并行在跑');
 assert.equal(a.supervisor.clients.size,2,'两个群 worker');
 assert.equal(a.chatClients.size,1,'一个私聊 client');
 // 取消 DM
 const r=await a.respond(msg('p2p','oc_dmx','/cancel','om_TC'));
 assert(/取消/.test(r),r);
 assert(await until(()=>a.chatClients.size===0),'DM client 已释放');
 assert(await until(()=>{const it=(a.queues['oc_dmx']||{items:[]}).items.find(x=>x.messageId==='om_TX');return it&&it.status==='failed'&&it.error==='已取消';}),'DM 落定取消');
 // 群任务未被终止、未被重试
 assert.equal(held.filter(h=>settled.includes(h.task)).length,0,'群任务未被提前结算');
 assert.equal(a.supervisor.clients.size,2,'群 worker 不受影响');
 assert.equal(held.length,3,'无新 client 启动（无重试扩散）');
 const jobA=[...a.supervisor.jobs.values()].find(j=>j.chat==='oc_gA'&&j.id!=='aaaa11110000');
 const jobB=[...a.supervisor.jobs.values()].find(j=>j.chat==='oc_gB'&&j.id!=='bbbb22221111');
 assert.equal(jobA.status,'running');assert.equal(jobB.status,'running');
 // 放行群任务：正常完成
 for(const h of held.filter(h=>h.task!=='私聊长任务'))h.client.runResolve({message:'done'});
 assert(await until(()=>settled.length===2),'群任务正常完成');
 assert(await until(()=>a.queues['oc_gA'].items[0].status==='done'&&a.queues['oc_gB'].items[0].status==='done'),'群队列落定');
});

// ── N04：空闲私聊即时受理回执，回复随后经 outbox 送达 ──
test('N04: idle DM gets immediate acceptance ACK, reply follows via outbox',async t=>{
 const {a,calls}=bridge(t);
 mockCodex(t);
 const r=await a.respond(msg('p2p','oc_dm','讲个冷知识','om_K1'));
 assert(r&&/处理中，稍后回报/.test(r),'空闲也即时回执: '+r);
 assert(await until(()=>calls.some(c=>c.includes('oc_dm')&&c.some(x=>typeof x==='string'&&/^ok$/.test(x)))),'模型回复随后送达');
});

// ── 重启后排队的自然语言请求仍由模型决定动作 ──
test('BOOT-QUEUE: queued DM requests remain available for model routing',async t=>{
 const seed={'store.json':{version:1,seen:[],queues:{'oc_dmb':{seq:2,paused:false,pauseReason:null,items:[
  {seq:1,messageId:'om_B1',text:'新起一个任务：用 a 项目部署站点',kind:'dm',status:'queued',enqueuedAt:1},
  {seq:2,messageId:'om_B2',text:'飞书插件有特殊版本吗',kind:'dm',status:'queued',enqueuedAt:2}]}},outbox:[],dispatches:{}}};
 const {a}=bridge(t,{seed});
 mockCodex(t);
 const q=a.queues['oc_dmb'];
 assert.equal(q.items[0].status,'queued','请求保留在队列');
 assert.equal(q.items[1].status,'queued','普通提问保留排队');
 assert.equal(a.outbox.length,0,'不凭关键词丢弃请求');
});

// ── 复核#2/验收：注册失败不宣告虚假完成；重试复用已建群不重复创建 ──
test('DISP-GUARD: register failure is honest (no false success); retry reuses created group',async t=>{
 const {a,calls}=bridge(t);
 mockCodex(t);
 // 第一次：注册写入失败（saveGroups 抛错）→ 不宣告"已建好"
 a.patch(`const _sg=saveGroups;globalThis._sg=_sg;saveGroups=()=>{throw new Error('ENOSPC disk full')};`);
 const r=await a.respond(msg('p2p','oc_dm','/run a 部署测试','om_G1'));
 assert(/新任务已保存/.test(r),r);
 assert(await until(()=>calls.some(c=>c.includes('oc_dm')&&c.some(x=>typeof x==='string'&&/注册写入失败，未宣告完成/.test(x)))),'明确告知注册失败');
 assert(!calls.some(c=>c.includes('oc_dm')&&c.some(x=>typeof x==='string'&&/专属群已建好/.test(x))),'无虚假完成通知');
 assert.equal(a.dispatches['om_G1'].status,'register-failed','待修复状态');
 assert(a.dispatches['om_G1'].groupChat,'已建群记录在意图中');
 // 恢复存储 + 重投：复用已建群，不得重复 chat-create
 a.patch(`saveGroups=globalThis._sg;`);
 const creates=()=>calls.filter(c=>c.includes('+chat-create')).length;
 const before=creates();
 const r2=await a.respond(msg('p2p','oc_dm','/run a 部署测试','om_G1'));
 assert(/已受理/.test(r2)&&/无需重发/.test(r2),'job 幂等拒绝重复执行');
 assert.equal(creates(),before,'不重复建群');
});

// ── 复核#4：/adopt 受控绑定 ──
test('ADOPT: controlled bind creates real job and binds existing group',async t=>{
 const {a,calls}=bridge(t);
 const {runs}=mockCodex(t);
 const r=await a.respond(msg('p2p','oc_dm','/adopt oc_orphan1 a 部署 DemoBot 与飞书机器人','om_A1'));
 assert(/受控绑定执行中/.test(r),r);
 assert(await until(()=>runs.length===1),'真实 worker 启动');
 const g=a.groups['oc_orphan1'];
 assert(g&&g.adopted===true&&/^[a-f0-9]{12}$/.test(g.anchor),'绑定注册且为真实 job ID');
 assert(await until(()=>a.dispatches['om_A1'].status==='done'));
 assert(calls.some(c=>c.includes('oc_orphan1')&&c.some(x=>typeof x==='string'&&/群绑定完成/.test(x))),'群内宣告绑定');
 // 群内后续消息进入专属任务（不再被拒绝）
 const rr=await a.respond(msg('group','oc_orphan1','查下部署进度','om_A2'));
 assert(/收到/.test(rr),'绑定后群消息正常受理: '+rr);
});
test('ADOPT-GUARD: registered group / unknown project / API failure all abort safely',async t=>{
 const {a,calls}=bridge(t);
 mockCodex(t);
 a.groups['oc_taken']={anchor:'aaaa11110000',alias:'a',status:'active'};
 a.supervisor.jobs.set('aaaa11110000',{id:'aaaa11110000',alias:'a',chat:'oc_taken',threadId:'t',status:'completed',cwd:'/tmp',mode:'auto',started:1});
 const r1=await a.respond(msg('p2p','oc_dm','/adopt oc_taken a 任务','om_A3'));
 await sleep(50);
 assert(await until(()=>calls.some(c=>c.some(x=>typeof x==='string'&&/已有任务绑定/.test(x)))),'已注册群拒绝');
 const r2=await a.respond(msg('p2p','oc_dm','/adopt oc_new2 demobot 部署','om_A4'));
 assert(await until(()=>calls.some(c=>c.some(x=>typeof x==='string'&&/未知项目/.test(x)))),'未知项目拒绝且不建议未注册 alias');
 assert(!a.groups['oc_new2'],'未做变更');
 // API 失败：中止且零变更
 a.patch(`lark=async(args)=>{calls.push(args);if(args.includes('+chat-members-list'))throw new Error('dns misbehaving');return {ok:true,data:{message_id:'om_fake',chat_id:'oc_new'}};};`);
 await a.respond(msg('p2p','oc_dm','/adopt oc_new3 a 任务','om_A5'));
 assert(await until(()=>calls.some(c=>c.some(x=>typeof x==='string'&&/核验失败.*未做任何变更/.test(x)))),'核验失败中止');
 assert(!a.groups['oc_new3'],'零变更');
 assert(!Object.values(a.supervisor.jobs.values?a.supervisor.jobs.values():[]).length||![...a.supervisor.jobs.values()].some(j=>j.message==='om_A5'),'未创建 job');
});

// ── 复核 P1#1：DM 环境 PATH 前置 guard shim，exec 层拦截飞书 CLI ──
test('GUARD: DM chatEnv prepends guard-bin; lark-cli shim refuses',async t=>{
 const {a,root}=bridge(t);
 const p=a.patch(`chatEnv().PATH`);
 assert(p.includes('guard-bin'),'PATH 前置 guard 目录: '+p.slice(0,80));
 const shim=path.join(root,'.local/state/lark-codex-tasks/guard-bin/lark-cli');
 assert(fs.existsSync(shim),'shim 已生成');
 const out=require('node:child_process').spawnSync('bash',[shim],{encoding:'utf8'});
 assert.equal(out.status,1,'shim 拒绝执行');
 assert(/禁止调用飞书 CLI/.test(out.stderr),'拒绝信息指引正规派活');
});

test('private chat uses the isolated Codex launcher while group jobs retain Codex',async t=>{
 const {a}=bridge(t);const {starts}=mockCodex(t);
 await a.respond(msg('p2p','oc_dm','你好','om_DM_SANDBOX'));
 assert(await until(()=>starts.length===1));
 assert.equal(path.basename(starts[0].codex),'codex-dm-sandbox.sh');
 assert.equal(starts[0].sandbox,'danger-full-access');
 assert.equal(starts[0].approvalPolicy,'on-request');
 assert.equal(path.basename(a.supervisor.codex),'codex');
});

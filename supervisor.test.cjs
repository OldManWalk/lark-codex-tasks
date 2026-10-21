const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Supervisor,parse,parseRun,projects,redact,atomic,worktreeFor,MODES}=require('./supervisor.cjs');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'lct-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);for(const n of ['a','b','c'])fs.mkdirSync(path.join(workspace,n));const config=path.join(root,'projects.json');atomic(config,Object.fromEntries(['a','b','c'].map(n=>[n,path.join(workspace,n)])));const clients=[];const sent=[];const s=new Supervisor({state:path.join(root,'jobs'),config,root:workspace,env:{TEST_API_KEY:'secret-api-value',LCT_PLATFORM:'linux'},codex:'codex',send:async(...a)=>sent.push(a),
 clientFactory:(o)=>{const c={o,started:false,approvals:[],async start(){this.started=true;clients.push(this);return 'thread-'+clients.length;},run(task){this.task=task;return this.p=new Promise((res,rej)=>{this.resolve=res;this.reject=rej;});},async cancel(){this.cancelled=true;},_approve(m,p,r){this.approvals.push([m,p,r]);this.o.onApproval(m,p,r);}};return c;}});return {s,clients,sent,config,workspace};}
test('command parsing accepts slash commands, rejects junk',()=>{assert.deepEqual(parse('/run scratch do\nthing'),{cmd:'/run',alias:'scratch',task:'do\nthing'});assert.deepEqual(parse('/done'),{cmd:'/done'});assert.throws(()=>parse('/run /tmp hi'));assert.throws(()=>parse('/ping x'));assert.throws(()=>parse('x'.repeat(9000)));assert.deepEqual(parse('not a command'),{cmd:null,natural:true});assert.deepEqual(parse('/tmp/doc.md 看下复核建议'),{cmd:null,natural:true},'R08: 路径开头正文返回 natural 标记，不抛内部标记');assert.throws(()=>parse('/unknown'),/未知命令/);assert.deepEqual(parse('/qdrop 3'),{cmd:'/qdrop',seq:3});assert.deepEqual(parse('/adopt oc_ab12 a 部署x'),{cmd:'/adopt',chat:'oc_ab12',alias:'a',task:'部署x'});assert.deepEqual(parse('/auditgroups'),{cmd:'/auditgroups'});assert.throws(()=>parse('/adopt oc_a b'));});
test('natural dispatch parses alias, task and mode flags',()=>{assert.deepEqual(parseRun('crashai 修复登录 --yolo'),{alias:'crashai',task:'修复登录',mode:'yolo'});assert.deepEqual(parseRun('handoff write docs'),{alias:'handoff',task:'write docs',mode:'auto'});assert.equal(parseRun('BADALIAS x'),null);assert.equal(parseRun('x'),null);});
test('scratch creates an empty private directory even with a malformed Git placeholder',t=>{const f=fixture(t),scratch=path.join(f.workspace,'scratch');fs.mkdirSync(scratch);fs.mkdirSync(path.join(scratch,'.git'));fs.writeFileSync(path.join(scratch,'existing.txt'),'other task');const w=worktreeFor(scratch,f.workspace,'scratch','aaaaaaaaaaaa');assert.notEqual(w.cwd,fs.realpathSync(scratch));assert.deepEqual(fs.readdirSync(w.cwd),[]);assert.equal(fs.readFileSync(path.join(scratch,'existing.txt'),'utf8'),'other task');assert.throws(()=>worktreeFor(scratch,f.workspace,'scratch','aaaaaaaaaaaa'),/EEXIST/);});
test('two scratch groups run with separate threads under the global worker limit',async t=>{
 const {s,clients,workspace,config}=fixture(t),scratch=path.join(workspace,'scratch');
 fs.mkdirSync(scratch);atomic(config,{a:path.join(workspace,'a'),scratch});
 const first=await s.start('scratch','DemoBot task','oc_demobot','om_s1');
 const second=await s.start('scratch','VPS research','oc_vps','om_s2');
 assert.notEqual(s.jobs.get(first).threadId,s.jobs.get(second).threadId);
 assert.equal(s.jobs.get(first).chat,'oc_demobot');
 assert.equal(s.jobs.get(second).chat,'oc_vps');
 assert.notEqual(s.jobs.get(first).cwd,s.jobs.get(second).cwd);fs.writeFileSync(path.join(s.jobs.get(first).cwd,'first-only.txt'),'keep');assert(!fs.existsSync(path.join(s.jobs.get(second).cwd,'first-only.txt')));
 await assert.rejects(s.start('scratch','third task','oc_third','om_s3'),/已有 2 个任务/);
 clients[0].resolve({message:'done'});await new Promise(r=>setImmediate(r));
 const followup=await s.continueJob(first,'continue','oc_demobot','om_s4');
 assert.notEqual(s.jobs.get(followup).threadId,s.jobs.get(second).threadId);
 assert.equal(s.jobs.get(followup).cwd,s.jobs.get(first).cwd);assert.equal(fs.readFileSync(path.join(s.jobs.get(followup).cwd,'first-only.txt'),'utf8'),'keep');
 clients[1].resolve({message:'done'});clients[2].resolve({message:'done'});
});
test('projects rejects symlink escape and non-object config',t=>{const f=fixture(t);fs.symlinkSync(os.tmpdir(),path.join(f.workspace,'escape'));atomic(f.config,{escape:path.join(f.workspace,'escape')});assert.throws(()=>projects(f.config,f.workspace));atomic(f.config,[]);assert.throws(()=>projects(f.config,f.workspace));});
test('start uses client with mode policies, per-project lock, completion report',async t=>{const {s,clients,sent}=fixture(t);
 const a=await s.start('a','hello','oc_test','om_1');await assert.rejects(s.start('a','again','oc_test','om_2'));await s.start('b','task','oc_test','om_3');assert(clients[0].o.threadParams.sandbox==='danger-full-access'&&clients[0].o.threadParams.approvalPolicy==='on-request');
 clients[1].resolve({message:'b done'});await new Promise(r=>setImmediate(r));
 const y=await s.start('c','task --yolo','oc_test','om_5',{mode:'yolo'});assert(clients[2].o.threadParams.sandbox==='danger-full-access'&&clients[2].o.threadParams.approvalPolicy==='never');
 clients[0].resolve({message:'done-msg'});await new Promise(r=>setImmediate(r));assert.equal(s.jobs.get(a).status,'completed');
 clients[2].reject(new Error('boom'));await new Promise(r=>setImmediate(r));assert.equal(s.jobs.get(y).status,'failed');});
test('approval callback routed to onApproval handler',async t=>{const {s,clients}=fixture(t);let asked=null;s.onApproval=(job,m,p,respond)=>{asked={job,m,p};respond('decline');};
 await s.start('a','task','oc_test','om_1');clients[0]._approve('item/commandExecution/requestApproval',{cmd:'sudo rm -rf /'},()=>{});
 await new Promise(r=>setImmediate(r));assert(asked&&asked.m.includes('requestApproval'));assert.equal(asked.job.alias,'a');});
test('cancel interrupts client and waits',async t=>{const {s,clients}=fixture(t);const id=await s.start('a','task','oc_test','om_1');assert.throws(()=>s.cancel('ffffffffffff'));s.cancel(id);assert.equal(s.jobs.get(id).status,'cancelling');clients[0].resolve({message:''});await new Promise(r=>setImmediate(r));assert.equal(s.jobs.get(id).status,'cancelled');});
test('client startup failure is reported as failure instead of a started task',async t=>{const {s}=fixture(t);
 s.clientFactory=()=>({async start(){throw Error('startup failed');}});
 await assert.rejects(s.start('a','task','oc_test','om_START_FAIL'),/startup failed/);
 const j=[...s.jobs.values()].find(x=>x.message==='om_START_FAIL');
 assert.equal(j.status,'failed');assert.equal(j.notifyPending,false);assert.equal(s.clients.size,0);
});
test('network failure after turn submission does not replay the task',async t=>{const {s,clients}=fixture(t);
 const id=await s.start('a','mutating task','oc_test','om_NETWORK');
 clients[0].turnSubmitted=true;
 clients[0].reject(new Error('network stream reset'));
 await new Promise(r=>setImmediate(r));
 assert.equal(s.jobs.get(id).status,'failed');assert.equal(clients.length,1);assert.equal(s.jobs.get(id).retried,false);
});
test('completion report passes the full saved conclusion and job to the sender',async t=>{
 const {s,clients,sent}=fixture(t);
 const id=await s.start('a','task','oc_test','om_REPORT');
 const conclusion='开头'+'.'.repeat(900)+'末尾';
 clients[0].resolve({message:conclusion});
 await new Promise(r=>setImmediate(r));
 await s.flush();
 const report=sent.find(x=>x[2]==='job-'+id);
 assert(report&&report[1].includes('末尾'),'结论不能在 600 字处截断');
 assert.equal(report[3].id,id,'发送端拿到结构化任务状态以构造卡片');
});
test('completion saves long conclusions without dropping their beginning',async t=>{
 const {s,clients}=fixture(t);
 const id=await s.start('a','task','oc_test','om_LONG');
 const conclusion='开头'+'.'.repeat(9000)+'末尾';
 clients[0].resolve({message:conclusion});
 await new Promise(r=>setImmediate(r));
 assert.equal(s.jobs.get(id).lastMessage,conclusion);
});
test('terminal save failure holds the job and queue until durable retry',async t=>{
 const {s,clients}=fixture(t);let settled=0;s.onSettled=()=>settled++;
 const id=await s.start('a','task','oc_test','om_DISK');
 const original=s.jobs.get(id);
 const save=s.save.bind(s);let fail=true;s.save=j=>{if(j.id===id&&j.status==='completed'&&fail)throw Error('ENOSPC');return save(j);};
 clients[0].resolve({message:'done'});await new Promise(r=>setImmediate(r));
 assert.equal(s.jobs.get(id).status,'running');assert.equal(s.clients.has(id),true);assert.equal(settled,0);
 assert.throws(()=>s.cancel(id),/终态正在等待存储恢复/);
 fail=false;s._commitTerminal(id);await new Promise(r=>setImmediate(r));
 assert.equal(s.jobs.get(id).status,'completed');assert.equal(s.clients.has(id),false);assert.equal(settled,1);
 assert.equal(s.jobs.get(id),original,'已有回调持有的 job 引用保持有效');
 assert.equal(JSON.parse(fs.readFileSync(path.join(s.state,id,'state.json'))).status,'completed');
});
test('restart interrupts old jobs and retries failed notification',async t=>{const {s}=fixture(t);const id=await s.start('a','task','oc_test','om_1');const recovered=new Supervisor({state:s.state,env:{LCT_PLATFORM:'linux'},send:async()=>{throw Error('offline');}});assert.equal(recovered.jobs.get(id).status,'interrupted');await recovered.flush();assert.equal(recovered.jobs.get(id).notifyPending,true);recovered.send=async()=>{};await recovered.flush();assert.equal(recovered.jobs.get(id).notifyPending,false);});
test('redact before truncating avoids exposing literal env secrets',()=>{const out=redact('secret-api-value password=hello sk-1234567890abcdef',{TEST_API_KEY:'secret-api-value'});assert(!out.includes('secret-api-value'));assert(!out.includes('hello'));assert(!out.includes('sk-'));assert(redact('a'.repeat(5000),{},100).length<130);});
test('git worktree isolates HEAD and supports base branch continuation',t=>{const {execFileSync}=require('node:child_process');const f=fixture(t),repo=path.join(f.workspace,'a'),content=path.join(repo,'content');fs.mkdirSync(content);fs.writeFileSync(path.join(content,'note.md'),'baseline\n');const git=args=>execFileSync('git',['-C',repo,...args],{stdio:'pipe'});git(['init']);git(['add','.']);git(['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','baseline']);
 const w=worktreeFor(content,f.workspace,'a','aaaaaaaaaaaa');assert.equal(w.branch,'agent/aaaaaaaaaaaa');assert.equal(fs.readFileSync(path.join(w.cwd,'note.md'),'utf8'),'baseline\n');
 fs.writeFileSync(path.join(w.cwd,'note.md'),'worker change');const c1=execFileSync('git',['-C',w.worktree,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const w2=worktreeFor(content,f.workspace,'a','bbbbbbbbbbbb',w.branch);assert.notEqual(w2.baseCommit,c1);assert.equal(fs.readFileSync(path.join(w2.cwd,'note.md'),'utf8'),'worker change');
 const scratchRepo=worktreeFor(content,f.workspace,'scratch','dddddddddddd');assert.equal(scratchRepo.branch,'agent/dddddddddddd','有效 Git 仓库仍应隔离');
 fs.writeFileSync(path.join(content,'dirty.md'),'unsaved');assert.throws(()=>worktreeFor(content,f.workspace,'a','cccccccccccc'),/未提交/);});

test('session chain root is stable beyond 200 continuations and cycles are rejected',t=>{
 const {s}=fixture(t);let prev=null;for(let i=0;i<220;i++){const j={id:i.toString(16).padStart(12,'0'),continuedFrom:prev};s.jobs.set(j.id,j);prev=j.id;assert.equal(s.chainId(j),'000000000000');}
 s.jobs.get('000000000000').continuedFrom=prev;assert.throws(()=>s.chainId(s.jobs.get(prev)),/循环/);
});
test('legacy shared-directory sessions continue in their original cwd',async t=>{
 const {s,clients,workspace}=fixture(t);const cwd=path.join(workspace,'a');fs.writeFileSync(path.join(cwd,'legacy.txt'),'existing');const j={id:'aaaaaaaaaaaa',alias:'a',chat:'oc_legacy',threadId:'thread-legacy',cwd,status:'completed',started:1};s.jobs.set(j.id,j);const id=await s.continueJob(j.id,'continue','oc_legacy','om_next');assert.equal(s.jobs.get(id).cwd,cwd);assert.equal(clients[0].o.resumeThreadId,'thread-legacy');assert.equal(fs.readFileSync(path.join(cwd,'legacy.txt'),'utf8'),'existing');clients[0].resolve({message:'done'});
});

test('cancel persistence failure restores running state and never interrupts client',async t=>{
 const {s,clients}=fixture(t);const id=await s.start('a','task','oc_stop_save','om_stop_save');const save=s.save;s.save=()=>{throw Error('disk full');};
 assert.throws(()=>s.cancel(id),/disk full/);assert.equal(s.jobs.get(id).status,'running');assert.equal(clients[0].cancelled,undefined);s.save=save;clients[0].resolve({message:'ok'});await new Promise(r=>setImmediate(r));
});
test('stop confirmation failure keeps cancelling and blocks replacement until a successful explicit retry',async t=>{
 const {s,clients}=fixture(t);const id=await s.start('a','task','oc_stop_unknown','om_stop_unknown');clients[0].waitForStop=async()=>{throw Error('stop timeout');};
 s.cancel(id);await new Promise(r=>setImmediate(r));assert.equal(s.jobs.get(id).status,'cancelling');assert.equal(s.clients.size,1);assert.match(s.jobs.get(id).stopError,/stop timeout/);
 await assert.rejects(s.continueJob(id,'new','oc_stop_unknown','om_new'),/还在运行/);
 clients[0].waitForStop=async()=>{};s.cancel(id);await new Promise(r=>setImmediate(r));assert.equal(s.jobs.get(id).status,'cancelled');assert.equal(s.jobs.get(id).stopConfirmed,true);
});
test('Codex stop confirmation waits for process close instead of finished-turn status',async()=>{
 const {CodexClient}=require('./codex-client.cjs'),{EventEmitter}=require('node:events');const c=new CodexClient({});c.child=new EventEmitter();c.finished=true;
 let confirmed=false;const wait=c.waitForStop(1000).then(()=>confirmed=true);await new Promise(r=>setImmediate(r));assert.equal(confirmed,false);c.child.emit('close',0,null);await wait;assert.equal(confirmed,true);
 const d=new CodexClient({});d.child=new EventEmitter();await assert.rejects(d.waitForStop(5),/停止确认超时/);assert.equal(d.child.listenerCount('close'),0);
});

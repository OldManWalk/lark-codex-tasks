const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CodexClient}=require('./codex-client.cjs');
const {Supervisor,atomic}=require('./supervisor.cjs');
const {buildReportCard}=require('./report-card.cjs');
const {classifyFailure,failureHint}=require('./task-failure.cjs');
const tick=()=>new Promise(r=>setImmediate(r));
const overload='rate limit exceeded: The engine is currently overloaded, please try again later';
function fakeClient(){const logs=[],c=new CodexClient({onLog:s=>logs.push(s)});c.threadId='thread-test';c._req=async()=>({turn:{id:'turn-test'}});return {c,logs};}
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lct-provider-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);fs.mkdirSync(path.join(workspace,'scratch'));
 const config=path.join(root,'projects.json');atomic(config,{scratch:path.join(workspace,'scratch')});const clients=[],sent=[];
 const s=new Supervisor({state:path.join(root,'jobs'),root:workspace,config,env:{TEST_API_KEY:'test-secret-value'},codex:'codex',send:async(...a)=>sent.push(a),clientFactory:o=>{
  const c={o,child:{kill(){}},async start(){clients.push(this);return 'thread-test';},run(){return new Promise((res,rej)=>{this.resolve=res;this.reject=rej;});}};return c;
 }});return {s,clients,sent};
}
test('provider overload is distinct from account rate limiting and unrelated failures',()=>{
 assert.equal(classifyFailure(overload),'provider_overloaded');assert.equal(classifyFailure('too many requests'),'rate_limited');assert.equal(classifyFailure('network reset'),null);
});
test('scoped retries remain nonterminal and preserve provider metadata in logs',async()=>{
 const {c,logs}=fakeClient(),r=c.run('test');await tick();
 c._onEvent('error',{threadId:'foreign',willRetry:true,error:{message:'Reconnecting'}});assert.equal(c.providerRetryCount,0);
 for(let n=1;n<=5;n++)c._onEvent('error',{threadId:c.threadId,turnId:c.turnId,willRetry:true,error:{message:'Reconnecting... '+n+'/5',codexErrorInfo:'streamDisconnected'}});
 assert.equal(c.finished,false);assert.equal(c.providerRetryCount,5);assert(logs[4].includes('streamDisconnected'));
 c._onEvent('turn/completed',{turn:{id:c.turnId,status:'completed',items:[]}});await r;
});
test('terminal errors preserve structured metadata, tool state and original message',async()=>{
 const {c,logs}=fakeClient(),r=c.run('test');const rejected=assert.rejects(r,e=>e instanceof Error&&e.message===overload&&e.codexErrorInfo==='usageLimitExceeded'&&e.turnSubmitted&&e.executionStarted);await tick();
 c._onEvent('item/started',{threadId:c.threadId,turnId:c.turnId,item:{type:'commandExecution'}});
 c._onEvent('error',{threadId:c.threadId,turnId:c.turnId,willRetry:false,error:{message:overload,codexErrorInfo:'usageLimitExceeded'}});
 await rejected;assert(logs.some(x=>x.startsWith('[error]')&&x.includes('usageLimitExceeded')));
});
test('turn/completed errors also become real Error objects with metadata',async()=>{
 const {c}=fakeClient(),r=c.run('test');const rejected=assert.rejects(r,e=>e instanceof Error&&e.codexErrorInfo==='usageLimitExceeded');await tick();
 c._onEvent('turn/completed',{turn:{id:c.turnId,status:'failed',error:{message:overload,codexErrorInfo:'usageLimitExceeded'}}});await rejected;
});
test('turn/start timeout is submission-uncertain, not safely replayable',async()=>{
 const {c}=fakeClient();c._req=async()=>{throw Error('request timeout: turn/start');};
 await assert.rejects(c.run('mutating task'),e=>e.turnSubmissionAttempted&&!e.turnSubmitted);assert.equal(c.turnSubmissionAttempted,true);
});
test('turn/started arriving before the request response still records acceptance',async()=>{
 const {c}=fakeClient();let ack;c._req=()=>new Promise(r=>ack=r);const r=c.run('test');
 c._onEvent('turn/started',{threadId:c.threadId,turn:{id:'turn-test'}});assert.equal(c.turnSubmitted,true);
 c._onEvent('turn/completed',{turn:{id:'turn-test',status:'completed',items:[]}});await r;ack({turn:{id:'turn-test'}});await tick();
});
test('submitted overload preserves partial progress without replaying commands',async t=>{
 const {s,clients,sent}=fixture(t),id=await s.start('scratch','task','oc_test','om_test');const c=clients[0];Object.assign(c,{turnSubmitted:true,turnSubmissionAttempted:true,executionStarted:true,providerRetryCount:5,lastMessage:'partial test-secret-value'});
 c.reject(Object.assign(Error(overload),{codexErrorInfo:'usageLimitExceeded'}));await tick();await s.flush();const j=s.jobs.get(id);
 assert.equal(j.failureKind,'provider_overloaded');assert.equal(j.providerRetryCount,5);assert.equal(j.retryBlocked,'turn-submitted');assert.equal(j.retried,false);assert.equal(clients.length,1);assert(!j.lastMessage.includes('test-secret-value'));assert.equal(c.cancelSource,'job-finished');assert(sent.some(x=>x[1].includes('不是建群失败')));
 const card=buildReportCard(j);assert.match(card.body.elements[1].content,/5 次连接重试/);assert.match(card.body.elements[1].content,/本群回复“继续”/);
});
test('supervisor does not replay after turn/start response timeout',async t=>{
 const {s,clients}=fixture(t),id=await s.start('scratch','mutating task','oc_test','om_timeout');clients[0].turnSubmissionAttempted=true;
 clients[0].reject(Error('request timeout: turn/start'));await tick();assert.equal(clients.length,1);assert.equal(s.jobs.get(id).retried,false);assert.equal(s.jobs.get(id).retryBlocked,'submission-uncertain');
});
test('errors are redacted before persistence and reporting',async t=>{
 const {s,clients}=fixture(t),id=await s.start('scratch','task','oc_test','om_secret');clients[0].reject(Error('rate limit exceeded test-secret-value'));await tick();
 const j=s.jobs.get(id);assert(!j.error.includes('test-secret-value'));assert(!fs.readFileSync(path.join(s.state,id,'state.json'),'utf8').includes('test-secret-value'));
});
test('normal failure and success do not get misleading provider recovery hints',()=>{
 assert.equal(failureHint({status:'failed',error:'permission denied'}),'');assert.equal(failureHint({status:'completed',error:overload}),'');
 assert(!failureHint({status:'failed',error:overload}).includes('续接原任务会话'));
 assert.match(failureHint({status:'failed',error:overload,threadId:'t',retryBlocked:'submission-uncertain'}),/尚未确认/);
});

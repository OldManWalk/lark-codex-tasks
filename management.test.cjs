const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createManagement}=require('./management.cjs'),channel=require('./control-channel.cjs'),{startWebStatus}=require('./web-status.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lct-m-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {CFG:{stateDir:dir},env:{},fileEnv:{}};}
async function done(m,id){for(let i=0;i<100;i++){const s=await m.snapshot(true),o=s.operations.find(o=>o.id===id);if(o&&o.status!=='running')return o;await wait(10);}throw Error('operation did not finish');}
function req(port,body,headers={}){return new Promise((resolve,reject)=>{const q=http.request({host:'127.0.0.1',port,path:'/api/actions',method:'POST',headers},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(b)}));});q.on('error',reject);q.end(body);});}
test('M1: public shell contains no instance data; mutations require bearer, JSON and same Origin',async t=>{
 let calls=0;const w=await startWebStatus({port:0,token:'secret',getState:()=>({}),onAction:()=>{calls++;return {id:'one'};},log(){}});t.after(()=>w.close());const valid={Authorization:'Bearer secret',Origin:'http://127.0.0.1:'+w.port,'Content-Type':'application/json'};
 assert.equal((await req(w.port,'{}')).status,401);
 assert.equal((await req(w.port,'{}',{...valid,Origin:'https://evil.example'})).status,403);
 assert.equal((await req(w.port,'{}',{...valid,'Content-Type':'text/plain'})).status,403);
 assert.equal((await req(w.port,'x',valid)).status,400);
 assert.equal((await req(w.port,'x'.repeat(17000),valid)).status,413);
 assert.equal((await req(w.port,'{}',valid)).status,202);assert.equal(calls,1);
});
test('M2: durable operation IDs prevent double execution, including after controller restart',async t=>{
 const ctx=fixture(t);let calls=0;const rpc=async(route)=>route==='/state'?{instance:'a',jobs:[],queues:{},groups:[],outbox:[]}:((calls++),{message:'paused'}),cli=async()=>({running:true});
 const m=createManagement({ctx,cli,rpc}),s=await m.snapshot();const b={requestId:'request_123456',action:'queue.pause',target:'oc_test',expected:s.controlRevision,confirmed:true};
 await m.submit(b);await m.submit(b);assert.equal((await done(m,b.requestId)).status,'succeeded');assert.equal(calls,1);
 const m2=createManagement({ctx,cli,rpc});await m2.submit(b);assert.equal(calls,1);await assert.rejects(m2.submit({...b,target:'oc_other'}),/不同操作/);
});
test('M3: offline snapshots explicitly stale, no mutation; stopped service can start without bridge socket',async t=>{
 const ctx=fixture(t);let running=false;const calls=[];const rpc=async(route)=>{if(!running)throw Error('offline');return {instance:'a',jobs:[],queues:{},groups:[],outbox:[]};};
 const cli=async(cmd)=>{calls.push(cmd);if(cmd==='up')running=true;return {running};};const m=createManagement({ctx,cli,rpc});const s=await m.snapshot();assert.equal(s.stale,true);assert.equal(s.online,false);
 await m.submit({requestId:'request_start1',action:'service.start',expected:s.serviceRevision,confirmed:true});assert.equal((await done(m,'request_start1')).status,'succeeded');assert(calls.includes('up'));assert.equal((await m.snapshot(true)).online,true);
});
test('M4: service stop checks bridge quiescence; failed check never invokes stop',async t=>{
 const ctx=fixture(t),calls=[];const cli=async(cmd)=>(calls.push(cmd),{running:true});const rpc=async(route)=>{if(route==='/state')return {jobs:[],queues:{},groups:[],outbox:[]};throw Error('仍有执行中工作');};const m=createManagement({ctx,cli,rpc}),s=await m.snapshot();
 await m.submit({requestId:'request_stop12',action:'service.stop',expected:s.serviceRevision,confirmed:true});assert.equal((await done(m,'request_stop12')).status,'failed');assert(!calls.includes('down'));
});
test('M5: interrupted operation becomes unknown after restart and never auto replays',async t=>{
 const ctx=fixture(t),dir=path.join(ctx.CFG.stateDir,'management');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'operations.json'),JSON.stringify([{id:'request_crash1',status:'running'}]));let calls=0;const m=createManagement({ctx,cli:async()=>({running:false}),rpc:async()=>{calls++;}});const s=await m.snapshot();assert.equal(s.operations[0].status,'unknown');assert.equal(calls,0);
});
test('M6: private socket works, cannot steal live socket, same action never runs concurrently',async t=>{
 const ctx=fixture(t);let release;const c=await channel.startChannel({stateDir:ctx.CFG.stateDir,getState:()=>({ok:true}),act:()=>new Promise(r=>{release=r;})});t.after(()=>c.close());const socket=channel.socketPath(ctx.CFG.stateDir);assert.equal(fs.statSync(socket).mode&0o777,0o600);assert.deepEqual(await channel.request(socket),{ok:true});
 await assert.rejects(channel.startChannel({stateDir:ctx.CFG.stateDir,getState(){},act(){}}),/已有控制接口/);
 const pending=channel.request(socket,'/action',{action:'pause'});while(!release)await wait(5);await assert.rejects(channel.request(socket,'/action',{action:'pause'}),/正在执行/);release({ok:true});await pending;
});
test('M7: stale service confirmation never runs a lifecycle command',async t=>{
 const ctx=fixture(t),calls=[];const m=createManagement({ctx,cli:async cmd=>(calls.push(cmd),{running:false}),rpc:async()=>{throw Error('offline');}});
 await m.submit({requestId:'request_stale1',action:'service.start',expected:'old',confirmed:true});assert.equal((await done(m,'request_stale1')).status,'failed');assert(!calls.includes('up'));
});

test('M8: workspace result preserves failed/unknown status and payload participates in deduplication',async t=>{
 const ctx=fixture(t);let calls=0;const rpc=async route=>route==='/state'?{instance:'a',jobs:[],queues:{},groups:[],outbox:[]}:(calls++,{status:'unknown',message:'创建结果需核查',documentId:null,requestId:'request_workspace1'});
 const m=createManagement({ctx,cli:async()=>({running:true}),rpc}),s=await m.snapshot();
 const b={requestId:'request_workspace1',action:'workspace.sync',target:'job_one',summary:'计划 A',expected:s.controlRevision,confirmed:true};
 await m.submit(b);const r=await done(m,b.requestId);assert.equal(r.status,'unknown');assert.equal(r.receipt.requestId,b.requestId);
 await m.submit(b);assert.equal(calls,1);await assert.rejects(m.submit({...b,summary:'计划 B'}),/不同操作/);
});

test('M9: edit text participates in durable dedup; private instruction bodies never enter cached snapshots',async t=>{
 const ctx=fixture(t);let calls=0;const rpc=async(route,b)=>route==='/state'?{jobs:[],queues:{},groups:[],outbox:[]}:route==='/instruction'?{text:'private draft',itemRevision:'revision'}:(calls++,{status:'accepted',message:'stopping'});
 const m=createManagement({ctx,cli:async()=>({running:true}),rpc}),s=await m.snapshot();
 assert.equal((await m.instruction({target:'oc_test',seq:1})).text,'private draft');
 const b={action:'instruction.edit',target:'oc_test',seq:1,text:'new draft',itemRevision:'revision',expected:s.controlRevision,requestId:'request_edit_1',confirmed:true};
 await m.submit(b);assert.equal((await done(m,b.requestId)).status,'accepted');await m.submit(b);assert.equal(calls,1);
 await assert.rejects(m.submit({...b,text:'changed draft'}),/不同操作/);
 const files=['snapshot.json','operations.json'].map(n=>fs.readFileSync(path.join(ctx.CFG.stateDir,'management',n),'utf8')).join('');assert(!files.includes('private draft'));assert(!files.includes('new draft'));
});
test('M10: accepted stop receipt becomes confirmed only after live durable reconciliation',async t=>{
 const ctx=fixture(t);let finished=false;const rpc=async route=>route==='/state'?{jobs:[],groups:[],outbox:[],queues:{oc_test:{items:finished?[{lastChange:{requestId:'request_withdraw_1',status:'succeeded',kind:'withdraw',finishedAt:123}}]:[]}}}:{status:'accepted',message:'stopping'};
 const m=createManagement({ctx,cli:async()=>({running:true}),rpc}),s=await m.snapshot();await m.submit({action:'instruction.withdraw',target:'oc_test',seq:1,itemRevision:'revision',expected:s.controlRevision,requestId:'request_withdraw_1',confirmed:true});assert.equal((await done(m,'request_withdraw_1')).status,'accepted');
 finished=true;const after=await m.snapshot(true);assert.equal(after.operations[0].status,'succeeded');assert.match(after.operations[0].message,/已确认停止/);
});
test('M11: instruction detail requires bearer auth and is unavailable through worker socket',async t=>{
 const ctx=fixture(t),server=await channel.startChannel({stateDir:ctx.CFG.stateDir,workspaceOnly:true,workspaceAct:()=>({ok:true}),getInstruction:()=>({text:'must not expose'})});t.after(()=>server.close());
 await assert.rejects(channel.request(channel.workspaceSocketPath(ctx.CFG.stateDir),'/instruction',{target:'job'}),/接口不存在/);
 let reads=0;const w=await startWebStatus({port:0,token:'secret',getState:()=>({}),onInstruction:async()=>{reads++;return {text:'sensitive body'};},log(){}});t.after(()=>w.close());
 const url='http://127.0.0.1:'+w.port+'/api/instruction?target=job';assert.equal((await fetch(url+'\u0026token=secret')).status,401);
 const response=await fetch(url,{headers:{Authorization:'Bearer secret'}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).text,'sensitive body');assert.equal(reads,1);
});

// 故障回归：只使用临时状态与合成 Lark/Codex，不访问真实账号或生产目录。
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {CodexClient}=require('./codex-client.cjs');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lct-recovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const state=path.join(root,'.local/state/lark-codex-tasks');
 for(const dir of [state,path.join(root,'.config/lark-codex-tasks'),path.join(root,'workspace/scratch')])fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(root,'.config/lark-codex-tasks/projects.json'),'{}');
 const proc=new EventEmitter();proc.env={LARK_OWNER_OPEN_ID:'owner',LCT_REACTIONS:'0'};
 const calls=[];const ctx=vm.createContext({require:n=>n==='node:os'?{...os,homedir:()=>root}:require(n),__dirname,module:{},process:proc,console:{log(){},error(){}},setTimeout,clearTimeout,setInterval,clearInterval,calls});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'lark-bridge.cjs'),'utf8')+`
 lark=async args=>{calls.push(args);return {ok:true,data:{message_id:'om_fake'}};};
 globalThis.api={runDmItem,runChatTurn,settle,respond,enqueueItem,txStore,setReact,drainChat,post,sweepAttachments,keepAttachment,
  patch:code=>eval(code),waitReacts:()=>Promise.all([...reactChains.values()]),get queues(){return queues;},get outbox(){return outbox;},get groups(){return groups;},get seen(){return seen;},get dispatches(){return dispatches;},get attachments(){return attachments;},supervisor};
 `,ctx);
 return {a:ctx.api,ctx,root,state,calls};
}
function job(a){const j={id:'job_test',alias:'scratch',chat:'oc_test',status:'completed',started:1,finished:2,threadId:'thread_test'};a.supervisor.jobs.set(j.id,j);a.groups[j.chat]={anchor:j.id,alias:'scratch',status:'active'};return j;}
function settlementMocks(a){a.patch("archiveToKnowledge=()=>'/mock/archive.md'; send=async()=>{}; dissolveGroup=async()=>{};");}
const decision=JSON.stringify({type:'reply',message:'ok',project:'',projectExplicit:false,task:'',title:'',target:''});

test('transaction rollback retains original objects, restores removed items and rolls back callback errors',t=>{
 const {a}=fixture(t);a.enqueueItem('oc_test','dm','first','om_first');a.enqueueItem('oc_test','dm','second','om_second');
 const q=a.queues.oc_test,items=q.items,first=items[0],second=items[1];
 assert.throws(()=>a.txStore(()=>{q.items.splice(0,1);second.status='failed';q.items.push({messageId:'om_new'});a.outbox.push({id:'new'});a.dispatches.intent={status:'pending'};a.seen.add('om_extra');throw Error('callback failed');}),/callback failed/);
 assert.equal(a.queues.oc_test,q);assert.equal(q.items,items);assert.equal(items[0],first);assert.equal(items[1],second);assert.equal(second.status,'queued');assert.equal(a.outbox.length,0);assert.equal(a.dispatches.intent,undefined);assert(!a.seen.has('om_extra'));
});

test('DM completion survives another transaction failing while the turn is in flight',async t=>{
 const {a,ctx,state}=fixture(t);let resolve;ctx.turnGate=new Promise(r=>resolve=r);ctx.decision=decision;
 a.patch('runChatTurn=()=>globalThis.turnGate; runRouteTurn=async()=>globalThis.decision; pump=()=>{};');
 const item=a.enqueueItem('oc_test','dm','hello','om_first').item;item.status='active';
 const running=a.runDmItem('oc_test',item);a.patch('globalThis.savedPersist=persistStore; persistStore=()=>{throw Error("ENOSPC");};');
 assert.throws(()=>a.txStore(()=>{a.queues.oc_test.paused=true;}),/ENOSPC/);a.patch('persistStore=globalThis.savedPersist;');resolve(decision);await running;
 assert.equal(a.queues.oc_test.items[0],item);assert.equal(item.status,'done');assert.equal(a.queues.oc_test.paused,false);
 assert.equal(JSON.parse(fs.readFileSync(path.join(state,'store.json'))).queues.oc_test.items[0].status,'done');
});

test('DM does not retry an attempted submission whose acceptance is unknown',async t=>{
 const {a,ctx}=fixture(t);let runs=0;ctx.run=async()=>{runs++;throw Object.assign(Error('request timeout: turn/start'),{turnSubmissionAttempted:true,turnSubmitted:false});};
 a.patch('runChatTurn=(...args)=>globalThis.run(...args); pump=()=>{};');
 const item=a.enqueueItem('oc_test','dm','mutating task','om_timeout').item;item.status='active';await a.runDmItem('oc_test',item);
 assert.equal(runs,1);assert.equal(item.status,'failed');assert.match(item.error,/是否受理未知/);
});

test('real runChatTurn preserves attempted versus acknowledged submission metadata',async t=>{
 const {a}=fixture(t),originalStart=CodexClient.prototype.start,originalRun=CodexClient.prototype.run,originalDispose=CodexClient.prototype.dispose;
 t.after(()=>{CodexClient.prototype.start=originalStart;CodexClient.prototype.run=originalRun;CodexClient.prototype.dispose=originalDispose;});
 CodexClient.prototype.start=async function(){this.threadId='thread_dm';return this.threadId;};
 CodexClient.prototype.run=function(){this.turnSubmissionAttempted=true;return Promise.reject(Error('request timeout: turn/start'));};CodexClient.prototype.dispose=()=>{};
 await assert.rejects(a.runChatTurn('mutating task','oc_test'),e=>e.turnSubmissionAttempted===true&&e.turnSubmitted===false&&e.phase==='turn');
});

test('cancelled pre-submission error is not retried',async t=>{
 const {a,ctx}=fixture(t);let runs=0;ctx.run=async()=>{runs++;throw Object.assign(Error('network timeout'),{cancelled:true});};a.patch('runChatTurn=()=>globalThis.run();pump=()=>{};');
 const item=a.enqueueItem('oc_test','dm','hello','om_cancel').item;await a.runDmItem('oc_test',item);assert.equal(runs,1);assert.equal(item.status,'failed');
});

test('bot removed during notification preserves binding and does not attempt dissolution',async t=>{
 const {a}=fixture(t),j=job(a);settlementMocks(a);a.patch('send=async()=>{const e=Error("Bot/User can NOT be out of the chat.");e.larkError={code:230002};throw e;};dissolveGroup=async()=>{throw Error("must not dissolve");};');
 await assert.rejects(a.settle(j),/结算通知失败/);assert(a.groups.oc_test);assert(!j.settledAt);
});

test('bot removed or forbidden during dissolution preserves binding and settlement status',async t=>{
 for(const code of [230002,230001,999999]){
  const {a,ctx}=fixture(t),j=job(a);ctx.code=code;settlementMocks(a);a.patch('dissolveGroup=async()=>{const e=Error("permission denied");e.larkError={code:globalThis.code};throw e;};');
  await assert.rejects(a.settle(j),/群解散失败/);assert(a.groups.oc_test);assert(!j.settledAt);
 }
});

test('settlement persistence failure returns failure and retains binding for retry',async t=>{
 const {a}=fixture(t),j=job(a);settlementMocks(a);const save=a.supervisor.save.bind(a.supervisor);a.supervisor.save=()=>{throw Error('ENOSPC');};
 await assert.rejects(a.settle(j),/结算记录写入失败/);assert(a.groups.oc_test);assert(!j.settledAt);assert(!j.settledChat);
 a.supervisor.save=save;await a.settle(j);assert(!a.groups.oc_test);assert.equal(j.settledChat,'oc_test');
});

test('binding persistence failure retries only cleanup after durable settlement',async t=>{
 const {a,ctx}=fixture(t),j=job(a);settlementMocks(a);let sends=0,deletes=0;ctx.fakeSend=async()=>sends++;ctx.fakeDissolve=async()=>deletes++;
 a.patch('send=()=>globalThis.fakeSend();dissolveGroup=()=>globalThis.fakeDissolve();globalThis.savedSaveGroups=saveGroups;saveGroups=()=>{throw Error("ENOSPC");};');
 await assert.rejects(a.settle(j),/绑定清理写入失败/);assert(a.groups.oc_test);assert(j.settledAt);
 const reply=await a.respond({chat_type:'group',chat_id:'oc_test',message_type:'text',content:'new work',message_id:'om_after'});assert.match(reply,/绑定清理尚未完成/);assert(!a.queues.oc_test);
 a.patch('saveGroups=globalThis.savedSaveGroups;');await a.settle(j);assert(!a.groups.oc_test);assert.equal(sends,1);assert.equal(deletes,1);
});

test('reopened archived task closes new group while preserving original archive and timestamp',async t=>{
 const {a}=fixture(t),j=job(a);j.settledAt=123;j.settledChat='oc_old';j.settledArchive='/original.md';settlementMocks(a);a.patch('archiveToKnowledge=()=>{throw Error("must preserve archive");};');
 const result=await a.settle(j);assert.match(result,/原任务/);assert.equal(j.settledAt,123);assert.equal(j.settledArchive,'/original.md');assert.equal(j.settledChat,'oc_test');assert(!a.groups.oc_test);
});


test('outbox waits for backed-off head instead of overtaking within the same chat',async t=>{
 const {a,ctx}=fixture(t),sent=[];ctx.fakeSend=async(c,text,key)=>sent.push(key);a.patch('send=(...args)=>globalThis.fakeSend(...args);');
 a.outbox.push({id:'first',chat:'oc_test',text:'first',state:'pending',nextAt:Date.now()+60000},{id:'second',chat:'oc_test',text:'second',state:'pending',nextAt:0});
 await a.drainChat('oc_test');assert.deepEqual(sent,[]);a.outbox[0].nextAt=0;await a.drainChat('oc_test');assert.deepEqual(sent,['first','second']);
});

test('outbox delivery receipt survives disk failure without in-process resend and flushes on recovery',async t=>{
 const {a,ctx,state}=fixture(t),sent=[];ctx.fakeSend=async(c,text,key)=>sent.push(key);a.patch('send=(...args)=>globalThis.fakeSend(...args);');
 a.outbox.push({id:'first',chat:'oc_test',text:'first',state:'pending',nextAt:0},{id:'second',chat:'oc_test',text:'second',state:'pending',nextAt:0});a.txStore(()=>{});
 a.patch('globalThis.originalPersist=persistStore;persistStore=()=>{throw Error("ENOSPC");};');
 await a.drainChat('oc_test');await a.drainChat('oc_test');assert.deepEqual(sent,['first']);assert.equal(a.outbox[0].state,'sent');assert.equal(a.outbox[1].state,'pending');
 a.patch('persistStore=globalThis.originalPersist;');await a.drainChat('oc_test');assert.deepEqual(sent,['first','second']);assert(JSON.parse(fs.readFileSync(path.join(state,'store.json'))).outbox.every(e=>e.state==='sent'));
});

test('failed outbox attempt is counted once even when persistence rolls back',async t=>{
 const {a}=fixture(t);a.outbox.push({id:'first',chat:'oc_test',text:'first',state:'pending',nextAt:0,attempts:0});
 a.patch('send=async()=>{throw Error("network");};persistStore=()=>{throw Error("ENOSPC");};');await a.drainChat('oc_test');assert.equal(a.outbox[0].attempts,1);
});

test('failed reaction creation preserves the last confirmed reaction',async t=>{
 const {a,ctx}=fixture(t);const item=a.enqueueItem('oc_test','dm','hello','om_react').item;item.reactionId='rid_old';item.reactionState='wait';
 ctx.fakeLark=async args=>{ctx.calls.push(args);if(args[2]==='create')throw Error('network');return {ok:true};};a.patch('CFG.reactions=true;lark=(...args)=>globalThis.fakeLark(...args);');
 a.setReact(item,'run');await a.waitReacts();assert.equal(item.reactionId,'rid_old');assert.equal(item.reactionState,'wait');assert.equal(ctx.calls.filter(args=>args[2]==='delete').length,0);
});

test('reaction persistence failure rolls back the new mark and retains the old one',async t=>{
 const {a,ctx}=fixture(t);const item=a.enqueueItem('oc_test','dm','hello','om_react').item;item.reactionId='rid_old';item.reactionState='wait';
 ctx.fakeLark=async args=>{ctx.calls.push(args);return {ok:true,data:{reaction_id:'rid_new'}};};a.patch('CFG.reactions=true;lark=(...args)=>globalThis.fakeLark(...args);persistStore=()=>{throw Error("ENOSPC");};');
 a.setReact(item,'run');await a.waitReacts();assert.equal(item.reactionId,'rid_old');assert.equal(item.reactionState,'wait');
 const deletes=ctx.calls.filter(args=>args[2]==='delete').map(args=>JSON.parse(args[args.indexOf('--params')+1]).reaction_id);assert.deepEqual(deletes,['rid_new']);
});

test('qdrop and qclear remove waiting reactions after durable removal, preserving active item',async t=>{
 const {a,ctx}=fixture(t);const first=a.enqueueItem('oc_test','dm','one','om_one').item,second=a.enqueueItem('oc_test','dm','two','om_two').item,active=a.enqueueItem('oc_test','dm','three','om_active').item;
 first.reactionId='rid_one';second.reactionId='rid_two';active.status='active';active.reactionId='rid_active';
 ctx.fakeLark=async args=>{ctx.calls.push(args);return {ok:true};};a.patch('lark=(...args)=>globalThis.fakeLark(...args);');
 const msg=text=>({chat_type:'p2p',chat_id:'oc_test',content:text,message_type:'text',message_id:'om_cmd'});
 await a.respond(msg('/qdrop 1'));await a.respond(msg('/qclear'));await a.waitReacts();assert.equal(a.queues.oc_test.items.length,1);assert.equal(a.queues.oc_test.items[0],active);
 const deletes=ctx.calls.filter(args=>args[2]==='delete').map(args=>JSON.parse(args[args.indexOf('--params')+1]).reaction_id);assert.deepEqual(deletes,['rid_one','rid_two']);
});

test('failed queue removal keeps waiting reaction and item',async t=>{
 const {a}=fixture(t);const item=a.enqueueItem('oc_test','dm','one','om_one').item;item.reactionId='rid_one';a.patch('persistStore=()=>{throw Error("ENOSPC");};');
 const reply=await a.respond({chat_type:'p2p',chat_id:'oc_test',content:'/qclear',message_type:'text',message_id:'om_cmd'});await a.waitReacts();assert.match(reply,/清空未生效/);assert.equal(a.queues.oc_test.items[0],item);assert.equal(item.reactionId,'rid_one');
});


test('cache sweep protects queued and active attachment references, including paused queues',t=>{
 const {a,root}=fixture(t),storage=require('./media-cache.cjs');const cache=path.join(root,'.cache/lark-codex-tasks'),dir=storage.managedDir(cache),old=Date.now()-10*86400e3;
 const ids=['om_queue-0','om_active-0','om_expired-0'];for(const id of ids){const file=path.join(dir,id+'__file');fs.writeFileSync(file,'content');a.attachments[id]={id,cachePath:file,path:file,createdAt:old};}
 a.queues.oc_test={paused:true,items:[{status:'queued',media:[{id:ids[0]}]},{status:'active',media:[{id:ids[1]}]}]};
 const result=a.sweepAttachments();assert.deepEqual(Array.from(result.removed),[ids[2]]);assert(fs.existsSync(a.attachments[ids[0]].path));assert(fs.existsSync(a.attachments[ids[1]].path));assert(a.attachments[ids[2]].cacheDeletedAt);
});

test('archive outside knowledge project succeeds without claiming a Git commit in another directory',async t=>{
 const {a,root}=fixture(t),j=job(a);const archive=path.join(root,'custom archive');a.patch('CFG.archiveDir='+JSON.stringify(archive)+';send=async()=>{};dissolveGroup=async()=>{};');
 const result=await a.settle(j);assert(result.includes(archive));assert(fs.existsSync(path.join(archive,'job_te-scratch.md')));
});

test('archiving a referenced attachment promotes it to persist and records its durable path',async t=>{
 const {a,root}=fixture(t),j=job(a),storage=require('./media-cache.cjs');const cache=path.join(root,'.cache/lark-codex-tasks'),file=path.join(storage.managedDir(cache),'om_image__0__image');fs.writeFileSync(file,'data');
 a.attachments['om_image-0']={id:'om_image-0',cachePath:file,path:file,createdAt:Date.now(),ready:true};j.task='read '+file;j.images=[file];a.patch('send=async()=>{};dissolveGroup=async()=>{};');
 await a.settle(j);const record=a.attachments['om_image-0'];assert(record.keptAt);assert(record.path.includes('/persist/'));assert(fs.existsSync(record.path));const archived=fs.readFileSync(j.settledArchive,'utf8');assert(archived.includes(record.path));
});


test('keep rejects a partially downloaded file rather than persisting incomplete bytes',t=>{
 const {a,root}=fixture(t),storage=require('./media-cache.cjs');const file=path.join(storage.managedDir(path.join(root,'.cache/lark-codex-tasks')),'om_partial__0__file');fs.writeFileSync(file,'partial');
 a.attachments['om_partial-0']={id:'om_partial-0',cachePath:file,path:file,ready:false};assert.throws(()=>a.keepAttachment('om_partial-0'),/尚未完成接收/);assert(!a.attachments['om_partial-0'].keptAt);
});


test('unsettled group task chain protects completed jobs referenced cache before archiving',t=>{
 const {a,root}=fixture(t),j=job(a),storage=require('./media-cache.cjs');const file=path.join(storage.managedDir(path.join(root,'.cache/lark-codex-tasks')),'om_pending_archive__0__file');fs.writeFileSync(file,'content');
 a.attachments['om_pending_archive-0']={id:'om_pending_archive-0',cachePath:file,path:file,createdAt:Date.now()-30*86400e3,ready:true};j.task='read '+file;
 const result=a.sweepAttachments();assert.equal(result.removed.length,0);assert(fs.existsSync(file));
});


test('unstructured CLI error text mentioning dissolution is not evidence to remove a binding',async t=>{
 const {a}=fixture(t),j=job(a);settlementMocks(a);a.patch('send=async()=>{throw Error("command timed out: --text Your request specifies a chat which has already been dissolved.");};');
 await assert.rejects(a.settle(j),/结算通知失败/);assert(a.groups.oc_test);assert(!j.settledAt);
});

test('pausing during safe retry backoff prevents a fresh DM submission',async t=>{
 const {a,ctx}=fixture(t);let runs=0;ctx.fakeTurn=async()=>{runs++;throw Error('network timeout before start');};a.patch('runChatTurn=()=>globalThis.fakeTurn();pump=()=>{};');
 const item=a.enqueueItem('oc_test','dm','hello','om_backoff').item;ctx.setTimeout=(fn,ms)=>{assert.equal(ms,8000);a.queues.oc_test.paused=true;fn();return 0;};await a.runDmItem('oc_test',item);
 assert.equal(runs,1);assert.equal(item.status,'failed');assert.equal(item.error,'已取消');
});

test('cancelled resume initialization cannot fall back to a new DM thread',async t=>{
 const {a}=fixture(t),originalStart=CodexClient.prototype.start,originalDispose=CodexClient.prototype.dispose;let starts=0;
 t.after(()=>{CodexClient.prototype.start=originalStart;CodexClient.prototype.dispose=originalDispose;});a.patch('saveDmSession("oc_test","thread_old");');
 CodexClient.prototype.start=async function(){starts++;this.cancelRequested=true;throw Error('network timeout');};CodexClient.prototype.dispose=()=>{};
 await assert.rejects(a.runChatTurn('hello','oc_test'),e=>e.cancelled===true);assert.equal(starts,1);
});


test('a pending DM text reference protects an old attachment even without a media manifest',t=>{
 const {a,root}=fixture(t),storage=require('./media-cache.cjs');const file=path.join(storage.managedDir(path.join(root,'.cache/lark-codex-tasks')),'om_reference__0__file');fs.writeFileSync(file,'content');
 a.attachments['om_reference-0']={id:'om_reference-0',cachePath:file,path:file,createdAt:Date.now()-30*86400e3,ready:true};a.queues.oc_dm={items:[{status:'active',kind:'dm',text:'read '+file}]};
 assert.equal(a.sweepAttachments().removed.length,0);assert(fs.existsSync(file));
});


test('dropped item still clears its old reaction if an in-flight replacement cannot persist',async t=>{
 const {a,ctx}=fixture(t);const item=a.enqueueItem('oc_test','dm','one','om_drop').item;item.reactionId='rid_old';item.reactionState='wait';let release;
 ctx.createGate=new Promise(r=>release=r);t.after(()=>release({ok:true,data:{reaction_id:'rid_new'}}));
 ctx.fakeLark=async args=>{ctx.calls.push(args);if(args[2]==='create')return ctx.createGate;return {ok:true};};a.patch('CFG.reactions=true;lark=(...args)=>globalThis.fakeLark(...args);');
 a.setReact(item,'run');await Promise.resolve();await a.respond({chat_type:'p2p',chat_id:'oc_test',content:'/qclear',message_type:'text',message_id:'om_cmd'});
 a.patch('persistStore=()=>{throw Error("ENOSPC");};');release({ok:true,data:{reaction_id:'rid_new'}});await a.waitReacts();
 const ids=ctx.calls.filter(args=>args[2]==='delete').map(args=>JSON.parse(args[args.indexOf('--params')+1]).reaction_id);assert.deepEqual(ids,['rid_new','rid_old']);assert.equal(a.queues.oc_test.items.length,0);
});

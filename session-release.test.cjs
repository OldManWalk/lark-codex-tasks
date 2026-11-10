const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {execFileSync}=require('node:child_process');
const {EventEmitter}=require('node:events');
const sup=require('./supervisor.cjs');

const until=async(fn,ms=2000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await new Promise(r=>setTimeout(r,10));}return false;};
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lct-release-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const state=path.join(root,'.local/state/lark-codex-tasks');fs.mkdirSync(state,{recursive:true});
 fs.mkdirSync(path.join(root,'.config/lark-codex-tasks'),{recursive:true});
 fs.mkdirSync(path.join(root,'workspace/a'),{recursive:true});
 const kb=path.join(root,'workspace/knowledge/content');fs.mkdirSync(kb,{recursive:true});execFileSync('git',['init','-q',kb]);
 sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{a:path.join(root,'workspace/a')});
 const proc=new EventEmitter();proc.env={LARK_OWNER_OPEN_ID:'owner',LCT_PLATFORM:'linux',LCT_SANDBOX_KIND:'bwrap',LCT_NODE_LABEL:'server-test'};
 const context=vm.createContext({require:n=>n==='node:os'?{...os,homedir:()=>root}:require(n),__dirname,module:{},process:proc,console,setTimeout,clearTimeout,setInterval,clearInterval});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'lark-bridge.cjs'),'utf8')+`
 lark=async(args)=>({ok:true,data:{message_id:'om_fake',chat_id:'oc_new',reaction_id:'rid_fake'}});
 globalThis.api={releaseBinding,settle,respond,groupContext,webSnapshot,supervisor,pendingByChat,
  get groups(){return groups;},get queues(){return queues;},get outbox(){return outbox;}};
 `,context);
 return {a:context.api,root,state};
}
function bind(a,{status='completed'}={}){
 const id='aaaaaaaaaaaa',chat='oc_g',job={id,alias:'a',chat,threadId:'thread-a',status,cwd:'/tmp',mode:'auto',started:1,finished:2,lastMessage:'done'};
 a.supervisor.jobs.set(id,job);a.supervisor.save(job);
 a.groups[chat]={anchor:id,alias:'a',status:'active',kind:'group_task',thread:'thread-a',chain:id,instr:'group-task-v3',title:'task'};return {job,chat,id};
}
const msg=(text,id)=>({type:'im.message.receive_v1',chat_type:'group',chat_id:'oc_g',content:text,message_id:id||Math.random().toString(36),sender_id:'owner',sender_type:'user',message_type:'text'});

test('release detaches execution, persists resume and blocks ordinary group work',async t=>{
 const {a,state}=fixture(t),{job,chat}=bind(a);
 const first=a.releaseBinding(null,chat);
 assert.equal(first.resume.threadId,'thread-a');assert.equal(first.resume.threadNode.role,'server');assert.equal(first.resume.generation,2);
 assert.equal(a.groups[chat].status,'parked');assert.equal(a.groups[chat].attachment.ownerNode,null);assert.equal(job.release,first.resume);
 assert.equal(a.groupContext(chat),null);assert.equal(a.webSnapshot().sessions[0].status,'parked');
 a.queues[chat]={seq:0,paused:true,items:[]};assert.equal(a.webSnapshot().sessions[0].status,'parked');
 const persisted=JSON.parse(fs.readFileSync(path.join(state,'groups.json')));assert.equal(persisted[chat].status,'parked');
 const response=await a.respond(msg('continue working'));assert.match(response,/普通消息不会执行/);
 const second=a.releaseBinding(null,chat);assert.equal(second.alreadyParked,true);assert.equal(second.resume.generation,2);
});

test('running work cannot be released implicitly',t=>{
 const {a}=fixture(t),{chat}=bind(a,{status:'running'});
 assert.throws(()=>a.releaseBinding(null,chat),/仍在运行/);assert.equal(a.groups[chat].status,'active');
});

test('queued work cannot be released or silently discarded',t=>{
 const {a}=fixture(t),{chat}=bind(a);a.queues[chat]={seq:1,paused:false,items:[{seq:1,status:'queued'}]};
 assert.throws(()=>a.releaseBinding(null,chat),/排队或执行中/);assert.equal(a.groups[chat].status,'active');
});

test('pending approval blocks release',t=>{
 const {a}=fixture(t),{chat}=bind(a);a.pendingByChat.set(chat,[{resolved:false}]);
 assert.throws(()=>a.releaseBinding(null,chat),/未决审批/);assert.equal(a.groups[chat].status,'active');
});

test('pending outbox blocks release so no late session message arrives',t=>{
 const {a}=fixture(t),{chat}=bind(a);a.outbox.push({chat,state:'pending'});
 assert.throws(()=>a.releaseBinding(null,chat),/待投递/);assert.equal(a.groups[chat].status,'active');
});

test('done is an explicit second stage for a parked group',async t=>{
 const {a}=fixture(t),{job,chat}=bind(a);a.releaseBinding(null,chat);
 const response=await a.respond(msg('/done','om_done'));assert.match(response,/结算中/);
 assert(await until(()=>!a.groups[chat]));assert(job.settledAt>0);assert.equal(job.settledChat,chat);
});

test('/release command returns the node-aware resume path',async t=>{
 const {a}=fixture(t),{chat}=bind(a);const response=await a.respond(msg('/release','om_release'));
 assert.match(response,/lct resume aaaaaaaaaaaa/);assert.match(response,/其他设备不能直接复用/);assert.equal(a.groups[chat].status,'parked');
});

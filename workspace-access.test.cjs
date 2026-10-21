'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createAccess}=require('./workspace-access.cjs'),channel=require('./control-channel.cjs');
function fixture(){
 const job={id:'job_one',chat:'chat_one',status:'running'},binding={status:'active',chain:'chain_one'},calls=[];
 const access=createAccess({enabled:()=>true,stateDir:'/tmp/example',getJob:id=>id===job.id?job:null,getChain:()=> 'chain_one',getBinding:()=>binding,execute:async(b,j)=>(calls.push({b,j}),{status:'succeeded'})});
 const env=access.envFor(job.id,job.chat),body={jobId:job.id,token:env.LCT_WORKSPACE_TOKEN,action:'workspace.sync',summary:'plan',requestId:'request_example'};
 return {job,binding,calls,access,env,body};
}
test('worker capability cannot choose another session or any control-plane action',async()=>{
 const f=fixture();assert(f.env.LCT_WORKSPACE_SOCKET.endsWith('/workspace.sock'));await f.access.act(f.body);assert.equal(f.calls[0].b.target,'job_one');
 for(const extra of [{action:'job.cancel'},{target:'other'},{chat:'other'},{documentId:'other'},{jobId:'other'},{token:'bad'}])await assert.rejects(f.access.act({...f.body,...extra}));
 assert.equal(f.calls.length,1);
});
test('capability expires on completion, binding changes, or replacement by a retried run',async()=>{
 const f=fixture();f.job.status='completed';await assert.rejects(f.access.act(f.body));f.job.status='running';
 f.binding.chain='another';await assert.rejects(f.access.act(f.body));f.binding.chain='chain_one';
 f.access.envFor(f.job.id,f.job.chat);await assert.rejects(f.access.act(f.body));assert.equal(f.calls.length,0);
});
test('worker socket never exposes management snapshot or generic admin actions',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lct-wa-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const f=fixture(),server=await channel.startChannel({stateDir:dir,workspaceOnly:true,workspaceAct:f.access.act});t.after(()=>server.close());
 const socket=channel.workspaceSocketPath(dir);assert.equal(fs.statSync(socket).mode&0o777,0o600);
 assert.deepEqual(await channel.request(socket,'/health'),{ready:true});
 await assert.rejects(channel.request(socket,'/state'),/接口不存在/);
 await assert.rejects(channel.request(socket,'/action',{action:'service.stop'}),/接口不存在/);
 assert.equal((await channel.request(socket,'/workspace',f.body)).status,'succeeded');
});
test('workspace secrets are stripped from inherited environments and redacted from output',()=>{
 const {redact,sanitizeEnv}=require('./supervisor.cjs');const f=fixture();
 assert.equal(redact('credential '+f.env.LCT_WORKSPACE_TOKEN,{}),'credential [REDACTED]');
 const env=sanitizeEnv({...f.env,LCT_WEB_TOKEN:'private',PATH:'/bin'});assert(!env.LCT_WORKSPACE_TOKEN);assert(!env.LCT_WORKSPACE_SOCKET);assert.equal(env.PATH,'/bin');
});

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CodexClient}=require('./codex-client.cjs');

const policy={model:'k3.1-pro',model_provider:'custom',model_reasoning_effort:'high'};

function fixture(t,config=policy){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lct-model-policy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const capture=path.join(root,'requests.jsonl'),stub=path.join(root,'codex-stub');
 const script=`const fs=require('fs'),readline=require('readline');
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(process.env.MODEL_CAPTURE,JSON.stringify(m)+String.fromCharCode(10));if(m.id===undefined)return;
 let result={};
 if(m.method==='config/read')result={config:${JSON.stringify(config)}};
 else if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:m.params.threadId||'thread-new',cwd:m.params.cwd}};
 else if(m.method==='turn/start')result={turn:{id:'turn-test'}};
 process.stdout.write(JSON.stringify({id:m.id,result})+String.fromCharCode(10));});`;
 fs.writeFileSync(stub,'#!'+process.execPath+'\n'+script,{mode:0o700});
 const requests=()=>fs.readFileSync(capture,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
 return {root,capture,stub,requests};
}

function client(f,opts={}){
 return new CodexClient({codex:f.stub,cwd:f.root,env:{...process.env,MODEL_CAPTURE:f.capture},threadParams:{name:'model-test',cwd:f.root},...opts});
}

async function run(c){
 const result=c.run('test');result.catch(()=>{});
 const deadline=Date.now()+2000;
 while(!c.turnId&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
 assert.equal(c.turnId,'turn-test');
 c._onEvent('turn/completed',{threadId:c.threadId,turnId:c.turnId,turn:{id:c.turnId,status:'completed',items:[]}});
 await result;
}

test('new threads and turns explicitly use the effective CCSwitch model policy',async t=>{
 const f=fixture(t),c=client(f);t.after(()=>c.dispose());
 await c.start();await run(c);
 const start=f.requests().find(x=>x.method==='thread/start'),turn=f.requests().find(x=>x.method==='turn/start');
 assert.equal(start.params.model,'k3.1-pro');assert.equal(start.params.modelProvider,'custom');assert.equal(start.params.allowProviderModelFallback,false);
 assert.equal(turn.params.model,'k3.1-pro');assert.equal(turn.params.effort,'high');
});

test('resume overrides the stored thread model instead of retaining it',async t=>{
 const f=fixture(t),c=client(f,{resumeThreadId:'old-thread'});t.after(()=>c.dispose());
 await c.start();await run(c);
 const resume=f.requests().find(x=>x.method==='thread/resume'),turn=f.requests().find(x=>x.method==='turn/start');
 assert.equal(resume.params.threadId,'old-thread');assert.equal(resume.params.model,'k3.1-pro');assert.equal(resume.params.modelProvider,'custom');
 assert.equal(turn.params.model,'k3.1-pro');assert.equal(turn.params.effort,'high');
});

test('explicit thread policy wins over global defaults',async t=>{
 const f=fixture(t),c=client(f,{threadParams:{cwd:f.root,model:'thread-model',modelProvider:'thread-provider',effort:'medium'}});t.after(()=>c.dispose());
 await c.start();await run(c);
 const start=f.requests().find(x=>x.method==='thread/start'),turn=f.requests().find(x=>x.method==='turn/start');
 assert.equal(start.params.model,'thread-model');assert.equal(start.params.modelProvider,'thread-provider');
 assert.equal(turn.params.model,'thread-model');assert.equal(turn.params.effort,'medium');
});

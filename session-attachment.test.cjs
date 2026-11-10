const {test}=require('node:test');
const assert=require('node:assert/strict');
const {normalizeAttachment,parkAttachment,resumeInstruction,assertThreadAvailable}=require('./session-attachment.cjs');

const serverNode={id:'node-server',role:'server',label:'server-node',platform:'linux'};
const localNode={id:'node-local',role:'local',label:'local-node',platform:'darwin'};
const job={id:'aaaaaaaaaaaa',threadId:'thread-a',cwd:'/workspace/a',alias:'a',status:'completed'};
const group={anchor:job.id,alias:'a',status:'active',thread:'thread-a',chain:'chain-a'};

test('legacy server binding becomes an attached execution record without changing chain or thread',()=>{
 const next=normalizeAttachment({group,job,chain:'chain-a',node:serverNode,at:10});
 assert.equal(next.attachment.state,'attached');assert.equal(next.attachment.chainId,'chain-a');
 assert.equal(next.attachment.threadId,'thread-a');assert.equal(next.attachment.threadNode.id,'node-server');
 assert.equal(next.attachment.ownerNode.role,'server');assert.equal(next.attachment.generation,1);
});

test('release parks the group, clears execution ownership and preserves resume evidence',()=>{
 const {group:next,resume}=parkAttachment({group,job,chain:'chain-a',node:serverNode,at:20});
 assert.equal(next.status,'parked');assert.equal(next.thread,'thread-a');assert.equal(next.chain,'chain-a');
 assert.equal(next.attachment.ownerNode,null);assert.equal(next.attachment.generation,2);assert.equal(resume.generation,2);
 assert.equal(resume.threadNode.id,'node-server');assert.equal(resume.sourceCwd,'/workspace/a');
 const again=parkAttachment({group:next,job,chain:'chain-a',node:serverNode,at:30});
 assert.equal(again.resume,resume);assert.equal(again.group,next);
});

test('same-node resume is exact, while a local node cannot directly resume a server thread',()=>{
 const {resume}=parkAttachment({group,job,chain:'chain-a',node:serverNode});
 const server=resumeInstruction(resume,serverNode);
 assert.equal(server.strategy,'same-node-thread');assert.deepEqual(server.command.args,['codex','resume','thread-a']);
 const local=resumeInstruction(resume,localNode);
 assert.equal(local.strategy,'remote-result-handoff');assert.equal(local.command,null);assert.equal(local.reason,'thread-node-mismatch');
});

test('local and server roles are explicit and invalid roles fail',()=>{
 assert.throws(()=>resumeInstruction({schemaVersion:1,kind:'codex-resume',threadId:'t',threadNode:{...serverNode,role:'workstation'}},localNode),/local 或 server/);
});

test('one active thread cannot have two group executors, but parked history is allowed',()=>{
 assert.throws(()=>assertThreadAvailable({oc_a:group,oc_b:{...group,anchor:'bbbbbbbbbbbb'}},'thread-a'),/已附着/);
 assert.doesNotThrow(()=>assertThreadAvailable({oc_a:{...group,status:'parked'}},'thread-a'));
});

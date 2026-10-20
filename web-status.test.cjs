// 阶段 4 验收：Web 面板鉴权、安全头、路由、SSE 推送、token 生成、快照脱敏。
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {startWebStatus,tokenOk,_page}=require('./web-status.cjs');

function get(port,p,bearer){return new Promise((resolve,reject)=>{
  const headers=bearer?{Authorization:'Bearer '+bearer}:{};
  const req=http.get({host:'127.0.0.1',port,path:p,headers},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:b}));});
  req.on('error',reject);
});}

test('W1: token required; bearer and query token both accepted; timingSafeEqual semantics',async t=>{
  const fake={ts:1,counts:{},health:{},jobs:[],queues:{},groups:[],outbox:[],dispatches:[],attachments:[],events:[],logs:'',attention:[]};
  const web=await startWebStatus({port:0,token:'t-123',getState:()=>fake,log:()=>{}});
  t.after(()=>web.close());
  assert(!tokenOk('','t-123')&&!tokenOk('t-124','t-123')&&tokenOk('t-123','t-123'));
  assert.equal((await get(web.port,'/')).status,200,'登录页面公开，但不含实例数据');
  assert.equal((await get(web.port,'/api/state')).status,401,'实例数据需要认证');
  assert.equal((await get(web.port,'/api/state','wrong')).status,401,'错误 Bearer 拒绝');
  assert.equal((await get(web.port,'/api/state?token=wrong')).status,401,'错误 query token 拒绝');
  assert.equal((await get(web.port,'/','t-123')).status,200,'Bearer 放行');
  assert.equal((await get(web.port,'/?token=t-123')).status,200,'query token 放行（SSE 需要）');
});

test('W2: page has security headers and no external resources',async t=>{
  const web=await startWebStatus({port:0,token:'x',getState:()=>({}),log:()=>{}});
  t.after(()=>web.close());
  const r=await get(web.port,'/','x');
  assert.equal(r.headers['x-frame-options'],'DENY');
  assert(r.headers['content-security-policy'].includes("default-src 'none'"),'CSP 禁外部资源');
  assert(r.headers['content-security-policy'].includes("connect-src 'self'"),'CSP 必须放行 SSE 连接（default-src none 会连 EventSource 一起拦）');
  assert.equal(r.headers['referrer-policy'],'no-referrer');
  assert(r.body.includes('管理后台')&&!/src="http|href="http/.test(r.body),'页面零外部资源');
});

test('W3: state endpoint returns snapshot; 404/405 handled',async t=>{
  const state={marker:'v1',jobs:[{id:'j1'}]};
  const web=await startWebStatus({port:0,token:'x',getState:()=>state,log:()=>{}});
  t.after(()=>web.close());
  const r=await get(web.port,'/api/state?token=x');
  assert.equal(r.status,200);assert.deepEqual(JSON.parse(r.body).jobs,[{id:'j1'}]);
  assert.equal((await get(web.port,'/nope?token=x')).status,404);
  const m=await new Promise((res,rej)=>{const req=http.request({host:'127.0.0.1',port:web.port,path:'/?token=x',method:'POST'},res2=>res(res2));req.on('error',rej);req.end();});
  assert.equal(m.statusCode,405);m.resume();
});

test('W4: SSE pushes initial snapshot and updates on change',async t=>{
  let n=0;
  const web=await startWebStatus({port:0,token:'x',getState:()=>({n:++n}),log:()=>{}});
  t.after(()=>web.close());
  const chunks=[];
  await new Promise((resolve,reject)=>{
    const req=http.get(`http://127.0.0.1:${web.port}/api/events?token=x`,res=>{
      res.setEncoding('utf8');let buf='';let done=false;
      res.on('data',c=>{buf+=c;const m=buf.match(/data: /g);if(m&&m.length>=2&&!done){done=true;req.destroy();resolve();}});
      res.on('error',reject);
    });
    req.on('error',reject);setTimeout(()=>reject(new Error('SSE 两次推送超时')),6000);
  });
});

test('W5: missing token is generated and logged once; invalid host/port rejected; address reuse fails clearly',async t=>{
  const logs=[];
  const web=await startWebStatus({port:0,token:'',getState:()=>({}),log:m=>logs.push(m)});
  t.after(()=>web.close());
  assert(web.token&&web.token.length>=20,'生成随机 token');
  assert(logs.some(l=>l.includes('token')),'token 打到日志');
  assert.throws(()=>startWebStatus({port:-1,token:'x',getState:()=>{},log:()=>{}}),/LCT_WEB_PORT 无效/);
  assert.throws(()=>startWebStatus({port:0,host:'evil host',token:'x',getState:()=>{},log:()=>{}}),/LCT_WEB_HOST/);
  await assert.rejects(()=>startWebStatus({port:web.port,token:'x',getState:()=>{},log:()=>{}}),/监听失败/,'地址占用明确报错');
});

// ── 快照脱敏（bridge 级，vm 沙箱内构造带机密的队列/outbox）──
function bridgeVm(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lct-w-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const state=path.join(root,'.local/state/lark-codex-tasks');fs.mkdirSync(state,{recursive:true});
  fs.mkdirSync(path.join(root,'.config/lark-codex-tasks'),{recursive:true});
  fs.mkdirSync(path.join(root,'workspace/scratch'),{recursive:true});
  const sup=require('./supervisor.cjs');
  sup.atomic(path.join(root,'.config/lark-codex-tasks/projects.json'),{});
  const proc=new EventEmitter();proc.env={LARK_OWNER_OPEN_ID:'owner',LCT_PLATFORM:'linux',LCT_SANDBOX_KIND:'bwrap',TEST_SECRET:'fixture-secret-for-redaction'};
  const context=vm.createContext({__dirname,require:n=>n==='node:os'?{...os,homedir:()=>root}:n==='./supervisor.cjs'?{...sup,redact:(value,env=proc.env,limit)=>sup.redact(value,env,limit)}:require(n),module:{},process:proc,console:{log(){},error(){}},setTimeout,clearTimeout,setInterval,clearInterval});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'lark-bridge.cjs'),'utf8')+`
lark=async()=>({ok:true,data:{message_id:'om_fake',chat_id:'oc_new'}});
globalThis.api={patch:code=>eval(code),get queues(){return queues;},get outbox(){return outbox;}};
`,context);
  return context.api;
}

test('W6: snapshot redacts secrets and never carries message text',t=>{
  const a=bridgeVm(t);
  a.patch(`queues['oc_t']={seq:1,paused:true,pauseReason:'fatal:boom',items:[{seq:1,messageId:'om_x',text:'正文机密内容 abc',kind:'task',status:'failed',error:'炸了啊 '+process.env.TEST_SECRET,enqueuedAt:1}]}`);
  a.patch(`outbox.push({id:'ob1',chat:'oc_t',text:'死信正文',key:null,attempts:5,nextAt:0,state:'failed',createdAt:1,lastError:process.env.TEST_SECRET})`);
  const snap=JSON.parse(JSON.stringify(a.patch('webSnapshot()')));
  const item=snap.queues['oc_t'].items[0];
  assert.equal(item.textLen,10,'正文只给长度');assert(!('text' in item),'正文不落面板');
  assert(!JSON.stringify(snap).includes('fixture-secret-for-redaction'),'快照不含凭据值');
  assert(item.error.length>0&&item.error.length<=120,'错误摘要保留');
  assert(snap.attention.some(x=>x.includes('/qresume')),'暂停队列进入待决断清单');
  assert(snap.attention.some(x=>x.includes('ob1')),'死信进入待决断清单');
  assert.equal(typeof snap.counts.pausedQueues,'number');
});

test('W7: inline page script parses cleanly and contains no script-terminating sequence',()=>{
 const html=_page();
 const m=html.match(/<script>([\s\S]*)<\/script>/);
 assert(m,'页面应有内联脚本');
 new vm.Script(m[1]); // 抛 SyntaxError 即失败（防引号转义坑）
 assert(!m[1].includes('</scr'+'ipt>'),'脚本内容不得含 </script> 序列');
});

test('W8: bridge management uses durable queue changes, rejects stale confirmation and protects busy stop',async t=>{
 const a=bridgeVm(t);a.patch(`queues['oc_q']={seq:1,paused:true,pauseReason:'manual',items:[{seq:1,kind:'dm',status:'queued',text:'private',messageId:'om_test'}]};pump=()=>{};syncGroupName=()=>{};`);
 const rev=()=>a.patch("require('./control-channel.cjs').revision(webSnapshot())");
 await assert.rejects(a.patch(`managementAction({action:'queue.resume',target:'oc_q',expected:'stale',confirmed:true})`),/状态已变化/);
 const b={action:'queue.resume',target:'oc_q',expected:rev(),confirmed:true};await a.patch('managementAction('+JSON.stringify(b)+')');assert.equal(a.queues.oc_q.paused,false);
 await assert.rejects(a.patch('managementAction('+JSON.stringify({action:'service.prepare',expected:rev()})+')'),/仍有执行中/);
 a.patch(`queues.oc_q.items=[];`);await a.patch('managementAction('+JSON.stringify({action:'service.prepare',expected:rev()})+')');
 assert.match(a.patch(`managementHoldUntil>Date.now()`)?'held':'not held',/^held$/);
 await assert.rejects(a.patch('managementAction('+JSON.stringify({...b,expected:rev()})+')'),/维护/);
 await a.patch(`managementAction({action:'service.release'})`);
});

test('W9: private workers receive normalized platform paths and never inherit management token',t=>{
 const a=bridgeVm(t);a.patch(`process.env.LCT_WEB_TOKEN='panel-secret';`);
 const env=a.patch('chatEnv()');assert(!('LCT_WEB_TOKEN' in env));assert(env.LCT_STATE_DIR&&env.LCT_CACHE_DIR&&env.LCT_LOGS_DIR);
 const safe=require('./supervisor.cjs').sanitizeEnv({LCT_WEB_TOKEN:'panel-secret',LARK_APP_SECRET:'lark-secret',PATH:'/bin'});assert.deepEqual(safe,{PATH:'/bin'});
});

// Public list is one session per row; execution history stays in details.
test('W10: hundreds of completed turns stay one active session, including old-group history',()=>{
 const {sessionViews}=require('./web-status.cjs');const jobs=Array.from({length:220},(_,i)=>({id:String(i),chain:'root',threadId:'session-a',chat:i<10?'oc_old':'oc_current',alias:'scratch',status:i===2?'failed':'completed',started:i+1,finished:i+2,settled:i===10,cwd:'/workspace/scratch',title:'same task'}));
 const sessions=sessionViews({jobs,groups:[{chat:'oc_current',anchor:'219',thread:'session-a',status:'active',topic:'one task'}]});assert.equal(sessions.length,1);assert.equal(sessions[0].executionCount,220);assert.equal(sessions[0].status,'idle');assert.equal(sessions[0].canReopen,false);assert.equal(sessions[0].latestJobId,'219');assert.equal(sessions[0].records.length,220);
});
test('W11: same titles or directories never merge unrelated sessions',()=>{
 const {sessionViews}=require('./web-status.cjs');const jobs=['a','b'].map((id,i)=>({id,chain:id,threadId:'session-'+id,title:'same task',alias:'scratch',cwd:'/workspace/scratch',status:'completed',started:i+1}));assert.equal(sessionViews({jobs}).length,2);
});
test('W12: session status reflects current binding, queue, execution and explicit archive',()=>{
 const {sessionViews}=require('./web-status.cjs');const job={id:'latest',chain:'root',threadId:'session-a',alias:'scratch',status:'completed',started:2,settled:true};const group={chat:'oc_live',anchor:'latest',thread:'session-a',status:'active'};
 assert.equal(sessionViews({jobs:[job]})[0].status,'archived');assert.equal(sessionViews({jobs:[job],groups:[group]})[0].status,'idle');assert.equal(sessionViews({jobs:[job],groups:[group],queues:{oc_live:{paused:true,items:[]}}})[0].status,'paused');
 const live=sessionViews({jobs:[{...job,status:'running'}],groups:[group]})[0];assert.equal(live.status,'running');assert.equal(live.activeJobId,'latest');assert.equal(live.canReopen,false);
 const archived=sessionViews({jobs:[{...job,status:'failed'}]})[0];assert.equal(archived.status,'archived');assert.equal(archived.canReopen,true);
 assert.equal(sessionViews({jobs:[job],groups:[group,{...group,chat:'oc_other'}]})[0].status,'unknown');
});

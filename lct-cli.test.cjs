// lct CLI 验收：env 文件解析、pidfile 存活判断、up/down 裸进程模式真实生命周期、服务模板内容。
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync,spawn}=require('node:child_process');
const lct=require('./lct.cjs');

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lct-cli-'));t.after(()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{}});
  const stub=path.join(root,'stub-bridge.cjs');
  fs.writeFileSync(stub,'console.log("stub bridge ready, pid "+process.pid);setInterval(()=>{},1000);\n');
  const svc='lct-test-'+Math.random().toString(36).slice(2,8);
  const env={...process.env,LCT_PLATFORM:'linux',LCT_SERVICE_NAME:svc,
    LCT_STATE_DIR:path.join(root,'state'),LCT_CONFIG_DIR:path.join(root,'config'),
    LCT_LOGS_DIR:path.join(root,'logs'),LCT_BRIDGE_ENTRY:stub};
  fs.mkdirSync(env.LCT_CONFIG_DIR,{recursive:true});
  const run=(args)=>spawnSync(process.execPath,[path.join(__dirname,'lct.cjs'),...args],{encoding:'utf8',env,timeout:30000});
  return {root,env,run,stub,svc};
}

test('L1: parseEnvFile handles comments, quotes, blanks and export prefix without eval',t=>{
 const f=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'lct-env-')),'bridge.env');t.after(()=>fs.rmSync(path.dirname(f),{recursive:true,force:true}));
 fs.writeFileSync(f,'# 注释\n\nLARK_OWNER_OPEN_ID=ou_abc\nQUOTED="hello world"\nSINGLE=\'x y\'\nexport EXPORTED=1\nlowercase=ok\nBAD LINE\n');
 const r=lct.parseEnvFile(f);
 assert.equal(r.LARK_OWNER_OPEN_ID,'ou_abc');assert.equal(r.QUOTED,'hello world');assert.equal(r.SINGLE,'x y');assert.equal(r.EXPORTED,'1');assert.equal(r.lowercase,'ok');
 assert(!('BAD' in r)&&!('# 注释' in r));
 assert.deepEqual(lct.parseEnvFile(f+'-missing'),{});
});

test('L2: isAlive distinguishes live, dead and foreign processes',async t=>{
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 t.after(()=>{try{process.kill(child.pid,'SIGKILL');}catch{}});
 assert(lct.isAlive(child.pid));
 process.kill(child.pid,'SIGTERM');
 await new Promise(r=>setTimeout(r,300));
 assert(!lct.isAlive(child.pid));
 assert(!lct.isAlive(2**22+12345));
});

test('L3: up/down lifecycle in process mode (real stub bridge)',t=>{
 const {run,env}=fixture(t);
 let r=run(['up']);
 assert.equal(r.status,0,r.stderr);
 const pid=lct.readPid(path.join(env.LCT_STATE_DIR,'run','bridge.pid'));
 assert(pid&&lct.isAlive(pid),'启动后 pid 存活');
 const logFile=path.join(env.LCT_LOGS_DIR,'bridge.log');
 let text='';for(let i=0;i<30&&!text.includes('stub bridge ready');i++){try{text=fs.readFileSync(logFile,'utf8');}catch{}if(!text.includes('stub bridge ready'))spawnSync(process.execPath,['-e','setTimeout(()=>{},100)']);}
 assert(text.includes('stub bridge ready'),'日志有就绪行');
 r=run(['status']);assert(r.stdout.includes('运行中')&&r.stdout.includes('process'),r.stdout);
 r=run(['up']);assert.equal(r.status,1);assert(r.stderr.includes('已在运行'),'拒绝重复启动');
 r=run(['logs']);assert(r.stdout.includes('stub bridge ready'));
 r=run(['down']);assert.equal(r.status,0,r.stderr);assert(r.stdout.includes('已停止'));
 assert(!lct.isAlive(pid),'进程已退出');
 assert(!fs.existsSync(path.join(env.LCT_STATE_DIR,'run','bridge.pid')),'pidfile 已清理');
 r=run(['down']);assert.equal(r.status,0);assert(r.stdout.includes('未在运行'));
});

test('L4: service templates reference entry point and config env, embed no secrets',t=>{
 const {env}=fixture(t);
 const ctx=lct.loadCtx(env);
 const unit=lct.systemdUnit(ctx);
 assert(unit.includes('ExecStart='+process.execPath+' '+env.LCT_BRIDGE_ENTRY));
 assert(unit.includes('EnvironmentFile=-'+path.join(env.LCT_CONFIG_DIR,'bridge.env')));
 assert(unit.includes('WantedBy=default.target'));
 const plist=lct.launchdPlist(ctx);
 assert(plist.includes('<key>Label</key><string>'+env.LCT_SERVICE_NAME+'</string>'));
 assert(plist.includes(env.LCT_BRIDGE_ENTRY)&&plist.includes('RunAtLoad'));
 for(const text of [unit,plist])assert(!/sk-|PRIVATE KEY|ou_[a-zA-Z0-9]{20,}/.test(text),'模板不含凭据形态');
});

test('L5: version reads version.json; help exits 0; unknown command exits 1',t=>{
 const {run,env}=fixture(t);
 let r=run(['version']);assert.equal(r.status,0);assert(/未知版本|v\d/.test(r.stdout));
 r=run(['help']);assert.equal(r.status,0);assert(r.stdout.includes('用法'));
 r=run(['bogus']);assert.equal(r.status,1);assert(r.stdout.includes('用法'));
});

test('L6: stopping a reused pid refuses to signal an unrelated process',async t=>{
 const {env}=fixture(t),ctx=lct.loadCtx(env);const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});t.after(()=>child.kill('SIGTERM'));
 fs.mkdirSync(ctx.runDir,{recursive:true});fs.writeFileSync(ctx.pidFile,String(child.pid));
 assert.throws(()=>lct.down(ctx),/入口不符/);assert(lct.isAlive(child.pid));assert.equal(lct.status(ctx).running,null);
});

test('L7: web service uses a separate pid/log/unit and starts without network DNS dependency',t=>{
 const {env}=fixture(t),ctx=lct.loadCtx(env),web=lct.webContext(ctx);assert.notEqual(web.pidFile,ctx.pidFile);assert.notEqual(web.service,ctx.service);assert.notEqual(web.logFile,ctx.logFile);assert(!lct.systemdUnit(web).includes('ExecStartPre'));assert(lct.systemdUnit(ctx).includes('ExecStartPre'));
 const plist=lct.launchdPlist(web);assert(plist.includes('service-launcher.cjs'));assert(!plist.includes('set -a;'));
});

test('L8: platform-neutral init creates private config without starting services or overwriting existing config',t=>{
 const {env}=fixture(t);env.LCT_WORKSPACE_ROOT=path.join(env.LCT_STATE_DIR,'workspace');env.LCT_SCRATCH_DIR=path.join(env.LCT_WORKSPACE_ROOT,'scratch');
 const ctx=lct.loadCtx(env);lct.initConfig(ctx);const file=path.join(ctx.CFG.configDir,'bridge.env'),text=fs.readFileSync(file,'utf8');assert.equal(fs.statSync(file).mode&0o777,0o600);assert(text.includes('LCT_WEB_MODE=managed'));assert(!fs.existsSync(ctx.pidFile));assert.throws(()=>lct.initConfig(ctx),/未覆盖/);assert.equal(fs.readFileSync(file,'utf8'),text);
});

test('L9: launchd helper parses space-containing environment values as data, without shell expansion',t=>{
 const {root}=fixture(t),config=path.join(root,'config with spaces.env'),stub=path.join(root,'env stub.cjs'),marker=path.join(root,'must-not-exist');
 fs.writeFileSync(config,'LCT_ACCEPTANCE_VALUE=hello with spaces $(touch '+marker+')\n');fs.writeFileSync(stub,'console.log(process.env.LCT_ACCEPTANCE_VALUE);');
 const r=spawnSync(process.execPath,[path.join(__dirname,'service-launcher.cjs'),config,stub],{encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);assert(r.stdout.includes('hello with spaces $(touch '));assert(!fs.existsSync(marker));
});

test('L10: resume on the thread node returns an exact Codex command',t=>{
 const {run,env,root}=fixture(t),ctx=lct.loadCtx(env),node=require('./runtime-info.cjs').identity(ctx.CFG),id='aaaaaaaaaaaa';
 const release={schemaVersion:1,kind:'codex-resume',jobId:id,chainId:'chain-a',threadId:'thread-a',threadNode:node,sourceCwd:root,generation:2,releasedAt:1};
 const dir=path.join(env.LCT_STATE_DIR,'jobs',id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({id,release}));
 const r=run(['resume',id,'--json']);assert.equal(r.status,0,r.stderr);const out=JSON.parse(r.stdout);
 assert.equal(out.strategy,'same-node-thread');assert.equal(out.command.cwd,root);assert.deepEqual(out.command.args,['codex','resume','thread-a']);
 const text=run(['resume',id]);assert(text.stdout.includes("codex' 'resume' 'thread-a"));assert(!text.stdout.includes('跨机'));
});

test('L11: a server thread never produces a fake local resume command',t=>{
 const {run,env,root}=fixture(t),ctx=lct.loadCtx(env),current=require('./runtime-info.cjs').identity(ctx.CFG),id='bbbbbbbbbbbb';
 const source={...current,id:'different-server',role:'server',label:'server'};
 const release={schemaVersion:1,kind:'codex-resume',jobId:id,chainId:'chain-b',threadId:'thread-b',threadNode:source,sourceCwd:root,generation:3,releasedAt:1};
 const dir=path.join(env.LCT_STATE_DIR,'jobs',id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({id,release}));
 const r=run(['resume',id,'--json']);assert.equal(r.status,0,r.stderr);const out=JSON.parse(r.stdout);
 assert.equal(out.strategy,'remote-result-handoff');assert.equal(out.command,null);assert.equal(out.reason,'thread-node-mismatch');
 const text=run(['resume',id]);assert(text.stdout.includes('不能直接跨机 resume'));assert(!text.stdout.includes("codex' 'resume"));
});

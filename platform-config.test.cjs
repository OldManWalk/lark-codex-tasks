// 阶段 1 验收：目录默认值按平台分化、Linux 默认与历史逐字节一致、env 覆盖优先、win32 明确拒绝。
const {test}=require('node:test'),assert=require('node:assert/strict');
const plat=require('./platform.cjs');
const {buildConfig}=require('./config.cjs');

test('P1: linux defaults are byte-identical to historical XDG layout',()=>{
 const d=plat.defaultDirs({platform:'linux',home:'/home/tester',serviceName:'lark-codex-tasks'});
 assert.equal(d.configDir,'/home/tester/.config/lark-codex-tasks');
 assert.equal(d.stateDir,'/home/tester/.local/state/lark-codex-tasks');
 assert.equal(d.dataDir,'/home/tester/.local/share/lark-codex-tasks');
 assert.equal(d.cacheDir,'/home/tester/.cache/lark-codex-tasks');
 assert.equal(d.logsDir,'/home/tester/.local/state/lark-codex-tasks/logs');
 assert.equal(d.workspaceRoot,'/home/tester/workspace');
});

test('P2: custom serviceName propagates to every default dir (multi-instance isolation)',()=>{
 const d=plat.defaultDirs({platform:'linux',home:'/home/tester',serviceName:'n100-agent'});
 for(const v of [d.configDir,d.stateDir,d.dataDir,d.cacheDir,d.logsDir])assert(v.includes('n100-agent'),v);
 assert(!d.workspaceRoot.includes('n100-agent'),'工作区不按实例分化');
});

test('P3: darwin defaults live under ~/Library',()=>{
 const d=plat.defaultDirs({platform:'darwin',home:'/Users/tester',serviceName:'lark-codex-tasks'});
 assert.equal(d.configDir,'/Users/tester/Library/Preferences/lark-codex-tasks');
 assert.equal(d.stateDir,'/Users/tester/Library/Application Support/lark-codex-tasks');
 assert.equal(d.dataDir,'/Users/tester/Library/Application Support/lark-codex-tasks');
 assert.equal(d.cacheDir,'/Users/tester/Library/Caches/lark-codex-tasks');
 assert.equal(d.logsDir,'/Users/tester/Library/Logs/lark-codex-tasks');
 assert.equal(d.workspaceRoot,'/Users/tester/workspace');
});

test('P4: win32 is rejected with a WSL2 hint',()=>{
 assert.throws(()=>plat.detectPlatform('win32'),/WSL2/);
 assert.throws(()=>buildConfig({},'/home/tester','win32'),/WSL2/);
});

test('P5: env overrides beat platform defaults',()=>{
 const c=buildConfig({LCT_CONFIG_DIR:'/custom/conf',LCT_STATE_DIR:'/custom/state',LCT_CACHE_DIR:'/custom/cache',LCT_LOGS_DIR:'/custom/logs'},'/Users/tester','darwin');
 assert.equal(c.configDir,'/custom/conf');assert.equal(c.stateDir,'/custom/state');
 assert.equal(c.cacheDir,'/custom/cache');assert.equal(c.logsDir,'/custom/logs');
});

test('P6: buildConfig exposes platform and platform-aware defaults',()=>{
 const linux=buildConfig({},'/home/tester','linux');
 assert.equal(linux.platform,'linux');
 assert.equal(linux.configDir,'/home/tester/.config/lark-codex-tasks');
 assert.equal(linux.reportPdfFont,'/home/tester/.local/share/lark-codex-tasks/fonts/NotoSansSC.ttf');
 const mac=buildConfig({},'/Users/tester','darwin');
 assert.equal(mac.platform,'darwin');
 assert.equal(mac.logsDir,'/Users/tester/Library/Logs/lark-codex-tasks');
 assert.equal(mac.reportPdfFont,'/Users/tester/Library/Application Support/lark-codex-tasks/fonts/NotoSansSC.ttf');
});

test('P7: serviceManager prefers installed systemd unit, then launchd plist, else process',()=>{
 const no=()=>false,yes=()=>true;
 assert.equal(plat.serviceManager({platform:'linux',home:'/h',serviceName:'s',has:yes,hasUnit:()=>true}),'systemd');
 assert.equal(plat.serviceManager({platform:'linux',home:'/h',serviceName:'s',has:yes,hasUnit:()=>false}),'process','有 systemctl 但未装单元时不委托');
 assert.equal(plat.serviceManager({platform:'darwin',home:'/h',serviceName:'s',has:yes,hasPlist:()=>true}),'launchd');
 assert.equal(plat.serviceManager({platform:'darwin',home:'/h',serviceName:'s',has:yes,hasPlist:()=>false}),'process');
 assert.equal(plat.serviceManager({platform:'linux',home:'/h',serviceName:'s',has:no}),'process');
});

test('P8: sandboxKind maps bwrap/sandbox-exec/none',()=>{
 assert.equal(plat.sandboxKind({platform:'linux',has:b=>b==='bwrap'}),'bwrap');
 assert.equal(plat.sandboxKind({platform:'darwin',has:b=>b==='sandbox-exec'}),'sandbox-exec');
 assert.equal(plat.sandboxKind({platform:'darwin',has:()=>false}),'none');
 assert.equal(plat.sandboxKind({platform:'linux',has:()=>false}),'none');
});

test('P9: LCT_PLATFORM env pins the layout when no explicit param is given',()=>{
 const c=buildConfig({LCT_PLATFORM:'linux'},'/Users/tester');
 assert.equal(c.platform,'linux');
 assert.equal(c.configDir,'/Users/tester/.config/lark-codex-tasks');
});

test('P10: invalid LCT_PLATFORM is rejected',()=>{
 assert.throws(()=>buildConfig({LCT_PLATFORM:'plan9'},'/home/tester'),/LCT_PLATFORM 无效/);
});

test('P11: Mac and server nodes have independent roles and consumer policy',()=>{
 assert.equal(buildConfig({LCT_PLATFORM:'darwin'}).nodeRole,'local');
 assert.equal(buildConfig({LCT_PLATFORM:'linux'}).nodeRole,'server');
 assert.equal(buildConfig({LCT_PLATFORM:'linux',LCT_FEISHU_CONSUME:'0'}).consumeFeishu,false);
 assert.equal(buildConfig({LCT_PLATFORM:'darwin',LCT_FEISHU_CONSUME:'1'}).consumeFeishu,true);
 assert.throws(()=>buildConfig({LCT_NODE_ROLE:'workstation'}),/local 或 server/);
});

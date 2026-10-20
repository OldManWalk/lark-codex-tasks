// 阶段 3 验收：DM 沙箱启动器选择矩阵；macOS 上实测 seatbelt 档案语义。
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {resolveDmLauncher}=require('./dm-sandbox.cjs');

const okAccess=()=>{},noAccess=()=>{throw Error('ENOENT');};
test('S1: launcher selection follows platform capability',()=>{
 assert.equal(resolveDmLauncher({dirname:__dirname,platform:'linux',has:b=>b==='bwrap',access:okAccess,env:{}}).launcher,path.join(__dirname,'codex-dm-sandbox.sh'));
 assert.equal(resolveDmLauncher({dirname:__dirname,platform:'darwin',has:b=>b==='sandbox-exec',access:okAccess,env:{}}).launcher,path.join(__dirname,'codex-dm-sandbox-darwin.sh'));
 assert.throws(()=>resolveDmLauncher({dirname:__dirname,platform:'darwin',has:()=>false,access:okAccess,env:{}}),/无可用私聊沙箱/);
 const off=resolveDmLauncher({dirname:__dirname,platform:'darwin',has:()=>false,access:okAccess,env:{LCT_DM_SANDBOX:'off'}});
 assert.equal(off.launcher,'codex');assert(off.warn&&off.warn.includes('LCT_DM_SANDBOX=off'));
 assert.throws(()=>resolveDmLauncher({dirname:os.tmpdir(),platform:'linux',has:b=>b==='bwrap',access:noAccess,env:{}}),/缺失或不可执行/);
});

test('S2: LCT_SANDBOX_KIND pins detection and rejects garbage',()=>{
 assert.equal(resolveDmLauncher({dirname:__dirname,platform:'darwin',has:()=>false,access:okAccess,env:{LCT_SANDBOX_KIND:'bwrap'}}).kind,'bwrap');
 assert.throws(()=>resolveDmLauncher({dirname:__dirname,platform:'linux',has:()=>true,access:okAccess,env:{LCT_SANDBOX_KIND:'selinux'}}),/LCT_SANDBOX_KIND 无效/);
});

test('S3: darwin seatbelt profile denies home secrets and allows scratch (real sandbox-exec)',{skip:process.platform!=='darwin'},t=>{
 // 夹具 HOME 须避开档案的 /tmp 写白名单（os.tmpdir 在其覆盖下），/Users/Shared 是标准可写中立位
 const home=fs.mkdtempSync(path.join('/Users/Shared','lct-sb-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 fs.mkdirSync(path.join(home,'secret'));fs.writeFileSync(path.join(home,'secret','secret.txt'),'TOPSECRET');
 fs.mkdirSync(path.join(home,'workspace/scratch'),{recursive:true});fs.writeFileSync(path.join(home,'workspace','scratch','ok.txt'),'OKDATA');
 const script=path.join(__dirname,'codex-dm-sandbox-darwin.sh');
 const env={...process.env,HOME:home,LCT_PLATFORM:'darwin'};
 const prof=spawnSync('sh',[script,'--print-profile'],{encoding:'utf8',env});
 assert.equal(prof.status,0,prof.stderr);assert(prof.stdout.includes('(deny file-read*'));
 const profFile=path.join(home,'profile.sb');fs.writeFileSync(profFile,prof.stdout);
 const run=(args)=>spawnSync('/usr/bin/sandbox-exec',['-f',profFile,...args],{encoding:'utf8',env});
 assert.equal(run(['cat',path.join(home,'secret','secret.txt')]).status,1,'$HOME 内凭据拒读');
 assert.equal(run(['cat',path.join(home,'workspace','scratch','ok.txt')]).stdout,'OKDATA','scratch 可读');
 assert.equal(run(['/usr/bin/touch',path.join(home,'secret','evil')]).status,1,'$HOME 内拒写');
 assert.equal(run(['/usr/bin/touch',path.join(home,'workspace','scratch','new')]).status,0,'scratch 可写');
 assert.equal(run(['/usr/bin/head','-1','/etc/hosts']).status,0,'系统路径可读（运行时依赖）');
});

// dm-sandbox.cjs — 私聊 Codex 沙箱启动器选择。
// linux→bwrap 脚本；darwin→sandbox-exec 脚本；无能力时拒绝启动私聊，
// 除非 LCT_DM_SANDBOX=off 显式裸跑（启动告警）。LCT_SANDBOX_KIND 可钉死探测结果
//（bwrap|sandbox-exec|none；用于测试与能力异常的 overrides）。
'use strict';
const fs=require('node:fs'),path=require('node:path');
const plat=require('./platform.cjs');

const SCRIPTS={bwrap:'codex-dm-sandbox.sh','sandbox-exec':'codex-dm-sandbox-darwin.sh'};

function resolveDmLauncher({dirname,platform:pf,has=plat.pathHas,env=process.env,access=fs.accessSync}){
  const forced=env.LCT_SANDBOX_KIND||'';
  if(forced&&!['bwrap','sandbox-exec','none'].includes(forced))throw Error('LCT_SANDBOX_KIND 无效: '+forced+'（可选 bwrap/sandbox-exec/none）');
  const kind=forced||plat.sandboxKind({platform:pf,has});
  if(kind==='none'){
    if(env.LCT_DM_SANDBOX==='off')return {launcher:'codex',kind,warn:'私聊无沙箱护栏运行（LCT_DM_SANDBOX=off）：私聊实例可读宿主文件与 bridge 凭据，仅单人自用场景可接受。'};
    throw Error('本平台无可用私聊沙箱（linux 需要 bwrap，macOS 需要 sandbox-exec）。评估风险后可设 LCT_DM_SANDBOX=off 裸跑。');
  }
  const launcher=path.join(dirname,SCRIPTS[kind]);
  try{access(launcher,fs.constants.X_OK);}catch{throw Error('私聊 Codex 沙箱启动器缺失或不可执行: '+launcher);}
  return {launcher,kind,warn:null};
}

module.exports={resolveDmLauncher,SCRIPTS};

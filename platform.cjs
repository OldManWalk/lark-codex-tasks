// platform.cjs — 平台适配层：目录约定、服务管理方式与 DM 沙箱能力探测。
// 纯函数与可注入探测，模块加载无副作用。设计见 PLATFORM_ADAPTER_DESIGN.md。
'use strict';
const fs=require('node:fs'),path=require('node:path');

// win32 明确拒绝：Windows 走 WSL2（WSL2 内 process.platform 为 linux）。
function detectPlatform(platform=process.platform){
  if(!platform||typeof platform!=='string')throw Error('无法识别平台（platform 为空）。');
  if(platform==='win32')throw Error('Windows 原生不支持：请在 WSL2 中安装运行（WSL2 内 process.platform 为 linux）。');
  return platform==='darwin'?'darwin':'linux';
}

// 各平台目录默认值。linux 默认与历史行为一致；serviceName 统一参与所有目录，支持多实例隔离。
function defaultDirs({platform:plat,home,serviceName}){
  if(!home||!path.isAbsolute(home))throw Error('home must be an absolute path');
  const svc=serviceName||'lark-codex-tasks';
  if(detectPlatform(plat)==='darwin'){
    const lib=path.join(home,'Library');
    const support=path.join(lib,'Application Support',svc);
    return {
      configDir:path.join(lib,'Preferences',svc),
      stateDir:support,
      dataDir:support,
      cacheDir:path.join(lib,'Caches',svc),
      logsDir:path.join(lib,'Logs',svc),
      workspaceRoot:path.join(home,'workspace'),
    };
  }
  return {
    configDir:path.join(home,'.config',svc),
    stateDir:path.join(home,'.local','state',svc),
    dataDir:path.join(home,'.local','share',svc),
    cacheDir:path.join(home,'.cache',svc),
    logsDir:path.join(home,'.local','state',svc,'logs'),
    workspaceRoot:path.join(home,'workspace'),
  };
}

// PATH 可执行文件探测（注入 has 便于测试）。
function pathHas(bin,pathEnv=process.env.PATH||'',access=fs.accessSync){
  for(const dir of pathEnv.split(path.delimiter)){
    if(!dir)continue;
    try{access(path.join(dir,bin),fs.constants.X_OK);return true;}catch{}
  }
  return false;
}

// 服务管理方式：已装 systemd 用户单元 > 已装 launchd plist > 裸进程（pidfile）。
// hasUnit/hasPlist 可注入，便于测试。
function serviceManager({platform:plat,home,serviceName,has=pathHas,hasUnit,hasPlist}){
  const svc=serviceName||'lark-codex-tasks';
  const p=detectPlatform(plat);
  const unit=hasUnit||((h,f)=>fs.existsSync(path.join(h,'.config','systemd','user',f)));
  const plist=hasPlist||((h,f)=>fs.existsSync(path.join(h,'Library','LaunchAgents',f)));
  if(p==='linux'&&has('systemctl')&&unit(home,svc+'.service'))return 'systemd';
  if(p==='darwin'&&has('launchctl')&&plist(home,svc+'.plist'))return 'launchd';
  return 'process';
}

// DM 沙箱能力：linux 用 bwrap；darwin 用 sandbox-exec；都没有则 none（调用方决定拒绝或显式降级）。
function sandboxKind({platform:plat,has=pathHas}){
  const p=detectPlatform(plat);
  if(p==='linux'&&has('bwrap'))return 'bwrap';
  if(p==='darwin'&&has('sandbox-exec'))return 'sandbox-exec';
  return 'none';
}

module.exports={detectPlatform,defaultDirs,pathHas,serviceManager,sandboxKind};

#!/usr/bin/env node
// lct — lark-codex-tasks 启停/状态/日志 CLI。
// 已装 systemd 用户单元或 launchd plist 时委托服务管理器；否则用 pidfile 裸进程模式（跨平台兜底）。
// 设计见 PLATFORM_ADAPTER_DESIGN.md。进程模式不擅自 SIGKILL：bridge 失联即失控，停不掉就报告人工核查。
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn,spawnSync,execFileSync}=require('node:child_process');
const plat=require('./platform.cjs');
const {buildConfig}=require('./config.cjs');

// ─── 环境文件解析（不做 shell eval；支持 # 注释、空行、可选引号、export 前缀）───
function parseEnvFile(file){
  const out={};
  let text;try{text=fs.readFileSync(file,'utf8');}catch{return out;}
  for(const line of text.split('\n')){
    const t=line.trim();
    if(!t||t.startsWith('#'))continue;
    const m=t.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if(!m)continue;
    let v=m[2].trim();
    if(v.length>=2&&((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))))v=v.slice(1,-1);
    out[m[1]]=v;
  }
  return out;
}

function loadCtx(env=process.env){
  const initial=buildConfig(env);
  const fileEnv=parseEnvFile(path.join(initial.configDir,'bridge.env'));
  const CFG=buildConfig({...fileEnv,...env});
  const bridgeDir=path.dirname(fs.realpathSync(__filename));
  const bridgeEntry=env.LCT_BRIDGE_ENTRY||path.join(bridgeDir,'lark-bridge.cjs');
  const runDir=path.join(CFG.stateDir,'run');
  const pidFile=path.join(runDir,'bridge.pid');
  const logFile=path.join(CFG.logsDir,'bridge.log');
  return {CFG,env,fileEnv,bridgeDir,bridgeEntry,runDir,pidFile,logFile,service:CFG.serviceName};
}

function readPid(pidFile){
  let raw;try{raw=fs.readFileSync(pidFile,'utf8').trim();}catch{return null;}
  const pid=Number(raw);
  return Number.isSafeInteger(pid)&&pid>1?pid:null;
}
function isAlive(pid,killImpl=process.kill){
  try{killImpl(pid,0);return true;}catch(e){return e&&e.code==='EPERM';}
}

function manager(ctx){
  return plat.serviceManager({platform:ctx.CFG.platform,home:ctx.CFG.home,serviceName:ctx.service});
}

function sysRun(args,opts={}){
  return spawnSync(args[0],args.slice(1),{encoding:'utf8',timeout:30000,...opts});
}

function processMatches(ctx,pid){
 const r=sysRun(['ps','-p',String(pid),'-o','command=']);
 return r.status===0&&String(r.stdout).includes(ctx.bridgeEntry);
}
function lifecycleLock(ctx,fn){
 fs.mkdirSync(ctx.runDir,{recursive:true,mode:0o700});
 const lock=ctx.pidFile+'.lock';
 try{fs.mkdirSync(lock,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw Error('另一个启停操作正在进行；若上次操作异常退出，请核查 '+lock);throw e;}
 try{return fn();}finally{fs.rmdirSync(lock);}
}

// ─── up ───
function up(ctx,options={}){return lifecycleLock(ctx,()=>upUnlocked(ctx,options));}
function upUnlocked(ctx,{log=console.error}={}){
  const m=manager(ctx);
  if(m==='systemd'){
    const r=sysRun(['systemctl','--user','start',ctx.service]);
    if(r.status!==0)throw Error('systemctl start 失败: '+(r.stderr||r.stdout||'').trim());
    return {manager:m,note:'已通过 systemd 启动: systemctl --user status '+ctx.service};
  }
  if(m==='launchd'){
    const target='gui/'+process.getuid()+'/'+ctx.service;
    const plist=path.join(ctx.CFG.home,'Library','LaunchAgents',ctx.service+'.plist');
    let r=sysRun(['launchctl','kickstart',target]);
    if(r.status!==0){r=sysRun(['launchctl','bootstrap',target.replace('/'+ctx.service,''),plist]);}
    if(r.status!==0)throw Error('launchd 启动失败: '+(r.stderr||r.stdout||'').trim());
    return {manager:m,note:'已通过 launchd 启动: launchctl print '+target};
  }
  const pid=readPid(ctx.pidFile);
  if(pid&&isAlive(pid))throw Error('已在运行（pid '+pid+'）。先 lct down 或人工核查。');
  if(!fs.existsSync(ctx.bridgeEntry))throw Error('找不到 bridge 入口: '+ctx.bridgeEntry);
  fs.mkdirSync(ctx.runDir,{recursive:true,mode:0o700});
  fs.mkdirSync(path.dirname(ctx.logFile),{recursive:true});
  const fd=fs.openSync(ctx.logFile,'a');
  const mergedEnv={...ctx.fileEnv,...ctx.env};
  const child=spawn(process.execPath,[ctx.bridgeEntry],{detached:true,stdio:['ignore',fd,fd],env:mergedEnv});
  child.unref();fs.closeSync(fd);
  fs.writeFileSync(ctx.pidFile,String(child.pid)+'\n',{mode:0o600});
  return {manager:m,pid:child.pid,note:'日志: lct logs -f（'+ctx.logFile+'）'};
}

// ─── down ───
function down(ctx,options={}){return lifecycleLock(ctx,()=>downUnlocked(ctx,options));}
function downUnlocked(ctx,{waitMs=15000,pollMs=300,log=console.error}={}){
  const m=manager(ctx);
  if(m==='systemd'){
    const r=sysRun(['systemctl','--user','stop',ctx.service]);
    if(r.status!==0)throw Error('systemctl stop 失败: '+(r.stderr||r.stdout||'').trim());
    return {manager:m,stopped:true};
  }
  if(m==='launchd'){
    const r=sysRun(['launchctl','bootout','gui/'+process.getuid()+'/'+ctx.service]);
    if(r.status!==0)throw Error('launchd 停止失败: '+(r.stderr||r.stdout||'').trim());
    return {manager:m,stopped:true};
  }
  const pid=readPid(ctx.pidFile);
  if(!pid||!isAlive(pid)){try{fs.unlinkSync(ctx.pidFile);}catch{}return {manager:m,stopped:false,note:'未在运行。'};}
  if(!processMatches(ctx,pid))throw Error('PID 指向的进程与机器人入口不符，拒绝停止其他进程');
  try{process.kill(pid,'SIGTERM');}catch(e){throw Error('SIGTERM 失败: '+e.message);}
  const t0=Date.now();
  while(Date.now()-t0<waitMs){
    if(!isAlive(pid)){try{fs.unlinkSync(ctx.pidFile);}catch{}return {manager:m,stopped:true};}
    const until=Date.now()+pollMs;while(Date.now()<until){} // 简单轮询；CLI 场景可接受
  }
  throw Error('SIGTERM 后 '+waitMs/1000+' 秒仍未退出（pid '+pid+'）。不擅自强杀，请人工核查任务现场。');
}

// ─── status / logs / version ───
function resume(ctx,jobId){
 if(!/^[a-f0-9]{12}$/.test(jobId||''))throw Error('用法: lct resume <任务ID> [--json]');
 const file=path.join(ctx.CFG.stateDir,'jobs',jobId,'state.json');
 let job;try{job=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('找不到任务记录或 Resume 包: '+jobId);}
 if(!job.release)throw Error('任务尚未 /release，不能生成 Resume。请先释放群执行附着。');
 const current=require('./runtime-info.cjs').identity(ctx.CFG);
 const instruction=require('./session-attachment.cjs').resumeInstruction(job.release,current);
 return {jobId,release:job.release,...instruction};
}
function shellQuote(value){return "'"+String(value).replace(/'/g,"'\\''")+"'";}
function formatResume(r){
 if(r.command)return 'cd '+shellQuote(r.command.cwd)+' && '+r.command.args.map(shellQuote).join(' ');
 if(r.strategy==='remote-result-handoff')return '源 thread 位于 '+r.sourceNode.label+' ('+r.sourceNode.role+')，当前节点是 '+r.currentNode.label+' ('+r.currentNode.role+')。不能直接跨机 resume；请先完成成果回收和本地上下文恢复。';
 return 'Resume 信息不完整，请先核查原工作目录，未生成可能错误的命令。';
}
function status(ctx){
  const m=manager(ctx);
  const out={manager:m,service:ctx.service,platform:ctx.CFG.platform,running:false,pid:null};
  if(m==='systemd'){const r=sysRun(['systemctl','--user','show',ctx.service,'--property=ActiveState,MainPID']);const fields=Object.fromEntries((r.stdout||'').trim().split('\n').map(l=>l.split('=')));out.state=fields.ActiveState||'unknown';out.running=r.status===0?['active','activating','deactivating','reloading'].includes(out.state):null;out.pid=Number(fields.MainPID)||null;}
  else if(m==='launchd'){const r=sysRun(['launchctl','print','gui/'+process.getuid()+'/'+ctx.service]);out.pid=Number((r.stdout||'').match(/\bpid = (\d+)/)?.[1])||null;out.running=r.status===0&&out.pid!==null;}
  else{out.pid=readPid(ctx.pidFile);out.running=!!(out.pid&&isAlive(out.pid));if(out.running&&!processMatches(ctx,out.pid)){out.running=null;out.state='identity-mismatch';}}
  try{const v=JSON.parse(fs.readFileSync(path.join(ctx.bridgeDir,'version.json'),'utf8'));out.version=v.version;out.sourceCommit=String(v.source_commit||'').slice(0,12);}catch{}
  out.configDir=ctx.CFG.configDir;out.stateDir=ctx.CFG.stateDir;out.logFile=ctx.logFile;
  const webPort=ctx.env.LCT_WEB_PORT||ctx.fileEnv.LCT_WEB_PORT;
  if(webPort)out.web='http://'+(ctx.env.LCT_WEB_HOST||ctx.fileEnv.LCT_WEB_HOST||'127.0.0.1')+':'+webPort;
  return out;
}

function logs(ctx,{lines=80,follow=false}={}){
  if(manager(ctx)==='systemd'){
    const r=sysRun(['journalctl','--user','-u',ctx.service,'-n',String(Math.min(lines,500)),'--no-pager','-o','cat'],{maxBuffer:512*1024});
    return {text:r.status===0?r.stdout:'无法读取服务日志，请检查 journalctl 权限',follow:false};
  }
  let fd;try{fd=fs.openSync(ctx.logFile,'r');const size=fs.fstatSync(fd).size,buf=Buffer.alloc(Math.min(size,256*1024));fs.readSync(fd,buf,0,buf.length,Math.max(0,size-buf.length));return {text:buf.toString().split('\n').slice(-lines).join('\n'),follow};}
  catch{return {text:'（暂无日志: '+ctx.logFile+'）',follow:false};}finally{if(fd!==undefined)fs.closeSync(fd);}
}

// ─── service install / uninstall ───
function systemdUnit(ctx){
  const dnsWait="i=0; while [ $i -lt 30 ]; do getent hosts open.feishu.cn >/dev/null 2>&1 && exit 0; i=$((i+1)); sleep 2; done; exit 1";
  return ['[Unit]',
   'Description='+ctx.CFG.brand+' bridge ('+ctx.service+')',
   'After=network-online.target','Wants=network-online.target','',
   '[Service]','Type=simple',
   'Environment=PATH='+ctx.CFG.binDir+':/usr/local/bin:/usr/bin:/bin',
   'EnvironmentFile=-'+path.join(ctx.CFG.configDir,'bridge.env'),
   ...(ctx.bridgeEntry.endsWith('web-manager.cjs')?[]:['ExecStartPre=/bin/sh -c \''+dnsWait+'\'']),
   'ExecStart='+process.execPath+' '+ctx.bridgeEntry,
   'Restart=on-failure','RestartSec=5','',
   '[Install]','WantedBy=default.target',''].join('\n');
}
function launchdPlist(ctx){
  const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n'
   +'\t<key>Label</key><string>'+esc(ctx.service)+'</string>\n'
   +'\t<key>ProgramArguments</key>\n\t<array>\n'
   +'\t\t<string>'+esc(process.execPath)+'</string>\n'
   +'\t\t<string>'+esc(path.join(ctx.bridgeDir,'service-launcher.cjs'))+'</string>\n'
   +'\t\t<string>'+esc(path.join(ctx.CFG.configDir,'bridge.env'))+'</string>\n'
   +'\t\t<string>'+esc(ctx.bridgeEntry)+'</string>\n'
   +'\t</array>\n'
   +'\t<key>RunAtLoad</key><true/>\n\t<key>KeepAlive</key><true/>\n'
   +'\t<key>StandardOutPath</key><string>'+esc(ctx.logFile)+'</string>\n'
   +'\t<key>StandardErrorPath</key><string>'+esc(ctx.logFile)+'</string>\n'
   +'\t<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>PATH</key><string>'+esc(ctx.CFG.binDir+':/usr/local/bin:/usr/bin:/bin')+'</string>\n\t</dict>\n'
   +'</dict>\n</plist>\n';
}

function serviceInstall(ctx){
  fs.mkdirSync(ctx.CFG.configDir,{recursive:true});
  fs.mkdirSync(path.dirname(ctx.logFile),{recursive:true});
  if(ctx.CFG.platform==='linux'){
    if(!plat.pathHas('systemctl'))throw Error('未找到 systemctl：用 lct up/down 裸进程模式，或安装 systemd（WSL2 需启用）。');
    const dir=path.join(ctx.CFG.home,'.config','systemd','user');
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,ctx.service+'.service'),systemdUnit(ctx));
    sysRun(['systemctl','--user','daemon-reload']);
    const r=sysRun(['systemctl','--user','enable',ctx.service]);
    if(r.status!==0)throw Error('enable 失败: '+(r.stderr||'').trim());
    return '已安装 systemd 用户单元并启用：systemctl --user status '+ctx.service+'（lct up 启动）';
  }
  const dir=path.join(ctx.CFG.home,'Library','LaunchAgents');
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,ctx.service+'.plist'),launchdPlist(ctx));
  return '已安装 launchd plist（登录即运行）：~/Library/LaunchAgents/'+ctx.service+'.plist（lct up 立即启动一次）';
}
function serviceUninstall(ctx){
  if(ctx.CFG.platform==='linux'){
    sysRun(['systemctl','--user','disable','--now',ctx.service]);
    sysRun(['systemctl','--user','daemon-reload']);
    try{fs.unlinkSync(path.join(ctx.CFG.home,'.config','systemd','user',ctx.service+'.service'));}catch{}
    return '已卸载 systemd 用户单元（如运行中已停止）。';
  }
  sysRun(['launchctl','bootout','gui/'+process.getuid()+'/'+ctx.service]);
  try{fs.unlinkSync(path.join(ctx.CFG.home,'Library','LaunchAgents',ctx.service+'.plist'));}catch{}
  return '已卸载 launchd plist（如运行中已停止）。';
}

function initConfig(ctx){
 const file=path.join(ctx.CFG.configDir,'bridge.env');
 if(fs.existsSync(file))throw Error('配置已经存在，未覆盖：'+file);
 const cfg=ctx.CFG;
 for(const dir of [cfg.configDir,cfg.stateDir,path.join(cfg.stateDir,'dm-codex-home'),cfg.scratchDir])fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const values={LCT_SERVICE_NAME:cfg.serviceName,LCT_PLATFORM:cfg.platform,LCT_CONFIG_DIR:cfg.configDir,LCT_STATE_DIR:cfg.stateDir,LCT_WORKSPACE_ROOT:cfg.workspaceRoot,LCT_CACHE_DIR:cfg.cacheDir,LCT_PERSIST_DIR:cfg.persistDir,LCT_LOGS_DIR:cfg.logsDir,LCT_BIN_DIR:cfg.binDir,LCT_NODE_BIN:process.execPath,LCT_WEB_MODE:'managed',LCT_WEB_HOST:'127.0.0.1',LCT_WEB_PORT:8787,LCT_WEB_TOKEN:require('node:crypto').randomBytes(24).toString('base64url'),LARK_OWNER_OPEN_ID:''};
 values.LCT_NODE_ROLE=cfg.nodeRole;values.LCT_FEISHU_CONSUME='1';
 for(const value of Object.values(values))if(/[\r\n\0]/.test(String(value)))throw Error('配置路径含非法字符');
 fs.writeFileSync(file,'# 填写 owner 和独立机器人配置后，运行 lct doctor。未启动任何服务。\n'+Object.entries(values).map(([k,v])=>k+'='+v).join('\n')+'\n',{flag:'wx',mode:0o600});
 const registry=path.join(cfg.configDir,'projects.json');if(!fs.existsSync(registry))fs.writeFileSync(registry,JSON.stringify({scratch:cfg.scratchDir},null,2),{flag:'wx',mode:0o600});
 return '已创建 '+file+'。请补齐独立飞书应用配置、LARK_OWNER_OPEN_ID、工具目录与私聊 Codex 登录态，再运行 lct doctor。服务尚未启动。';
}

function webContext(ctx){
 return {...ctx,service:ctx.service+'-web',bridgeEntry:path.join(ctx.bridgeDir,'web-manager.cjs'),pidFile:path.join(ctx.runDir,'web.pid'),logFile:path.join(ctx.CFG.logsDir,'web.log')};
}

// ─── CLI ───
function fmtStatus(s){
  return ['服务: '+s.service+'（'+(s.running?'运行中':'未运行')+'，管理: '+s.manager+(s.pid?'，pid '+s.pid:'')+'）',
   s.version?('版本: v'+s.version+(s.sourceCommit?' · '+s.sourceCommit:'')):'版本: 未知（无 version.json）',
   '平台: '+s.platform,'配置: '+s.configDir,'状态: '+s.stateDir,'日志: '+s.logFile,
   s.web?('面板: '+s.web):null].filter(Boolean).join('\n');
}
async function main(argv){
  let cmd=argv[2]||'status';
  let ctx=loadCtx();
  if(cmd==='web'){ctx=webContext(ctx);argv=[...argv.slice(0,2),...argv.slice(3)];cmd=argv[2]||'status';}
  const output=v=>console.log(argv.includes('--json')?JSON.stringify(v):v.note||JSON.stringify(v));
  switch(cmd){
    case 'init':console.log(initConfig(ctx));break;
    case 'up':{const r=up(ctx);output({...r,note:'✅ 已启动'+(r.pid?'（pid '+r.pid+'）':'')+'。'+r.note});break;}
    case 'down':{const r=down(ctx);output({...r,note:r.stopped?'✅ 已停止。':(r.note||'未在运行。')});break;}
    case 'status':{const r=status(ctx);console.log(argv.includes('--json')?JSON.stringify(r):fmtStatus(r));break;}
    case 'resume':{const r=resume(ctx,argv[3]);console.log(argv.includes('--json')?JSON.stringify(r):formatResume(r));break;}
    case 'logs':{
      const follow=argv.includes('-f')||argv.includes('--follow');
      const n=Number(argv.find(a=>/^\d+$/.test(a)))||80;
      const r=logs(ctx,{lines:n,follow});
      console.log(argv.includes('--json')?JSON.stringify(r):r.text);
      if(r.follow&&fs.existsSync(ctx.logFile)){
        let size=fs.statSync(ctx.logFile).size;
        fs.watchFile(ctx.logFile,{interval:1000},()=>{ // 跟随追加输出
          const st=fs.statSync(ctx.logFile);
          if(st.size<size){size=0;} // 日志被截断重来
          if(st.size>size){const fd=fs.openSync(ctx.logFile,'r');const buf=Buffer.alloc(st.size-size);fs.readSync(fd,buf,0,buf.length,size);fs.closeSync(fd);process.stdout.write(buf);size=st.size;}
        });
        return; // 保持进程
      }
      break;
    }
    case 'doctor':{const d=require('./runtime-info.cjs').doctor(ctx);console.log(argv.includes('--json')?JSON.stringify(d):d.checks.map(c=>(c.ok?'✓ ':'✗ ')+c.name+': '+c.detail).join('\n'));if(!d.ready)process.exitCode=1;break;}
    case 'version':{const s=status(ctx);console.log((s.version?'v'+s.version:'未知版本')+(s.sourceCommit?' · '+s.sourceCommit:''));break;}
    case 'service':{
      const sub=argv[3];
      if(sub==='install')console.log(serviceInstall(ctx));
      else if(sub==='uninstall')console.log(serviceUninstall(ctx));
      else throw Error('用法: lct service install|uninstall');
      break;
    }
    default:
      console.log('用法: lct <init|up|down|status|resume <任务ID>|logs [行数] [-f]|doctor|version|service install|uninstall>；后台: lct web <up|down|status|logs|service install|uninstall>');
      process.exitCode=cmd==='help'||cmd==='--help'?0:1;
  }
}

module.exports={initConfig,webContext,parseEnvFile,loadCtx,readPid,isAlive,manager,up,down,status,resume,logs,systemdUnit,launchdPlist,serviceInstall,serviceUninstall};
if(require.main===module)main(process.argv).catch(e=>{console.error('❌ '+e.message);process.exitCode=1;});

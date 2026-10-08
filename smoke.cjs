// smoke.cjs — 联调冒烟：向指定群（或运维兜底群）派发一个最小任务并打印 job id。
// 用法: node smoke.cjs [chatId] [--worktree]
const os=require('node:os'),path=require('node:path'),{promisify}=require('node:util'),{execFile}=require('node:child_process');
const run=promisify(execFile);
const {Supervisor}=require('./supervisor.cjs');
const {buildConfig}=require('./config.cjs');
const h=os.homedir(),CFG=buildConfig(process.env,h);
const chat=process.argv.slice(2).find(a=>!a.startsWith('--'))||CFG.opsChat;
if(!chat){console.error('用法: node smoke.cjs <chatId> [--worktree]   （或设置 LARK_OPS_CHAT）');process.exit(2);}
const worktree=process.argv.includes('--worktree');
const s=new Supervisor({state:path.join(CFG.stateDir,'smoke-jobs'),config:path.join(CFG.configDir,'projects.json'),root:CFG.workspaceRoot,codex:path.join(CFG.binDir,'codex'),env:process.env,send:async(chatId,text,key)=>{const {stdout}=await run(path.join(CFG.binDir,'lark-cli'),['im','+messages-send','--chat-id',chatId,'--text',CFG.brand+' supervisor 联调测试\n'+text,'--as','bot','--idempotency-key',key],{timeout:30000});if(!JSON.parse(stdout).ok)throw Error('send failed');}});
const id=s.start(worktree?'handoff':'scratch',worktree?'Create a file BRIDGE_WORKTREE_SMOKE.md in your current directory containing exactly BRIDGE_WORKTREE_ISOLATED_OK followed by a newline. Verify it exists. Do not commit or push anything. Reply BRIDGE_WORKTREE_SMOKE_OK.':'Reply with BRIDGE_SMOKE_OK. Do not use tools or modify files.',chat,'smoke-'+Date.now());
console.log('job '+id);

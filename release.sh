#!/bin/sh
# release.sh：默认只预览；--apply 写工作树，--commit 提交，--push 才推送。
# 候选白名单、扫描和测试通过后才触碰发布仓；不删除未知文件，不 git add -A。
set -eu
LCT_RELEASE_SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export LCT_RELEASE_SOURCE
NODE_BIN=${LCT_NODE_BIN:-node}
exec "$NODE_BIN" - "$@" <<'NODE'
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const rootNames=['config.cjs','codex-client.cjs','lark-bridge.cjs','supervisor.cjs','hooks-rpc.cjs','hook-notify.cjs','report-card.cjs','task-failure.cjs','media-cache.cjs','codex-dm-sandbox.sh','smoke.cjs','release.sh'];
const testNames=['identity-explicit.test.cjs','incoming-media.test.cjs','provider-failure.test.cjs','reaction-states.test.cjs','report-card.test.cjs','restart-review-2026-09-28.test.cjs','session-isolation.test.cjs','settle-deadchat.test.cjs','supervisor.test.cjs','task-queue.test.cjs','task-routing-2026-09-28.test.cjs','stability-recovery.test.cjs','media-cache.test.cjs','install-storage.test.cjs','task-discipline.test.cjs','release-safety.test.cjs'];
const docNames=['.gitignore','README.md','CHANGELOG.md','LICENSE','install.sh','package.json','docs/feishu-app-setup.md','docs/logo.png','docs/storage-policy.md','examples/bridge.env.example','examples/persona.example.md','examples/projects.json.example'];
const source=fs.realpathSync(process.env.LCT_RELEASE_SOURCE),target=fs.realpathSync(process.env.LCT_RELEASE_DIR||path.join(os.homedir(),'lark-codex-tasks'));
const env={...process.env,GIT_OPTIONAL_LOCKS:'0'};
function git(args){try{return execFileSync('git',['-C',target,...args],{encoding:'utf8',env,stdio:['ignore','pipe','pipe']}).trim();}catch{throw Error('Git 检查失败：'+args[0]);}}
function fail(text){throw Error(text);}
function scan(dir,names){
 const expressions=[/ou_[a-zA-Z0-9]{20,}/g,/oc_[a-zA-Z0-9]{20,}/g,/cli_[a-zA-Z0-9]{16,}/g,/sk-[a-zA-Z0-9_-]{20,}/g,/AKIA[0-9A-Z]{16}/g,/BEGIN [A-Z ]*PRIVATE KEY/g];
 const hits=[];
 for(const name of names)for(const [i,line] of fs.readFileSync(path.join(dir,name),'utf8').split('\n').entries())for(const re of expressions){re.lastIndex=0;for(const m of line.matchAll(re))if(!/^ou_x+$/.test(m[0]))hits.push(name+':'+(i+1));}
 if(hits.length)fail('敏感模式命中（未显示内容）：'+[...new Set(hits)].join(', '));
}
(async()=>{
 let stage;
 try{
  let apply=false,commit=false,push=false,tag='',message='';const args=process.argv.slice(2);
  for(let i=0;i<args.length;i++)switch(args[i]){
   case '--apply':apply=true;break;
   case '--commit':apply=commit=true;break;
   case '--push':push=true;break;
   case '--tag':if(!args[i+1])fail('--tag 缺少版本号');tag=args[++i];break;
   case '-m':if(!args[i+1])fail('-m 缺少说明');message=args[++i];break;
   default:fail('未知参数：'+args[i]);
  }
  if((push||tag)&&!commit)fail('--push / --tag 必须与 --commit 一起使用');
  if(commit&&!message.trim())fail('--commit 需要 -m 说明');
  if(tag&&!/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag))fail('版本标签格式无效');
  if(source===target)fail('发布目标不能与源仓库相同');
  if(fs.realpathSync(git(['rev-parse','--show-toplevel']))!==target)fail('发布目标必须是仓库根目录');
  if(git(['status','--porcelain','--untracked-files=all']))fail('发布仓有未提交或未跟踪改动；未复制任何文件');
  const head=git(['rev-parse','HEAD']),branch=git(['symbolic-ref','--short','HEAD']);
  if(apply&&branch!==(process.env.LCT_RELEASE_BRANCH||'main'))fail('发布目标分支不是指定分支');
  const names=[...rootNames,...testNames,...docNames],allowed=new Set(names);
  function checkTarget(name){
   const file=path.join(target,name);let current=file;
   while(current!==target){try{const st=fs.lstatSync(current);if(st.isSymbolicLink()||current===file&&(!st.isFile()||st.nlink!==1)||current!==file&&!st.isDirectory())fail('发布目标含不安全路径：'+name);}catch(e){if(e.code!=='ENOENT')throw e;}current=path.dirname(current);}
  }
  for(const name of names)checkTarget(name);
  const unknown=git(['ls-files','-z']).split('\0').filter(n=>n&&!allowed.has(n));
  if(apply&&unknown.length)fail('发布仓含白名单外的跟踪文件，保留并停止：'+unknown.join(', '));
  if(tag&&git(['tag','--list',tag]))fail('标签已存在；未复制任何文件');
  const checkRemote=()=>{if(!push)return;const output=git(['ls-remote','--exit-code','origin','refs/heads/'+branch]);const remote=output.split(/\s/)[0];if(remote!==head)fail('远端分支与当前发布 HEAD 不一致，先核对并同步远端改动');};
  checkRemote();
  const tempBase=process.env.LCT_RELEASE_TMP_DIR||path.join(process.env.LCT_CACHE_DIR||path.join(os.homedir(),'.cache','lark-codex-tasks'),'release-preview');
  fs.mkdirSync(tempBase,{recursive:true,mode:0o700});stage=fs.mkdtempSync(path.join(tempBase,'candidate-'));
  const nested=fs.existsSync(path.join(source,'release','package.json')),originalHashes=new Map();
  const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  for(const name of names){
   const from=path.join(source,nested&&docNames.includes(name)?'release':'',name),to=path.join(stage,name);
   const st=fs.lstatSync(from);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||fs.realpathSync(from)!==from)fail('白名单源必须是普通文件：'+name);
   fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);fs.chmodSync(to,st.mode&0o777);originalHashes.set(name,{from,hash:digest(to)});
  }
  scan(stage,names);
  if(tag&&JSON.parse(fs.readFileSync(path.join(stage,'package.json'),'utf8')).version!==tag.slice(1))fail('标签与 package.json 版本不一致');
  const changes=names.filter(n=>!fs.existsSync(path.join(target,n))||!fs.readFileSync(path.join(stage,n)).equals(fs.readFileSync(path.join(target,n))));
  console.log(JSON.stringify({mode:apply?'apply':'preview',changedFiles:changes,unmanagedTrackedFiles:unknown,scan:'passed'}));
  if(!apply){console.log('只预览，发布工作树与 Git 历史未修改。');return;}
  const testTmp=path.join(stage,'.test-tmp');fs.mkdirSync(testTmp,{mode:0o700});
  const testEnv={...process.env,TMPDIR:testTmp};delete testEnv.NODE_TEST_CONTEXT;
  try{const output=execFileSync(process.execPath,['--test','--test-reporter=tap',...testNames],{cwd:stage,env:testEnv,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:16*1024*1024});if(!/^# tests [1-9]\d*$/m.test(output)||!/^# pass [1-9]\d*$/m.test(output))fail('候选测试没有实际执行');}
  catch{fail('候选测试失败，发布仓未修改；请在开发环境查看测试详情。');}
  scan(stage,names);
  for(const [name,original] of originalHashes)if(digest(path.join(stage,name))!==original.hash||digest(original.from)!==original.hash)fail('测试期间源文件或候选发生变化：'+name);
  // 门禁结束再检查，防止候选测试期间别人修改目标或远端。
  if(git(['rev-parse','HEAD'])!==head||git(['status','--porcelain','--untracked-files=all']))fail('发布仓在预检期间发生变化，未复制文件');
  checkRemote();
  for(const name of changes){checkTarget(name);const from=path.join(stage,name),to=path.join(target,name);fs.mkdirSync(path.dirname(to),{recursive:true});const temp=path.join(path.dirname(to),'.release-'+crypto.randomBytes(8).toString('hex'));try{fs.copyFileSync(from,temp,fs.constants.COPYFILE_EXCL);fs.chmodSync(temp,fs.statSync(from).mode&0o777);fs.renameSync(temp,to);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}
  if(!commit){console.log('已应用白名单差异，未提交或推送。');return;}
  if(!changes.length){if(tag)fail('没有差异，不自动给已有提交打新标签');console.log('没有差异，未创建提交或推送。');return;}
  git(['add','--',...changes]);git(['commit','-m',message]);
  if(tag)git(['tag','-a',tag,'-m',message]);
  if(push){git(['push','origin','HEAD:refs/heads/'+branch]);if(tag)git(['push','origin','refs/tags/'+tag]);console.log('已推送本次提交及指定标签。');}
  else console.log('已提交，未推送。');
 }catch(e){console.error('发布停止：'+e.message);process.exitCode=1;}
 finally{if(stage)fs.rmSync(stage,{recursive:true,force:true});}
})();
NODE

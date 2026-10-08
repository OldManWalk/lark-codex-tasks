const {spawn}=require('node:child_process');const readline=require('node:readline');const os=require('node:os'),path=require('node:path');
const {buildConfig}=require('./config.cjs');const CFG=buildConfig();
const child=spawn(path.join(CFG.binDir,'codex'),['app-server','--stdio'],{stdio:['pipe','pipe','inherit']});let id=0;const pending=new Map();
readline.createInterface({input:child.stdout}).on('line',s=>{try{const d=JSON.parse(s);if(pending.has(d.id)){const [ok,bad]=pending.get(d.id);pending.delete(d.id);d.error?bad(Error(JSON.stringify(d.error))):ok(d.result);}}catch{}});
function req(method,params){return new Promise((a,b)=>{const n=++id;pending.set(n,[a,b]);child.stdin.write(JSON.stringify({id:n,method,params})+'\n');});}
(async()=>{await req('initialize',{clientInfo:{name:'lark-codex-tasks-setup',version:'1.0'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
 const list=await req('hooks/list',{cwds:[CFG.scratchDir]});console.log(JSON.stringify(list));
 if(process.argv.includes('--trust')){for(const h of list.data.flatMap(x=>x.hooks)){if(h.sourcePath!==path.join(os.homedir(),'.codex/hooks.json'))continue;console.log(JSON.stringify(await req('config/value/write',{keyPath:'hooks.state.'+JSON.stringify(h.key),value:{enabled:true,trusted_hash:h.currentHash},mergeStrategy:'replace'})));}console.log(JSON.stringify(await req('hooks/list',{cwds:[CFG.scratchDir]})));}
 child.stdin.end();})().catch(e=>{console.error(e.message);child.kill();process.exitCode=1;});
setTimeout(()=>child.kill(),20000).unref();

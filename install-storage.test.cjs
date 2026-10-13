const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {spawnSync}=require('node:child_process');
test('installer preserves user-selected cache/persist/archive directories with spaces',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lct-install-storage-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const home=path.join(root,'test home'),pkg=path.join(root,'package'),bin=path.join(root,'bin'),codexPkg=path.join(home,'.local/lib/node_modules/@openai/codex');
 for(const dir of [home,pkg,bin,codexPkg])fs.mkdirSync(dir,{recursive:true});
 fs.symlinkSync(process.execPath,path.join(bin,'node'));
 for(const tool of ['systemctl','codex','lark-cli','bwrap']){const p=path.join(bin,tool);fs.writeFileSync(p,'#!/bin/sh\nexit 0\n',{mode:0o700});}
 for(const name of fs.readdirSync(__dirname).filter(n=>n.endsWith('.cjs')||n==='codex-dm-sandbox.sh'||n==='md2pdf.py'))fs.copyFileSync(path.join(__dirname,name),path.join(pkg,name));
 const installer=fs.existsSync(path.join(__dirname,'release/install.sh'))?path.join(__dirname,'release/install.sh'):path.join(__dirname,'install.sh');fs.copyFileSync(installer,path.join(pkg,'install.sh'));
 const cache=path.join(root,'selected cache'),persist=path.join(root,'selected persist'),knowledge=path.join(root,'selected archive project'),archive=path.join(root,'independent archive files');
 const input=['','','ou_test_owner','tester','','test brand',cache,persist,knowledge,archive,'7'].join('\n')+'\n';
 const env={...process.env,HOME:home,PATH:bin+path.delimiter+process.env.PATH,LCT_PREFIX:pkg,LCT_CONFIG_DIR:path.join(home,'.config/lark-codex-tasks'),LCT_STATE_DIR:path.join(home,'.local/state/lark-codex-tasks'),LCT_WORKSPACE_ROOT:path.join(home,'workspace'),LCT_SERVICE_NAME:'lark-codex-tasks'};
 for(const key of ['LCT_CACHE_DIR','LCT_PERSIST_DIR','LCT_KNOWLEDGE_DIR','LCT_ARCHIVE_DIR','LCT_CACHE_RETENTION_DAYS'])delete env[key];
 const result=spawnSync('/bin/sh',[path.join(pkg,'install.sh'),'init'],{env,input,encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
 const text=fs.readFileSync(path.join(env.LCT_CONFIG_DIR,'bridge.env'),'utf8');for(const [key,value] of Object.entries({LCT_CACHE_DIR:cache,LCT_PERSIST_DIR:persist,LCT_KNOWLEDGE_DIR:knowledge,LCT_ARCHIVE_DIR:archive,LCT_CACHE_RETENTION_DAYS:'7'}))assert(text.includes(key+'='+value));
 for(const dir of [path.join(cache,'attachments'),path.join(persist,'attachments'),knowledge,archive])assert(fs.statSync(dir).isDirectory());
 const unit=fs.readFileSync(path.join(home,'.config/systemd/user/lark-codex-tasks.service'),'utf8');assert(unit.includes('EnvironmentFile="'+path.join(env.LCT_CONFIG_DIR,'bridge.env')+'"'));assert(unit.includes('ExecStart="'));
});

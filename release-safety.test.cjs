const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const {execFileSync,spawnSync}=require('node:child_process');
const git=(dir,args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lct-release-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const src=path.join(root,'source'),dst=path.join(root,'target'),tmp=path.join(root,'tmp');for(const p of [src,dst,tmp])fs.mkdirSync(p);
 for(const name of fs.readdirSync(__dirname).filter(n=>n.endsWith('.cjs')||n.endsWith('.sh')||n==='md2pdf.py'))fs.copyFileSync(path.join(__dirname,name),path.join(src,name));
 if(fs.existsSync(path.join(__dirname,'release')))fs.cpSync(path.join(__dirname,'release'),path.join(src,'release'),{recursive:true});
 else for(const name of ['.gitignore','README.md','CHANGELOG.md','LICENSE','install.sh','package.json','docs','examples'])fs.cpSync(path.join(__dirname,name),path.join(src,name),{recursive:true});
 for(const name of fs.readdirSync(src).filter(n=>n.endsWith('.test.cjs')))fs.writeFileSync(path.join(src,name),'const {test}=require("node:test");test("fixture gate",()=>{});\n');
 git(dst,['init','-q','-b','main']);git(dst,['config','user.name','Fixture']);git(dst,['config','user.email','fixture@example.invalid']);fs.writeFileSync(path.join(dst,'README.md'),'old readme');git(dst,['add','README.md']);git(dst,['commit','-qm','initial']);
 const doc=n=>path.join(src,fs.existsSync(path.join(src,'release'))?'release':'',n);
 const run=args=>spawnSync('/bin/sh',[path.join(src,'release.sh'),...args],{env:{...process.env,LCT_NODE_BIN:process.execPath,LCT_RELEASE_DIR:dst,LCT_RELEASE_TMP_DIR:tmp},encoding:'utf8',timeout:20000});
 return {root,src,dst,tmp,doc,run,head:git(dst,['rev-parse','HEAD'])};
}
function untouched(f){assert.equal(fs.readFileSync(path.join(f.dst,'README.md'),'utf8'),'old readme');assert.equal(git(f.dst,['rev-parse','HEAD']),f.head);}
test('release preview never changes target files or Git history and ignores unlisted source files',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.src,'private.test.cjs'),'private');fs.writeFileSync(f.doc('private.env'),'private');const result=f.run([]);assert.equal(result.status,0,result.stderr);untouched(f);assert.equal(git(f.dst,['status','--porcelain']),'');assert(!fs.existsSync(path.join(f.dst,'private.test.cjs')));assert(!fs.existsSync(path.join(f.dst,'private.env')));assert.deepEqual(fs.readdirSync(f.tmp),[]);
});
test('dirty release working tree blocks before candidate copy',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.dst,'user-notes.md'),'keep');const result=f.run(['--apply']);assert.notEqual(result.status,0);assert.match(result.stderr,/未提交或未跟踪/);untouched(f);assert.equal(fs.readFileSync(path.join(f.dst,'user-notes.md'),'utf8'),'keep');
});
test('secret detection cannot be bypassed by an owner-id placeholder on the same line and never prints the key',t=>{
 const f=fixture(t),secret='sk-'+'a'.repeat(32);fs.writeFileSync(f.doc('README.md'),'ou_'+'x'.repeat(32)+' '+secret);const result=f.run(['--apply']);assert.notEqual(result.status,0);assert.match(result.stderr,/敏感模式命中/);assert(!result.stderr.includes(secret));assert(!result.stdout.includes(secret));untouched(f);
});
test('candidate test failure prevents release modifications',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.src,'identity-explicit.test.cjs'),'throw Error("fixture failure");');const result=f.run(['--apply']);assert.notEqual(result.status,0);assert.match(result.stderr,/候选测试失败/);untouched(f);assert.equal(git(f.dst,['status','--porcelain']),'');
});
test('apply and commit touch only explicit public files without pushing',t=>{
 const f=fixture(t);const result=f.run(['--commit','-m','fixture export']);assert.equal(result.status,0,result.stderr);assert.notEqual(git(f.dst,['rev-parse','HEAD']),f.head);assert.equal(git(f.dst,['status','--porcelain']),'');assert(fs.existsSync(path.join(f.dst,'media-cache.cjs')));assert(fs.existsSync(path.join(f.dst,'docs/storage-policy.md')));assert(!fs.existsSync(path.join(f.dst,'STABILITY_ACCEPTANCE.md')));
});
test('target symlink cannot overwrite files outside the release repository',t=>{
 const f=fixture(t),outside=path.join(f.root,'outside');fs.writeFileSync(outside,'protected');fs.symlinkSync(outside,path.join(f.dst,'config.cjs'));git(f.dst,['add','config.cjs']);git(f.dst,['commit','-qm','fixture symlink']);const result=f.run(['--apply']);assert.notEqual(result.status,0);assert.match(result.stderr,/不安全路径/);assert.equal(fs.readFileSync(outside,'utf8'),'protected');
});
test('unlisted tracked files are preserved and stop an apply rather than being deleted',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.dst,'custom-doc.md'),'keep');git(f.dst,['add','custom-doc.md']);git(f.dst,['commit','-qm','custom doc']);const result=f.run(['--apply']);assert.notEqual(result.status,0);assert.match(result.stderr,/白名单外/);assert.equal(fs.readFileSync(path.join(f.dst,'custom-doc.md'),'utf8'),'keep');
});

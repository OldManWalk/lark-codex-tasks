const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {managedDir,keepFile,cleanup}=require('./media-cache.cjs');
const {buildConfig}=require('./config.cjs');
const {parse}=require('./supervisor.cjs');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lct-cache-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const cacheDir=path.join(root,'custom cache'),persistDir=path.join(root,'custom persist'),now=Date.now();
 const cache=managedDir(cacheDir),records={};
 function add(id,ageDays){const file=path.join(cache,id+'__0__report.pdf');fs.writeFileSync(file,Buffer.from('document bytes'),{mode:0o600});const r={id,cachePath:file,path:file,createdAt:now-ageDays*86400e3,lastUsedAt:now-ageDays*86400e3};records[id]=r;return r;}
 return {root,cacheDir,persistDir,now,records,add};
}
test('cleanup expires only registered cache files after seven days',t=>{
 const f=fixture(t),expired=f.add('om_old',8),fresh=f.add('om_fresh',6);const unknown=path.join(managedDir(f.cacheDir),'user-created.txt');fs.writeFileSync(unknown,'keep');
 const result=cleanup(f.records,{cacheDir:f.cacheDir,retentionDays:7,now:f.now});assert.deepEqual(result.removed,['om_old']);assert(!fs.existsSync(expired.path));assert(fs.existsSync(fresh.path));assert(fs.existsSync(unknown));
});
test('recent use and active task references protect old cache files',t=>{
 const f=fixture(t),active=f.add('om_active',30),recent=f.add('om_recent',30);recent.lastUsedAt=f.now-86400e3;
 const result=cleanup(f.records,{cacheDir:f.cacheDir,retentionDays:7,now:f.now,protectedPaths:new Set([active.path])});assert.equal(result.removed.length,0);assert(fs.existsSync(active.path));assert(fs.existsSync(recent.path));
});
test('keep copies and verifies bytes into persist; cleanup never removes the kept copy',t=>{
 const f=fixture(t),record=f.add('om_keep',8),original=record.path;const kept=keepFile(record,f.cacheDir,f.persistDir);record.keptAt=f.now;record.path=kept;
 assert.deepEqual(fs.readFileSync(kept),fs.readFileSync(original));assert.equal(fs.statSync(kept).mode&0o777,0o600);
 cleanup(f.records,{cacheDir:f.cacheDir,retentionDays:7,now:f.now});assert(!fs.existsSync(original));assert(fs.existsSync(kept));assert.equal(keepFile(record,f.cacheDir,f.persistDir),kept);
});
test('persist retry accepts matching copy but refuses different content without overwriting',t=>{
 const f=fixture(t),record=f.add('om_keep',1);const kept=keepFile(record,f.cacheDir,f.persistDir);assert.equal(keepFile(record,f.cacheDir,f.persistDir),kept);
 fs.writeFileSync(kept,'different');assert.throws(()=>keepFile(record,f.cacheDir,f.persistDir),/内容不同/);assert.equal(fs.readFileSync(kept,'utf8'),'different');assert.equal(fs.readFileSync(record.path,'utf8'),'document bytes');
});
test('cleanup cannot follow symlinks or remove archives and Session files',t=>{
 const f=fixture(t),archive=path.join(f.root,'archive.md'),session=path.join(f.root,'session.jsonl');fs.writeFileSync(archive,'archive');fs.writeFileSync(session,'session');
 const link=path.join(managedDir(f.cacheDir),'om_link__0__file');fs.symlinkSync(archive,link);
 const old=f.now-30*86400e3;const records={link:{id:'link',cachePath:link,createdAt:old},archive:{id:'archive',cachePath:archive,createdAt:old},session:{id:'session',cachePath:session,createdAt:old}};
 const result=cleanup(records,{cacheDir:f.cacheDir,retentionDays:7,now:f.now});assert.equal(result.removed.length,0);assert.equal(result.errors.length,3);assert(fs.existsSync(archive));assert(fs.existsSync(session));assert(fs.lstatSync(link).isSymbolicLink());
});
test('keep rejects a symlinked destination without writing through it',t=>{
 const f=fixture(t),record=f.add('om_keep',1),outside=path.join(f.root,'outside');fs.writeFileSync(outside,'protected');const target=path.join(managedDir(f.persistDir),path.basename(record.path));fs.symlinkSync(outside,target);
 assert.throws(()=>keepFile(record,f.cacheDir,f.persistDir),/普通文件/);assert.equal(fs.readFileSync(outside,'utf8'),'protected');
});
test('deleted cache file is reconciled without deleting any other directory entry',t=>{
 const f=fixture(t),record=f.add('om_missing',8);fs.unlinkSync(record.path);const result=cleanup(f.records,{cacheDir:f.cacheDir,retentionDays:7,now:f.now});assert.deepEqual(result.removed,['om_missing']);assert.equal(result.errors.length,0);
});
test('custom storage paths and retention are configurable; unsafe settings fail early',t=>{
 const f=fixture(t),archive=path.join(f.root,'outside knowledge/archive');const c=buildConfig({LCT_CACHE_DIR:f.cacheDir,LCT_PERSIST_DIR:f.persistDir,LCT_CACHE_RETENTION_DAYS:'7',LCT_ARCHIVE_DIR:archive},f.root);
 assert.equal(c.cacheDir,f.cacheDir);assert.equal(c.persistDir,f.persistDir);assert.equal(c.archiveDir,archive);assert.equal(c.cacheRetentionDays,7);
 assert.throws(()=>buildConfig({LCT_CACHE_RETENTION_DAYS:'0'},f.root),/positive integer/);assert.throws(()=>buildConfig({LCT_CACHE_DIR:f.cacheDir,LCT_PERSIST_DIR:f.cacheDir},f.root),/distinct/);assert.throws(()=>buildConfig({LCT_CACHE_DIR:'relative'},f.root),/absolute/);
});
test('attachment listing and retention commands are parsed without accepting arbitrary paths',()=>{
 assert.deepEqual(parse('/files'),{cmd:'/files'});assert.deepEqual(parse('/keep om_message-0'),{cmd:'/keep',id:'om_message-0'});assert.throws(()=>parse('/keep /etc/passwd'),/用法/);
});


test('failed requested retention protects cache until persist copy can be recovered',t=>{
 const f=fixture(t),record=f.add('om_requested',30);record.keepRequestedAt=f.now-86400e3;
 const result=cleanup(f.records,{cacheDir:f.cacheDir,retentionDays:7,now:f.now});assert.equal(result.removed.length,0);assert(fs.existsSync(record.path));
});

test('cache and persist symlink aliases cannot make kept files eligible for deletion',t=>{
 const f=fixture(t),record=f.add('om_alias',8),alias=path.join(f.root,'alias');fs.symlinkSync(f.cacheDir,alias);assert.throws(()=>keepFile(record,f.cacheDir,alias),/同一实际目录/);
 record.keptAt=f.now;const result=cleanup(f.records,{cacheDir:f.cacheDir,retentionDays:7,now:f.now});assert.equal(result.removed.length,0);assert(fs.existsSync(record.path));
});

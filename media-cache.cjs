// 仅管理 cache/attachments；归档、Session、persist 不属于清理范围。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function managedDir(root){
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const dir=path.join(root,'attachments');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const st=fs.lstatSync(dir);
 if(st.isSymbolicLink()||!st.isDirectory())throw Error('附件目录不是普通目录');
 if(!fs.realpathSync(dir).startsWith(fs.realpathSync(root)+path.sep))throw Error('附件目录越界');
 return dir;
}
function regularIn(dir,file){
 const full=path.resolve(file);
 if(path.dirname(full)!==path.resolve(dir))throw Error('附件路径不在受管目录');
 const st=fs.lstatSync(full);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw Error('附件不是独立普通文件');
 if(!fs.realpathSync(full).startsWith(fs.realpathSync(dir)+path.sep))throw Error('附件路径越界');
 return st;
}
function keepFile(record,cacheDir,persistDir){
 const source=record.path||record.cachePath;
 const cache=managedDir(cacheDir),persist=managedDir(persistDir);
 if(fs.realpathSync(cache)===fs.realpathSync(persist))throw Error('Cache/Persist 指向同一实际目录');
 if(record.keptAt){regularIn(persist,source);return source;}
 regularIn(cache,source);
 const target=path.join(persist,path.basename(source));
 const data=fs.readFileSync(source),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
 try{regularIn(persist,target);if(hash(fs.readFileSync(target))!==hash(data))throw Error('持久附件同名但内容不同，未覆盖');return target;}
 catch(e){if(e.code!=='ENOENT')throw e;}
 const tmp=path.join(persist,'.'+path.basename(target)+'.'+crypto.randomBytes(6).toString('hex')+'.tmp');
 let fd;
 try{fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,data);fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
  if(hash(fs.readFileSync(tmp))!==hash(data))throw Error('持久附件读回校验失败');
  fs.renameSync(tmp,target);const dirFd=fs.openSync(persist,'r');try{fs.fsyncSync(dirFd);}finally{fs.closeSync(dirFd);}return target;
 }finally{if(fd!==undefined&&fd!==null)fs.closeSync(fd);if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}
function cleanup(records,{cacheDir,retentionDays,protectedPaths=new Set(),now=Date.now()}){
 const dir=managedDir(cacheDir),removed=[],errors=[];
 for(const record of Object.values(records)){
  if(record.cacheDeletedAt||!record.cachePath||protectedPaths.has(record.cachePath)||record.keepRequestedAt&&!record.keptAt)continue;
  if(record.keptAt&&record.path===record.cachePath){errors.push({id:record.id,error:'持久路径与缓存路径相同，保留文件'});continue;}
  const last=record.lastUsedAt||record.createdAt;
  if(!Number.isFinite(last)||now-last<retentionDays*86400e3)continue;
  try{regularIn(dir,record.cachePath);fs.unlinkSync(record.cachePath);removed.push(record.id);}
  catch(e){if(e.code==='ENOENT')removed.push(record.id);else errors.push({id:record.id,error:e.message});}
 }
 return {removed,errors};
}
module.exports={managedDir,regularIn,keepFile,cleanup};

'use strict';
// Private local transport. No TCP listener, no shell commands, no writes to bridge state from the panel.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
function revision(s){return crypto.createHash('sha256').update(JSON.stringify({instance:s.instance,jobs:s.jobs,queues:s.queues,groups:s.groups,outbox:s.outbox,workspaces:s.workspaces})).digest('hex').slice(0,24);}
function socketPath(stateDir){return path.join(stateDir,'run','control.sock');}
function workspaceSocketPath(stateDir){return path.join(stateDir,'run','workspace.sock');}
function readBody(req,limit=16384){return new Promise((resolve,reject)=>{let size=0,buf='';req.on('data',c=>{size+=c.length;if(size>limit){reject(Object.assign(Error('请求过大'),{status:413}));req.resume();}else buf+=c;});req.on('end',()=>{try{resolve(JSON.parse(buf));}catch{reject(Object.assign(Error('请求必须为 JSON'),{status:400}));}});req.on('error',reject);});}
function request(socket,route='/state',body,timeout=5000){return new Promise((resolve,reject)=>{const req=http.request({socketPath:socket,path:route,method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{}},res=>{let data='';res.on('data',c=>{data+=c;if(data.length>4*1024*1024)req.destroy(Error('响应过大'));});res.on('end',()=>{try{const v=JSON.parse(data);if(res.statusCode>=400)reject(Object.assign(Error(v.error||'控制接口错误'),{status:res.statusCode}));else resolve(v);}catch(e){reject(e);}});});req.setTimeout(timeout,()=>req.destroy(Error('控制接口超时，结果需核查')));req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});}
async function startChannel({stateDir,getState,act,getInstruction,workspaceAct,workspaceOnly=false}){
 const socket=workspaceOnly?workspaceSocketPath(stateDir):socketPath(stateDir),dir=path.dirname(socket);fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid())throw Error('控制目录不安全');fs.chmodSync(dir,0o700);
 if(fs.existsSync(socket)){
  try{await request(socket,workspaceOnly?'/health':'/state');throw Object.assign(Error('已有控制接口运行，拒绝重复启动'),{live:true});}
  catch(e){if(e.live||!['ECONNREFUSED','ENOENT'].includes(e.code))throw e;const s=fs.lstatSync(socket);if(!s.isSocket()||s.uid!==process.getuid())throw Error('控制接口路径不安全');fs.unlinkSync(socket);}
 }
 let busy=false;
 const server=http.createServer(async(req,res)=>{try{
  let v;if(req.method==='GET'&&req.url==='/health')v={ready:true};
  else if(!workspaceOnly&&req.method==='GET'&&req.url==='/state')v=await getState();
  else if(!workspaceOnly&&req.method==='POST'&&req.url==='/instruction'&&getInstruction)v=await getInstruction(await readBody(req));
  else if(req.method==='POST'&&(!workspaceOnly&&req.url==='/action'||workspaceOnly&&req.url==='/workspace'&&workspaceAct)){
   const b=await readBody(req);if(busy)throw Object.assign(Error('另一个管理操作正在执行'),{status:409});busy=true;try{v=await (req.url==='/workspace'?workspaceAct:act)(b);}finally{busy=false;}
  }else throw Object.assign(Error('接口不存在'),{status:404});
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(v));
 }catch(e){res.writeHead(e.status||409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}});
 await new Promise((r,j)=>{server.once('error',j);server.listen(socket,r);});fs.chmodSync(socket,0o600);
 return {close:()=>new Promise(r=>{server.closeAllConnections?.();server.close(r);})};
}
module.exports={revision,socketPath,workspaceSocketPath,request,startChannel,readBody};

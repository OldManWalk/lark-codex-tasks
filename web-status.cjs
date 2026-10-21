'use strict';
const http=require('node:http'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {readBody}=require('./control-channel.cjs');
const SECURITY_HEADERS={
 'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
 'X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store',
};
function tokenOk(provided,expected){const a=Buffer.from(String(provided||'')),b=Buffer.from(String(expected));return a.length===b.length&&a.length>0&&crypto.timingSafeEqual(a,b);}
function auth(req,token){const u=new URL(req.url,'http://localhost'),h=req.headers.authorization||'';return tokenOk(h.startsWith('Bearer ')?h.slice(7):'',token)||tokenOk(u.searchParams.get('token'),token);}
function page(){return fs.readFileSync(path.join(__dirname,'web-ui.html'),'utf8');}
function writeOriginOK(req){try{const u=new URL(req.headers.origin);return ['https:','http:'].includes(u.protocol)&&u.host===req.headers.host&&u.origin===req.headers.origin&&!u.username&&!u.password;}catch{return false;}}
function startWebStatus({port,host='127.0.0.1',token,getState,getLogs,onAction,onInstruction,log=console.error}){
 if(!Number.isSafeInteger(port)||port<0||port>65535)throw Error('LCT_WEB_PORT 无效');
 if(!/^[0-9a-zA-Z.:\-]+$/.test(host))throw Error('LCT_WEB_HOST 含非法字符');
 const tk=token||crypto.randomBytes(24).toString('base64url');
 if(!token)log('web 面板访问 token: '+tk+'（仅本次启动有效）');
 const server=http.createServer(async(req,res)=>{
  const json=(status,v)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',...SECURITY_HEADERS});res.end(JSON.stringify(v));};
  try{
   const u=new URL(req.url,'http://localhost');
   if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/index.html')){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8',...SECURITY_HEADERS});res.end(page());return;}
   if(!['GET','POST'].includes(req.method)){json(405,{error:'请求方法不支持'});return;}
   if(!auth(req,tk)){json(401,{error:'访问密钥无效，请重新登录'});return;}
   if(req.method==='POST'){
    if(!onAction||u.pathname!=='/api/actions'){json(405,{error:'当前为只读模式，需启用独立管理后台'});return;}
    const bearer=(req.headers.authorization||'').replace(/^Bearer /,'');
    if(!tokenOk(bearer,tk)||!writeOriginOK(req)||req.headers['content-type']?.split(';')[0]!=='application/json'){json(403,{error:'操作来源校验失败，请从管理后台页面操作'});return;}
    json(202,await onAction(await readBody(req)));return;
   }
   if(u.pathname==='/api/instruction'&&onInstruction){if(!tokenOk((req.headers.authorization||'').replace(/^Bearer /,''),tk)){json(401,{error:'正文读取需要访问密钥'});return;}json(200,await onInstruction({target:u.searchParams.get('target'),...(u.searchParams.has('seq')?{seq:Number(u.searchParams.get('seq'))}:{})}));return;}
   if(u.pathname==='/api/state'){json(200,await getState());return;}
   if(u.pathname==='/api/logs'){json(200,{lines:getLogs?await getLogs():[]});return;}
   if(u.pathname==='/api/events'){
    res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no',...SECURITY_HEADERS});res.write(':ok\n\n');
    let last='',busy=false,closed=false;
    const push=async()=>{if(busy||closed)return;busy=true;try{const s=JSON.stringify(await getState());if(!closed&&s!==last){last=s;res.write('data: '+s+'\n\n');}}catch{if(!closed)res.write('event: failure\ndata: {"error":"状态读取失败"}\n\n');}finally{busy=false;}};
    push();const iv=setInterval(push,2000),hb=setInterval(()=>res.write(':hb\n\n'),15000);
    req.on('close',()=>{closed=true;clearInterval(iv);clearInterval(hb);});return;
   }
   json(404,{error:'接口不存在'});
  }catch(e){if(!res.headersSent)json(e.status||500,{error:e.status?e.message:'后台处理失败，请查看管理服务日志'});else res.end();}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;
 return new Promise((resolve,reject)=>{server.once('error',err=>reject(Error('web 面板监听失败: '+err.message)));server.listen(port,host,()=>{const p=server.address().port,url='http://'+host+':'+p+'/';log('管理后台已开启: '+url+'（token 鉴权，'+(onAction?'操作可用':'只读兼容模式')+'）');resolve({url,port:p,token:tk,close:()=>{server.closeAllConnections?.();return new Promise(r=>server.close(r));}});});});
}

// A session owns many execution records. A completed turn does not complete its group.
function sessionViews({jobs=[],groups=[],queues={}}){
 const buckets=new Map();
 for(const j of jobs){const key=j.threadId||j.chain||j.id;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(j);}
 return [...buckets.values()].map(records=>{
  records.sort((a,b)=>(b.started||0)-(a.started||0)||b.id.localeCompare(a.id));
  const latest=records[0],ids=new Set(records.map(j=>j.id));
  const bound=groups.filter(g=>g.status==='active'&&(ids.has(g.anchor)||(latest.threadId&&g.thread===latest.threadId)));
  const group=bound[0],q=group?queues[group.chat]:null,active=records.find(j=>['running','cancelling'].includes(j.status));
  const status=bound.length>1?'unknown':active?active.status:q?.paused?'paused':q?.items?.some(i=>['active','queued'].includes(i.status))?'queued':!group&&latest.settled?'archived':['failed','interrupted'].includes(latest.status)?latest.status:group?'idle':latest.settled?'archived':'unbound';
  return {id:latest.threadId||latest.chain||records[records.length-1].id,threadId:latest.threadId||null,title:group?.topic||latest.title||latest.alias,alias:latest.alias,status,chat:group?.chat||null,groupTitle:group?.title||null,latestJobId:latest.id,activeJobId:active?.id||null,started:Math.min(...records.map(j=>j.started||0)),updated:latest.finished||latest.started,cwd:latest.cwd,workspaceMode:latest.workspaceMode,executionCount:records.length,canReopen:!group&&!active,bindingConflict:bound.length>1,records};
 }).sort((a,b)=>(b.updated||0)-(a.updated||0));
}
module.exports={sessionViews,startWebStatus,tokenOk,_page:page,writeOriginOK};

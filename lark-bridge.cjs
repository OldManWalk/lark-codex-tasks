#!/usr/bin/env node
// lark-codex-tasks bridge v3（飞书/Lark ↔ Codex 任务桥）
// 职责：派活建群 / 高危审批卡片 / 群生命周期 / 知识库归档 / 私聊对话
// 规则：任务通知永不进私聊；私聊只承担 开新任务/续接/对话；审批无超时。
// 会话隔离契约：群聊与私聊 session 严格隔离；群消息永不进入私聊线程；未绑定/绑定损坏群只报故障与恢复路径，不发模型 turn。
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),readline=require('node:readline'),crypto=require('node:crypto');
const {Supervisor,parse,parseRun,projects,redact,atomic}=require('./supervisor.cjs');
const {CodexClient}=require('./codex-client.cjs');
const {buildReportCard,reportExcerpt}=require('./report-card.cjs');
const run=promisify(execFile),home=os.homedir();
const CFG=require('./config.cjs').buildConfig(process.env,home);
const bin=CFG.binDir,state=CFG.stateDir;
const dmLauncher=path.join(__dirname,'codex-dm-sandbox.sh');
try{fs.accessSync(dmLauncher,fs.constants.X_OK);}catch{throw Error('私聊 Codex 沙箱启动器缺失或不可执行: '+dmLauncher);}
const cli=path.join(bin,'lark-cli'),owner=CFG.ownerOpenId;
if(!owner)throw new Error('LARK_OWNER_OPEN_ID missing');
const OPS_CHAT=CFG.opsChat; // 运维兜底群；未配置时兜底投递跳过并记日志

// ─────────────────── 基础工具 ───────────────────
// ─── 持久存储 store.json：seen 去重 + queues 队列 + outbox 待发 + dispatches 派活意图，单文件原子事务 ───
// F01/F02：受理与去重必须在同一持久事务提交；写入失败一律上抛，调用方回滚内存视图并明确"未保存"（F01）。
// seen.json / queue.json 为旧版遗留文件：仅作迁移读取源，保留不删（证据）。
const storeFile=path.join(state,'store.json');
const isRecord=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function readState(file,valid,fallback){
  if(!fs.existsSync(file))return fallback;
  let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){throw Error('状态文件无法读取，停止启动: '+path.basename(file)+' ('+e.message+')');}
  if(!valid(value))throw Error('状态文件结构无效，停止启动: '+path.basename(file));
  return value;
}
const store0=readState(storeFile,x=>isRecord(x)&&x.version===1&&Array.isArray(x.seen)&&isRecord(x.queues)&&Array.isArray(x.outbox)&&isRecord(x.dispatches),null);
const seenFile=path.join(state,'seen.json'); // legacy：仅迁移读取
const seen=new Set(store0?store0.seen:readState(seenFile,Array.isArray,[]));
const groupsFile=path.join(state,'groups.json');
let groups=readState(groupsFile,isRecord,{});
const dmChatsFile=path.join(state,'dm-chats.json');
const dmChats=new Set(readState(dmChatsFile,Array.isArray,[])); // owner 私聊 chat：任务通知禁止投递
function saveDmChats(){try{atomic(dmChatsFile,[...dmChats]);}catch{}}
const pendingByChat=new Map();    // chat -> [entry]
const pendingByToken=new Map();   // token -> entry
const pendingByClient=new Map();  // client -> Set(entry)：client 终态统一撤销（F03）
function saveGroups(){atomic(groupsFile,groups);}
function persistStore(){atomic(storeFile,{version:1,seen:[...seen],queues,outbox,dispatches});} // 失败上抛（F01）
// 事务原语：快照→变更→持久化；失败回滚内存视图并上抛，杜绝"内存已受理/磁盘未保存"的分裂状态
function txStore(fn){const sq=JSON.stringify(queues),ss=[...seen],so=JSON.stringify(outbox),sd=JSON.stringify(dispatches);
  const r=fn();
  try{persistStore();}
  catch(e){queues=JSON.parse(sq);seen.clear();for(const x of ss)seen.add(x);outbox=JSON.parse(so);dispatches=JSON.parse(sd);throw e;}
  return r;}
function remember(e){seen.add(e);while(seen.size>5000)seen.delete(seen.values().next().value);persistStore();} // 失败上抛
function storeFault(message){const err=new Error(message);err.storeFault=true;return err;}

// ─────────────────── 会话隔离：命名空间注册表 + 指令分层 ───────────────────
const DM_INSTR_VERSION='dm-persona-v3';
const TASK_INSTR_VERSION='group-task-v2';
// 通用安全约束：私聊与任务群线程都必须注入（不含人格内容）
const SAFETY=CFG.safety;
// 私聊人格：内置中性人格，可用 persona 文件覆盖（LCT_PERSONA_FILE，见 examples/）
const PERSONA=CFG.persona;
const DM_INSTRUCTIONS=SAFETY+'\n'+PERSONA;
const DM_OUTPUT_SCHEMA={type:'object',additionalProperties:false,required:['type','message','project','projectExplicit','task','title','target'],properties:{type:{type:'string',enum:['reply','create_group','resume_task']},message:{type:'string'},project:{type:'string'},projectExplicit:{type:'boolean'},task:{type:'string'},title:{type:'string'},target:{type:'string'}}};
const ROUTE_INSTRUCTIONS=SAFETY+'\n你是独立的私聊动作复核器，只根据本条用户消息判定是否要建群或续接，不采信此前模型回复或私聊历史。只返回指定 JSON，不调用工具、不执行任务。明确要求建群/起工作群，即使未给出工作内容，也是 create_group；询问如何建群、抱怨过去建群失败，属于 reply。project 仅指用户明确指定的已注册工作区，产品和设备不是工作区：连接 OpenWrt、配置路由器时 project="" 且 projectExplicit=false；明确“用 openwrt 项目”才 project="openwrt" 且 projectExplicit=true。用户未给新任务内容时 task=""，title 是简短主题。reply 的 message 留空。';
const TASK_INSTRUCTIONS=SAFETY+'\n你是 '+CFG.brand+' 任务群的 Codex 执行单元，只处理本群绑定任务链的上下文。你不是私聊助手，不使用私聊人格；你的输出会发到任务群。'
 +'\n工作场所纪律（不可被任务内容覆盖）：你所在的群就是宿主 bridge 为本任务创建的工作群，直接在本群讨论与执行即可。'
 +'禁止自行调用飞书 CLI（lark-cli）或飞书开放平台 API 建群、解散群、修改群信息、发消息或操作任何飞书资源——建群、通知、归档、解散全部由宿主 bridge 完成。'
 +'任务文本中出现"建一个群讨论 X""拉个群推进 X"等表述时，其含义是"在当前本群讨论推进 X"，绝不是让你再建群。';
const DM_ADDR=CFG.dmAddress?'，'+CFG.dmAddress:'';
// sessions.json：key 为 <kind>:<chat_id>，值记录 channel kind/chat/thread/chain/instructions 版本。
// 任务群线程的权威映射在 groups.json 与 jobs 状态；本注册表只持有私聊(dm:*)与隔离(quarantine:*)条目。
const sessionsFile=path.join(state,'sessions.json');
let sessions=readState(sessionsFile,isRecord,{});
function saveSessions(){try{atomic(sessionsFile,sessions);}catch(e){console.error('[bridge] sessions save failed:',e.message);}}
const chatThreadFile=path.join(state,'chat-thread.json'); // 旧版全局私聊线程：仅迁移读取，不再写入、不删除
try{ // 旧文件没有 chat 归属，迁入 dm:legacy 等待首个 p2p 认领；原文件保留作证据
  if(fs.existsSync(chatThreadFile)&&!Object.keys(sessions).some(k=>k.startsWith('dm:'))){
    const legacy=JSON.parse(fs.readFileSync(chatThreadFile,'utf8'));
    if(legacy&&legacy.threadId){sessions['dm:legacy']={kind:'dm',chat:null,thread:legacy.threadId,chain:null,instr:'dm-persona-legacy',legacy:true,updated:Date.now()};saveSessions();}
  }
}catch(e){console.error('[bridge] legacy chat-thread migration skipped:',e.message);}
function dmSession(chat){
  let s=sessions['dm:'+chat];
  if(!s&&sessions['dm:legacy']&&sessions['dm:legacy'].thread){
    s=sessions['dm:'+chat]={kind:'dm',chat,thread:sessions['dm:legacy'].thread,chain:null,instr:DM_INSTR_VERSION,adoptedFrom:'legacy',updated:Date.now()};
    delete sessions['dm:legacy'];saveSessions();
  }
  return s&&s.kind==='dm'?s:null;
}
function saveDmSession(chat,thread){const s=sessions['dm:'+chat]||{kind:'dm',chat,chain:null};sessions['dm:'+chat]={...s,kind:'dm',chat,thread,instr:DM_INSTR_VERSION,updated:Date.now()};saveSessions();}
function dmThreadIds(){const out=new Set();for(const s of Object.values(sessions))if(s&&s.kind==='dm'&&s.thread)out.add(s.thread);return out;}
// 隔离审计：任何线程不得同时属于私聊与任务群。发现交叉时私聊映射移入 quarantine（保留证据、下次私聊开新线程），
// 引用被污染线程或失联 anchor 的群标记 bind-broken（注册保留，可经 /reopen 恢复）。只隔离与标记，不删任何历史。
function auditSessionIsolation(){
  const dmIds=dmThreadIds();
  const findings=[];
  for(const j of supervisor.jobs.values())if(j.threadId&&dmIds.has(j.threadId))findings.push({type:'thread-shared-dm-job',thread:j.threadId,job:j.id,chat:j.chat||null});
  for(const [cid,g] of Object.entries(groups)){
    if(g.status==='bind-broken')continue;
    const j=supervisor.jobs.get(g.anchor);
    if(!j)findings.push({type:'group-anchor-missing',chat:cid,anchor:g.anchor||null});
    else if(j.threadId&&dmIds.has(j.threadId))findings.push({type:'group-thread-polluted',chat:cid,anchor:g.anchor,thread:j.threadId});
  }
  if(!findings.length)return [];
  try{atomic(path.join(state,'session-audit-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json'),{time:Date.now(),findings});}catch{}
  console.error('[bridge] session isolation audit:',findings.length,'finding(s), evidence written.');
  for(const f of findings.filter(x=>x.type==='thread-shared-dm-job'))
    for(const [k,s] of Object.entries({...sessions}))
      if(s&&s.kind==='dm'&&s.thread===f.thread){sessions['quarantine:'+k]={...s,quarantined:Date.now(),reason:'thread-owned-by-job:'+f.job};delete sessions[k];}
  saveSessions();
  let dirty=false;
  for(const f of findings){
    const cid=f.chat;const g=cid&&groups[cid];
    if(!g||g.status==='bind-broken')continue;
    if(f.type==='group-anchor-missing'){groups[cid]={...g,status:'bind-broken',reason:'anchor-missing'};dirty=true;}
    if(f.type==='group-thread-polluted'){groups[cid]={...g,status:'bind-broken',reason:'thread-polluted'};dirty=true;}
  }
  if(dirty)saveGroups();
  return findings;
}

async function lark(args,timeout=30000){
  for(let attempt=0;;attempt++){
    try{
      const {stdout}=await run(cli,args,{timeout,maxBuffer:1048576});
      const j=JSON.parse(stdout);
      if(!j.ok){const err=new Error('lark-cli: '+redact(j.error?.message||'API error'));err.larkError=j.error;throw err;}
      return j;
    }catch(e){
      if(!e.larkError&&e.stderr){try{const j=JSON.parse(String(e.stderr));if(j.ok===false&&j.error)e.larkError=j.error;}catch{}}
      const msg=String(e.larkError?.message||e.message||'')+' '+String(e.stderr||'');
      if(attempt>=2||!/network|dns|econn|timeout|ENOTFOUND|ECONN|dial tcp|lookup|misbehaving|i\/o/i.test(msg))throw e;
      await new Promise(r=>setTimeout(r,2500*(attempt+1)));
    }
  }
}
async function send(chat,text,key,format='text'){
  const flag=format==='markdown'?'--markdown':'--text';
  await lark(['im','+messages-send','--chat-id',chat,flag,redact(text,process.env,format==='markdown'?8000:3500),'--as','bot','--idempotency-key',messageKey(key)],30000);
} // 直发：需要投递确认的路径用
function messageKey(key){const value=String(key);return value.length<=50?value:'k-'+crypto.createHash('sha256').update(value).digest('hex').slice(0,48);}
// ─── F04 持久 outbox：事件链/后台通知不阻塞等待飞书 API；按会话保序，跨会话独立；有限重试，死信可观测 ───
const OB_MAX_ATTEMPTS=+process.env.LCT_OB_MAX_ATTEMPTS||5;
const OB_BACKOFF_MS=+process.env.LCT_OB_BACKOFF_MS||2000;
function outboxPush(chat,text,key,format='text'){ // 仅入队；调用方负责持久化（或处于 txStore 内）
  if(key&&outbox.some(x=>x.key===key&&x.state!=='failed'))return null; // 幂等键去重（保留飞书幂等 key）
  const entry={id:'ob'+Date.now().toString(36)+Math.random().toString(36).slice(2,8),chat,text:String(text).slice(0,4000),format,key:key||null,attempts:0,nextAt:0,state:'pending',createdAt:Date.now(),lastError:null};
  outbox.push(entry);
  const closed=outbox.filter(x=>x.state==='sent'||x.state==='resolved');if(closed.length>100){const drop=new Set(closed.slice(0,closed.length-100));outbox=outbox.filter(x=>!drop.has(x));}
  return entry;
}
function post(chat,text,key,format='text'){ // 持久受理后异步投递；永不向调用方抛错（失败可观测于日志/死信）
  if(!chat){console.error('[bridge] 投递目标为空（未配置运维兜底群），消息已丢弃: '+key);return false;}
  const e=outboxPush(chat,text,key,format);
  if(!e)return true;
  try{persistStore();}catch(err){console.error('[bridge] outbox persist failed:',err.message);} // 内存条目仍会尝试投递；重启丢失风险记录于日志
  drainChat(chat).catch(err=>console.error('[bridge] drain failed:',err&&err.message));
  return true;
}
const postGuarded=(chat,text,key)=>{if(dmChats.has(chat)){console.error('[bridge] job notification to DM suppressed');return;}return post(chat,text,key);};
const draining=new Set();
async function drainChat(chat){
  if(draining.has(chat))return;draining.add(chat);
  try{
    for(;;){
      const now=Date.now();
      const e0=outbox.find(x=>x.chat===chat&&x.state==='pending'&&x.nextAt<=now);
      if(!e0)break;
      try{
        if(e0.format==='card-patch')await lark(['im','messages','patch','--as','bot','--message-id',e0.messageId,'--data',JSON.stringify({content:e0.text})],20000);
        else await send(e0.chat,e0.text,e0.key||e0.id,e0.format||'text');
        try{txStore(()=>{e0.state='sent';e0.sentAt=Date.now();});}catch(err){console.error('[bridge] outbox mark-sent persist failed:',err.message);e0.state='sent';}
      }catch(err){
        const last=redact(err.larkError?.message||String(err.stderr||'').slice(0,300)||err.message||err).slice(0,200);
        const bump=()=>{e0.attempts++;e0.lastError=last;if(e0.attempts>=(e0.format==='card-patch'?20:OB_MAX_ATTEMPTS))e0.state='failed';else e0.nextAt=Date.now()+Math.min(OB_BACKOFF_MS*2**Math.min(e0.attempts,10),60000);};
        try{txStore(bump);}catch(e2){console.error('[bridge] outbox persist failed:',e2.message);bump();}
        if(e0.state==='failed')console.error('[bridge] outbox dead-letter:',e0.key||e0.id,'->',e0.chat,'|',last);
        break; // 按会话保序：本条未投达，同会话后续不抢跑
      }
    }
  }finally{draining.delete(chat);}
}
function outboxStats(){return {pending:outbox.filter(x=>x.state==='pending').length,failed:outbox.filter(x=>x.state==='failed').length};}
async function sendCard(chat,cardJson,key){if(!chat){console.error('[bridge] 卡片投递目标为空，已跳过: '+key);return null;}const j=await lark(['im','+messages-send','--chat-id',chat,'--msg-type','interactive','--content',cardJson,'--as','bot','--idempotency-key',messageKey(key)],30000);return (j.data&&j.data.message_id)||null;}
// ── 指令表情三态（装饰性 best-effort：失败仅记日志，不进死信、不影响任务执行）──
// 等待 OneSecond → 处理中 Typing → 完成 DONE / 失败 CrossMark；切换=贴新删旧
const REACT_EMOJI={wait:'OneSecond',run:'Typing',done:'DONE',fail:'CrossMark'};
const reactChains=new Map(); // messageId → Promise：同一指令的表情切换串行，保证"贴新删旧"不乱序；不持久化
function setReact(item,state){
  if(!CFG.reactions||!item||!item.messageId)return;
  const emoji=REACT_EMOJI[state];if(!emoji)return;
  const key=item.messageId;
  const p=(reactChains.get(key)||Promise.resolve()).then(async()=>{
    const prev=item.reactionId||null;
    const j=await lark(['im','reactions','create','--params',JSON.stringify({message_id:item.messageId}),'--data',JSON.stringify({reaction_type:{emoji_type:emoji}}),'--as','bot'],15000)
      .catch(e=>{console.error('[bridge] 表情标记失败('+state+'):',String(e.message||e).slice(0,80));return null;});
    const rid=j&&j.data&&j.data.reaction_id;
    if(rid){try{txStore(()=>{item.reactionId=rid;item.reactionState=state;});}catch(e){console.error('[bridge] 表情状态持久化失败:',e.message);}}
    if(prev&&prev!==rid)await lark(['im','reactions','delete','--params',JSON.stringify({message_id:item.messageId,reaction_id:prev}),'--as','bot'],15000).catch(()=>{});
  });
  reactChains.set(key,p.catch(()=>{})); // 单步失败不断链
  if(reactChains.size>500)reactChains.delete(reactChains.keys().next().value); // 宽松防泄漏
}
async function sendReportCard(chat,job,key,fallback){
  try{await sendCard(chat,JSON.stringify(buildReportCard(job)),key);}
  catch(e){
    const detail=String(e.larkError?.message||'');
    if(!e.larkError||!/invalid|schema|unsupported|not supported|parameter|400\d{3}/i.test(detail))throw e;
    console.error('[bridge] report card rejected, rich-text fallback:',redact(detail).slice(0,120));
    await send(chat,reportExcerpt(fallback),key,'markdown');
  }
}
async function deleteMessage(messageId){if(!messageId)return;try{await lark(['api','DELETE','/open-apis/im/v1/messages/'+messageId],15000);}catch(e){console.error('[bridge] msg delete failed:',e.message.slice(0,100));}}
async function renameGroup(chat,name){try{await lark(['im','+chat-update','--as','bot','--chat-id',chat,'--name',name],20000);}catch(e){console.error('[bridge] rename failed:',e.message.slice(0,80));}}
async function dissolveGroup(chat){await lark(['api','DELETE','/open-apis/im/v1/chats/'+chat],20000);}
function extractPostText(c){ // 富文本 post：text/a 段拼接，@提及剔除，图片/媒体段忽略，段落间换行
 const body=Array.isArray(c.content)?c:['zh_cn','en_us','ja_jp'].map(k=>c[k]).find(v=>v&&typeof v==='object'&&Array.isArray(v.content));
 if(!body)return '';
 const parts=[];
 if(body.title)parts.push(String(body.title));
 for(const para of body.content){
  if(!Array.isArray(para))continue;
  let line='';
  for(const seg of para){
   if(!seg||typeof seg!=='object')continue;
   if(seg.tag==='text'||seg.tag==='a')line+=seg.text||'';
   else if(seg.tag==='code_block')line+=(line?'\n':'')+(seg.text||'');
  }
  if(line.trim())parts.push(line);
 }
 return parts.join('\n');
}
function extractText(e){
 let c=e.content;
 if(typeof c==='string'&&c.startsWith('{')){try{c=JSON.parse(c);}catch{}}
 if(typeof c==='string')return c;
 if(c&&typeof c==='object'){
  if(typeof c.text==='string')return c.text;
  return extractPostText(c);
 }
 return String(c||'');
}
function stripMention(t){return t.replace(/<at[^>]*>[^<]*<\/at>/gi,'').replace(/@_user_\d+/g,'').trim();}
function shortDesc(task,n){return Array.from(String(task).replace(/\s+/g,' ').trim()).slice(0,n).join('');}
function groupTopic(topic,fallback){return shortDesc(redact(String(topic||fallback||'任务讨论').replace(/[\r\n\t<>]/g,' ')),24)||'任务讨论';}
function groupName(emoji,alias,topic,id){return emoji+' '+groupTopic(topic,alias)+(id?' ·'+id.slice(0,6):'');}
const GROUP_READY_TASK='这是新建的独立任务群。请只确认会话就绪，等待用户在群内提出具体工作；本轮不要修改文件或执行部署。';

// ─────────────────── 每会话持久队列（TASK_QUEUE/TASK_ACK 契约） ───────────────────
// queue.json：chat -> {seq, paused, pauseReason, items:[{seq,messageId,text,kind,status,enqueuedAt,startedAt,finishedAt,runJobId,error,queuedAck}]}
// kind: task=任务群续接, dm=私聊对话。status: queued/active/done/failed。
// 受理回执在入队成功后立即给出；调度器 pump 在入队/任务终态/重启恢复时自动推进，不依赖用户再发消息。
const queueFile=path.join(state,'queue.json'); // legacy：仅迁移读取
let queues=store0?store0.queues:readState(queueFile,isRecord,{});
let outbox=store0&&Array.isArray(store0.outbox)?store0.outbox:[];       // F04：持久待发箱 {id,chat,text,key,attempts,nextAt,state,createdAt,lastError}
let dispatches=store0&&store0.dispatches&&typeof store0.dispatches==='object'?store0.dispatches:{}; // F02：派活意图（/run、/resume、自然语言派活），崩溃可恢复且幂等
function qOf(chat){return queues[chat]||(queues[chat]={seq:0,paused:false,pauseReason:null,items:[]});}
const Q_MAX=50; // 每群最大等待数；触发时明确"未入队"
// 执行中 = 本群 active 项 或 anchor job running（/run 直接启动的任务也算）
function queueStats(chat){
  const q=queues[chat],items=q?q.items:[];
  let running=items.some(i=>i.status==='active')?1:0;
  const g=groups[chat];
  if(!running&&g&&g.anchor){const j=supervisor.jobs.get(g.anchor);if(j&&['running','cancelling'].includes(j.status))running=1;}
  const waiting=items.filter(i=>i.status==='queued').length;
  return {running,waiting};
}
function enqueueItem(chat,kind,text,messageId){
  const q0=queues[chat];
  const dup=q0&&q0.items.find(i=>i.messageId===messageId&&['queued','active'].includes(i.status));
  if(dup)return {existing:dup}; // 重复投递：不新增、不重复执行、不重复回执
  const st=queueStats(chat);
  if(st.waiting>=Q_MAX)return {full:true};
  try{
    const r=txStore(()=>{ // F02：入队与 inbox 去重同一持久事务，崩溃窗口不产生丢消息
      const q=qOf(chat);
      const item={seq:++q.seq,messageId,text:redact(String(text).slice(0,4000),process.env,4000),kind,status:'queued',enqueuedAt:Date.now(),startedAt:null,finishedAt:null,runJobId:null,error:null,queuedAck:(st.running+st.waiting)>0}; // N03：凭证不进持久队列
      q.items.push(item);
      const term=q.items.filter(i=>!['queued','active'].includes(i.status));
      if(term.length>50){const drop=new Set(term.slice(0,term.length-50));q.items=q.items.filter(i=>!drop.has(i));}
      seen.add(messageId);while(seen.size>5000)seen.delete(seen.values().next().value);
      return {item,runningAhead:st.running,waitingAhead:st.waiting,paused:q.paused,pauseReason:q.pauseReason};
    });
    setReact(r.item,'wait');
    return r;
  }catch(e){ // F01：落盘失败必须明确"未保存、未受理"，不得执行；去重未提交，同 message_id 可重投
    console.error('[bridge] queue persist failed, not accepted:',e.message);
    throw storeFault('队列存储写入失败（'+String(e.message).slice(0,80)+'），本条未保存、未受理。请检查磁盘后重发。');
  }
}
// 调度器：防重入；逐会话对账 active、claim 下一 queued；同群串行，跨群独立
let pumping=false;
const inFlight=new Set(); // 用稳定消息 ID 标识执行项；事务回滚会替换队列对象
const flightKey=(chat,item)=>chat+':'+item.messageId;

async function pump(){
  if(pumping||stopping)return;pumping=true;
  try{
    for(const chat of Object.keys(queues)){
      const q=queues[chat];if(!q)continue;
      const act=q.items.find(i=>i.status==='active');
      if(act){
        if(inFlight.has(flightKey(chat,act)))continue; // 本进程仍在执行/启动该项
        const j=supervisor.jobs.get(act.runJobId)||[...supervisor.jobs.values()].find(x=>x.message===act.messageId&&x.chat===chat);
        if(j&&['running','cancelling'].includes(j.status))continue; // 仍在执行
        if(j&&act.kind==='task'&&groups[chat]&&groups[chat].anchor!==j.id){
          const g=groups[chat],previous={...g};
          g.anchor=j.id;g.thread=j.threadId||null;g.chain=supervisor.chainId(j);
          try{saveGroups();}catch(e){groups[chat]=previous;console.error('[bridge] group reconcile persist failed:',e.message);continue;}
        }
        // 终态对账与通知同一事务提交；持久化失败保持现状，下轮重试（F01）
        try{
          if(j&&j.status==='completed'){txStore(()=>{act.runJobId=j.id;act.status='done';act.finishedAt=Date.now();});setReact(act,'done');}
          else if(act.kind==='dm'&&!act.runJobId){txStore(()=>{act.status='failed';act.error='服务重启，该条对话执行状态未知，未自动重放';act.finishedAt=Date.now();outboxPush(chat,'⚠️ 服务重启，上一条对话未能确认完成，未自动重放。如需继续请再发一次。','qboot-'+act.messageId);});setReact(act,'fail');drainChat(chat).catch(()=>{});continue;}
          else if(j){ // failed/cancelled/interrupted：工作区安全性未知，持久阻断并解释，保留队列
            txStore(()=>{act.runJobId=j.id;act.status='failed';act.error='任务终态: '+j.status;act.finishedAt=Date.now();q.paused=true;q.pauseReason='prev-'+j.status+':'+j.id;
              if(!dmChats.has(chat))outboxPush(chat,'⚠️ 上一条指令的任务终态为 '+j.status+'，队列已暂停。确认工作区后 /qresume 继续（无需重发），或 /qclear 清空等待项。','qpause-'+act.messageId);});
            setReact(act,'fail');
            drainChat(chat).catch(()=>{});continue;
          }else{ // claim 后崩溃窗口：runJobId 未登记，结果未知，绝不盲目重放
            txStore(()=>{act.status='failed';act.error='服务重启，执行结果未知，未重放';act.finishedAt=Date.now();q.paused=true;q.pauseReason='unknown-after-restart';
              if(!dmChats.has(chat))outboxPush(chat,'⚠️ 服务重启，一条指令的执行结果未知（未自动重放）。队列已暂停，/qresume 恢复。','qpause-'+act.messageId);});
            setReact(act,'fail');
            drainChat(chat).catch(()=>{});continue;
          }
        }catch(e){console.error('[bridge] pump reconcile persist failed:',e.message);continue;}
      }
      if(q.paused)continue;
      const next=q.items.find(i=>i.status==='queued');
      if(!next)continue;
      if(next.kind==='task'){
        const gc=groupContext(chat);
        if(!gc){try{txStore(()=>{next.status='failed';next.error='群绑定失效';next.finishedAt=Date.now();q.paused=true;q.pauseReason='bind-lost';if(!dmChats.has(chat))outboxPush(chat,'⚠️ 群绑定已失效，排队指令未能启动，队列暂停。私聊 /reopen 重建后 /qresume。','qbind-'+next.messageId);});setReact(next,'fail');drainChat(chat).catch(()=>{});}catch(e){console.error('[bridge] pump bind-lost persist failed:',e.message);}continue;}
        const anchor=supervisor.jobs.get(gc.g.anchor);
        if(anchor&&['running','cancelling'].includes(anchor.status))continue; // 等终态唤醒
        if(supervisor.clients.size+dispatchReservations.size>=2)continue; // 等全局名额
        if(gc.g.alias!=='scratch'&&[...supervisor.jobs.values()].some(j=>j.alias===gc.g.alias&&j.id!==gc.g.anchor&&['running','cancelling'].includes(j.status)))continue; // 代码项目互斥；通用工作区可并行
        try{txStore(()=>{next.status='active';next.startedAt=Date.now();});}catch(e){console.error('[bridge] claim persist failed, not executing:',e.message);continue;} // F01：未持久化不执行
        setReact(next,'run');
        runTaskItem(chat,next,gc).catch(err=>console.error('[bridge] runTaskItem failed:',err&&err.message));
      }else{
        try{txStore(()=>{next.status='active';next.startedAt=Date.now();});}catch(e){console.error('[bridge] claim persist failed, not executing:',e.message);continue;} // F01：未持久化不执行
        setReact(next,'run');
        runDmItem(chat,next).catch(err=>console.error('[bridge] runDmItem failed:',err&&err.message));
      }
    }
  }finally{pumping=false;}
}
async function runTaskItem(chat,item,gc){
  inFlight.add(flightKey(chat,item));
  try{
    const id=await supervisor.continueJob(gc.g.anchor,item.text,chat,item.messageId);
    try{txStore(()=>{item.runJobId=id;});}catch(e){console.error('[bridge] runJobId persist failed（按 message_id 对账）:',e.message);}
    const g=groups[chat];
    if(g){const nj=supervisor.jobs.get(id),previous={...g};g.anchor=id;g.thread=(nj&&nj.threadId)||null;g.chain=nj?supervisor.chainId(nj):g.chain;
      if(g.topic==='待补充需求'){g.topic=groupTopic(item.text);g.title=groupName('🔵',g.alias,g.topic,id);}
      try{saveGroups();}catch(e){groups[chat]=previous;console.error('[bridge] group binding persist failed; will reconcile by message_id:',e.message);return;}
      if(previous.topic==='待补充需求')renameGroup(chat,g.title).catch(()=>{});
    }
    if(item.queuedAck)postGuarded(chat,'▶️ 轮到这条了，已开始处理。','qstart-'+item.messageId);
  }catch(err){
    item.error=String(err.message||err).slice(0,300);
    if(/已有 2 个任务|已有运行中的任务/.test(item.error)){try{txStore(()=>{item.status='queued';item.startedAt=null;item.error=null;});setReact(item,'wait');}catch(e){console.error('[bridge] requeue persist failed:',e.message);}return;} // 名额/互斥竞态：退回等待；由 finally 统一 pump（此处先 pump 会在 inFlight 删除前对账，把重启项误判为结果未知）
    const fatal=/线程|会话冲突|工作目录|绑定|未知任务/.test(item.error); // 线程失效/绑定异常：阻断；其余未启动错误：继续后续
    try{txStore(()=>{item.status='failed';item.finishedAt=Date.now();if(fatal){const q=qOf(chat);q.paused=true;q.pauseReason='fatal:'+item.error.slice(0,60);}if(!dmChats.has(chat))outboxPush(chat,'❌ 排队指令未能启动: '+redact(item.error)+(fatal?'\n队列已暂停，/qresume 恢复。':''),'qfail-'+item.messageId);});drainChat(chat).catch(()=>{});
    setReact(item,'fail');
    }catch(e){console.error('[bridge] fail-state persist failed:',e.message);}
  }finally{inFlight.delete(flightKey(chat,item));pump();}
}
function dmDecision(raw){
  let value;
  try{value=JSON.parse(raw);}catch{return {type:'reply',message:raw,project:'',projectExplicit:false,task:'',title:'',target:''};} // 旧 provider 的纯文本回复仍可显示
  if(!isRecord(value)||!['reply','create_group','resume_task'].includes(value.type)||typeof value.message!=='string'||typeof value.project!=='string'||typeof value.projectExplicit!=='boolean'||typeof value.task!=='string'||typeof value.title!=='string'||typeof value.target!=='string')
    throw Error('私聊动作格式无效，未执行任何动作。请重试。');
  return value;
}
async function runDmItem(chat,item){
  inFlight.add(flightKey(chat,item));
  try{
    let r;
    try{r=await runChatTurn(item.text,chat);}
    catch(err){
      // F06：仅 turn 未提交（start 阶段/未受理）的瞬时故障才重试；turn 已提交而结果未知时绝不盲目重发副作用
      if(!err.turnSubmitted&&/network|reconnect|timeout|stream|econn|exited/i.test(String(err.message||err))){await new Promise(res=>setTimeout(res,8000));r=await runChatTurn(item.text,chat);}
      else throw err;
    }
    let decision=dmDecision(r);
    const dirs=projects(supervisor.config,supervisor.root);
    const requested=decision.project.trim();
    const knownAlias=Object.keys(dirs).find(a=>a.toLowerCase()===requested.toLowerCase());
    // 私聊历史可能污染动作判断；未知别名也可能只是产品名。独立线程复核当前请求，绝不把其线程写进私聊会话。
    if(decision.type==='reply'||decision.type==='create_group'&&requested&&!knownAlias){
      const checked=dmDecision(await runRouteTurn(item.text,chat));
      if(checked.type!=='reply')decision=checked;
    }
    if(decision.type==='resume_task'){
      const target=decision.target.trim();
      if(!target){txStore(()=>{item.status='done';item.finishedAt=Date.now();outboxPush(chat,'请告诉我旧任务的名称或任务 ID，才能准确续接归档任务。','dmq-'+item.messageId);});setReact(item,'done');}
      else{
        const accepted=acceptIntent(item.messageId,{kind:'resume-archived',target,title:groupTopic(decision.title,target),task:decision.task.trim(),chat,messageId:item.messageId},()=>{
          item.status='done';item.finishedAt=Date.now();
          outboxPush(chat,'已受理归档任务《'+target+'》的续接请求；找到唯一任务链后建群，完成后回报。','dmq-'+item.messageId);
          setReact(item,'done');
        });
        if(!accepted.dup)executeIntent(accepted.intent);
      }
    }else if(decision.type==='create_group'){
      const requested=decision.project.trim();
      const registered=Object.keys(dirs).find(a=>a.toLowerCase()===requested.toLowerCase());
      const alias=registered||(decision.projectExplicit?requested:'scratch');
      if(!Object.hasOwn(dirs,alias)){
        const notice=decision.projectExplicit&&requested?'未知或不可用项目: '+alias+'。未建群、未启动任务。':'没有可用的默认项目 scratch。未建群、未启动任务。';
        txStore(()=>{item.status='done';item.finishedAt=Date.now();outboxPush(chat,notice+'\n可用项目：'+(Object.keys(dirs).join('、')||'无'),'dmq-'+item.messageId);});setReact(item,'done');
      }else{
        const bootstrap=!decision.task.trim();
        const title=groupTopic(decision.title,bootstrap?'待补充需求':item.text);
        const accepted=acceptIntent(item.messageId,{kind:'run',alias,task:bootstrap?GROUP_READY_TASK:item.text.trim(),title,mode:'auto',bootstrap,chat,messageId:item.messageId},()=>{
          item.status='done';item.finishedAt=Date.now();
          outboxPush(chat,'已受理《'+title+'》工作群请求；执行名额忙时自动排队，建好后发送任务 ID。','dmq-'+item.messageId);
          setReact(item,'done');
        });
        if(!accepted.dup)executeIntent(accepted.intent);
      }
    }else{
      txStore(()=>{item.status='done';item.finishedAt=Date.now();outboxPush(chat,decision.message||'(空回复)','dmq-'+item.messageId,'markdown');});setReact(item,'done');
    }
    drainChat(chat).catch(()=>{});
  }catch(err){
    const em=err.cancelled?'已取消':String(err.message||err).slice(0,300)+(err.turnSubmitted?'（指令已提交，结果未知，未自动重发）':'');
    const notice=err.cancelled?'⛔ 当前对话已取消。':'对话出错: '+redact(em);
    try{txStore(()=>{item.status='failed';item.error=em;item.finishedAt=Date.now();outboxPush(chat,notice,'dmqerr-'+item.messageId);});}
    catch(e){console.error('[bridge] dm terminal persist failed:',e.message);item.status='failed';item.error=em;item.finishedAt=Date.now();post(chat,notice,'dmqerr-'+item.messageId);}
    setReact(item,'fail');
    drainChat(chat).catch(()=>{});
  }finally{inFlight.delete(flightKey(chat,item));pump();}
}

// ─────────────────── 审批 ───────────────────
const KIND={'item/commandExecution/requestApproval':'命令执行','item/fileChange/requestApproval':'文件修改','item/permissions/requestApproval':'权限申请'};
function approvalBody(job,method,params){
  const p=params||{};
  let cmd=p.command||p.cmd||'';
  if(!cmd)cmd=JSON.stringify(p).slice(0,300);
  const reason=p.reason||'';
  const kind=KIND[method]||method;
  return {cmd:redact(cmd).slice(0,400),reason:redact(reason).slice(0,250),kind};
}
function approvalText(job,method,params){
  const b=approvalBody(job,method,params);
  return '⚠️ 高危审批请求\n任务: '+job.id+' · '+job.alias+' · '+(job.mode||'auto')+'模式\n类型: '+b.kind+'\n命令: '+b.cmd+(b.reason?'\n原因: '+b.reason:'')+'\n────────────\n回复: y=通过 | ys=通过并记住 | n=拒绝 | c=取消任务';
}
function approvalCard(job,method,params,token){
  const b=approvalBody(job,method,params);
  const btn=(text,type,d)=>({tag:'button',text:{tag:'plain_text',content:text},type:type||'default',behaviors:[{type:'callback',value:{t:token,d:d}}]});
  return JSON.stringify({schema:'2.0',config:{update_multi:true,width_mode:'default'},
   header:{title:{tag:'plain_text',content:'⚠️ 高危审批请求'},template:'carmine',text_tag_list:[{tag:'text_tag',text:{tag:'plain_text',content:job.id.slice(0,6)+' · '+job.alias},color:'blue'}]},
   body:{direction:'vertical',padding:'12px 12px 16px 12px',elements:[
    {tag:'markdown',content:'**类型**: '+b.kind+'\n**命令**:\n```bash\n'+b.cmd+'\n```'+(b.reason?'\n**原因**: '+b.reason:'')},
    {tag:'button',text:{tag:'plain_text',content:'✅ 通过'},type:'primary_filled',behaviors:[{type:'callback',value:{t:token,d:'accept'}}]},
    btn('🔓 通过并记住','default','acceptForSession'),
    btn('❌ 拒绝','danger','decline'),
    btn('⛔ 取消任务','danger_filled','cancel'),
    {tag:'markdown',content:"<font color='grey'>也可文字回复 y / ys / n / c</font>"}
   ]}});
}
function settledCard(title,template,body){
  return JSON.stringify({schema:'2.0',config:{update_multi:true,width_mode:'default'},
   header:{title:{tag:'plain_text',content:title},template},
   body:{direction:'vertical',padding:'12px 12px 16px 12px',elements:[
     {tag:'markdown',content:body},
     {tag:'markdown',content:"<font color='grey'>本卡片已归档。</font>"}
   ]}});
}
// 卡片决议已送达执行端后，更新失败也要持久重试，避免网络故障时留下可点击的旧卡。
async function updateCard(token,card,entry){
  if(entry.messageId){
    try{await lark(['im','messages','patch','--as','bot','--message-id',entry.messageId,'--data',JSON.stringify({content:card})],20000);return true;}
    catch(e){
      console.error('[bridge] card patch failed, queued:',e.message.slice(0,80));
      const detail=String(e.larkError?.message||e.message||'');
      if(e.larkError&&e.larkError.type!=='network'&&/invalid|schema|unsupported|not supported|parameter|400\d{3}/i.test(detail)){
        try{
          await sendCard(entry.chat||OPS_CHAT,card,'apprfinal-'+entry.token);
          await deleteMessage(entry.messageId);
          return false;
        }catch(fallbackErr){console.error('[bridge] card replacement failed:',fallbackErr.message.slice(0,100));}
      }
      const queued=outboxPush(entry.chat||OPS_CHAT,card,'cardpatch-'+entry.token,'card-patch');
      if(queued){queued.messageId=entry.messageId;try{persistStore();}catch(err){console.error('[bridge] card patch persist failed:',err.message);}drainChat(queued.chat).catch(()=>{});}
      return false;
    }
  }
  try{entry.messageId=await sendCard(entry.chat||OPS_CHAT,card,'apprfinal-'+entry.token)||entry.messageId;}
  catch(e2){console.error('[bridge] fallback card send failed:',e2.message.slice(0,100));post(entry.chat||OPS_CHAT,'审批已处理，但结果卡片暂未送达；请查看任务状态。','apprfinalerr-'+entry.token);}
  return false;
}
function removeEntry(entry){
  const chat=entry.chat||OPS_CHAT;
  const arr=pendingByChat.get(chat);if(arr){const i=arr.indexOf(entry);if(i>=0)arr.splice(i,1);if(!arr.length)pendingByChat.delete(chat);}
  pendingByToken.delete(entry.token);
  if(entry.client){const s=pendingByClient.get(entry.client);if(s){s.delete(entry);if(!s.size)pendingByClient.delete(entry.client);}}
  if(entry.timer)clearTimeout(entry.timer);
}
// 审批注册绑定 client/run 生命周期（F03）：client 终态经 onFinish 统一撤销 pending 并把卡片置为失效
function linkClient(entry){
  const c=entry.client;if(!c)return;
  let set=pendingByClient.get(c);
  if(!set){
    set=new Set();pendingByClient.set(c,set);
    const prev=c.onFinish;
    c.onFinish=(cl)=>{const s=pendingByClient.get(cl);if(s){pendingByClient.delete(cl);for(const en of[...s])expireEntry(en,'任务已结束');}if(prev)try{prev(cl);}catch{}};
  }
  set.add(entry);
}
function expireEntry(en,reason){
  if(en.resolved)return;
  en.resolved=true;removeEntry(en);
  const cmd=redact((en.params&&(en.params.command||en.params.cmd))||'').slice(0,200);
  if(en.messageId)updateCard(en.cardUpdateToken,settledCard('⚠️ 审批已失效','grey','**任务**: '+en.job.id+' · '+en.job.alias+'\n**命令**: '+cmd+'\n'+reason+'，本次审批未生效。'),en);
  else post(en.chat||OPS_CHAT,'⚠️ 一条审批已失效（'+reason+'），未生效。','expire-'+en.token);
}
function decide(entry,decision,via){
  if(entry.resolved)return false;
  const cmd=redact((entry.params&&(entry.params.command||entry.params.cmd))||'').slice(0,200);
  const base='**任务**: '+entry.job.id+' · '+entry.job.alias+'\n**命令**: '+cmd;
  // 决议前校验客户端与请求仍有效；失效不展示"已生效"（F03）
  if(entry.client&&(entry.client.finished||!entry.client.approvals.has(entry.reqId))){
    entry.resolved=true;removeEntry(entry);
    if(via==='card'&&entry.messageId)updateCard(entry.cardUpdateToken,settledCard('⚠️ 审批已失效','grey',base+'\n任务已结束或审批已被回收，本次操作未生效。'),entry);
    else post(entry.chat||OPS_CHAT,'⚠️ 该审批已失效（任务已结束），操作未生效。','stale-'+entry.token);
    return false;
  }
  let ok=false;try{ok=entry.respond(decision)!==false;}catch{ok=false;} // respond 返回 false/抛错 = 未送达
  entry.resolved=true;removeEntry(entry);
  if(!ok){ // 本地写入失败：标失败，不展示已生效（F03）
    if(via==='card'&&entry.messageId)updateCard(entry.cardUpdateToken,settledCard('⚠️ 决定未送达','carmine',base+'\n决定未能送达执行端（连接已断），审批未生效。'),entry);
    else post(entry.chat||OPS_CHAT,'⚠️ 决定未能送达执行端（任务可能已结束），审批未生效。','undeliv-'+entry.token);
    return false;
  }
  const label=decision==='accept'?'✅ 已通过':decision==='acceptForSession'?'✅ 已通过(本会话记住)':decision==='decline'?'❌ 已拒绝':'⛔ 任务已取消';
  if(via==='card'){if(entry.messageId)updateCard(entry.cardUpdateToken,settledCard(label,(decision==='accept'||decision==='acceptForSession')?'green':'carmine',base+'\n**决定**: '+label+' · 操作人: '+CFG.ownerName),entry);else post(entry.chat||OPS_CHAT,'已记录你的决定: '+label,'apprdone-'+entry.token);}
  else{deleteMessage(entry.messageId).catch(()=>{});post(entry.chat||OPS_CHAT,'已记录你的决定: '+label,'apprdone-'+entry.token);}
  return true;
}
async function askApproval(job,method,params,respond,ctx){
  const chat=job.chat||OPS_CHAT;
  if(dmChats.has(chat)&&job.alias!=='对话'){console.error('[bridge] task approval to DM blocked:',job.id);respond('decline');return;}
  const token=crypto.randomBytes(16).toString('hex');
  const entry={job,method,params,respond,token,chat,messageId:null,timer:null,resolved:false,cardUpdateToken:null,client:ctx&&ctx.client||null,reqId:ctx&&ctx.reqId};
  let arr=pendingByChat.get(chat);if(!arr)pendingByChat.set(chat,arr=[]);arr.push(entry);
  pendingByToken.set(token,entry);
  linkClient(entry); // F03：绑定 client 生命周期，终态统一回收
  if(process.env.LCT_TEST_EVENT_FILE)console.log('[bridge] approval token:',token);
  try{entry.messageId=await sendCard(chat,approvalCard(job,method,params,token),'appr-'+job.id+'-'+Date.now());}
  catch(e){
    console.error('[bridge] card send failed, text fallback:',e.message.slice(0,100));
    try{await send(chat,approvalText(job,method,params),'appr-'+job.id+'-'+Date.now());}
    catch(e2){removeEntry(entry);respond('decline');}
  }
}
function resolveTextApproval(chat,word){
  const arr=pendingByChat.get(chat);if(!arr||!arr.length)return false;
  const map={y:'accept',yes:'accept',同意:'accept',好:'accept',是:'accept',ys:'acceptForSession',记住:'acceptForSession',n:'decline',no:'decline',拒绝:'decline',不:'decline',c:'cancel',cancel:'cancel',取消:'cancel'};
  const decision=map[word.toLowerCase()];if(!decision)return false;
  return decide(arr[0],decision,'text');
}
async function handleCardAction(line){
  let e;try{e=JSON.parse(line);}catch{return;}
  if(e.type!=='card.action.trigger')return;
  const dedupe='card:'+(e.event_id||e.timestamp||JSON.stringify(e.action_value||{}));
  if(seen.has(dedupe))return;
  const mark=()=>{try{remember(dedupe);}catch(err){console.error('[bridge] card dedup persist failed:',err.message);}}; // 处理完成后提交去重（F02）
  if(e.operator_id!==owner){console.error('[bridge] card click from non-owner');mark();return;}
  if(e.action_tag!=='button'){mark();return;}
  let v;try{v=typeof e.action_value==='string'?JSON.parse(e.action_value):e.action_value;}catch{mark();return;}
  const ALLOWED=['accept','acceptForSession','decline','cancel'];
  const entry=v&&pendingByToken.get(v.t);
  if(!entry){post(e.chat_id,'ℹ️ 该审批已失效（可能已处理或服务重启）。如任务仍在运行，新审批会另发卡片。','stalecard-'+(e.event_id||Date.now()));mark();return;} // 重启旧卡明确失效，不恢复旧执行授权
  if(!ALLOWED.includes(v.d)){console.error('[bridge] illegal decision dropped:',v.d);post(e.chat_id,'⚠️ 非法审批动作，已忽略。','badact-'+(e.event_id||Date.now()));mark();return;}
  if(entry.chat&&e.chat_id&&entry.chat!==e.chat_id){console.error('[bridge] card chat mismatch dropped:',e.chat_id);post(e.chat_id,'⚠️ 审批卡片与目标会话不匹配，已忽略。','chatmm-'+(e.event_id||Date.now()));mark();return;}
  entry.cardUpdateToken=e.token;
  decide(entry,v.d,'card');
  console.log('[bridge] card approval:',entry.job.id,v.d);
  mark();
}

// ─────────────────── 群生命周期 ───────────────────
async function createGroup(name,description){
  const j=await lark(['im','+chat-create','--as','bot','--name',name,'--users',owner,'--type','private'],30000);
  const chat=(j.data&&j.data.chat_id)||j.chat_id;
  if(!chat)throw new Error('chat-create 未返回 chat_id');
  if(description){try{await lark(['im','+chat-update','--as','bot','--chat-id',chat,'--description',description.slice(0,100)],15000);}catch(e){console.error('[bridge] desc failed:',e.message.slice(0,80));}}
  return chat;
}
function markBroken(cid,g,reason){groups[cid]={...g,status:'bind-broken',reason};saveGroups();console.error('[bridge] group binding broken:',cid,reason);}
// 群任务上下文：注册存在 + anchor job 存在 + project/chat 一致 + 线程未被私聊占用；任一不满足即标记 bind-broken 并阻断
function groupContext(chat){
  const g=groups[chat];if(!g)return null;
  if(g.status==='bind-broken')return null;
  const j=supervisor.jobs.get(g.anchor);
  if(!j){markBroken(chat,g,'anchor-missing');return null;}
  if(g.alias&&j.alias!==g.alias){markBroken(chat,g,'alias-mismatch');return null;}
  if(j.chat&&j.chat!==chat){markBroken(chat,g,'chat-mismatch');return null;}
  if(j.threadId&&dmThreadIds().has(j.threadId)){markBroken(chat,g,'thread-polluted');return null;}
  const meta={kind:'group_task',chat,thread:j.threadId||null,chain:supervisor.chainId(j),instr:TASK_INSTR_VERSION};
  if(g.kind!==meta.kind||g.thread!==meta.thread||g.chain!==meta.chain||g.instr!==meta.instr){groups[chat]={...g,...meta};saveGroups();}
  return {g:groups[chat],j};
}
function archiveToKnowledge(j){
  try{
    const dir=CFG.archiveDir;
    fs.mkdirSync(dir,{recursive:true});
    const file=path.join(dir,j.id.slice(0,6)+'-'+j.alias+'.md');
    const body=['# '+CFG.brand+' 任务归档 · '+j.id,'',
      '- 项目: '+j.alias,'- 模式: '+(j.mode||'auto'),'- 状态: '+j.status,
      '- 分支: '+(j.branch||'-'),'- 工作区: '+(j.worktree||j.cwd||'-'),
      '- 耗时: '+Math.round((j.finished-j.started)/1000)+'s',
      '- 时间: '+new Date(j.started).toLocaleString('zh-CN'),'','## 结论','',redact(j.lastMessage||'(无)',process.env,Number.MAX_SAFE_INTEGER),'',
      '---','*由 '+CFG.serviceName+' 自动归档*'].join('\n');
    fs.writeFileSync(file,body,{mode:0o644});
    const kb=CFG.knowledgeDir;
    const relative=path.basename(CFG.archiveDir)+'/'+path.basename(file);
    const git=require('node:child_process').execFileSync;
    if(git('git',['-C',kb,'status','--porcelain','--',relative],{encoding:'utf8'}).trim()){
      git('git',['-C',kb,'add','--',relative],{stdio:'ignore'});
      git('git',['-C',kb,'-c','user.name='+CFG.brand+' Bridge','-c','user.email='+CFG.serviceName+'@local','commit','--only','-qm',CFG.serviceName+' archive: '+j.id.slice(0,6)+' '+j.alias,'--',relative],{stdio:'ignore'});
    }
    return 'knowledge/content/'+relative;
  }catch(e){console.error('[bridge] KB archive failed:',e.message);return null;}
}
// 结算期间阻止新指令入队和重复结算，失败后允许重试。
const settlingChats=new Set();
// 结算：永远以任务群为对象；归档→通知群→解散→清注册表
async function settle(job){
  const chat=job.chat;
  const current=chat&&groups[chat];
  if(!current||current.status!=='active'||current.anchor!==job.id)throw Error('该任务不是当前群的任务锚点，不能结算。请在现役任务群用 /done。');
  if(settlingChats.has(chat))throw Error('该任务群正在结算，请等待结果。');
  settlingChats.add(chat);
  try{
  if(job.settledAt){
    await send(chat,'📦 本群尚无新增任务，原任务归档仍保留。本群即将解散。','settle-reopened-'+job.id+'-'+chat);
    await dissolveGroup(chat);
    const binding=groups[chat];delete groups[chat];
    try{saveGroups();}catch(e){groups[chat]=binding;throw Error('群已解散，但绑定注册写入失败；需核查失效注册。');}
    return '✅ 群已解散，原任务 '+job.id.slice(0,6)+' 的归档保留。';
  }
  const archived=archiveToKnowledge(job);
  if(!archived)throw Error('知识库归档失败，任务群已保留；排查后重试 /done。');
  const isGroup=!!groups[chat];
  if(isGroup){
    await send(chat,'📦 任务已结算归档\n📄 已存知识库: '+archived+'\n本群即将解散。续接请私聊机器人: /reopen '+job.id,'settle-'+job.id);
    try{await dissolveGroup(chat);}catch(e){throw Error('群解散失败，绑定与任务记录已保留；排查后重试 /done。'+redact(e.message).slice(0,80));}
    const binding=groups[chat];delete groups[chat];
    try{saveGroups();}catch(e){groups[chat]=binding;throw Error('群已解散，但绑定注册写入失败；需先修复存储并清理失效注册。');}
  }else{
    console.error('[bridge] settle: job chat is not a task group, skip dissolve:',chat);
  }
  job.settledAt=Date.now();try{supervisor.save(job);}catch(e){console.error('[bridge] settledAt persist failed:',e.message);}
  return '✅ 任务 '+job.id.slice(0,6)+' 已结算，归档: '+archived+(isGroup?'，群已解散':'');
  }finally{settlingChats.delete(chat);}
}

// ─────────────────── Supervisor ───────────────────
const sendGuarded=async(chat,text,key,job)=>{if(dmChats.has(chat)){console.error('[bridge] job notification to DM suppressed');return;}return job?sendReportCard(chat,job,key,text):send(chat,text,key);};
const supervisor=new Supervisor({state:path.join(state,'jobs'),root:CFG.workspaceRoot,config:path.join(CFG.configDir,'projects.json'),codex:path.join(bin,'codex'),env:process.env,send:sendGuarded,
  taskInstructions:TASK_INSTRUCTIONS,isDmThread:t=>dmThreadIds().has(t),
  onSettled:()=>{pump();}, // 任务终态唤醒队列调度（自动推进本群下一项）
  onApproval:(job,method,params,respond,ctx)=>askApproval(job,method,params,respond,ctx)});
auditSessionIsolation(); // 启动即校验会话隔离；只做隔离/标记与证据落盘，不删历史
async function reopen(jobId,opts={}){
  const j=supervisor.jobs.get(jobId);if(!j)throw new Error('未知任务 ID。');
  if(['running','cancelling'].includes(j.status))throw new Error('任务仍在运行，不能重开。');
  if(j.settledAt&&!opts.allowSettled)throw new Error('任务已归档；请私聊说明旧任务名称续接，或使用 /reopen '+jobId+' 重建任务群。');
  const chain=supervisor.chainId(j);
  const newer=[...supervisor.jobs.values()].find(x=>x.id!==jobId&&supervisor.chainId(x)===chain&&x.started>j.started);
  if(newer)throw new Error('该 ID 是历史任务，请使用任务链最新 ID '+newer.id+'。');
  const active=Object.entries(groups).find(([,g])=>g.status==='active'&&supervisor.chainId(supervisor.jobs.get(g.anchor)||{})===chain);
  if(active&&active[1].anchor!==jobId)throw new Error('任务链已有现役群（'+active[0]+'），请使用现役任务 ID '+active[1].anchor+'。');
  if(j.threadId&&dmThreadIds().has(j.threadId))throw new Error('该任务线程与私聊会话冲突，已阻断重开；请派新任务。');
  const topic=opts.topic||groups[j.chat]?.topic||groupTopic(j.task,j.alias);
  const title=groupName('🔵',j.alias,topic,jobId);
  let chat=null,created=false;
  for(const [cid,g] of Object.entries(groups))if(g.anchor===jobId&&g.status==='active'){chat=cid;break;}
  if(chat){try{await renameGroup(chat,title);}catch{}}
  else{
    chat=opts.intent?.groupChat||await createGroup(title,'续接任务 '+jobId+' | '+shortDesc(j.lastMessage||'',60));
    created=!opts.intent?.groupChat;
    if(created&&opts.intent)try{txStore(()=>{dispatches[opts.intent.messageId].groupChat=chat;});}
    catch(err){try{await dissolveGroup(chat);}catch(cleanupErr){console.error('[bridge] archived resume orphan group:',chat,redact(cleanupErr.message).slice(0,80));}throw err;}
  }
  const previousGroup=groups[chat],previousChat=j.chat,previousArchivedChat=j.archivedChat;
  try{
    groups[chat]={anchor:jobId,alias:j.alias,topic,status:'active',kind:'group_task',chat,thread:j.threadId||null,chain:supervisor.chainId(j),instr:TASK_INSTR_VERSION,title};saveGroups();
    if(j.chat!==chat){if(j.settledAt&&!j.archivedChat)j.archivedChat=j.chat;j.chat=chat;supervisor.save(j);}
  }catch(e){
    if(previousGroup)groups[chat]=previousGroup;else delete groups[chat];
    j.chat=previousChat;
    j.archivedChat=previousArchivedChat;
    try{supervisor.save(j);}catch(err){console.error('[bridge] reopen job rollback persist failed:',err.message);}
    try{saveGroups();}catch(err){console.error('[bridge] reopen rollback persist failed:',err.message);}
    if(created)try{await dissolveGroup(chat);if(opts.intent)txStore(()=>{dispatches[opts.intent.messageId].groupChat=null;});}catch(err){console.error('[bridge] reopen orphan group:',chat,redact(err.message).slice(0,80));}
    throw e;
  }
  post(chat,'🔵 群已重开，继续处理任务 '+jobId+' ('+j.alias+')\n直接发消息即可派后续活'+(j.branch?'(将从分支 '+j.branch+' 接续)。':'.'),'reopen-'+jobId+'-'+chat);
  return chat;
}

function archivedCandidates(target){
  const chains=new Map();
  for(const j of supervisor.jobs.values()){
    const chain=supervisor.chainId(j),items=chains.get(chain)||[];items.push(j);chains.set(chain,items);
  }
  const query=String(target||'').trim().toLowerCase();
  const terms=(query.match(/[a-z][a-z0-9_-]{2,}/g)||[]).filter(x=>!['task','project','archive','resume'].includes(x));
  const result=[];
  for(const [chain,items] of chains){
    if(!items.some(j=>j.settledAt||j.chat&&groups[j.chat]?.status!=='active'&&['completed','failed','cancelled','interrupted'].includes(j.status)))continue;
    if(Object.values(groups).some(g=>g.status==='active'&&g.chain===chain))continue;
    items.sort((a,b)=>a.started-b.started);
    const latest=items.at(-1);
    if(!latest.threadId||dmThreadIds().has(latest.threadId)||['running','cancelling'].includes(latest.status))continue;
    const haystack=items.map(j=>[j.task,j.lastMessage,j.alias].filter(Boolean).join(' ')).join(' ').toLowerCase();
    if(query&&!(items.some(j=>j.id===query)||terms.length&&terms.every(t=>haystack.includes(t))||!terms.length&&query.length>=3&&haystack.replace(/\s+/g,'').includes(query.replace(/\s+/g,''))))continue;
    result.push({chain,latest,summary:groupTopic(items[0].task,latest.alias)});
  }
  return result.sort((a,b)=>b.latest.started-a.latest.started);
}
async function resumeArchivedFlow(intent){
  const queueNewWork=chat=>{
    if(!intent.task)return;
    if(queues[chat]?.items.some(i=>i.messageId==='resume-'+intent.messageId))return;
    const queued=enqueueItem(chat,'task',intent.task,'resume-'+intent.messageId);
    if(queued.full)post(chat,'⚠️ 新增工作未进入群队列：队列已满，请在群内重发。','resume-full-'+intent.messageId);
    else pump();
  };
  const previous=dispatches[intent.messageId];
  if(previous?.jobId){
    const bound=Object.entries(groups).find(([,g])=>g.status==='active'&&g.anchor===previous.jobId);
    if(bound){queueNewWork(bound[0]);return '任务 '+previous.jobId+' 已有现役群 '+bound[0]+'，请在群内继续。';}
  }
  const candidates=archivedCandidates(intent.target);
  if(!candidates.length)return '❌ 未找到已归档的《'+intent.target+'》任务链。请提供旧任务 ID，或用 /jobs 核对后再试；未建群。';
  if(candidates.length>1)return '❌ 找到多个已归档任务链，未建群。请用任务 ID 指定：\n'+candidates.slice(0,8).map(c=>c.latest.id+' · '+c.summary).join('\n');
  const {latest}=candidates[0];
  if(previous&&!previous.jobId)txStore(()=>{dispatches[intent.messageId].jobId=latest.id;});
  const existing=Object.entries(groups).find(([,g])=>g.status==='active'&&g.anchor===latest.id);
  if(existing)return '任务 '+latest.id+' 已有现役群 '+existing[0]+'，请在群内继续。';
  await reopen(latest.id,{allowSettled:true,topic:groupTopic(intent.title,intent.target),intent});
  queueNewWork(latest.chat);
  return '归档任务 '+latest.id+' 的群已重建，沿用原任务会话。请在群内发送新进展，任务会在本群续接。';
}

// ─────────────────── 派活 ───────────────────
const dispatchReservations=new Map();
function dispatchBlocker(alias){
  if(supervisor.clients.size+dispatchReservations.size>=2)return '两个执行名额都在使用中';
  if(alias!=='scratch'&&([...supervisor.jobs.values()].some(j=>j.alias===alias&&['running','cancelling'].includes(j.status))||[...dispatchReservations.values()].includes(alias)))return '该项目已有运行中的任务';
  return null;
}
async function dispatch(alias,task,mode,e,base,bootstrap=false,title=null){
  const dup=[...supervisor.jobs.values()].find(j=>j.message===e.message_id); // F02：同一 message_id 已成功受理，不重复执行
  if(dup)return '该指令已受理（任务 '+dup.id+'），执行中或已完成，无需重发。';
  const dirs=projects(supervisor.config,supervisor.root);
  if(!dirs[alias])return '❌ 未知或不可用项目: '+alias+'。未建群、未启动任务。用 /projects 查看。';
  const blocked=dispatchBlocker(alias);
  if(blocked)return {deferred:true,reason:blocked};
  dispatchReservations.set(e.message_id,alias);
  try{
  const rec=dispatches[e.message_id];
  const topic=groupTopic(title,bootstrap?'待补充需求':task);
  let g;
  if(rec&&rec.groupChat){g=rec.groupChat;} // 重投/重试复用已建群：飞书资源创建成功≠任务创建成功，不得重复建群
  else{
    try{g=await createGroup(groupName('🔵',alias,topic),'任务目标: '+shortDesc(bootstrap?'等待群内具体需求':task,90));}
    catch(err){return '❌ 建群失败，未启动任务。请重试。('+redact(err.message).slice(0,100)+')';}
    if(rec){try{txStore(()=>{rec.groupChat=g;});}catch(e2){console.error('[bridge] intent groupChat persist failed:',e2.message);}}
  }
  let id;
  try{id=await supervisor.start(alias,task,g,e.message_id,{mode,base});}
  catch(err){
    let cleaned=false;
    try{await dissolveGroup(g);cleaned=true;}catch(cleanupErr){console.error('[bridge] failed group cleanup:',redact(cleanupErr.message).slice(0,100));}
    if(cleaned&&rec){try{txStore(()=>{if(dispatches[e.message_id])dispatches[e.message_id].groupChat=null;});}catch(e2){console.error('[bridge] intent cleanup persist failed:',e2.message);}}
    return '❌ 任务启动失败，未创建执行任务。'+(cleaned?'临时群已清理。':'临时群清理失败，请联系维护者处理。')+'('+redact(err.message).slice(0,100)+')';
  }
  // 持久注册成功后才允许宣告"任务已创建"；注册失败给明确待修复状态及补偿路径（复核#2）
  try{groups[g]={anchor:id,alias,topic,status:'active',kind:'group_task',chat:g,thread:null,chain:id,instr:TASK_INSTR_VERSION,title:groupName('🔵',alias,topic,id)};saveGroups();}
  catch(err){
    console.error('[bridge] group register failed:',err.message);
    if(rec){try{txStore(()=>{rec.status='register-failed';rec.jobId=id;rec.updatedAt=Date.now();});}catch{}}
    return '⚠️ 任务已启动（'+id+'）但群注册写入失败，未宣告完成。请检查磁盘后私聊 /adopt '+g+' '+alias+' <任务> 修复绑定。';
  }
  if(rec)try{txStore(()=>{dispatches[e.message_id].jobId=id;});}catch(err){console.error('[bridge] intent jobId persist failed:',err.message);}
  try{await renameGroup(g,groupName('🔵',alias,topic,id));}catch{}
  try{await send(g,bootstrap?'🔵 工作群已建立 · '+topic+'\n会话任务ID: '+id+'\n请在本群发送具体工作；后续消息会续接本群会话。\n/done 结算归档并解散本群':'🔵 新任务 · '+topic+' · '+mode+'模式\n任务: '+redact(String(task).slice(0,600),process.env,600)+'\n任务ID: '+id+(base?'\n接续分支: '+base:'')+'\n────────────\n群内发消息=派后续活 | /done 结算归档并解散本群','gintro-'+id);}catch{}
  return bootstrap?'《'+topic+'》工作群已建立，独立会话 '+id+' 已绑定。请在群内提出具体工作。':'任务 '+id+' 已启动，专属群《'+topic+'》已绑定。';
  }finally{dispatchReservations.delete(e.message_id);}
}

// ─── F02 派活意图：message_id → {kind,status,...} 持久意图；受理与去重同一事务，崩溃恢复后幂等重投 ───
function acceptIntent(messageId,intent,onAccepted){
  const prev=dispatches[messageId];
  if(prev&&prev.status!=='failed'){
    if(onAccepted)txStore(()=>onAccepted(prev));
    return {dup:true,jobId:prev.jobId||null,intent:prev};
  }
  const dupJob=[...supervisor.jobs.values()].find(j=>j.message===messageId);
  try{
    txStore(()=>{
      dispatches[messageId]={...intent,task:redact(String(intent.task||'').slice(0,2000),process.env,2000),title:intent.title?groupTopic(intent.title):null,status:dupJob?'done':'pending',jobId:dupJob?dupJob.id:null,createdAt:prev?prev.createdAt:Date.now(),updatedAt:Date.now()}; // N03：凭证不进意图存储
      seen.add(messageId);while(seen.size>5000)seen.delete(seen.values().next().value);
      const keys=Object.keys(dispatches);if(keys.length>200){let excess=keys.length-200;for(const k of keys)if(excess>0&&['done','failed'].includes(dispatches[k].status)){delete dispatches[k];excess--;}} // 等待中的意图不能被滚动清理
      if(onAccepted)onAccepted(dispatches[messageId]);
    });
  }catch(e){throw storeFault('受理存储失败（'+String(e.message).slice(0,80)+'），本条未保存、未受理。请检查磁盘后重发。');}
  if(dupJob)return {dup:true,jobId:dupJob.id,intent:dispatches[messageId]};
  return {intent:dispatches[messageId]};
}
const executingIntents=new Set();
function executeIntent(intent){
  if(executingIntents.has(intent.messageId))return Promise.resolve();
  executingIntents.add(intent.messageId);
  const mark=st=>{try{txStore(()=>{if(dispatches[intent.messageId]){dispatches[intent.messageId].status=st;dispatches[intent.messageId].updatedAt=Date.now();}});}catch(e){console.error('[bridge] intent persist failed:',e.message);}};
  const flow=intent.kind==='resume'?resumeFlow(intent)
    :intent.kind==='resume-archived'?resumeArchivedFlow(intent)
    :intent.kind==='adopt'?adoptFlow(intent)
    :dispatch(intent.alias,intent.task,intent.mode,{message_id:intent.messageId,chat_id:intent.chat},intent.base||null,!!intent.bootstrap,intent.title||null);
  return Promise.resolve(flow)
    .then(msg=>{ // ❌=失败；⚠️=流程已自标状态（如 register-failed）不覆盖；其余=完成
      if(isRecord(msg)&&msg.deferred){
        try{txStore(()=>{const rec=dispatches[intent.messageId];if(rec&&!rec.waitingAt)rec.waitingAt=Date.now();});}catch(e){console.error('[bridge] deferred intent persist failed:',e.message);}
        post(intent.chat,'《'+groupTopic(intent.title,intent.task)+'》已排队：'+msg.reason+'。空位后自动建群并启动，无需重发。','intentwait-'+intent.messageId);
        return;
      }
      if(/^❌/.test(msg||''))mark('failed');
      else if(!/^⚠️/.test(msg||''))mark('done');
      if(msg)post(intent.chat,msg,'intent-'+intent.messageId+(intent.retryEpoch?'-retry'+intent.retryEpoch:''));})
    .catch(err=>{mark('failed');post(intent.chat,'❌ '+redact(String(err.message||err)).slice(0,200),'interr-'+intent.messageId);})
    .finally(()=>{executingIntents.delete(intent.messageId);});
}
// 受控 adopt（复核#4）：核验群归属（bot 成员）→ 校验项目 → 创建真实 job/thread → 绑定原群。
// 不借用其他任务 ID，不直接手填 groups.json；核验失败中止且零变更。
async function adoptFlow(intent){
  const chat=intent.targetChat;
  if(groups[chat])return '❌ 该群已有任务绑定（anchor '+groups[chat].anchor+'），不能重复 adopt。';
  const dirs=projects(supervisor.config,supervisor.root);
  if(!dirs[intent.alias])return '❌ 未知项目: '+intent.alias+'（/projects 查看）。未做任何变更。';
  try{
    const result=await lark(['im','+chat-members-list','--as','bot','--chat-id',chat,'--member-types','user,bot','--page-all','--page-limit','0','--format','json'],20000);
    const members=result.data||{};
    if(members.has_more||members.truncations?.length||!Array.isArray(members.users)||!Array.isArray(members.bots)||members.users.length!==1||members.users[0].member_id!==owner||members.bots.length!==1)throw Error('群成员必须仅有 owner 和当前机器人，且列表完整');
  }
  catch(err){return '❌ 群归属核验失败（API 不可用或机器人不在群内），已中止绑定，未做任何变更。('+redact(err.message).slice(0,100)+')';}
  const failedIntent=Object.values(dispatches).find(x=>x.groupChat===chat&&x.status==='register-failed'&&x.jobId);
  const jobsForChat=[...supervisor.jobs.values()].filter(j=>j.chat===chat);
  if(!failedIntent&&jobsForChat.length>1)return '❌ 该群关联多个任务，无法确认续接点；未创建新任务，请人工核查。';
  const existing=failedIntent?supervisor.jobs.get(failedIntent.jobId):jobsForChat[0];
  if(failedIntent&&(!existing||existing.chat!==chat||existing.alias!==intent.alias))return '❌ 该群已有注册失败的任务记录，但项目或群信息不一致；未创建第二个任务，请人工核查。';
  if(existing&&(existing.alias!==intent.alias||!existing.threadId||existing.settledAt))return '❌ 该群已有任务记录，但项目不一致、任务已结算或没有可续接线程；未创建第二个任务，请人工核查。';
  let id=existing&&existing.id;
  if(!id)try{id=await supervisor.start(intent.alias,intent.task,chat,intent.messageId,{mode:'auto'});}
  catch(err){return '❌ 任务创建失败，未绑定。('+redact(err.message).slice(0,100)+')';}
  try{groups[chat]={anchor:id,alias:intent.alias,status:'active',kind:'group_task',chat,thread:null,chain:id,instr:TASK_INSTR_VERSION,title:groupName('🔵',intent.alias,intent.task,id),adopted:true};saveGroups();}
  catch(err){console.error('[bridge] adopt register failed:',err.message);return '⚠️ 任务已创建（'+id+'）但绑定注册写入失败，请检查磁盘后重试 /adopt（群与任务均未重复创建）。';}
  try{await renameGroup(chat,groupName('🔵',intent.alias,intent.task,id));}catch{}
  try{await send(chat,'🔵 群绑定完成 · '+intent.alias+'\n任务: '+redact(String(intent.task).slice(0,600),process.env,600)+'\n任务ID: '+id+'\n────────────\n本群已纳入任务管理：群内消息=派后续活 | /done 结算归档并解散','gintro-'+id);}catch{}
  return '群绑定完成，任务 '+id+(existing?' 已复用原任务记录':' 已在目标群创建')+'（'+intent.alias+'）。';
}
async function resumeFlow(intent){
  const existing=[...supervisor.jobs.values()].find(j=>j.message===intent.messageId);
  if(existing&&(existing.alias!==intent.alias||!existing.threadId))return '❌ 上次续接任务未成功启动或项目不一致；未重复创建任务，请重新发起。';
  if(existing&&groups[existing.chat]&&groups[existing.chat].anchor===existing.id)return '该续接指令已受理（任务 '+existing.id+'），无需重发。';
  if(!existing&&!projects(supervisor.config,supervisor.root)[intent.alias])return '❌ 未知或不可用项目: '+intent.alias+'。未建群、未启动任务。';
  const rec=dispatches[intent.messageId];
  let g=existing&&existing.chat||rec&&rec.groupChat;
  if(!g){
    try{g=await createGroup(groupName('🔵',intent.alias,intent.task),'续接会话 '+intent.thread.slice(0,8)+'… | '+shortDesc(intent.task,60));}
    catch(err){return '❌ 建群失败，未启动续接。请重试。('+redact(err.message).slice(0,100)+')';}
    if(rec)try{txStore(()=>{dispatches[intent.messageId].groupChat=g;});}
    catch(err){
      let cleaned=false;try{await dissolveGroup(g);cleaned=true;}catch(cleanupErr){console.error('[bridge] resume group cleanup failed:',redact(cleanupErr.message).slice(0,100));}
      return '❌ 续接群登记失败，任务未启动。'+(cleaned?'临时群已清理。':'临时群清理失败，群 ID '+g+' 需人工核查。');
    }
  }
  let id=existing&&existing.id;
  if(!id)try{id=await supervisor.start(intent.alias,intent.task,g,intent.messageId,{mode:'auto',resumeThread:intent.thread});}
  catch(err){
    let cleaned=false;try{await dissolveGroup(g);cleaned=true;}catch(cleanupErr){console.error('[bridge] resume group cleanup failed:',redact(cleanupErr.message).slice(0,100));}
    if(cleaned&&rec)try{txStore(()=>{dispatches[intent.messageId].groupChat=null;});}catch(e){console.error('[bridge] resume cleanup persist failed:',e.message);}
    return '❌ 续接启动失败。'+(cleaned?'临时群已清理。':'临时群清理失败，群 ID '+g+' 需人工核查。')+'('+redact(err.message).slice(0,100)+')';
  }
  const previous=groups[g];
  try{groups[g]={anchor:id,alias:intent.alias,status:'active',kind:'group_task',chat:g,thread:null,chain:id,instr:TASK_INSTR_VERSION,title:groupName('🔵',intent.alias,intent.task,id)};saveGroups();}
  catch(err){
    if(previous)groups[g]=previous;else delete groups[g];
    if(rec)try{txStore(()=>{dispatches[intent.messageId].status='register-failed';dispatches[intent.messageId].jobId=id;dispatches[intent.messageId].updatedAt=Date.now();});}catch(e){console.error('[bridge] resume repair intent persist failed:',e.message);}
    return '⚠️ 续接任务已创建（'+id+'），但群绑定写入失败。请检查存储后私聊 /adopt '+g+' '+intent.alias+' <任务> 修复绑定。';
  }
  try{await send(g,'🔵 续接任务 · '+intent.alias+'\n会话: '+intent.thread+'\n任务: '+redact(String(intent.task).slice(0,600),process.env,600)+'\n任务ID: '+id+'\n────────────\n群里只发审批和结果 | /done 结算归档并解散','gintro-'+id);}catch{}
  if(rec)try{txStore(()=>{dispatches[intent.messageId].jobId=id;});}catch(e){console.error('[bridge] resume jobId persist failed:',e.message);}
  return '会话续接任务 '+id+' 已启动，任务群已绑定。';
}
// F05：健康信息依据真实组件状态，不无条件承诺"一切正常"
function healthLine(){
  const appr=[...pendingByChat.values()].reduce((n,a)=>n+a.length,0);
  const ob=outboxStats();
  return '运行 '+supervisor.clients.size+'/2 · 待审批 '+appr+' · 待发消息 '+ob.pending+(ob.failed?' · 投递失败 '+ob.failed+' 条':'')+'。';
}

// ─────────────────── 私聊对话（短生命周期实例；仅限 p2p） ───────────────────
const chatClients=new Set(); // 私聊执行实例（停止时统一取消）；同会话并发由队列 pump 串行保证
const chatClientByChat=new Map(); // chat -> 当前执行中的私聊 client（N02：会话级取消）
// 私聊工具权限边界（复核 P1#1）：DM 执行实例的 PATH 前置 guard shim，exec/CLI 层拦截飞书 CLI。
// 绝对路径调用的残余风险由 /auditgroups 审计与 /adopt 受控绑定补偿兜底。
const guardBin=path.join(state,'guard-bin');
try{fs.mkdirSync(guardBin,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(guardBin,'lark-cli'),'#!/bin/bash\necho "⛔ 私聊对话实例禁止调用飞书 CLI。新任务/建群/绑定必须由宿主 bridge 经任务创建流程办理；请回复用户：私聊发 \'<项目> <任务>\' 或 \'/run <项目> <任务>\' 即可正规派活。" >&2\nexit 1\n',{mode:0o700});
}catch(e){console.error('[bridge] guard-bin setup failed:',e.message);}
function chatEnv(){const env={...process.env};for(const k of Object.keys(env))if(/^LARK_|^FEISHU_/.test(k))delete env[k];env.PATH=guardBin+path.delimiter+(env.PATH||'');return env;}
async function runRouteTurn(text,chat){
  const client=new CodexClient({codex:dmLauncher,cwd:CFG.scratchDir,env:chatEnv(),
    threadParams:{name:CFG.threadPrefix+'-router',cwd:CFG.scratchDir,sandbox:'danger-full-access',approvalPolicy:'never',developerInstructions:ROUTE_INSTRUCTIONS+'\n已注册工作区：'+Object.keys(projects(supervisor.config,supervisor.root)).join('、')},
    onApproval:(m,p,respond)=>respond('decline'),onLog:()=>{}});
  chatClients.add(client);chatClientByChat.set(chat,client);
  try{
    await client.start();
    const result=await client.run(text,{outputSchema:DM_OUTPUT_SCHEMA});
    return result.message||'';
  }finally{
    chatClients.delete(client);
    if(chatClientByChat.get(chat)===client)chatClientByChat.delete(chat);
    await Promise.resolve(client.dispose()).catch(()=>{});
  }
}
async function runChatTurn(text,chat){
  const sess=dmSession(chat);
  const resumeId=sess&&sess.thread?sess.thread:null;
  const sessionJob=Object.freeze({id:'chat-'+chat.slice(3,11)+'-'+Date.now().toString(36),alias:'对话',chat,mode:'auto',kind:'dm'}); // 审批身份：不可变、绑定本私聊
  const mk=(resume)=>new CodexClient({codex:dmLauncher,cwd:CFG.scratchDir,env:chatEnv(),
    resumeThreadId:resume,
    // 外层 bwrap 限制文件系统；Codex 再启内层沙箱会使工具进程无法创建。
    threadParams:{name:CFG.threadPrefix+'-chat',cwd:CFG.scratchDir,sandbox:'danger-full-access',approvalPolicy:'on-request',developerInstructions:DM_INSTRUCTIONS+'\n当前已注册项目别名：'+Object.keys(projects(supervisor.config,supervisor.root)).join('、')+'。只有用户明确要求使用某项目工作区时 projectExplicit 才为 true；产品或设备名不属于项目。明确指定不存在的项目时仍填写原称，由 bridge 拒绝并告知。'},
    onApproval:(m,p,respond,ctx)=>askApproval(sessionJob,m,p,respond,ctx),
    onLog:()=>{}});
  const attempt=async(resume)=>{
    const c=mk(resume);chatClients.add(c);chatClientByChat.set(chat,c);
    try{
      try{await c.start();}
      catch(e){Object.assign(e,{phase:'start',turnSubmitted:false});if(c.cancelRequested)e.cancelled=true;throw e;} // turn 未提交：可安全重试
      saveDmSession(chat,c.threadId);
      try{const r=await c.run(text,{outputSchema:DM_OUTPUT_SCHEMA});return r.message||'(空回复)';}
      catch(e){Object.assign(e,{phase:'turn',turnSubmitted:!!(c.turnSubmitted||c.turnSubmissionAttempted)});if(c.cancelRequested)e.cancelled=true;throw e;} // 已提交则结果未知
    }finally{chatClients.delete(c);if(chatClientByChat.get(chat)===c)chatClientByChat.delete(chat);Promise.resolve(c.dispose()).catch(()=>{});} // F06/R01：无论 finished 均释放进程
  };
  try{return await attempt(resumeId||undefined);}
  catch(err){
    // 仅"恢复线程失败且 turn 尚未提交"才允许开新线程重跑；turn 提交后结果未知先对账（不盲目重发副作用）
    if(resumeId&&err.phase==='start'){console.error('[bridge] chat resume failed, fresh thread:',String(err.message||err).slice(0,100));return attempt(undefined);}
    throw err;
  }
}
// 私聊对话统一走 queue.json 持久队列（kind:'dm'）：入队即回执，pump 串行消费；不再存在全局/会话 busy 拒绝。

// N02+复核#2：私聊会话级取消——先锁定/暂停该会话队列（禁止该 turn 自动重试与后续自动启动），
// 再 interrupt/dispose 当前 client（审批经 F03 链统一失效）；worker 不得杀宿主或兄弟进程，只能走此接口。
function cancelDmTurn(chat){
  const q=qOf(chat);
  try{txStore(()=>{q.paused=true;q.pauseReason=q.pauseReason||'cancel-lock';});}catch(e){console.error('[bridge] cancel-lock persist failed:',e.message);return '⚠️ 队列锁定未保存，取消未执行。请检查存储后重试。';}
  const act=q.items.find(i=>i.status==='active'&&i.kind==='dm');
  const c=chatClientByChat.get(chat);
  if(!act&&!c)return '当前没有正在执行的对话。会话队列已锁定，/qresume 恢复。';
  if(c){c.cancelRequested=true;Promise.resolve(c.dispose()).catch(()=>{});}
  return '收到，正在取消当前对话执行。会话队列已锁定，核查副作用后 /qresume 恢复。';
}

// ─────────────────── 命令路由 ───────────────────
async function respond(e){
  const text=stripMention(extractText(e));
  if(!text)return e.message_type==='post'?'⚠️ 没有从这条富文本消息中提取到文字（纯图片/文件暂不支持）。请补充文字说明。':null;
  const chat=e.chat_id;
  if(e.chat_type==='p2p'&&!dmChats.has(chat)){dmChats.add(chat);saveDmChats();}
  const word=text.trim().split(/\s+/)[0];
  if(pendingByChat.has(chat)&&/^(y|ys|n|c|yes|no|cancel|同意|拒绝|取消|好|是|不|记住)$/i.test(word)){if(resolveTextApproval(chat,word.toLowerCase()))return null;}
  let p=null;
  if(text.trim().startsWith('/')){
    const parsed=parse(text); // natural 标记（绝对路径/非命令正文）不按命令处理，落到正文路由（R08）
    if(parsed.cmd)p=parsed;
  }
  if(p){
    if(e.chat_type==='group'&&['/run','/group','/resume','/reopen'].includes(p.cmd))return '⛔ 建群操作仅限私聊机器人。群内只能派后续活、审批、/done 结算。';
    switch(p.cmd){
      case '/ping':{const h=healthLine();return e.chat_type==='p2p'?CFG.dmGreeting+h:CFG.brand+' 在线。'+h;} // F05：群内中性任务身份；健康依据真实组件状态
      case '/help':return '命令:\n/ping /status /projects /jobs /groups\n/group [项目] [任务]（先建独立工作群，默认 scratch）\n/run <项目> <任务> [--yolo|--safe]\n/resume <项目> <会话ID> <任务>\n/cancel [任务ID]（私聊裸发=取消当前对话）\n/logs [任务ID]\n/done [任务ID] 结算任务群(归档+解散)\n/reopen <任务ID> 重开任务群\n/cleanup 清理失效群注册\n/adopt <群ID> <项目> <任务> 受控绑定已有群\n/auditgroups 审计未注册群\n/outbox 查看死信 · /outbox show <ID> · /outbox retry <ID> --checked · /outbox resolve <ID> delivered|obsolete --checked\n/queue 查看本群队列 · /qpause 暂停 · /qresume 恢复 · /qdrop <序号> 丢弃 · /qclear 清空等待\n──\n私聊派活: "<项目> <任务>"；也可说“建群处理工作”\n群聊发消息=给本群已绑定任务派后续活（自动排队、轮到自己动执行）\n审批: 点卡片按钮 或回复 y / ys / n / c';
      case '/projects':return Object.keys(projects(supervisor.config,supervisor.root)).join('\n')||'无可用项目。';
      case '/jobs':return supervisor.list();
      case '/groups':{const lines=Object.entries(groups).map(([,g])=>'🔵 '+g.alias+' · '+g.anchor.slice(0,6)+' · '+g.title);return lines.join('\n')||'暂无任务群。';}
      case '/queue':{const q=queues[chat];if(!q)return '本会话队列为空。';const lines=q.items.filter(i=>['queued','active'].includes(i.status)).map(i=>'#'+i.seq+' '+(i.status==='active'?'执行中':'等待中')+' · '+shortDesc(i.text,30));return '队列'+(q.paused?'（已暂停: '+(q.pauseReason||'-')+'）':'')+'：\n'+(lines.join('\n')||'（无待处理项）');}
      case '/qpause':{try{txStore(()=>{const q=qOf(chat);q.paused=true;q.pauseReason=q.pauseReason||'manual';});}catch(ex){return '⚠️ 存储写入失败（'+String(ex.message).slice(0,60)+'），暂停未生效。';}return '队列已暂停。已受理的指令保留，/qresume 恢复。';}
      case '/qresume':{try{txStore(()=>{const q=qOf(chat);q.paused=false;q.pauseReason=null;});}catch(ex){return '⚠️ 存储写入失败（'+String(ex.message).slice(0,60)+'），恢复未生效。';}pump();return '队列已恢复，自动继续处理。';}
      case '/qclear':{const q=queues[chat];if(!q)return '本会话队列为空。';let n=0;try{txStore(()=>{n=q.items.filter(i=>i.status==='queued').length;q.items=q.items.filter(i=>i.status!=='queued');});}catch(ex){return '⚠️ 存储写入失败（'+String(ex.message).slice(0,60)+'），清空未生效。';}return '已丢弃 '+n+' 条等待中的指令（执行中的不受影响）。';}
      case '/qdrop':{const q=queues[chat];if(!q)throw new Error('本会话队列为空。');const i=q.items.findIndex(x=>x.seq===p.seq&&x.status==='queued');if(i<0)throw new Error('没有找到等待中的 #'+p.seq+'（/queue 查看）。');try{txStore(()=>{q.items.splice(i,1);});}catch(ex){return '⚠️ 存储写入失败（'+String(ex.message).slice(0,60)+'），丢弃未生效。';}return '已丢弃排队指令 #'+p.seq+'。';}
      case '/status':{const appr=[...pendingByChat.values()].reduce((n,a)=>n+a.length,0);const ob=outboxStats();return CFG.brand+' '+os.hostname()+'\n运行: '+supervisor.clients.size+'/2\n待审批: '+appr+'\n待发消息: '+ob.pending+(ob.failed?'（投递失败 '+ob.failed+'）':'')+'\n\n'+supervisor.list();}
      case '/outbox':{
        if(e.chat_type!=='p2p')return '⛔ 死信管理仅限私聊。';
        if(!p.action){const failed=outbox.filter(x=>x.state==='failed');return failed.length?'投递失败 '+failed.length+' 条：\n'+failed.map(x=>x.id+' · '+x.chat+' · '+(x.key||'-')+' · '+(x.lastError||'-')).join('\n')+'\n查看: /outbox show <ID>':'没有投递失败的消息。';}
        const entry=outbox.find(x=>x.id===p.id&&x.state==='failed');if(!entry)throw Error('没有该 ID 的失败消息。');
        if(p.action==='show')return '死信 '+entry.id+'\n目标群: '+entry.chat+'\n幂等键: '+(entry.key||'-')+'\n发送时间: '+new Date(entry.createdAt).toLocaleString('zh-CN')+'\n错误: '+(entry.lastError||'-')+'\n内容: '+redact(entry.text,process.env,1000)+'\n先核对目标会话。确认未送达且仍有用时发送 /outbox retry '+entry.id+' --checked；已送达或过时则用 /outbox resolve '+entry.id+' delivered|obsolete --checked 关闭。';
        if(p.action==='resolve'){
          try{txStore(()=>{entry.state='resolved';entry.resolution=p.resolution;entry.resolvedAt=Date.now();});}catch(ex){return '⚠️ 死信关闭状态未保存。('+redact(ex.message).slice(0,80)+')';}
          return '已关闭死信 '+entry.id+'（'+p.resolution+'），未发送消息。';
        }
        try{txStore(()=>{entry.state='pending';entry.attempts=0;entry.nextAt=0;entry.lastError=null;entry.checkedAt=Date.now();});}catch(ex){return '⚠️ 死信重投状态未保存，未执行。('+redact(ex.message).slice(0,80)+')';}
        drainChat(entry.chat).catch(err=>console.error('[bridge] outbox retry failed:',err.message));
        return '已受理重投 '+entry.id+'。同一幂等键保持不变，/outbox 查看投递结果。';}
      case '/logs':{if(p.id)return supervisor.tail(p.id);const gc=groupContext(chat);if(gc)return supervisor.tail(gc.j.id);const latest=[...supervisor.jobs.keys()].at(-1);return latest?supervisor.tail(latest):'暂无任务。';}
      case '/cancel':{
        if(!p.id){ // 裸 /cancel：仅限私聊取消本会话执行中的对话（N02）
          if(e.chat_type!=='p2p')throw new Error('用法: /cancel <任务ID>。群内请指定任务 ID。');
          return cancelDmTurn(chat);
        }
        const r=supervisor.cancel(p.id);for(const arr of [...pendingByChat.values()])for(const en of [...arr])if(en.job.id===p.id){en.resolved=true;try{en.respond('cancel');}catch{}removeEntry(en);deleteMessage(en.messageId).catch(()=>{});}return r;}
      case '/reopen':reopen(p.id,{allowSettled:true}).catch(err=>send(chat,'❌ 重开失败: '+redact(err.message).slice(0,200),'reopenerr-'+Date.now()).catch(()=>{}));return '收到，任务群重建中，完成后群内可见。';
      case '/adopt':{ // 受控绑定已有群（复核#4）：仅限私聊；意图持久化幂等
        if(e.chat_type!=='p2p')return '⛔ /adopt 仅限私聊使用。';
        const r=acceptIntent(e.message_id,{kind:'adopt',targetChat:p.chat,alias:p.alias,task:p.task,chat:e.chat_id,messageId:e.message_id});
        if(r.dup)return '该绑定指令已受理'+(r.jobId?'（任务 '+r.jobId+'）':'')+'，无需重发。';
        executeIntent(r.intent);
        return '收到'+DM_ADDR+'。受控绑定执行中：核验群归属 → 创建真实任务 → 绑定注册，完成后回报。';}
      case '/auditgroups':{ // 审计未注册群（孤儿群检测，补偿路径兜底）
        if(e.chat_type!=='p2p')return '⛔ /auditgroups 仅限私聊使用。';
        (async()=>{
          try{
            const j=await lark(['im','+chat-list','--as','bot','--page-size','100','--page-limit','3','--format','json'],30000);
            const items=(j.data&&(j.data.items||j.data.chats))||[];
            const orphans=items.filter(c=>c&&c.chat_id&&!groups[c.chat_id]&&!dmChats.has(c.chat_id));
            const lines=orphans.map(c=>'⚠️ '+c.chat_id+' · '+redact(String(c.name||'(无名)')).slice(0,40));
            await send(chat,lines.length?'发现 '+lines.length+' 个未注册群：\n'+lines.join('\n')+'\n\n修复：私聊 /adopt <群ID> <项目> <任务> 受控绑定；或确认无用后手动解散。':'✅ 未发现未注册的孤儿群。','audit-'+Date.now());
          }catch(err){await send(chat,'❌ 群审计失败（API 不可用）: '+redact(err.message).slice(0,150),'auditerr-'+Date.now());}
        })().catch(()=>{});
        return '收到，群注册审计中，完成后回报。';}
      case '/cleanup':{ // API 失败不能证明群失效；保留绑定并报告待人工核查
        (async()=>{let checked=0,uncertain=0;
          for(const cid of Object.keys({...groups})){try{await lark(['im','+chat-members-list','--as','bot','--chat-id',cid,'--member-types','bot','--format','json'],15000);checked++;}catch{uncertain++;}}
          await send(chat,'群检查完成：可访问 '+checked+' 个，无法确认 '+uncertain+' 个。未自动删除绑定；对无法确认的群请核查后处理。','cleanup-'+Date.now());
        })().catch(err=>send(chat,'❌ 清理失败: '+redact(err.message).slice(0,200),'cleanerr-'+Date.now()).catch(()=>{}));
        return '群检查已开始，完成后回报。';}
      case '/done':{
        let job=null;
        if(p.id)job=supervisor.jobs.get(p.id);
        else{const gc=groupContext(chat);if(gc)job=gc.j;}
        if(!job)throw new Error('找不到要结算的任务。在任务群里发 /done，或 /done <任务ID>。');
        if(!job.chat||groups[job.chat]?.anchor!==job.id||groups[job.chat]?.status!=='active')throw new Error('该任务不是现役群的任务锚点，不能结算。请在现役任务群用 /done。');
        if(['running','cancelling'].includes(job.status))throw new Error('任务还在运行，先等完成或 /cancel。');
        const q=queues[job.chat||chat]; // 队列未空不解散：不静默删除已受理指令
        if(q&&q.items.some(i=>['queued','active'].includes(i.status)))throw new Error('本群还有排队/执行中的指令。先 /qclear 清空或等队列排空再 /done。');
        settle(job).then(summary=>{if(chat!==job.chat)send(chat,summary,'done-'+job.id).catch(()=>{});}).catch(err=>send(chat,'❌ 结算失败: '+redact(err.message).slice(0,200),'doneerr-'+Date.now()).catch(()=>{}));
        return '收到，结算中（归档+解散群），完成后回报。';}
      case '/group':{
        if(e.chat_type!=='p2p')return '⛔ /group 仅限私聊使用。';
        if(!projects(supervisor.config,supervisor.root)[p.alias])return '❌ 未知或不可用项目: '+p.alias+'。未建群、未启动任务。用 /projects 查看。';
        const bootstrap=!p.task,task=p.task||GROUP_READY_TASK,title=groupTopic(p.task,bootstrap?'待补充需求':p.alias);
        const r=acceptIntent(e.message_id,{kind:'run',alias:p.alias,task,title,mode:'auto',bootstrap,chat:e.chat_id,messageId:e.message_id});
        if(r.dup)return '该建群指令已受理'+(r.jobId?'（会话任务 '+r.jobId+'）':'')+'，无需重发。';
        executeIntent(r.intent);
        return '已受理《'+title+'》工作群请求；执行名额忙时自动排队，建好后发送任务 ID。';}
      case '/run':{const tail=p.task.match(/\s+--(yolo|safe)$/i);const mode=tail?tail[1].toLowerCase():'auto';const task=tail?p.task.slice(0,tail.index).trim():p.task;
        if(!projects(supervisor.config,supervisor.root)[p.alias])return '❌ 未知或不可用项目: '+p.alias+'。未建群、未启动任务。用 /projects 查看。';
        const r=acceptIntent(e.message_id,{kind:'run',alias:p.alias,task,title:groupTopic(task),mode,chat:e.chat_id,messageId:e.message_id}); // F02：意图+去重同一事务
        if(r.dup)return '该指令已受理'+(r.jobId?'（任务 '+r.jobId+'）':'')+'，执行中或已完成，无需重发。';
        executeIntent(r.intent);
        return '新任务已保存；执行名额忙时自动排队，建群后发送任务 ID。';}
      case '/resume':{
        const r=acceptIntent(e.message_id,{kind:'resume',alias:p.alias,thread:p.thread,task:p.task,chat:e.chat_id,messageId:e.message_id}); // F02：意图+去重同一事务
        if(r.dup)return '该续接指令已受理'+(r.jobId?'（任务 '+r.jobId+'）':'')+'，无需重发。';
        executeIntent(r.intent);
        return '收到'+DM_ADDR+'。续接部署中，稍后回报。';}
    }
  }
  if(e.chat_type==='group'){
    if(settlingChats.has(chat))return '任务群正在结算，本条消息未受理。请等待结算结果；失败后可重发。';
    const gc=groupContext(chat);
    if(!gc){ // 未绑定/绑定损坏：报障并给出恢复路径；绝不降级私聊、不发模型 turn
      const g=groups[chat];
      if(g&&g.status==='bind-broken')return '⚠️ 本群任务绑定已失效（'+g.reason+'，anchor '+(g.anchor||'?').slice(0,6)+'），本条消息未执行。群聊与私聊会话相互独立。\n恢复路径：私聊机器人 /reopen '+g.anchor+' 重建任务群，或私聊派新任务。';
      return '⚠️ 本群未绑定任务，本条消息未执行。群聊与私聊会话相互独立，不会在群内进入私聊对话。\n绑定路径：私聊机器人发 "<项目> <任务>" 或 /run <项目> <任务> 派活会自动建任务群；已有任务用 /reopen <任务ID> 重开。';
    }
    // 持久入队后立即受理回执；调度器自动推进，不要求用户重发（TASK_QUEUE 契约）
    const r=enqueueItem(chat,'task',text.trim(),e.message_id);
    if(r.existing)return null; // 重复投递：不新增、不重复执行、不重复回执
    if(r.full)return '⚠️ 本群排队已满（'+Q_MAX+' 条），本条未保存。请 /qclear 清空或等队列排空后重发。';
    pump();
    if(r.paused)return '收到，已保存。队列当前暂停（'+(r.pauseReason||'人工暂停')+'），/qresume 恢复后自动处理，无需重发。';
    if(r.runningAhead===0&&r.waitingAhead===0){
      if(supervisor.clients.size>=2)return '收到，已排队。本群前方 0 条，正在等待执行名额。';
      return '收到，正在启动本群任务。';
    }
    if(r.runningAhead===1&&r.waitingAhead===0)return '收到，已排队：前面 1 条正在执行。完成后自动处理。';
    return '收到，已排队：前面共 '+(r.runningAhead+r.waitingAhead)+' 条（'+r.runningAhead+' 条执行中、'+r.waitingAhead+' 条等待）。轮到后自动处理。';
  }
  const pr=parseRun(text);
  if(pr&&projects(supervisor.config,supervisor.root)[pr.alias]){
    const r=acceptIntent(e.message_id,{kind:'run',alias:pr.alias,task:pr.task,title:groupTopic(pr.task),mode:pr.mode,chat:e.chat_id,messageId:e.message_id});
    if(r.dup)return '该指令已受理'+(r.jobId?'（任务 '+r.jobId+'）':'')+'，执行中或已完成，无需重发。';
    executeIntent(r.intent);
    return '新任务已受理，正在创建任务群；成功后发送任务 ID，失败会明确告知。';
  }
  if(e.chat_type==='p2p'){
    // 私聊对话走自己的持久队列；空闲直接执行，忙碌明确回执排队数量
    const r=enqueueItem(chat,'dm',text,e.message_id);
    if(r.existing)return null;
    if(r.full)return '队列已满（'+Q_MAX+' 条），本条未保存'+DM_ADDR+'。等前面处理完再发。';
    pump();
    if(r.runningAhead+r.waitingAhead>0)return '收到'+DM_ADDR+'。已排队：前面 '+(r.runningAhead+r.waitingAhead)+' 条（'+r.runningAhead+' 条执行中、'+r.waitingAhead+' 条等待），轮到自动处理。';
    return CFG.dmAck; // N04：空闲也即时受理回执
  }
  return '没看懂。直接发 "<项目> <任务>" 派活，或 /help。';
}

// ─────────────────── 事件处理 ───────────────────
let queue=Promise.resolve();     // im 消费者串行链（测试事件文件共用，保持确定性）
let cardQueue=Promise.resolve(); // 卡片消费者独立链：消息处理阻塞不再连坐审批（F04）
async function handle(line){
  let e;try{e=JSON.parse(line);}catch{return;}
  if(e.type!=='im.message.receive_v1')return;
  if(e.sender_type!=='user'||e.sender_id!==owner||!['text','post'].includes(e.message_type))return; // text+富文本 post 均受理
  if(!['p2p','group'].includes(e.chat_type))return;
  if(!/^om_[\w-]+$/.test(e.message_id||'')||!/^oc_[\w-]+$/.test(e.chat_id||''))return;
  if(seen.has(e.message_id))return;
  let response,commit=true;
  try{response=await respond(e);}
  catch(err){response=(err&&err.storeFault?'⚠️ ':'❌ ')+err.message;if(err&&err.storeFault)commit=false;} // 受理失败：不提交去重，重投可恢复（F01/F02）
  // 入队/派活路径已在各自事务内提交 seen；此处为其余路径在受理后补交去重（先受理后去重，崩溃不丢消息）
  if(commit&&!seen.has(e.message_id)){try{remember(e.message_id);}catch(err){console.error('[bridge] dedup persist failed:',err.message);}}
  if(response)post(e.chat_id,response,'reply-'+crypto.createHash('sha256').update(e.message_id).digest('hex').slice(0,32)); // F04：投递不阻塞事件链
  console.log('[bridge] handled '+e.message_id+' ('+(e.chat_type||'?')+')');
}

// ─────────────────── 主循环 ───────────────────
let stopping=false;
const consumers=new Set();
async function consume(eventKey,onEvent,tag,card){
  const proc=spawn(cli,['event','consume',eventKey,'--as','bot'],{stdio:['pipe','pipe','pipe']});
  consumers.add(proc);
  let ready=false;
  const lines=readline.createInterface({input:proc.stdout});lines.pause();
  const err=readline.createInterface({input:proc.stderr});
  err.on('line',line=>{console.error(redact(line));if(line.includes('[event] ready event_key=')){ready=true;lines.resume();}});
  const timer=setTimeout(()=>{if(!ready){console.error('[bridge] '+tag+' readiness timeout');proc.kill('SIGTERM');}},60000);
  lines.on('line',line=>{ // F04：两条消费者各自独立串行链，单一慢事件不阻塞另一通道
    if(card)cardQueue=cardQueue.then(()=>onEvent(line)).catch(err=>console.error('[bridge] '+tag+' handler failed:',err&&err.message));
    else queue=queue.then(()=>onEvent(line)).catch(err=>console.error('[bridge] '+tag+' handler failed:',err&&err.message));
  });
  await new Promise(resolve=>{proc.on('close',resolve);proc.on('error',resolve);});
  consumers.delete(proc);
  clearTimeout(timer);
}
async function consumeLoop(eventKey,onEvent,tag,card){
  while(!stopping){await consume(eventKey,onEvent,tag,card);if(!stopping)await new Promise(r=>setTimeout(r,5000));}
}
function sweepHooks(){ // hook 通知不再投递，周期压制+每周清理文件防磁盘堆积
  const dir=path.join(state,'hooks');
  if(!fs.existsSync(dir))return;
  const now=Date.now();
  for(const name of fs.readdirSync(dir)){
    if(!/^[a-f0-9]{24}\.json$/.test(name))continue;
    const file=path.join(dir,name);
    let e;try{e=JSON.parse(fs.readFileSync(file,'utf8'));}catch{continue;}
    if(!e.sent){e.sent=true;e.delivery='suppressed-v3';try{atomic(file,e);}catch{}}
    else if(e.time&&now-e.time>7*86400e3){try{fs.rmSync(file);}catch{}}
  }
}
async function main(){
  sweepHooks();
  const retry=setInterval(()=>supervisor.flush().catch(()=>{}),30000);
  const pumpTimer=setInterval(()=>{pump();for(const intent of Object.values(dispatches))if(intent.kind==='run'&&intent.status==='pending'&&intent.waitingAt)executeIntent(intent);},30000); // 任务空位后自动继续已保存的建群请求
  pump(); // 启动即对账：恢复重启前未完成的队列
  for(const c of new Set(outbox.filter(x=>x.state==='pending').map(x=>x.chat)))drainChat(c).catch(()=>{}); // 启动补投 outbox（F04）
  const obSweeper=setInterval(()=>{const now=Date.now();for(const c of new Set(outbox.filter(x=>x.state==='pending'&&x.nextAt<=now).map(x=>x.chat)))drainChat(c).catch(()=>{});},30000);
  for(const intent of Object.values(dispatches))if(intent.status==='pending'){console.error('[bridge] resume pending dispatch intent:',intent.messageId);executeIntent(intent);} // F02：崩溃恢复，幂等重投
  const sweeper=setInterval(()=>{try{sweepHooks();}catch{}},60000);
  const testFile=process.env.LCT_TEST_EVENT_FILE;
  if(testFile){
    const arm=()=>{
      fs.unwatchFile(testFile);
      fs.watchFile(testFile,{interval:1000},()=>{
        let linesArr;try{linesArr=fs.readFileSync(testFile,'utf8').split('\n').filter(Boolean);}catch{return;}
        fs.unwatchFile(testFile);fs.rmSync(testFile,{force:true});setTimeout(arm,1500);
        for(const l of linesArr){
          const isCard=l.includes('card.action.trigger');
          queue=queue.then(()=>isCard?handleCardAction(l):handle(l)).catch(err=>console.error('[bridge] test handler failed:',err&&err.message));
        }
      });
    };
    console.log('[bridge] test event file enabled: '+testFile);arm();
  }
  await Promise.all([consumeLoop('im.message.receive_v1',handle,'im',false),consumeLoop('card.action.trigger',handleCardAction,'card',true)]);
  clearInterval(retry);clearInterval(sweeper);clearInterval(pumpTimer);clearInterval(obSweeper);
}
function stop(){
  if(stopping)return;stopping=true;
  supervisor.stop();
  for(const c of chatClients){try{Promise.resolve(c.dispose()).catch(()=>{});}catch{}}
  for(const p of consumers){try{p.stdin.end();}catch{}try{p.kill('SIGTERM');}catch{}}
  setTimeout(()=>process.exit(0),8000).unref();
}
process.on('unhandledRejection',e=>console.error('[bridge] unhandledRejection:',e&&e.message||e));
process.on('uncaughtException',e=>console.error('[bridge] uncaughtException:',e&&e.message||e));
process.on('SIGTERM',stop);process.on('SIGINT',stop);
if(require.main===module)main().catch(e=>{console.error(redact(e.message));process.exitCode=1;});

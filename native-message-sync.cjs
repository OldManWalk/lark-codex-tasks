"use strict";
const crypto=require("node:crypto");
// Reconcile against the source API: the current CLI has no recall/edit subscription.
function decodeMessage(m,{messageId,chat,owner,mediaFromContent=()=>[],redact=x=>x}){
 if(!m||m.message_id!==messageId||m.chat_id!==chat)throw Error("原消息身份不匹配");
 if(m.sender?.sender_type!=="user"||m.sender?.id!==owner)throw Error("原消息发送者不匹配");
 const updatedAt=Number(m.update_time||m.create_time);if(!Number.isFinite(updatedAt))throw Error("原消息版本缺失");
 const base={messageId,chat,updatedAt,deleted:m.deleted===true};
 if(base.deleted)return {...base,signature:"deleted",text:"",media:[]};
 if(!["text","post","image","file"].includes(m.msg_type))throw Error("不支持的原消息类型");
 let body;try{body=JSON.parse(m.body.content);}catch{throw Error("原消息正文无法解析");}
 const mentionMap=new Map((m.mentions||[]).map(x=>[x.key,x.name||""]));
 function node(n){switch(n.tag){case "text":case "md":return n.text||"";case "a":return (n.text||"")+" "+(n.href||"");case "at":return n.user_name||"";case "img":return "";case "emotion":return "";case "hr":return "\n";case "code_block":return n.text||"";default:throw Error("编辑后的富文本包含暂不支持的内容");}}
 let text="";
 if(m.msg_type==="text"){if(typeof body.text!=="string")throw Error("原消息正文缺失");text=body.text;}
 else if(m.msg_type==="post"){
  const post=Array.isArray(body.content)?body:Object.values(body).find(x=>x&&Array.isArray(x.content));
  if(!post)throw Error("富文本正文缺失");
  text=[post.title||"",...post.content.map(row=>row.map(node).join(""))].filter(Boolean).join("\n");
 }else text=m.msg_type==="image"?"[图片]":"[文件] "+(body.file_name||"");
 for(const [key,name] of mentionMap)text=text.split(key).join(name);
 text=redact(text.trim());if(text.length>4000)throw Error("编辑后的指令超过 4000 字符");
 const media=mediaFromContent(m.msg_type,body,messageId).map(m=>{const index='n'+crypto.createHash('sha256').update(String(m.key)).digest('hex').slice(0,16);return {...m,index,id:messageId+'-'+index};});
 if(!text&&media.length)text="请处理附件";
 if(!text)throw Error("编辑后的指令为空");
 const signature=crypto.createHash("sha256").update(JSON.stringify([m.msg_type,body])).digest("hex");
 return {...base,signature,text,media,edited:m.updated===true||Number(m.update_time)>Number(m.create_time)};
}
function createSourceReader({fetchMessage,owner,mediaFromContent,redact,clock=Date.now}){
 const pending=new Map();const health={enabled:true,lastCheckedAt:0,lastSuccessAt:0,error:null};
 async function read(messageId,chat){
  const key=chat+":"+messageId;if(pending.has(key))return pending.get(key);
  const promise=(async()=>{
   health.lastCheckedAt=clock();
   try{const m=await fetchMessage(messageId);const source=decodeMessage(m,{messageId,chat,owner,mediaFromContent,redact});health.lastSuccessAt=clock();health.error=null;return source;}
   catch(e){health.error=String(e.message).slice(0,180);throw e;}
  })();pending.set(key,promise);
  try{return await promise;}finally{if(pending.get(key)===promise)pending.delete(key);}
 }
 return {read,health};
}
function needsChange(previous,source){
 if(previous?.deleted)return false;
 if(previous&&source.updatedAt<previous.updatedAt&&!source.deleted)return false;
 return source.deleted||!!previous&&previous.signature!==source.signature||!previous&&source.edited;
}
module.exports={decodeMessage,createSourceReader,needsChange};

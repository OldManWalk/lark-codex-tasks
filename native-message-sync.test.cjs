"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {decodeMessage,needsChange,createSourceReader}=require("./native-message-sync.cjs");
const opts={messageId:"om_test",chat:"oc_test",owner:"owner"};
function message(text="first",extra={}){return {message_id:"om_test",chat_id:"oc_test",sender:{id:"owner",sender_type:"user"},msg_type:"text",create_time:"10",update_time:"10",deleted:false,updated:false,body:{content:JSON.stringify({text})},...extra};}
test("N1 recall is recognized without requiring a body; identity is checked",()=>{
 assert.equal(decodeMessage(message("",{deleted:true,body:null}),opts).deleted,true);
 for(const extra of [{chat_id:"oc_other"},{message_id:"om_other"},{sender:{id:"other",sender_type:"user"}}])assert.throws(()=>decodeMessage(message("",extra),opts),/不匹配/);
});
test("N2 edits are versioned, duplicates ignored, stale reads cannot undo edits or recall",()=>{
 const a=decodeMessage(message(),opts),b=decodeMessage(message("new",{updated:true,update_time:"20"}),opts),c=decodeMessage(message("",{deleted:true,update_time:"30"}),opts);
 assert(needsChange(a,b));assert(!needsChange(b,b));assert(!needsChange(b,a));assert(needsChange(b,c));assert(!needsChange(c,b));assert(needsChange(null,b));assert(!needsChange(null,a));
});
test("N3 rich text uses latest text and content-addressed media; unsupported edits fail closed",()=>{
 const body={title:"标题",content:[[{tag:"text",text:"新任务"},{tag:"img",image_key:"img_new"}]]};
 const options={...opts,mediaFromContent:()=>[{key:"img_new",index:0,id:"old"}]};
 const source=decodeMessage(message("",{msg_type:"post",body:{content:JSON.stringify(body)}}),options);
 assert.equal(source.text,"标题\n新任务");assert.match(source.media[0].id,/^om_test-n[0-9a-f]{16}$/);
 assert.throws(()=>decodeMessage(message("",{body:{content:"bad"}}),opts),/解析/);
 assert.throws(()=>decodeMessage(message("x".repeat(4001)),opts),/4000/);
});
test("N4 concurrent source checks share the same read; failures can be retried",async()=>{
 let calls=0,resolve;const reader=createSourceReader({owner:"owner",fetchMessage:()=>{calls++;return new Promise(r=>resolve=r);}});
 const a=reader.read("om_test","oc_test"),b=reader.read("om_test","oc_test");resolve(message());assert.deepEqual(await a,await b);assert.equal(calls,1);assert(reader.health.lastSuccessAt);
 let fail=true;const retry=createSourceReader({owner:"owner",fetchMessage:async()=>{if(fail)throw Error("offline");return message();}});
 await assert.rejects(retry.read("om_test","oc_test"),/offline/);fail=false;await retry.read("om_test","oc_test");assert.equal(retry.health.error,null);
});
const {createInstructionControl}=require("./instruction-control.cjs");
function running(){
 const i={seq:1,messageId:"om_test",status:"active",kind:"task",text:"old",inputText:"old",runJobId:"job"};
 const q={seq:1,paused:false,items:[i]},j={id:"job",chat:"oc_test",message:"om_test",status:"running"};let cancellations=0;
 const c=createInstructionControl({queues:()=>({oc_test:q}),qOf:()=>q,jobs:new Map([["job",j]]),tx:fn=>fn(),cancelJob:()=>cancellations++,replaceNative:(item,source)=>{item.media=source.media;}});
 const apply=(kind,text="new",signature=text)=>c.applyNative({target:"oc_test",seq:1,action:"instruction."+kind,text,itemRevision:c.detail({target:"oc_test",seq:1}).itemRevision,nativeMessage:{text,signature,media:[]},requestId:signature});
 return {i,q,j,c,apply,get cancellations(){return cancellations;}};
}
test("N5 rapid native edits run only latest text after confirmed stop and automatically resume",()=>{
 const f=running();f.apply("edit","second");f.apply("edit","third");assert.equal(f.cancellations,1);f.j.status="cancelled";f.c.reconcile("oc_test");assert.notEqual(f.i.status,"queued");
 const g=running();g.apply("edit","second");g.apply("edit","third");g.j.status="cancelled";g.j.stopConfirmed=true;g.c.reconcile("oc_test");assert.equal(g.i.text,"third");assert.equal(g.i.status,"queued");assert.equal(g.q.paused,false);assert.equal(g.i.lastChange.autoResumed,true);
});
test("N6 recall overrides edit while stopping; old edit cannot resurrect recall",()=>{
 const f=running();f.apply("edit");f.apply("withdraw");f.apply("edit","stale");f.j.status="cancelled";f.j.stopConfirmed=true;f.c.reconcile("oc_test");assert.equal(f.i.status,"withdrawn");assert.equal(f.q.paused,false);
});
test("N7 native edit does not release a manual pause or override manual stopping",()=>{
 const f=running();f.q.paused=true;f.q.pauseReason="manual";f.apply("edit");f.j.status="cancelled";f.j.stopConfirmed=true;f.c.reconcile("oc_test");assert.equal(f.q.paused,true);
 const g=running();g.apply("edit");g.q.pauseReason="manual";g.j.status="cancelled";g.j.stopConfirmed=true;g.c.reconcile("oc_test");assert.equal(g.q.paused,true);
});
test("N8 completed race never executes edited text",()=>{
 const f=running();f.apply("edit");f.j.status="completed";f.c.reconcile("oc_test");assert.equal(f.i.status,"done");assert.equal(f.i.lastChange.status,"failed");assert.equal(f.q.paused,true);
});

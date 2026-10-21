'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createInstructionControl}=require('./instruction-control.cjs');
function fixture(){
 const qs={oc_a:{seq:2,paused:false,items:[{seq:1,messageId:'om_a',kind:'task',text:'first',inputText:'first',status:'queued'},{seq:2,messageId:'om_b',kind:'task',text:'second',status:'queued'}]}},jobs=new Map(),cancelled=[];
 let fail=false,flight=false,dmStop=false;
 const c=createInstructionControl({queues:()=>qs,qOf:chat=>qs[chat]||(qs[chat]={seq:0,items:[]}),jobs,tx:fn=>{if(fail)throw Error('disk full');return fn();},inFlight:()=>flight,stoppingDm:()=>dmStop,cancelJob:id=>cancelled.push(id),cancelDm:()=>cancelled.push('dm')});
 const action=(kind,body={})=>{const b={target:'oc_a',seq:1,...body};return c.apply({...b,action:'instruction.'+kind,itemRevision:c.detail(b).itemRevision});};
 return {qs,jobs,c,cancelled,action,fail:()=>fail=true,flight:v=>flight=v,dmStop:v=>dmStop=v};
}
test('I1 queued edits retain FIFO and attachments; old revisions cannot replace new text',()=>{
 const f=fixture(),i=f.qs.oc_a.items[0];i.images=['/safe/image.png'];i.attachmentContext='\n[attachment]';
 const old=f.c.detail({target:'oc_a',seq:1});f.action('edit',{text:'updated'});
 assert.equal(i.text,'updated\n[attachment]');assert.equal(i.inputText,'updated');assert.deepEqual(i.images,['/safe/image.png']);assert.deepEqual(f.qs.oc_a.items.map(i=>i.seq),[1,2]);assert.equal(i.history[0].text,'first');
 assert.throws(()=>f.c.apply({action:'instruction.edit',target:'oc_a',seq:1,text:'stale',itemRevision:old.itemRevision}),/已变化/);
});
test('I2 queued withdrawal is a durable tombstone; empty/oversize edits fail before mutation',()=>{
 const f=fixture();for(const text of ['', 'x'.repeat(4001)])assert.throws(()=>f.action('edit',{text}),/4000/);
 assert.equal(f.action('withdraw').status,'succeeded');assert.equal(f.qs.oc_a.items[0].status,'withdrawn');assert.equal(f.qs.oc_a.items.length,2);assert.equal(f.cancelled.length,0);
 assert.throws(()=>f.action('withdraw'),/已结束/);
});
test('I3 persistence failure prevents cancelling or accepting an edit',()=>{
 const f=fixture(),i=f.qs.oc_a.items[0];i.status='active';i.runJobId='job';f.jobs.set('job',{id:'job',chat:'oc_a',status:'running'});f.fail();
 assert.throws(()=>f.action('edit',{text:'new'}),/disk/);assert.equal(f.cancelled.length,0);assert.equal(i.change,undefined);
});
test('I4 running edit waits for confirmed process exit and explicit queue resume',()=>{
 const f=fixture(),i=f.qs.oc_a.items[0],j={id:'job',chat:'oc_a',status:'running'};i.status='active';i.runJobId='job';f.jobs.set('job',j);
 assert.equal(f.action('edit',{text:'replacement',requestId:'request_running_edit'}).status,'accepted');assert.deepEqual(f.cancelled,['job']);assert.equal(f.qs.oc_a.paused,true);assert.throws(()=>f.c.canResume('oc_a'),/停止/);
 f.c.reconcile('oc_a');assert.equal(i.status,'active');
 j.status='cancelled';j.stopConfirmed=true;f.flight(true);f.c.reconcile('oc_a');assert.equal(i.status,'active');
 f.flight(false);f.c.reconcile('oc_a');assert.equal(i.status,'queued');assert.equal(i.text,'replacement');assert.equal(i.seq,1);assert.equal(i.runJobId,null);assert.notEqual(i.runMessageId,i.messageId);assert.equal(f.qs.oc_a.paused,true);assert.equal(i.lastChange.requestId,'request_running_edit');f.c.canResume('oc_a');
});
test('I5 restart ambiguity keeps draft for inspection and never replays it',()=>{
 const f=fixture(),i=f.qs.oc_a.items[0];i.status='active';f.action('edit',{text:'draft'});f.c.reconcile('oc_a');
 assert.equal(i.status,'failed');assert.equal(i.change.status,'unknown');assert.equal(f.c.detail({target:'oc_a',seq:1}).draft,'draft');assert.equal(f.qs.oc_a.paused,true);
});
test('I6 cancelling during startup prevents submission and can finish without a job',()=>{
 const f=fixture(),i=f.qs.oc_a.items[0];i.status='active';f.flight(true);f.action('withdraw');assert.throws(()=>f.c.guard(i),/撤回/);f.c.prestartStopped('oc_a',i);f.c.reconcile('oc_a');assert.equal(i.status,'active');f.flight(false);f.c.reconcile('oc_a');assert.equal(i.status,'withdrawn');
});
test('I7 initial direct jobs are adopted and completed races are rejected',()=>{
 const f=fixture();f.jobs.set('initial',{id:'initial',chat:'oc_a',status:'running',task:'initial task',message:'om_initial'});
 const d=f.c.detail({target:'initial'});f.c.apply({action:'instruction.withdraw',target:'initial',itemRevision:d.itemRevision});assert.equal(f.qs.oc_a.items[0].runJobId,'initial');assert.deepEqual(f.cancelled,['initial']);
 const g=fixture();g.jobs.set('late',{id:'late',chat:'oc_a',status:'completed',task:'done'});assert.throws(()=>g.action('withdraw',{target:'late',seq:undefined}),/已结束/);
});
test('I8 DM completion cannot race ahead of stop confirmation; restart does not trust persisted pending',()=>{
 const f=fixture(),i=f.qs.oc_a.items[0];i.kind='dm';i.status='active';f.action('edit',{text:'new DM'});i.change.stopPending=true;f.dmStop(true);f.c.reconcile('oc_a');assert.equal(i.status,'active');f.dmStop(false);f.c.reconcile('oc_a');assert.equal(i.status,'failed');
});

test('I9: completed race reports too late and never queues a replacement',()=>{
 const f=fixture(),i=f.qs.oc_a.items[0],j={id:'job',chat:'oc_a',status:'running'};i.status='active';i.runJobId='job';f.jobs.set('job',j);f.action('edit',{text:'late draft'});j.status='completed';f.c.reconcile('oc_a');
 assert.equal(i.status,'done');assert.equal(i.lastChange.status,'failed');assert.equal(i.change.status,'too-late');assert.match(i.error,/撤回未生效/);assert.equal(f.c.detail({target:'oc_a',seq:1}).draft,'late draft');
});

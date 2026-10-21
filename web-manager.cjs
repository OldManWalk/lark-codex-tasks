#!/usr/bin/env node
'use strict';
const {loadCtx}=require('./lct.cjs');
const {createManagement}=require('./management.cjs');
const {startWebStatus}=require('./web-status.cjs');
async function main(){
 const ctx=loadCtx();
 if(!ctx.CFG.webToken)throw Error('独立管理后台需要在 bridge.env 配置 LCT_WEB_TOKEN');
 if(!ctx.CFG.webPort)throw Error('请配置 LCT_WEB_PORT');
 const control=createManagement({ctx});
 const web=await startWebStatus({port:ctx.CFG.webPort,host:ctx.CFG.webHost,token:ctx.CFG.webToken,getState:control.snapshot,onAction:control.submit,onInstruction:control.instruction});
 const stop=()=>web.close().then(()=>process.exit(0));process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={main};

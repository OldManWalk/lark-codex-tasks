#!/usr/bin/env node
'use strict';
// launchd does not understand env files. Parse data as data, including paths with spaces.
const {spawn}=require('node:child_process');
const {parseEnvFile}=require('./lct.cjs');
const [file,entry]=process.argv.slice(2);if(!file||!entry)throw Error('缺少配置文件或服务入口');
const child=spawn(process.execPath,[entry],{env:{...process.env,...parseEnvFile(file)},stdio:'inherit'});
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>child.kill(sig));
child.once('error',e=>{console.error('服务启动失败: '+e.message);process.exitCode=1;});
child.once('exit',(code,signal)=>{process.exitCode=code===null?(signal==='SIGTERM'?0:1):code;});

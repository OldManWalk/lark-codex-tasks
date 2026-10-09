// 防回归（2026-10-09 /done 解散失败事故）：宿主机器一旦做过 `lark-cli auth login`（user 身份），
// lark-cli 默认身份会从 bot 漂移到 user；bridge 的每个 lark() 调用都必须显式携带 --as，不受默认身份影响。
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');

test('every lark() call in lark-bridge.cjs carries explicit --as identity',()=>{
 const src=fs.readFileSync(path.join(__dirname,'lark-bridge.cjs'),'utf8');
 const calls=src.match(/lark\(\[[\s\S]*?\],/g)||[];
 assert(calls.length>=5,'应识别出全部 lark 调用点（实际 '+calls.length+' 个，过少说明正则失效）');
 for(const c of calls)assert(/'--as'/.test(c),'缺少显式身份的调用: '+c.replace(/\s+/g,' ').slice(0,100));
});

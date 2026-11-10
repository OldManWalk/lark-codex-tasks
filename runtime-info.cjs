'use strict';
const os=require('node:os'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),plat=require('./platform.cjs');
function identity(cfg){
 const file=path.join(cfg.stateDir,'instance.json');fs.mkdirSync(cfg.stateDir,{recursive:true,mode:0o700});
 let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('实例标识损坏，请人工核查 instance.json');}
 if(!value){value={id:crypto.randomUUID(),createdAt:Date.now()};try{fs.writeFileSync(file,JSON.stringify(value),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;value=JSON.parse(fs.readFileSync(file,'utf8'));}}
 if(typeof value.id!=='string')throw Error('实例标识无效');
 return {id:value.id,label:process.env.LCT_NODE_LABEL||os.hostname(),role:cfg.nodeRole||(cfg.platform==='darwin'?'local':'server'),platform:cfg.platform,wsl:cfg.platform==='linux'&&(/microsoft/i.test(os.release())||!!process.env.WSL_DISTRO_NAME)};
}
function doctor(ctx){
 const cfg=ctx.CFG,checks=[];const add=(name,ok,detail)=>checks.push({name,ok,detail});
 add('Node.js',Number(process.versions.node.split('.')[0])>=18,process.version);
 add('配置文件',fs.existsSync(path.join(cfg.configDir,'bridge.env')),path.join(cfg.configDir,'bridge.env'));
 for(const bin of ['codex','lark-cli']){const p=path.join(cfg.binDir,bin);let ok=false;try{fs.accessSync(p,fs.constants.X_OK);ok=true;}catch{}add(bin,ok,p);}
 const kind=plat.sandboxKind({platform:cfg.platform});add('私聊沙箱',kind!=='none',kind==='none'?'未发现沙箱；不会自动降级权限':kind);
 add('Web 密钥',!!cfg.webToken,cfg.webToken?'已配置（不显示内容）':'尚未配置 LCT_WEB_TOKEN');
 add('飞书指挥人',!!cfg.ownerOpenId,cfg.ownerOpenId?'已配置':'需要填写 LARK_OWNER_OPEN_ID');
 add('实例标识',true,'首次运行时在独立状态目录生成；不同机器不得复制运行状态目录');
 return {platform:cfg.platform,wsl:!!process.env.WSL_DISTRO_NAME||/microsoft/i.test(os.release()),checks,ready:checks.every(c=>c.ok)};
}
module.exports={identity,doctor};

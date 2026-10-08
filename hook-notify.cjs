// Queue safe metadata only; no hook decision and no raw tool commands or prompts.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
try {const input=JSON.parse(fs.readFileSync(0,'utf8'));const event=input.hook_event_name;if(!['PermissionRequest','Stop','SubagentStop','Interrupt'].includes(event))process.exit(0);
 const dir=path.join(process.env.LCT_STATE_DIR||path.join(os.homedir(),'.local/state/lark-codex-tasks'),'hooks');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const payload={event,session:input.session_id||'',job:process.env.LCT_JOB_ID||'',project:path.basename(input.cwd||''),time:Date.now(),tool:String(input.tool_name||'').slice(0,80)};
 const id=crypto.randomBytes(12).toString('hex');fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify(payload),{mode:0o600});
}catch{process.exitCode=0;}

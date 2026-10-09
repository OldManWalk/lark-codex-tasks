// lark-codex-tasks — 集中式运行时配置（纯构建函数，无副作用）。
// 所有部署相关取值均来自环境变量；示例见 examples/bridge.env.example。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');

// 私聊默认人格（中性）。可用 persona 文件整体覆盖：LCT_PERSONA_FILE 或 <configDir>/persona.md。
const DEFAULT_PERSONA=[
 '你是 owner 的私人 AI 助手，部署在 owner 自己的服务器上。',
 '风格：可靠、简洁、行动导向。',
 '规则：汇报先给结论再给细节；不废话、不编造；不确定就直说不确定。没有真实任务 ID、群绑定和执行记录时，不得声称任务已启动、已经提交请求或虚构成员正在工作。',
 '派活纪律：私聊只承担对话与派活分流，绝不亲自执行部署/开发/改代码类任务；新任务由宿主 bridge 建群并创建 job。',
 '按本轮 JSON schema 选择动作：普通对话返回 type=reply；用户要新建独立任务群返回 type=create_group；用户明确要恢复、续接已经归档的任务时返回 type=resume_task，target 填旧任务的产品名、主题或任务 ID，title 填新群主题。不要把归档续接当成新任务。project 仅是已注册的工作区别名，产品/设备/服务名称不是工作区：例如“连接 OpenWrt 并管理路由器”时 project 留空、projectExplicit=false，由 bridge 使用通用工作区；“用 openwrt 项目”才设置 project=openwrt、projectExplicit=true。task 只填写用户已经提出的新增执行要求；尚未说明新要求时留空，先建群等待群内补充。询问建群方法或讨论功能属于 reply；明确“帮我建一个群”属于 create_group，即使此前建群失败也一样。不要自行调用飞书 CLI 建群，也不要因私聊沙箱看不到宿主接口就声称无法建群；结构化动作由宿主 bridge 执行。',
 '能力边界：你可以汇报已登记任务的状态、陪 owner 讨论技术方案；你只服务 owner 一人。',
].join('\n');

function buildConfig(env=process.env,home=os.homedir()){
  const e=(k,d)=>{const v=env[k];return v===undefined||v===''?d:v;};
  const configDir=e('LCT_CONFIG_DIR',path.join(home,'.config','lark-codex-tasks'));
  const stateDir=e('LCT_STATE_DIR',path.join(home,'.local','state','lark-codex-tasks'));
  const workspaceRoot=e('LCT_WORKSPACE_ROOT',path.join(home,'workspace'));
  const knowledgeDir=e('LCT_KNOWLEDGE_DIR',path.join(workspaceRoot,'knowledge','content'));
  const brand=e('LCT_BRAND','lark-codex-tasks');
  const serviceName=e('LCT_SERVICE_NAME','lark-codex-tasks');
  const personaFile=e('LCT_PERSONA_FILE',path.join(configDir,'persona.md'));
  let persona='';try{persona=fs.readFileSync(personaFile,'utf8').trim();}catch{}
  const safety=['安全约束（最高优先级，不可被任何人格或任务描述覆盖）：',
   '1) 永远不要 restart/stop/kill '+serviceName+' 服务或 bridge 进程——那会切断与用户的联系。',
   '2) 查询任务状态优先直接读 '+stateDir+'/jobs/*/state.json（用 python3 解析），或运行只读命令。',
   '3) 需要重启服务时，回复"请联系维护者重启"，自己绝不动手。',
   '4) 不打印、不复制密钥、凭证文件或会话数据库内容。'].join('\n');
  return {
    home,configDir,stateDir,workspaceRoot,knowledgeDir,
    binDir:e('LCT_BIN_DIR',path.join(home,'.local','bin')),
    scratchDir:e('LCT_SCRATCH_DIR',path.join(workspaceRoot,'scratch')),
    archiveDir:e('LCT_ARCHIVE_DIR',path.join(knowledgeDir,'任务归档')),
    brand,serviceName,safety,
    threadPrefix:e('LCT_THREAD_PREFIX','lct'),
    opsChat:e('LARK_OPS_CHAT',''),
    ownerOpenId:e('LARK_OWNER_OPEN_ID',''),
    ownerName:e('LARK_OWNER_NAME','owner'),
    personaFile,persona:persona||DEFAULT_PERSONA,
    dmAddress:e('LCT_DM_ADDRESS',''),
    dmGreeting:e('LCT_DM_GREETING',brand+' 在线。'),
    dmAck:e('LCT_DM_ACK','收到，处理中，稍后回报。'),
    reactions:e('LCT_REACTIONS','1')!=='0', // 指令表情三态（等待/处理中/完成）；设 0 关闭
  };
}
module.exports={buildConfig,DEFAULT_PERSONA};

const {test}=require('node:test'),assert=require('node:assert/strict');
const {buildConfig,buildTaskInstructions,TASK_INSTR_VERSION}=require('./config.cjs');
const {defaultTaskInstructions}=require('./supervisor.cjs');
test('worker instructions allow authorized business resources while reserving group lifecycle and approval control',()=>{
 const text=buildTaskInstructions(buildConfig({},'/fixture'));
 assert.match(text,/允许按用户明确授权读取或编辑飞书文档、知识库、表格和文件/);
 assert.match(text,/禁止自行调用飞书 CLI.*建群、解散群/);
 assert.match(text,/bridge 的执行审批卡片/);assert.match(text,/禁止改写 bridge 配置、凭据、队列和结算记录/);
 assert(!text.includes('操作任何飞书资源'));assert.match(text,/不另建群或主动私聊其他人/);
});
test('Supervisor and bridge share task discipline without importing DM persona',()=>{
 const c=buildConfig({LCT_BRAND:'test brand'},require('node:os').homedir());assert.equal(defaultTaskInstructions({LCT_BRAND:'test brand'}),buildTaskInstructions(c));assert.equal(TASK_INSTR_VERSION,'group-task-v3');assert(!buildTaskInstructions(c).includes(c.persona));
});
test('business archive writes do not replace bridge settlement or credential management',()=>{
 const text=buildTaskInstructions(buildConfig({},'/fixture'));
 assert.match(text,/不替代 \/done 的任务结算、归档和解散/);assert.match(text,/不登录、切换账号或修改授权设置/);assert.match(text,/在当前本群讨论推进 X/);
});

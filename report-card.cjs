const {redact}=require('./supervisor.cjs');
const {failureHint}=require('./task-failure.cjs');
const MAX_REPORT_CHARS=7500;

function reportExcerpt(value){
  const safe=redact(String(value||''),process.env,Number.MAX_SAFE_INTEGER);
  if(safe.length<=MAX_REPORT_CHARS)return safe;
  return safe.slice(0,MAX_REPORT_CHARS)+'\n\n（结论过长，后续 '+(safe.length-MAX_REPORT_CHARS)+' 字未在卡片中展示；完整内容保存在任务记录中。）';
}

function cardMarkdown(value){
  const safe=reportExcerpt(value).replace(/</g,'&#60;').replace(/>/g,'&#62;');
  let fenced=false;
  return safe.split('\n').map(line=>{
    if(/^\s*(```|~~~)/.test(line)){fenced=!fenced;return line;}
    return fenced?line:line.replace(/^\s*#{1,3}\s+(.+?)\s*#*\s*$/,'**$1**');
  }).join('\n');
}

function buildReportCard(job){
  const states={completed:['任务完成','green'],failed:['任务失败','red'],cancelled:['任务已取消','grey'],interrupted:['任务中断','orange']};
  const [title,color]=states[job.status]||['任务状态','blue'];
  const result=cardMarkdown([job.error?'**错误：** '+job.error:null,failureHint(job),job.lastMessage].filter(Boolean).join('\n\n')||'（无结论）');
  const hasTable=/^\s*\|[^\n]+\|\s*\n\s*\|[\s:|-]+\|/m.test(result);
  const meta=[job.alias,job.id,job.mode||'auto'].filter(Boolean).join(' · ');
  const footer=['分支: '+(job.branch||'-'),job.threadId?'接管: `codex resume '+job.threadId+'`':null,'回复 `/done` 结算归档并解散本群'].filter(Boolean).join('\n');
  return {
    schema:'2.0',
    config:{update_multi:true,width_mode:hasTable?'fill':'default',summary:{content:title+' · '+job.alias+' · '+job.id.slice(0,6)}},
    header:{title:{tag:'plain_text',content:title+' · '+job.alias},subtitle:{tag:'plain_text',content:job.id.slice(0,6)+' · '+(job.mode||'auto')},template:color,icon:{tag:'standard_icon',token:'todo_colorful'}},
    body:{direction:'vertical',padding:'12px 12px 20px 12px',vertical_spacing:'12px',elements:[
      {tag:'column_set',flex_mode:'none',background_style:'grey-50',columns:[{tag:'column',width:'weighted',weight:1,padding:'8px',elements:[{tag:'markdown',content:'**'+cardMarkdown(meta)+'**',text_size:'notation'}]}]},
      {tag:'markdown',content:result,text_size:'normal'},
      {tag:'markdown',content:'<font color=\'grey\'>'+cardMarkdown(footer)+'</font>',text_size:'notation'}
    ]}
  };
}

module.exports={buildReportCard,cardMarkdown,reportExcerpt};

// lark-codex-tasks — 长报告文件交付：完整结论落盘为 Markdown，尽力转 PDF（中文内嵌字体）。
// PDF 转换失败不阻断 Markdown 交付；两个文件都留在 reportsDir，由 bridge 作为文件消息发送。
const fs=require('node:fs'),path=require('node:path'),{promisify}=require('node:util');
const {execFile}=require('node:child_process');

function safeName(value){return String(value||'').replace(/[^\w一-鿿-]+/g,'_').slice(0,40)||'task';}

async function saveReportFiles(job,text,{reportsDir,pythonBin='python3',pdfScript,fontPath,wantPdf=true,exec}={}){
  if(!reportsDir)throw Error('reportsDir required');
  fs.mkdirSync(reportsDir,{recursive:true});
  const base='任务报告-'+safeName(job&&job.alias)+'-'+String(job&&job.id||'').slice(0,12);
  const mdPath=path.join(reportsDir,base+'.md');
  const header='# 任务报告 · '+(job&&job.alias||'-')+' · '+String(job&&job.id||'').slice(0,12)
    +'\n\n- 任务 ID: '+(job&&job.id||'-')
    +'\n- 状态: '+(job&&job.status||'-')
    +'\n- 生成时间: '+new Date().toLocaleString('zh-CN')+'\n\n---\n\n';
  fs.writeFileSync(mdPath,header+String(text||'').trim()+'\n');
  let pdfPath=null;
  if(wantPdf&&pdfScript){
    try{
      const run=exec||promisify(execFile);
      await run(pythonBin,[pdfScript,mdPath,path.join(reportsDir,base+'.pdf'),fontPath||''],{timeout:90000,maxBuffer:4*1024*1024});
      const cand=path.join(reportsDir,base+'.pdf');
      if(fs.existsSync(cand)&&fs.statSync(cand).size>500)pdfPath=cand;
      else console.error('[bridge] report PDF missing or too small, markdown only:',base);
    }catch(e){console.error('[bridge] report PDF failed, markdown only:',String(e&&e.message||e).slice(0,120));}
  }
  const filePath=pdfPath||mdPath;
  return {mdPath,pdfPath,filePath,fileName:path.basename(filePath),dir:reportsDir};
}

module.exports={saveReportFiles,safeName};

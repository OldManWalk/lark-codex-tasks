// 报告文件交付：Markdown 必落盘；PDF 尽力转换，失败退化为纯 Markdown 交付。
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {saveReportFiles,safeName}=require('./report-file.cjs');

const tmp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'lct-rf-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};

test('report markdown always lands with metadata header',async t=>{
  const dir=tmp(t);
  const r=await saveReportFiles({id:'aaaaaaaaaaaa',alias:'scratch',status:'completed'},'# 结论\n内容',{reportsDir:dir,wantPdf:false});
  assert.equal(r.pdfPath,null);
  assert.equal(r.filePath,r.mdPath);
  assert.match(r.fileName,/任务报告-scratch-aaaaaaaaaaaa\.md$/);
  const body=fs.readFileSync(r.mdPath,'utf8');
  assert.match(body,/任务 ID: aaaaaaaaaaaa/);
  assert.match(body,/# 结论\n内容/);
});

test('pdf is preferred when the converter succeeds',async t=>{
  const dir=tmp(t);
  const fake=async(bin,args)=>{assert.equal(bin,'python3');assert.equal(args[0],'/fake/md2pdf.py');fs.writeFileSync(args[2],'x'.repeat(1200));return {stdout:''};};
  const r=await saveReportFiles({id:'bbbbbbbbbbbb',alias:'a',status:'completed'},'内容',{reportsDir:dir,pdfScript:'/fake/md2pdf.py',fontPath:'/f.ttf',wantPdf:true,exec:fake});
  assert(r.pdfPath&&r.pdfPath.endsWith('.pdf'),'PDF 存在则优先交付');
  assert.equal(r.filePath,r.pdfPath);
  assert(fs.existsSync(r.mdPath),'Markdown 原件保留');
});

test('converter failure degrades to markdown delivery without throwing',async t=>{
  const dir=tmp(t);
  const boom=async()=>{throw Error('python missing');};
  const r=await saveReportFiles({id:'cccccccccccc',alias:'a',status:'completed'},'内容',{reportsDir:dir,pdfScript:'/fake/md2pdf.py',wantPdf:true,exec:boom});
  assert.equal(r.pdfPath,null);
  assert.equal(r.filePath,r.mdPath);
});

test('tiny or empty pdf output is rejected',async t=>{
  const dir=tmp(t);
  const fake=async(bin,args)=>{fs.writeFileSync(args[2],'tiny');return {stdout:''};};
  const r=await saveReportFiles({id:'dddddddddddd',alias:'a',status:'completed'},'内容',{reportsDir:dir,pdfScript:'/fake/md2pdf.py',wantPdf:true,exec:fake});
  assert.equal(r.pdfPath,null);
  assert.equal(r.filePath,r.mdPath);
});

test('safeName strips path separators and odd characters',()=>{
  assert.equal(safeName('a/b\\c:d'),'a_b_c_d');
  assert.equal(safeName(''),'task');
});

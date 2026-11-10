'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {build,releases,validateNews}=require('./site-build.cjs');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lct-site-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('site builds real release history, candidate labels and subpath-safe links without runtime state',t=>{
 const output=fixture(t),r=build({output}),home=fs.readFileSync(path.join(output,'index.html'),'utf8'),updates=fs.readFileSync(path.join(output,'updates/index.html'),'utf8');
 assert.equal(r.version,JSON.parse(fs.readFileSync(path.join(__dirname,fs.existsSync(path.join(__dirname,'package.json'))?'package.json':'release/package.json'))).version);assert(r.releases>=3);assert(r.news>=2);assert(home.includes('当前公开版本 v'+r.version));assert(updates.includes('候选进展 · 尚未发布'));
 assert(home.includes('./assets/site.css'));assert(updates.includes('../assets/site.css'));assert(!/src="\/|href="\/(?!\/)/.test(home+updates));
 assert(!/n100\.oldmanwalk|ou_[A-Za-z0-9]{20,}|oc_[A-Za-z0-9]{20,}|LCT_WEB_TOKEN|\/home\/oldmanwalk|\/Users\//.test(home+updates));
 for(const name of ['feed.xml','sitemap.xml','robots.txt','404.html','.nojekyll','assets/site.js','assets/site.css','assets/logo.png','assets/social.png'])assert(fs.existsSync(path.join(output,name)),name);
 assert(!fs.existsSync(path.join(output,'lark-bridge.cjs')));assert(!fs.existsSync(path.join(output,'web-ui.html')));
});
test('release parser excludes Unreleased and preserves the final dated section',()=>{
 const rs=releases('## [Unreleased]\n- hidden\n\n## [1.2.0] - 2026-10-21\n- first\n\n## [1.1.0] - 2026-10-20\n- last\n');assert.deepEqual(rs.map(r=>r.version),['1.2.0','1.1.0']);assert.match(rs[1].body,/last/);
});
test('news schema rejects duplicate anchors and accidental release promotion',()=>{
 const n={id:'candidate',date:'2026-10-21',title:'title',summary:'summary',status:'candidate',body:['text']};assert.throws(()=>validateNews([n,n]),/Invalid/);assert.throws(()=>validateNews([{...n,status:'released'}]),/Invalid/);assert.throws(()=>validateNews([{...n,id:'<script>'}]),/Invalid/);
});
test('custom base URLs are propagated to discovery metadata and unsafe bases are rejected',t=>{
 const output=fixture(t);build({output,base:'https://example.com/project/'});assert.match(fs.readFileSync(path.join(output,'feed.xml'),'utf8'),/https:\/\/example.com\/project\/updates\//);assert.throws(()=>build({output,base:'javascript:alert(1)'}),/HTTPS/);assert.throws(()=>build({output,base:'https://user:password@example.com/'}),/HTTPS/);
});

test('local and server topology is visible without claiming completed fusion',t=>{
 const output=fixture(t);build({output});const home=fs.readFileSync(path.join(output,'index.html'),'utf8'),updates=fs.readFileSync(path.join(output,'updates/index.html'),'utf8');
 assert(home.includes('id="nodes"'));assert(home.includes('LCT_FEISHU_CONSUME=0'));assert(home.includes('/release'));
 assert(home.includes('自动跨机 Handoff、成果回收和统一控制台仍按后续阶段验收'));
 assert(updates.includes('id="session-attachments"'));assert(updates.includes('尚未发布'));
});

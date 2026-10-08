const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildReportCard,cardMarkdown,reportExcerpt}=require('./report-card.cjs');

test('report card keeps Markdown emphasis and tables in a wide card',()=>{
  const body='## 结论\n**可以使用**\n\n| 架构 | L1 | L2 |\n| --- | --- | --- |\n| Intel | 80KB | 2MB |';
  const card=buildReportCard({id:'aaaaaaaaaaaa',alias:'scratch',status:'completed',mode:'auto',lastMessage:body,threadId:'01a0ec2e-c33b-7770-b5f0-bb6788114e31'});
  assert.equal(card.schema,'2.0');
  assert.equal(card.config.width_mode,'fill');
  assert.equal(card.header.template,'green');
  assert.equal(card.body.elements[1].tag,'markdown');
  assert.match(card.body.elements[1].content,/\*\*结论\*\*/);
  assert.match(card.body.elements[1].content,/\| Intel \| 80KB \| 2MB \|/);
});

test('report card keeps the full saved conclusion and escapes card-native tags',()=>{
  const body='内容'.repeat(500)+'\n<at id=all></at>';
  const card=buildReportCard({id:'bbbbbbbbbbbb',alias:'a',status:'failed',lastMessage:body});
  assert.equal(card.header.template,'red');
  assert(card.body.elements[1].content.includes('内容'.repeat(500)));
  assert(!card.body.elements[1].content.includes('<at id=all>'));
  assert(card.body.elements[1].content.includes('&#60;at id=all&#62;'));
  assert.equal(cardMarkdown('```md\n## literal\n```\n## title'),'```md\n## literal\n```\n**title**');
});

test('long conclusion keeps its beginning and states the omitted length',()=>{
  const full='开头'+'.'.repeat(8100)+'末尾';
  const card=buildReportCard({id:'cccccccccccc',alias:'a',status:'completed',lastMessage:full});
  const content=card.body.elements[1].content;
  assert(content.startsWith('开头'));
  assert(!content.includes('末尾'));
  assert.match(content,/后续 \d+ 字未在卡片中展示/);
  assert.equal(reportExcerpt('**完整结论**'),'**完整结论**');
});

test('failure card shows the error beside any partial conclusion',()=>{
  const card=buildReportCard({id:'dddddddddddd',alias:'a',status:'failed',error:'network failure',lastMessage:'已完成部分调研'});
  assert.match(card.body.elements[1].content,/network failure/);
  assert.match(card.body.elements[1].content,/已完成部分调研/);
});

/* 临时测试脚本：用 BioTech案例 中的真实 BP 测试 bp-engine.js */
const fs = require('fs');
const path = require('path');

global.window = {};
require('./assets/bp-engine.js');
const BPEngine = global.window.BPEngine;

// 读取已提取的文本（由 read_file 工具提取后手动保存，或直接读取 txt）
const cases = [
  { name: 'BTK抑制剂示例', file: 'BTK抑制剂_商业计划书_示例.txt' },
  { name: '波睿达生物(CAR-T C轮)', file: 'BioTech案例/_extracted/波睿达生物.txt' },
  { name: '微影生物(器械·投资分析)', file: 'BioTech案例/_extracted/微影生物.txt' },
  { name: '华道生物(CAR-T pre-IPO)', file: 'BioTech案例/_extracted/华道生物.txt' }
];

cases.forEach(c => {
  const p = path.join(__dirname, c.file);
  if (!fs.existsSync(p)) { console.log('跳过（不存在）:', c.file); return; }
  const text = fs.readFileSync(p, 'utf8');
  const r = BPEngine.analyze(text);
  console.log('\n========== ' + c.name + ' ==========');
  console.log('字数:', text.length);
  console.log('四维得分:', JSON.stringify(r.scores), '| 总分:', r.total, '| 等级:', r.gradeText);
  console.log('抽取:', JSON.stringify(r.extracted));
  console.log('风险数:', r.risks.length, '| 建议数:', r.suggestions.length);
  console.log('扣分明细:');
  (r.penalties || []).forEach(p => console.log('  -[' + p.dim + '] -' + p.points + ' ' + p.reason));
});

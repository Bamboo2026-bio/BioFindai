/* 批量审计：对 BioTech案例/_extracted 下全部 BP 运行引擎，输出抽取结果与评分 */
const fs = require('fs');
const path = require('path');

global.window = {};
require('../assets/bp-engine.js');
const BPEngine = global.window.BPEngine;

const dir = path.join(__dirname, '..', 'BioTech案例', '_extracted');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt')).sort();

const rows = [];
files.forEach(f => {
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  const r = BPEngine.analyze(text);
  rows.push({
    file: f.replace(/\.txt$/, ''),
    chars: text.length,
    company: r.extracted.companyName,
    stage: r.extracted.stage,
    target: r.extracted.target,
    amount: r.extracted.financingAmount,
    valuation: r.extracted.valuation,
    scores: r.scores,
    total: r.total,
    grade: r.grade
  });
});

console.log('案例'.padEnd(34) + '字数'.padStart(7) + '  阶段'.padEnd(12) + '靶点'.padEnd(10) + '融资'.padEnd(10) + '估值'.padEnd(10) + '总分');
console.log('-'.repeat(120));
rows.forEach(r => {
  console.log(
    r.file.slice(0, 32).padEnd(34) +
    String(r.chars).padStart(7) + '  ' +
    String(r.stage).padEnd(12) +
    String(r.target).padEnd(10) +
    String(r.amount || '-').padEnd(10) +
    String(r.valuation || '-').padEnd(10) +
    r.total + '(' + r.grade + ')'
  );
});

console.log('\n=== 公司名抽取 ===');
rows.forEach(r => console.log(r.file.slice(0, 30).padEnd(32) + '→ ' + r.company));

// 异常检测
console.log('\n=== 异常检测 ===');
rows.forEach(r => {
  const issues = [];
  if (r.stage === '未识别') issues.push('阶段未识别');
  if (r.target === '未识别') issues.push('靶点未识别');
  if (!r.amount) issues.push('融资额未识别');
  if (!r.valuation) issues.push('估值未识别');
  if (r.company === '未识别' || r.company.length < 4) issues.push('公司名异常');
  if (issues.length) console.log(r.file.slice(0, 30).padEnd(32) + '⚠ ' + issues.join('、'));
});

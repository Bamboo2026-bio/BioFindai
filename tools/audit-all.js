/* 批量审计：对 BioTech案例/_extracted 下全部 BP 运行引擎，输出抽取结果与评分 */
const fs = require('fs');
const path = require('path');

global.window = {};
require('../assets/valuation-engine.js');
require('../assets/bp-engine.js');
const BPEngine = global.window.BPEngine;


const dir = path.join(__dirname, '..', 'BioTech案例', '_extracted');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt')).sort();

// 非药械赛道：本身不存在"靶点"概念，不应报靶点异常
const NON_TARGET_STAGES = ['非药械·食品', '非药械·材料', '非药械·消费品'];

// 靶点"不适用"：器械/平台型或非药械赛道，本身不存在药物靶点，属正常结果
const isTargetNA = t => typeof t === 'string' && t.indexOf('不适用') === 0;

// 融资额"未披露"判定：BP 全文确实没有任何"本轮融资需求"语境，属正常结果而非识别失败
// 注意：仅出现"完成种子轮/天使轮融资"等历史里程碑，不代表披露了本轮金额，仍应视为未披露
const FINANCING_NEED_CTX = /融资需求|融资金额|拟融资|本轮融资|融资规模|募集资金|融资额|融资计划|募资|投资额|本轮拟|拟募集/;
function isAmountUndisclosed(text) {
  return !FINANCING_NEED_CTX.test(text);
}



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
    valuationBasis: r.extracted.valuationBasis,
    valuationMethod: r.extracted.valuationMethod,
    valuationConfidence: r.extracted.valuationConfidence,
    valuationRange: r.extracted.valuationRange,
    scores: r.scores,
    amountUndisclosed: isAmountUndisclosed(text),


    total: r.total,
    grade: r.grade
  });
});

console.log('案例'.padEnd(34) + '字数'.padStart(7) + '  阶段'.padEnd(14) + '靶点'.padEnd(10) + '融资'.padEnd(10) + '估值'.padEnd(12) + '总分');
console.log('-'.repeat(130));
rows.forEach(r => {
  const val = r.valuation ? r.valuation + (r.valuationBasis === '原文披露' ? '' : '*') : '-';
  console.log(
    r.file.slice(0, 32).padEnd(34) +
    String(r.chars).padStart(7) + '  ' +
    String(r.stage).padEnd(14) +
    String(r.target).padEnd(10) +
    String(r.amount || '-').padEnd(10) +
    String(val).padEnd(12) +
    r.total + '(' + r.grade + ')'
  );
});
console.log('注：估值带 * 表示非原文披露（股权比例反推或多因子模型估算）');

console.log('\n=== 估值系统明细 ===');
rows.forEach(r => {
  const range = r.valuationRange ? ` [区间 ${r.valuationRange.low} ~ ${r.valuationRange.high}]` : '';
  console.log(
    r.file.slice(0, 26).padEnd(28) +
    String(r.valuation || '-').padEnd(10) +
    String(r.valuationMethod || '-').padEnd(16) +
    '置信度:' + String(r.valuationConfidence || '-').padEnd(5) +
    range
  );
});


console.log('\n=== 公司名抽取 ===');
rows.forEach(r => console.log(r.file.slice(0, 30).padEnd(32) + '→ ' + r.company));

// 异常检测
console.log('\n=== 异常检测 ===');
let issueCount = 0;
rows.forEach(r => {
  const issues = [];
  const isNonPharma = NON_TARGET_STAGES.includes(r.stage);
  if (r.stage === '未识别') issues.push('阶段未识别');
  // 靶点：非药械赛道 / 器械平台型（"不适用"）属正常结果，不计为异常
  if (r.target === '未识别' && !isNonPharma) issues.push('靶点未识别');
  // 融资额：BP 全文无融资语境 → "未披露"（正常）；有融资语境但未抽到 → "识别失败"（异常）
  if (!r.amount) issues.push(r.amountUndisclosed ? '融资额未披露' : '融资额识别失败');

  if (!r.valuation) issues.push('估值未识别');
  if (r.company === '未识别' || r.company.length < 4) issues.push('公司名异常');
  if (issues.length) { issueCount++; console.log(r.file.slice(0, 30).padEnd(32) + '⚠ ' + issues.join('、')); }
});
console.log(`\n共 ${rows.length} 个案例，${issueCount} 个存在待确认项`);

// 字段抽取覆盖率统计
const stat = (key, ok) => {
  const n = rows.filter(ok).length;
  return `${key}: ${n}/${rows.length} (${Math.round(n / rows.length * 100)}%)`;
};
console.log('\n=== 字段抽取覆盖率 ===');
console.log(stat('公司名', r => r.company && r.company !== '未识别'));
console.log(stat('临床阶段', r => r.stage !== '未识别'));
console.log(stat('靶点', r => r.target !== '未识别'));
console.log(stat('融资额', r => !!r.amount));
console.log(stat('估值', r => !!r.valuation));

/* 估值模型校准：用已知真实估值的案例回归检验模型误差
   用法：node tools/calibrate-valuation.js
   目标：MAPE（平均绝对百分比误差）< 50%，中位数误差 < 30%
*/
const fs = require('fs');
const path = require('path');

global.window = {};
require('../assets/valuation-engine.js');
require('../assets/bp-engine.js');
const V = global.window.ValuationEngine;
const BPEngine = global.window.BPEngine;

const dir = path.join(__dirname, '..', 'BioTech案例', '_extracted');

// 真实估值基准（亿元）：来自 BP 原文披露
const TRUTH = [
  { file: '波睿达生物.txt', actual: 16, note: 'C轮投前' },
  { file: '苏州泽霖生物制药有限公司Pre-A轮融资商业计划书(一).txt', actual: 2.0, note: 'Pre-A投前' },
  { file: '福沃药业简介.txt', actual: 8, note: '整体估值' },
  { file: '菲瑞药业.txt', actual: 8, note: 'B轮估值' },
  { file: '菲瑞药业商业计划书0513.txt', actual: 8, note: 'B轮估值' }
];

console.log('案例'.padEnd(26) + '实际'.padStart(8) + '模型'.padStart(10) + '误差'.padStart(10) + '  赛道/轮次/管线');
console.log('-'.repeat(90));

const errors = [];
TRUTH.forEach(t => {
  const p = path.join(dir, t.file);
  if (!fs.existsSync(p)) { console.log('跳过（文件不存在）: ' + t.file); return; }
  const text = fs.readFileSync(p, 'utf8');
  const r = BPEngine.analyze(text);
  const e = V.estimate({ text, stage: r.extracted.stage, hits: r.hits, amount: r.extracted.financingAmount });
  const err = (e.valueYi - t.actual) / t.actual;
  errors.push(Math.abs(err));
  console.log(
    t.file.slice(0, 24).padEnd(26) +
    (t.actual + '亿').padStart(8) +
    (e.valueYi + '亿').padStart(10) +
    ((err >= 0 ? '+' : '') + (err * 100).toFixed(0) + '%').padStart(10) +
    '  ' + e.factors.track + '/' + e.factors.round + '/' + e.factors.pipelineCount + '条'
  );
});

if (errors.length) {
  const mape = errors.reduce((a, b) => a + b, 0) / errors.length;
  const sorted = errors.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log('\nMAPE（平均绝对百分比误差）: ' + (mape * 100).toFixed(1) + '%');
  console.log('中位数误差: ' + (median * 100).toFixed(1) + '%');
  console.log(mape < 0.5 ? '✅ 模型校准达标（MAPE < 50%）' : '⚠️ 模型仍需校准（MAPE ≥ 50%）');
}

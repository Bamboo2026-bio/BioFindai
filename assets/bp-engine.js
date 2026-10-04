/* ============================================================
   BioFin 智投引擎 · BP 分析引擎 (bp-engine.js)
   ------------------------------------------------------------
   基于规则/关键词的轻量级 BP 文本分析引擎，用于 Demo 演示：
   - 从原始 BP 文本中抽取关键字段（公司、管线、临床、财务、融资、风险）
   - 依据 E3 评分模型（A30/B30/C20/D20）计算四维得分
   - 动态生成风险清单、详细诊断报告与改进建议

   说明：本引擎为前端演示用途，采用可解释的规则打分，
   不依赖后端大模型；真实产品中应由模块6/7的微调模型与RAG替代。
   ============================================================ */
(function (global) {
  'use strict';

  /* ----------------------------------------------------------
     评分维度定义（与模块20 E3 评分模型保持一致）
     ---------------------------------------------------------- */
  var DIMENSIONS = {
    framework: { key: 'framework', name: '基础框架评估', max: 30, weight: 0.30, icon: '📋' },
    pipeline:  { key: 'pipeline',  name: '管线深度诊断', max: 30, weight: 0.30, icon: '🧬' },
    capital:   { key: 'capital',   name: '资本逻辑校验', max: 20, weight: 0.20, icon: '💰' },
    risk:      { key: 'risk',      name: '风险控制评估', max: 20, weight: 0.20, icon: '⚠️' }
  };

  /* ----------------------------------------------------------
     关键词词典：用于识别 BP 中是否覆盖某类信息
     ---------------------------------------------------------- */
  var LEXICON = {
    // A 维度 · 内容质量
    company:    ['公司', '成立', '注册', '总部', '团队', '创始人', 'CEO', 'CTO', 'CSO', 'CMO'],
    market:     ['市场', '规模', '空间', 'CAGR', '复合增长', '患者', '发病率', '渗透率', '需求'],
    business:   ['商业模式', '盈利', '收入', '变现', 'BD', '授权', 'License', '合作', '渠道', '销售'],
    strategy:   ['战略', '规划', '里程碑', '发展', '路线', '目标', '布局'],
    // B 维度 · 技术实力
    pipeline:   ['管线', '靶点', '适应症', '临床', 'IND', 'NDA', 'I期', 'II期', 'III期', '临床前', '注册性'],
    clinical:   ['ORR', 'PFS', 'OS', 'DCR', 'DOR', 'AE', '安全性', '有效性', '样本量', '终点', '入组', '随机'],
    tech:       ['差异化', '首创', 'first-in-class', 'best-in-class', '选择性', '机制', '平台', '专利', 'FTO', '知识产权'],
    // C 维度 · 融资方案
    valuation:  ['估值', 'rNPV', 'DCF', '可比', '投前', '投后', 'PS', 'PE'],
    financing:  ['融资', '轮', '金额', '稀释', '股权', '投资', '亿元', '万元', 'IPO', '18A'],
    funduse:    ['资金用途', '资金使用', '用途', '研发投入', '临床推进', '产能', '运营', '储备'],
    // D 维度 · 风险控制
    compliance: ['合规', '风险', '监管', '法规', '广告法', '披露', '资质', 'GCP', 'GLP', 'GMP'],
    cashflow:   ['现金流', '现金', '跑道', '烧钱', '亏损', '资金链', '储备', '融资断档'],
    rdrisk:     ['研发失败', '失败率', '不确定性', '竞争', '集采', '医保', '政策', '附条件']
  };

  /* ----------------------------------------------------------
     风险表述检测：绝对化/违规用语
     ---------------------------------------------------------- */
  var RISKY_PHRASES = [
    { re: /治愈|根治|彻底治愈|100%有效|保证上市|承诺回报|稳赚|无风险/g, level: 'high', title: '合规风险：绝对化/承诺性表述', desc: 'BP中出现"治愈""根治""保证上市""承诺回报"等绝对化或承诺性表述，涉嫌违反《广告法》及药品宣传规范，可能影响融资尽调与上市审核。' },
    { re: /全球首创|世界第一|唯一|独家垄断/g, level: 'mid', title: '合规风险：夸大性表述', desc: 'BP中出现"全球首创""世界第一""唯一"等夸大性表述，若缺乏权威认证或临床数据支撑，可能引发合规质疑。' }
  ];

  /* ----------------------------------------------------------
     工具函数
     ---------------------------------------------------------- */
  function countHits(text, words) {
    var n = 0;
    for (var i = 0; i < words.length; i++) {
      if (text.indexOf(words[i]) !== -1) n++;
    }
    return n;
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  // 从文本中提取融资相关金额（优先匹配"融资/募资/拟融资…X亿元"语境）
  function extractAmount(text, unitWords) {
    // 优先：带融资语境的金额
    var ctxRe = /(?:融资|募资|拟融资|募集|本轮|投资额|融资金额)[^。\n]{0,15}?([0-9][0-9,\.]*)\s*(亿元|万元|亿|万)/;
    var cm = text.match(ctxRe);
    if (cm) return cm[1].replace(/,/g, '') + cm[2];
    // 兜底：任意金额，但排除"销售额/收入/营收/费用/成本"等非融资语境
    for (var i = 0; i < unitWords.length; i++) {
      var re = new RegExp('([0-9][0-9,\\.]*)\\s*' + unitWords[i], 'g');
      var m;
      while ((m = re.exec(text)) !== null) {
        var start = Math.max(0, m.index - 12);
        var ctx = text.slice(start, m.index);
        if (/销售额|收入|营收|费用|成本|亏损|利润|市值|价格|费用/.test(ctx)) continue;
        return m[1].replace(/,/g, '') + unitWords[i];
      }
    }
    return null;
  }

  /* ----------------------------------------------------------
     核心：分析 BP 文本
     返回 { scores, total, grade, gradeText, risks, reports, suggestions, extracted }
     ---------------------------------------------------------- */
  function analyze(rawText) {
    var text = String(rawText || '');
    var len = text.length;

    // ---------- 1. 各维度关键词命中统计 ----------
    var hits = {};
    Object.keys(LEXICON).forEach(function (k) {
      hits[k] = countHits(text, LEXICON[k]);
    });

    // ---------- 2. 抽取关键字段 ----------
    var extracted = {
      companyName: (text.match(/([\u4e00-\u9fa5A-Za-z0-9]{2,20}(?:生物|医药|医疗|制药|科技|健康)[\u4e00-\u9fa5A-Za-z0-9]{0,10}(?:有限公司|股份有限公司|集团)?)/) || [])[1] || '未识别',
      financingAmount: extractAmount(text, ['亿元', '万元']),
      valuation: (text.match(/(?:投前|投后|估值|市值)[^。\n]{0,20}?([0-9][0-9,\\.]*\s*[亿万]元)/) || [])[1] || null,
      stage: (text.match(/(临床前|临床I期|临床II期|临床III期|I期|II期|III期|已上市|已获批|IND|NDA)/) || [])[1] || '未识别',
      target: (text.match(/(PD-?1|PD-?L1|BTK|HER2|EGFR|CLDN18\.2|TROP2|CD19|CD20|VEGF|ALK|FGFR|TRK)/i) || [])[1] || '未识别',
      chars: len
    };

    // ---------- 3. 四维打分 ----------
    var scores = {};

    // A · 内容质量（30分）：公司/市场/商业/战略 覆盖度 + 篇幅
    var aCoverage = (hits.company > 0 ? 1 : 0) + (hits.market > 0 ? 1 : 0) +
                    (hits.business > 0 ? 1 : 0) + (hits.strategy > 0 ? 1 : 0);
    var aBase = aCoverage * 5;                       // 最多 20
    var aDepth = clamp(Math.round((hits.company + hits.market + hits.business + hits.strategy) / 2), 0, 6); // 最多 6
    var aLength = len > 3000 ? 4 : len > 1500 ? 3 : len > 600 ? 2 : len > 200 ? 1 : 0; // 最多 4
    scores.framework = clamp(aBase + aDepth + aLength, 0, 30);

    // B · 技术实力（30分）：管线/临床/技术 覆盖度
    var bCoverage = (hits.pipeline > 0 ? 1 : 0) + (hits.clinical > 0 ? 1 : 0) + (hits.tech > 0 ? 1 : 0);
    var bBase = bCoverage * 6;                       // 最多 18
    var bDepth = clamp(Math.round((hits.pipeline + hits.clinical + hits.tech) / 2), 0, 12); // 最多 12
    scores.pipeline = clamp(bBase + bDepth, 0, 30);

    // C · 融资方案（20分）：估值/融资/资金用途 覆盖度
    var cCoverage = (hits.valuation > 0 ? 1 : 0) + (hits.financing > 0 ? 1 : 0) + (hits.funduse > 0 ? 1 : 0);
    var cBase = cCoverage * 4;                       // 最多 12
    var cDepth = clamp(Math.round((hits.valuation + hits.financing + hits.funduse) / 2), 0, 8); // 最多 8
    scores.capital = clamp(cBase + cDepth, 0, 20);

    // D · 风险控制（20分）：合规/现金流/研发风险 覆盖度（覆盖越全，风险控制越好）
    var dCoverage = (hits.compliance > 0 ? 1 : 0) + (hits.cashflow > 0 ? 1 : 0) + (hits.rdrisk > 0 ? 1 : 0);
    var dBase = dCoverage * 4;                       // 最多 12
    var dDepth = clamp(Math.round((hits.compliance + hits.cashflow + hits.rdrisk) / 2), 0, 8); // 最多 8
    scores.risk = clamp(dBase + dDepth, 0, 20);

    // ---------- 4. 综合评分与等级 ----------
    var total = scores.framework + scores.pipeline + scores.capital + scores.risk;
    var grade, gradeText;
    if (total >= 85) { grade = 'A'; gradeText = 'A级 · 优秀'; }
    else if (total >= 70) { grade = 'B'; gradeText = 'B级 · 良好'; }
    else if (total >= 55) { grade = 'C'; gradeText = 'C级 · 一般'; }
    else { grade = 'D'; gradeText = 'D级 · 待改进'; }

    // ---------- 5. 风险清单 ----------
    var risks = [];
    RISKY_PHRASES.forEach(function (rp) {
      var m = text.match(rp.re);
      if (m) {
        risks.push({
          level: rp.level,
          title: rp.title,
          desc: rp.desc + '（命中：' + Array.from(new Set(m)).slice(0, 5).join('、') + '）',
          loc: '全文检索'
        });
      }
    });
    if (hits.cashflow === 0) {
      risks.push({ level: 'high', title: '现金流风险：未披露现金跑道', desc: 'BP中未提及现金流、现金跑道或烧钱率等关键财务指标，无法评估资金链安全性，建议补充18个月现金跑道测算。', loc: '财务章节' });
    }
    if (hits.valuation === 0) {
      risks.push({ level: 'mid', title: '估值依据缺失', desc: 'BP中未提供rNPV/DCF估值模型或可比交易依据，估值合理性无法验证。', loc: '融资章节' });
    }
    if (hits.tech === 0 || text.indexOf('FTO') === -1) {
      risks.push({ level: 'mid', title: '知识产权风险：缺少FTO分析', desc: 'BP未提供完整的FTO（自由实施）分析报告或专利布局图，存在潜在知识产权纠纷风险。', loc: '知识产权章节' });
    }
    if (hits.clinical === 0) {
      risks.push({ level: 'mid', title: '临床数据不足', desc: 'BP中缺少ORR/PFS/OS等关键疗效指标或安全性数据，难以评估管线价值。', loc: '临床章节' });
    }
    if (hits.compliance === 0) {
      risks.push({ level: 'low', title: '合规披露不完整', desc: 'BP中未系统披露合规资质（如GCP/GLP/GMP）与监管风险，建议补充。', loc: '合规章节' });
    }
    if (risks.length === 0) {
      risks.push({ level: 'low', title: '未发现明显风险点', desc: '基于关键词规则扫描，未发现明显合规或结构性风险，建议结合人工尽调进一步核实。', loc: '全文检索' });
    }

    // ---------- 6. 详细诊断报告 ----------
    var reports = {
      framework: [
        { tag: hits.company > 0 ? 'good' : 'bad', title: '公司概况', content: '公司信息覆盖度：' + (hits.company > 0 ? '已包含公司名称、团队、成立信息等' : '缺失公司基本信息') + '。', suggestion: hits.company > 0 ? null : '建议补充公司概况、核心团队背景与股权结构。' },
        { tag: hits.market > 0 ? 'good' : 'warn', title: '市场分析', content: '市场信息覆盖度：' + (hits.market > 0 ? '已包含市场规模、患者群体、增长预测等' : '市场分析较薄弱') + '。', suggestion: hits.market > 0 ? null : '建议补充市场规模、CAGR、目标患者群体与渗透率预测。' },
        { tag: hits.business > 0 ? 'good' : 'warn', title: '商业模式', content: '商业模式覆盖度：' + (hits.business > 0 ? '已说明收入来源与变现路径' : '商业模式阐述不足') + '。', suggestion: hits.business > 0 ? null : '建议补充BD合作、授权许可等变现路径。' },
        { tag: hits.strategy > 0 ? 'good' : 'warn', title: '发展战略', content: '战略规划覆盖度：' + (hits.strategy > 0 ? '已包含发展战略与里程碑规划' : '缺少清晰的战略与里程碑') + '。', suggestion: hits.strategy > 0 ? null : '建议补充未来18-24个月的关键里程碑。' }
      ],
      pipeline: [
        { tag: hits.pipeline > 0 ? 'good' : 'bad', title: '管线布局', content: '管线信息覆盖度：' + (hits.pipeline > 0 ? '已包含靶点、适应症、临床阶段等' : '缺少管线布局信息') + '。', suggestion: hits.pipeline > 0 ? null : '建议补充管线代号、靶点、适应症与临床阶段。' },
        { tag: hits.clinical > 0 ? 'good' : 'warn', title: '临床数据', content: '临床数据覆盖度：' + (hits.clinical > 0 ? '已包含疗效/安全性关键指标' : '缺少关键临床数据') + '。', suggestion: hits.clinical > 0 ? null : '建议补充ORR、PFS、OS等疗效指标与安全性数据。' },
        { tag: hits.tech > 0 ? 'good' : 'warn', title: '技术差异化与专利', content: '技术壁垒覆盖度：' + (hits.tech > 0 ? '已说明技术差异化与知识产权布局' : '技术差异化与专利布局不足') + '。', suggestion: hits.tech > 0 ? null : '建议补充技术差异化证据、FTO分析与专利布局图。' }
      ],
      capital: [
        { tag: hits.valuation > 0 ? 'good' : 'bad', title: '估值合理性', content: '估值依据覆盖度：' + (hits.valuation > 0 ? '已提供估值模型或可比依据' : '未提供估值依据') + '。', suggestion: hits.valuation > 0 ? null : '建议补充rNPV/DCF估值模型与可比交易对标。' },
        { tag: hits.financing > 0 ? 'good' : 'warn', title: '融资金额与稀释', content: '融资条款覆盖度：' + (hits.financing > 0 ? '已说明融资轮次、金额与稀释比例' : '融资条款不完整') + '。', suggestion: hits.financing > 0 ? null : '建议补充融资轮次、金额、投前/投后估值与稀释比例。' },
        { tag: hits.funduse > 0 ? 'good' : 'warn', title: '资金使用计划', content: '资金用途覆盖度：' + (hits.funduse > 0 ? '已说明资金用途分配' : '资金使用计划缺失') + '。', suggestion: hits.funduse > 0 ? null : '建议补充资金用途明细表与里程碑对应关系。' }
      ]
    };

    // ---------- 7. 改进建议 ----------
    var suggestions = [];
    if (hits.valuation === 0) suggestions.push('补充rNPV/DCF估值模型测算过程，提供可比交易对标数据，增强估值说服力');
    if (hits.cashflow === 0) suggestions.push('补充18个月现金跑道测算与融资断档应急预案');
    if (hits.tech === 0 || text.indexOf('FTO') === -1) suggestions.push('补充FTO分析报告与专利布局图，降低知识产权风险');
    if (hits.clinical === 0) suggestions.push('补充关键疗效数据（ORR、PFS、OS）与安全性数据');
    if (hits.business === 0) suggestions.push('补充BD合作策略与潜在合作伙伴分析，完善商业模式章节');
    if (hits.market === 0) suggestions.push('补充市场规模、CAGR、目标患者群体与渗透率预测');
    if (hits.compliance === 0) suggestions.push('补充合规资质（GCP/GLP/GMP）与监管风险披露');
    if (hits.strategy === 0) suggestions.push('补充未来18-24个月的关键里程碑规划');
    RISKY_PHRASES.forEach(function (rp) {
      if (rp.re.test(text)) suggestions.push('删除或修改绝对化/承诺性表述，确保合规宣传');
    });
    if (suggestions.length === 0) suggestions.push('BP整体质量较高，建议结合人工尽调进一步核实关键数据');

    // 去重
    suggestions = Array.from(new Set(suggestions));

    return {
      scores: scores,
      total: total,
      grade: grade,
      gradeText: gradeText,
      risks: risks,
      reports: reports,
      suggestions: suggestions,
      extracted: extracted,
      hits: hits
    };
  }

  /* ----------------------------------------------------------
     导出
     ---------------------------------------------------------- */
  global.BPEngine = {
    DIMENSIONS: DIMENSIONS,
    LEXICON: LEXICON,
    analyze: analyze
  };
})(window);

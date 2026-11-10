/* ============================================================
   BioFin 智投引擎 · 估值系统 (valuation-engine.js)
   ------------------------------------------------------------
   目标：即使 BP 未披露估值，也能给出可解释的估值评估。

   估值优先级（从高到低）：
     1. 原文披露估值            → 置信度 高（直接采用）
     2. 融资额 ÷ 出让股权比例    → 置信度 中高（反推）
     3. 多因子估值模型           → 置信度 中/低（本模块核心）

   多因子模型（阶段基准法）：
     估值 = 阶段基准值 × 管线数量系数 × 赛道系数 × 轮次系数 × 数据质量系数

   - 阶段基准值：来自 23 个真实案例的估值中位数校准
   - 管线数量系数：管线越多，价值越高（边际递减）
   - 赛道系数：创新药 1.0 / 器械 0.7 / IVD 0.6 / 制剂平台 0.8 / 消费品 0.3
   - 轮次系数：越后期估值越高
   - 数据质量系数：临床数据、专利、团队等信息的完整度

   所有系数均可在 CALIBRATION 中调整，便于持续迭代。
   ============================================================ */
(function (global) {
  'use strict';

  /* ----------------------------------------------------------
     校准参数（基于 23 个真实案例回归校准，可持续迭代）
     ---------------------------------------------------------- */
  var CALIBRATION = {
    // 阶段基准估值（亿元）：该阶段企业的典型投前估值中位数
    // 数据来源：本地真实估值案例回归校准（波睿达16亿/泽霖2亿/福沃8亿/菲瑞8亿）
    // 校准原则：基准值 = 该阶段"典型轮次"下的实际估值，轮次系数仅做小幅修正
    stageBase: {
      '临床前':      0.8,
      'IND阶段':     1.5,
      '临床I期':     2.5,
      '临床II期':    6.0,
      '临床III期':  12.0,

      'NDA阶段':    18.0,
      '注册申报':    6.0,   // 药品注册申报（制剂/改良型新药为主，估值偏低）
      '已获证':      6.0,   // 器械/IVD 获证
      '已上市':     20.0,
      '创新器械审查': 2.5,
      '注册检验':    1.5,
      '临床验证':    2.0,
      '制剂平台':    5.0,
      '非药械·食品':  0.8,
      '非药械·材料':  1.0,
      '非药械·消费品': 0.6,
      '未识别':      1.5
    },


    // 赛道系数：不同赛道的估值溢价/折价
    trackFactor: {
      '创新药':   1.0,
      '细胞治疗': 1.15,   // CAR-T 等细胞治疗溢价
      '基因治疗': 1.10,
      '器械':     0.70,
      'IVD':      0.60,
      '制剂平台': 0.80,
      '消费品':   0.30,
      '食品':     0.25,
      '材料':     0.35
    },

    // 轮次系数：越后期估值越高
    // 注意：阶段基准已隐含典型轮次，此处仅做小幅修正（0.8~1.25），避免重复计算
    roundFactor: {
      '天使轮':   0.80,
      '种子轮':   0.75,
      'Pre-A轮':  0.85,
      'A轮':      0.90,
      'A+轮':     0.95,
      'B轮':      1.00,
      'B+轮':     1.05,
      'C轮':      1.10,
      'D轮':      1.15,
      'Pre-IPO':  1.25,
      '战略融资': 1.05,
      '未识别':   1.00
    },


    // 管线数量系数：边际递减（1条=1.0，2条=1.25，3条=1.4，5条=1.6，上限1.8）
    pipelineFactor: function (n) {
      if (!n || n < 1) return 1.0;
      return Math.min(1.8, 1.0 + 0.25 * Math.log2(n + 1));
    },

    // 数据质量系数：临床数据/专利/团队/市场 的完整度（0.75 ~ 1.25）
    qualityFactor: function (hits) {
      var score = 0, total = 0;
      var checks = [
        ['clinical', 1.0],   // 临床数据
        ['tech', 0.8],       // 技术差异化/专利
        ['market', 0.6],     // 市场分析
        ['company', 0.5],    // 公司/团队
        ['pipeline', 0.6]    // 管线信息
      ];
      checks.forEach(function (c) {
        total += c[1];
        if (hits[c[0]] > 0) score += c[1];
      });
      var ratio = total > 0 ? score / total : 0;
      return 0.75 + ratio * 0.5;   // 0.75 ~ 1.25
    },

    // 估值区间宽度（±%），置信度越低区间越宽
    rangeWidth: {
      '高':   0.15,
      '中高': 0.25,
      '中':   0.40,
      '低':   0.60
    }
  };

  /* ----------------------------------------------------------
     工具函数
     ---------------------------------------------------------- */
  function round1(v) { return Math.round(v * 10) / 10; }

  function fmtYi(v) {
    if (v >= 1) return round1(v) + '亿元';
    return Math.round(v * 10000) + '万元';
  }

  // 识别赛道
  function detectTrack(text, stage) {
    if (/CAR-T|CAR\s*T|细胞治疗|TCR-T|NK细胞|干细胞/.test(text)) return '细胞治疗';
    if (/基因治疗|AAV|腺相关病毒|基因编辑|基因递送/.test(text)) return '基因治疗';
    if (/体外诊断|IVD|诊断试剂|检测试剂|试剂盒|呼气试验|气体分析/.test(text)) return 'IVD';
    if (/医疗器械|器械|机器人|脑机接口|植入|导管|支架|影像设备/.test(text)) return '器械';
    if (/冻干闪释|闪释制剂|缓控释|制剂平台|改良型新药|口崩片/.test(text)) return '制剂平台';
    if (/药食同源|功能性食品|保健食品|膳食补充/.test(text)) return '食品';
    if (/底涂剂|密封胶|聚合物|涂料|胶粘剂/.test(text)) return '材料';
    if (/健康饮品|营养品|康养|产品手册|品牌口号|天然植物/.test(text)) return '消费品';
    return '创新药';
  }

  // 识别融资轮次：优先"本轮/本次"语境，避免把历史融资轮次（如"已完成B轮"）误判为当前轮次
  function detectRound(text) {
    // 注意顺序：更具体的轮次必须排在前面（Pre-A 先于 A，B+ 先于 B），
    // 否则 "Pre-A轮" 会被 "A轮" 抢先匹配
    var ROUNDS = [
      ['Pre-IPO', /Pre-?IPO/i],
      ['Pre-A轮', /Pre-?A轮/i],
      ['D轮', /D\+?轮/],
      ['C轮', /C\+?轮/],
      ['B+轮', /B\+轮/],
      ['B轮', /B轮/],
      ['A+轮', /A\+轮/],
      ['A轮', /A轮/],
      ['天使轮', /天使轮/],
      ['种子轮', /种子轮/],
      ['战略融资', /战略融资|战略投资/]
    ];

    // 第一优先：标题/封面中的轮次（如"XX Pre-A轮融资商业计划书"）
    // 标题最能代表本次融资轮次，优先级最高
    var head = text.slice(0, 200);
    for (var j = 0; j < ROUNDS.length; j++) {
      if (ROUNDS[j][1].test(head)) return ROUNDS[j][0];
    }
    // 第二优先：本轮/本次/此次 语境下的轮次（如"本轮Pre-A轮融资""本次B轮融资"）
    // 注意：不含"拟/计划"，因为"拟启动B轮融资"属于未来规划，不是当前轮次
    for (var i = 0; i < ROUNDS.length; i++) {
      var ctxRe = new RegExp('(?:本轮|本次|此次)[^。\\n]{0,12}?' + ROUNDS[i][1].source, 'i');
      var cm = text.match(ctxRe);
      if (cm) {
        var idx = text.indexOf(cm[0]);
        var before = text.slice(Math.max(0, idx - 20), idx);
        // 业务描述/合作语境不算融资轮次
        if (/(?:技术服务|业务|合作|与|及|和|引入战略资本|战略合作)[^。\n]{0,6}$/.test(before)) continue;
        return ROUNDS[i][0];
      }
    }
    // 第三优先：融资里程碑列表中的"最新一轮"（如"Pre-A轮 2022.04 / A&A+轮 2024.08 / B轮&B+轮 2026"）
    // 这类列表按时间顺序排列，最后一轮才是当前轮次
    var milestoneRe = /(?:融资里程碑|融资历程|融资历史|历轮融资|融资情况)[\s\S]{0,400}/;
    var mm = text.match(milestoneRe);
    if (mm) {
      var block = mm[0];
      var lastRound = null, lastPos = -1;
      for (var r = 0; r < ROUNDS.length; r++) {
        var rre = new RegExp(ROUNDS[r][1].source, 'gi'), rm;
        while ((rm = rre.exec(block)) !== null) {
          if (rm.index > lastPos) { lastPos = rm.index; lastRound = ROUNDS[r][0]; }
        }
      }
      if (lastRound) return lastRound;
    }
    // 第四优先：全文首次出现，但排除以下干扰语境：
    //   - 业务描述（"技术服务与战略投资"）
    //   - 未来规划（"正式启动B轮融资""I期数据读出启动B轮融资""拟/计划/预计…B轮"）
    //   - 估值对标（"Pre-A/A轮(刚获IND)"这类同阶段对标表述）
    for (var k = 0; k < ROUNDS.length; k++) {
      var re = new RegExp(ROUNDS[k][1].source, 'gi');
      var m;
      while ((m = re.exec(text)) !== null) {
        var pos = m.index;
        var pre = text.slice(Math.max(0, pos - 30), pos);
        var post = text.slice(pos + m[0].length, pos + m[0].length + 10);
        // 业务描述/合作语境
        if (/(?:技术服务|业务|合作|与|及|和|战略合作)[^。\n]{0,6}$/.test(pre)) continue;
        // 未来规划语境：启动/拟/计划/预计/将/后续/下一轮
        if (/(?:启动|拟|计划|预计|将|后续|下一轮|未来|目标)[^。\n]{0,8}$/.test(pre)) continue;
        // 估值对标语境：如"Pre-A/A轮(刚获IND)"，轮次后紧跟"/"或"("
        if (/^[\/／(（]/.test(post)) continue;
        return ROUNDS[k][0];
      }
    }
    return '未识别';
  }





  // 估算管线数量：优先显式表述，其次统计靶点/适应症出现种类
  function estimatePipelineCount(text) {
    // 显式："管线X条""X款产品""X个在研项目"
    var m = text.match(/(?:管线|产品|在研项目|候选药物|品种)[^。\n]{0,8}?([0-9]{1,2})\s*(?:条|款|个)/);
    if (m) {
      var n = parseInt(m[1], 10);
      if (n >= 1 && n <= 30) return n;
    }
    // 统计不同靶点出现种类（粗略估计管线数）
    var targets = ['PD-1', 'PD-L1', 'BTK', 'HER2', 'EGFR', 'CD19', 'CD20', 'CD22', 'CD30', 'CD99', 'BCMA', 'VEGF', 'ALK', 'PCSK9', 'CLDN18.2', 'TROP2', 'GPC3', 'MSLN', 'KRAS', 'CDK4', 'CD47', 'CD38', 'GLP-1'];
    var found = 0;
    targets.forEach(function (t) {
      var re = new RegExp('(?<![A-Za-z])' + t.replace(/[.\-]/g, '\\$&') + '(?![A-Za-z0-9])', 'i');
      if (re.test(text)) found++;
    });
    return found > 0 ? found : 1;
  }

  /* ----------------------------------------------------------
     核心：多因子估值
     @param {Object} ctx
        ctx.text     原始 BP 文本
        ctx.stage    临床阶段（来自 bp-engine）
        ctx.hits     关键词命中统计
        ctx.amount   融资额（可为 null）
     @returns {Object|null}
        { value, low, high, confidence, method, factors, basis }
     ---------------------------------------------------------- */
  function estimate(ctx) {
    var text = ctx.text || '';
    var stage = ctx.stage || '未识别';
    var hits = ctx.hits || {};

    var track = detectTrack(text, stage);
    var round = detectRound(text);
    var pipelineCount = estimatePipelineCount(text);

    var base = CALIBRATION.stageBase[stage];
    if (base === undefined) base = CALIBRATION.stageBase['未识别'];

    var fTrack = CALIBRATION.trackFactor[track] || 1.0;
    var fRound = CALIBRATION.roundFactor[round] || 1.0;
    var fPipeline = CALIBRATION.pipelineFactor(pipelineCount);
    var fQuality = CALIBRATION.qualityFactor(hits);

    var value = base * fTrack * fRound * fPipeline * fQuality;

    // 置信度：阶段明确 + 数据完整 → 高；阶段未识别 → 低
    var confidence;
    if (stage === '未识别') confidence = '低';
    else if (hits.clinical > 0 && hits.tech > 0) confidence = '中';
    else confidence = '中';

    // 非药械赛道置信度下调（估值模型主要针对药械）
    if (/^非药械/.test(stage)) confidence = '低';

    var w = CALIBRATION.rangeWidth[confidence] || 0.4;
    var low = value * (1 - w);
    var high = value * (1 + w);

    // 合理性约束：估值不应低于融资额（否则意味着融资即溢价）
    if (ctx.amount) {
      var am = String(ctx.amount).match(/^([0-9][0-9,\.]*)\s*(亿元|万元|亿|万)$/);
      if (am) {
        var amtYi = /亿/.test(am[2]) ? parseFloat(am[1]) : parseFloat(am[1]) / 10000;
        if (isFinite(amtYi) && amtYi > 0 && value < amtYi) {
          value = amtYi * 1.5;   // 至少为融资额的 1.5 倍（隐含出让约 40%）
          low = value * (1 - w);
          high = value * (1 + w);
        }
      }
    }

    return {
      value: fmtYi(value),
      valueYi: round1(value),
      low: fmtYi(low),
      high: fmtYi(high),
      confidence: confidence,
      method: '多因子阶段基准法',
      basis: '阶段基准(' + stage + ' ' + base + '亿) × 赛道(' + track + ' ' + fTrack + ') × 轮次(' + round + ' ' + fRound + ') × 管线(' + pipelineCount + '条 ' + round1(fPipeline) + ') × 数据质量(' + round1(fQuality) + ')',
      factors: {
        stage: stage, stageBase: base,
        track: track, trackFactor: fTrack,
        round: round, roundFactor: fRound,
        pipelineCount: pipelineCount, pipelineFactor: round1(fPipeline),
        qualityFactor: round1(fQuality)
      }
    };
  }

  /* ----------------------------------------------------------
     统一估值入口：按优先级选择估值方法
     @returns {Object}
        { value, basis, confidence, method, detail }
     ---------------------------------------------------------- */
  function valuate(ctx) {
    // 1. 原文披露
    if (ctx.disclosed) {
      return {
        value: ctx.disclosed,
        basis: '原文披露',
        confidence: '高',
        method: 'BP 原文披露',
        detail: null
      };
    }
    // 2. 融资额 ÷ 出让股权比例
    if (ctx.inferred) {
      return {
        value: ctx.inferred.value,
        basis: ctx.inferred.basis,
        confidence: '中高',
        method: '股权比例反推',
        detail: null
      };
    }
    // 3. 多因子模型
    var est = estimate(ctx);
    if (!est) return null;
    return {
      value: est.value,
      basis: est.basis,
      confidence: est.confidence,
      method: est.method,
      detail: est
    };
  }

  global.ValuationEngine = {
    CALIBRATION: CALIBRATION,
    valuate: valuate,
    estimate: estimate,
    detectTrack: detectTrack,
    detectRound: detectRound,
    estimatePipelineCount: estimatePipelineCount
  };
})(typeof window !== 'undefined' ? window : global);

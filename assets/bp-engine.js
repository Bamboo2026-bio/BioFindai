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

  // 非融资语境关键词：市场规模、财务预测、成本等，避免误取
  var NON_FINANCING_CTX = /销售额|销售收入|销售|收入|营收|费用|成本|亏损|利润|净利润|市值|价格|定价|治疗|支付|医保|产能|产量|单价|市场规模|市场空间|万亿|千亿|亿美元|研发投入|预算|估值|检测|订单|合同额/;


  // 从文本中提取融资相关金额（优先匹配"融资/募资/拟融资…X亿元"语境）
  function extractAmount(text, unitWords) {
    // 优先：美元缩写格式（如"$250M""$32M"），因其更明确指向融资轮次
    var usdM = text.match(/(?:本轮|PRE-IPO轮|Pre-IPO轮|C轮|B轮|A轮)[^。\n]{0,10}?\$\s*([0-9][0-9,\.]*)\s*[Mm]/);
    if (usdM) return '$' + usdM[1].replace(/,/g, '') + 'M';
    // 优先：带融资语境的金额（支持"拟3-5亿""融资3亿元"等，含区间写法）
    var ctxRe = /(?:融资|募资|拟融资|募集|本轮|投资额|融资金额|拟)[^。\n]{0,15}?([0-9][0-9,\.]*)\s*(?:[-~至]\s*[0-9][0-9,\.]*\s*)?(亿元|万元|亿|万)/;
    var cm = text.match(ctxRe);
    if (cm) return cm[1].replace(/,/g, '') + cm[2];
    // 跨行/跨图表：PPT 提取后"B轮&B+轮融资需求"与"1.5亿元人民币"常被图表数据隔开
    // 策略：在融资关键词后 200 字符窗口内，取第一个"干净"的金额（排除市场规模/财务预测）
    var kwRe = /(?:融资需求|融资金额|拟融资|本轮融资|融资规模|募集资金|融资额|融资计划|B轮|A轮|C轮|Pre-IPO|天使轮)/g, km;
    while ((km = kwRe.exec(text)) !== null) {
      // 窗口扩大到 400 字符：PPT 提取后图表数据（坐标轴/图例）可能占据大量篇幅
      var win = text.slice(km.index, km.index + 400);
      // 逐行扫描：跳过图表中的纯数字行（如"-20,000""100,000"），只取带单位且语境干净的金额
      var lines = win.split('\n');
      var fallback = null;
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        // 跳过 PPT 图表坐标轴/数据标签行：数字被空格拆散（如"8 3 . 0 2亿""1 0 ～20 亿"）
        if (/[0-9]\s+[0-9]/.test(line)) continue;
        var am = line.match(/([0-9][0-9,\.]*)\s*(亿元|万元|亿|万)/);
        if (am) {
          // 语境判断只看"当前行"：PPT 图表中"销售收入、研发投入、净利润"常是图例，
          // 与下一行的融资金额并无语义关联，不能跨行排除
          if (!NON_FINANCING_CTX.test(line)) {
            var val = am[1].replace(/,/g, '') + am[2];
            // 最高优先级：资金用途行（如"900万元用于将研发管线推进IND"），这是融资总额的拆分
            if (/用于|用途|投入|分配/.test(line)) return val;
            // 次优先：带"人民币"或"元"的明确金额（如"1.5亿元人民币"）
            if (/人民币|元/.test(line)) return val;
            if (!fallback) fallback = val;
          }
        }
      }
      if (fallback) return fallback;


    }


    // 美元融资（如"累计募集资金> 8,000万美元"）
    var usd = text.match(/(?:融资|募集|累计募集)[^。\n]{0,15}?([0-9][0-9,\.]*)\s*(?:万)?美元/);
    if (usd) return usd[1].replace(/,/g, '') + '万美元';
    // 兜底：任意美元缩写格式
    usdM = text.match(/\$\s*([0-9][0-9,\.]*)\s*[Mm]/);
    if (usdM) return '$' + usdM[1].replace(/,/g, '') + 'M';
    // 兜底：任意金额，但排除"销售额/收入/营收/费用/成本/定价/治疗"等非融资语境
    for (var i = 0; i < unitWords.length; i++) {
      var re = new RegExp('([0-9][0-9,\\.]*)\\s*' + unitWords[i], 'g');
      var m;
      while ((m = re.exec(text)) !== null) {
        var start = Math.max(0, m.index - 15);
        var ctx = text.slice(start, m.index);
        if (NON_FINANCING_CTX.test(ctx)) continue;
        return m[1].replace(/,/g, '') + unitWords[i];
      }
    }
    return null;
  }


  // 判断某公司名出现位置是否属于"干扰语境"（创始人履历/前雇主/奖项/客户/竞品）
  // 典型干扰："任新绎健康管理有限公司（新奥集团）CEO""连续7年荣获美国制药界…奖"
  function isNoiseCompanyContext(text, index, name) {
    var before = text.slice(Math.max(0, index - 40), index);
    var after = text.slice(index + name.length, index + name.length + 20);
    // 前文：任职/履历/奖项/客户/竞品/合作方/投资方
    if (/(?:任|曾任|就职于|就职|供职|加入|毕业于|创始人|联合创始人|CEO|CTO|CSO|CMO|COO|董事长|总经理|总监|合伙人|顾问|团队|履历|经历|背景|曾于|曾在|来自|原)[^。\n]{0,12}$/.test(before)) return true;
    if (/(?:荣获|获得|获评|入选|评为|授予|颁发|奖|称号|认证|客户|供应商|合作方|竞品|对标|收购|并购|投资了|参股|子公司|母公司|集团旗下)/.test(before)) return true;
    // 投资方/股东名单（如"B轮 1.0亿：任大龙、博爱新开源医疗科技集团股份有限公司"）
    if (/(?:轮|融资|投资方|股东|领投|跟投|出资|认购)[^。\n]{0,40}$/.test(before)) return true;
    if (/[、，,：:]\s*$/.test(before) && /(?:轮|融资|投资方|股东|领投|跟投)/.test(text.slice(Math.max(0, index - 120), index))) return true;
    // 专家头衔/政府机构（如"国家科技部重点专项首席专家"）
    if (/(?:国家|省|市|部|局|委|院|所|中心|学会|协会|大学|学院)[^。\n]{0,6}$/.test(before)) return true;
    // 竞品对比语境（如"对比维度：安杰莱科技、强脑科技（BrainCo）、Neuralink"）
    if (/(?:对比|比较|竞品|对标|竞争格局|vs\.?|VS|相比|相较|优于|区别于)[^。\n]{0,30}$/.test(before)) return true;
    if (/[、，,]\s*$/.test(before) && /(?:对比|比较|竞品|对标|竞争格局|vs\.?|VS)/.test(text.slice(Math.max(0, index - 80), index))) return true;
    // 竞品对比表的行首条目（如"强脑科技：非侵入式脑机接口为主…"）
    // 判定：位于行首 + 后接冒号 + 该行是"XX：描述"的对比句式
    var lineStart = text.lastIndexOf('\n', index - 1) + 1;
    var isLineHead = text.slice(lineStart, index).trim() === '';
    if (isLineHead && /^\s*[：:]/.test(after)) {
      // 若同一段落中存在多个"XX：描述"行，则视为对比表
      var para = text.slice(Math.max(0, index - 300), index + 300);
      var colonLines = para.split('\n').filter(function (l) { return /^[\u4e00-\u9fa5A-Za-z]{2,12}\s*[：:]/.test(l.trim()); });
      if (colonLines.length >= 2) return true;
    }


    // 后文：职务/奖项/客户关系
    if (/^\s*(?:CEO|CTO|CSO|CMO|COO|董事长|总经理|总监|合伙人|顾问|创始人|总裁|首席|（新奥|\(新奥)/.test(after)) return true;
    if (/^\s*(?:奖|称号|认证|客户|供应商|合作|竞品|对标|部|局|委|院|所|中心|学会|协会|大学|学院)/.test(after)) return true;
    return false;
  }


  // 抽取公司名称：优先"公司全称/公司名称"语境，其次带"有限公司"后缀
  // 关键：BP 标题/开头通常就是公司名，应优先在文本前部查找，避免命中创始人履历中的前雇主
  function extractCompany(text) {
    // 显式"公司名称："字段：保留括号内的英文名（如"诺诚健华医药有限公司（InnoCare Pharma Limited）"）
    // 只取同一行内的内容（\n 会截断），避免把下一行"英文名称：…"吞进来
    var m = text.match(/(?:公司全称|公司名称|企业名称)[：:][ \t]*([^\n]{4,60})/);
    if (m) {
      var full = m[1].trim();

      // 若括号内是英文名，保留中文主体 + 英文名；否则去掉括号补充说明
      var pm = full.match(/^([\u4e00-\u9fa5]{2,20}(?:有限公司|股份有限公司))\s*[（(]([A-Za-z][A-Za-z0-9\s&.,\-]{2,40})[)）]/);
      if (pm) return pm[1] + '（' + pm[2].trim() + '）';
      return full.replace(/[（(].*?[)）]/g, '').trim();
    }

    // 公司名匹配模式（按优先级）：含括号地名全称 > 普通全称
    var patterns = [
      /([\u4e00-\u9fa5]{2,10}[（(][\u4e00-\u9fa5]{2,6}[)）][\u4e00-\u9fa5]{2,10}(?:有限公司|股份有限公司))/,
      /([\u4e00-\u9fa5]{2,12}(?:生物|医药|医疗|制药|科技|健康)[\u4e00-\u9fa5]{0,8}(?:有限公司|股份有限公司))/
    ];
    // 清理公司名前缀：兼容"更名为/改名为/变更为"被换行拆开的情况（如"更\n名为华道…"）
    function stripRenamePrefix(s) {
      return s.replace(/^[\s\S]*?(?:更名为|改名为|变更为|名为)/, '').trim();
    }
    // 先在文本前 300 字符（标题区）中查找，命中即返回
    var head = text.slice(0, 300);
    for (var i = 0; i < patterns.length; i++) {
      var hm = head.match(patterns[i]);
      if (hm) return stripRenamePrefix(hm[1]);
    }
    // 再在全文查找：跳过履历/奖项/客户等干扰语境，取第一个"干净"的命中
    for (var j = 0; j < patterns.length; j++) {
      var re = new RegExp(patterns[j].source, 'g'), fm;
      while ((fm = re.exec(text)) !== null) {
        if (isNoiseCompanyContext(text, fm.index, fm[1])) continue;
        return stripRenamePrefix(fm[1]);
      }
    }

    // 兜底1：品牌名频次策略——BP 中反复出现的"XX药业/XX生物/XX科技"通常就是公司简称
    // （如"福沃药业"在封面/页眉/正文反复出现，而全称可能未出现）
    var brandRe = /([\u4e00-\u9fa5]{2,8}(?:药业|生物|医药|医疗|制药|科技|健康|诊断|基因))/g, bm;
    var freq = {}, firstIdx = {};
    while ((bm = brandRe.exec(text)) !== null) {
      var name = bm[1];
      // 过滤普通名词/泛称，避免"结构生物学""健康管理""生物医药"等被误认为公司名
      if (/^(?:结构生物|分子生物|细胞生物|系统生物|合成生物|生物医药|生物技术|生物科技|生物制品|健康管理|健康科技|医疗科技|医药科技|精准医疗|智慧医疗|医疗器械|医疗服务|科技创新|科技有限|生物工程|基因治疗|基因检测|细胞治疗|免疫治疗|诊断试剂|医疗健康|大健康|健康产业|医药行业|生物制药|创新药|新药研发|药物研发|临床研究|医学研究|生命科学|生物医学|再生医学|转化医学|精准医学|数字医疗|互联网医疗|人工智能|智能科技|新材料|新能源)$/.test(name)) continue;
      if (isNoiseCompanyContext(text, bm.index, name)) continue;
      freq[name] = (freq[name] || 0) + 1;
      if (firstIdx[name] === undefined) firstIdx[name] = bm.index;
    }
    var bestName = null, bestScore = 0;
    Object.keys(freq).forEach(function (n) {
      // 频次优先，同频次取更靠前的
      var score = freq[n] * 1000 - firstIdx[n] / 1000;
      if (score > bestScore) { bestScore = score; bestName = n; }
    });
    if (bestName && freq[bestName] >= 2) return bestName;
    // 兜底2：标题行中的"XX生物/医药"（同样排除干扰语境）
    var re2 = /([\u4e00-\u9fa5]{2,10}(?:生物|医药|医疗|制药|科技|健康))/g, m2;
    while ((m2 = re2.exec(text)) !== null) {
      if (isNoiseCompanyContext(text, m2.index, m2[1])) continue;
      if (/^(?:结构生物|分子生物|细胞生物|系统生物|合成生物|生物医药|生物技术|生物科技|健康管理|健康科技|医疗科技|医药科技|精准医疗|智慧医疗|医疗器械|医疗服务|基因治疗|基因检测|细胞治疗|免疫治疗|诊断试剂|医疗健康|大健康|健康产业|医药行业|生物制药|创新药|新药研发|药物研发|临床研究|医学研究|生命科学|生物医学|再生医学|转化医学|精准医学|数字医疗|互联网医疗|人工智能|智能科技)$/.test(m2[1])) continue;
      return m2[1];
    }
    return '未识别';
  }



  // 抽取估值：优先"投前/投后估值"语境，排除 rNPV/管线估值等干扰
  function extractValuation(text) {
    // 优先：投前/投后估值（兼容"投前估值 16→30亿""投前估值20亿"等写法）
    // 注意：仅允许"投前/投后估值"与数字间有少量空白/冒号，避免跨句误匹配
    var m = text.match(/(?:投前|投后)估值[\s：:]{0,3}([0-9][0-9,\.]*)\s*(?:→|-|~|至)?\s*(?:[0-9][0-9,\.]*\s*)?([亿万])\s*元?/);
    if (m) return m[1].replace(/,/g, '') + m[2] + '元';
    // 其次：C轮/本轮估值
    m = text.match(/(?:本轮|C轮|B轮|A轮|Pre-IPO)[^。\n]{0,10}?估值[^。\n]{0,10}?([0-9][0-9,\.]*\s*[亿万]元)/);
    if (m) return m[1].replace(/\s/g, '');
    // 跨行/跨图表：PPT 提取后"估值"与金额常被图表数据隔开，在 120 字符窗口内查找
    var kwRe = /(?:投前估值|投后估值|本轮估值|估值|市值)/g, km;
    while ((km = kwRe.exec(text)) !== null) {
      var win = text.slice(km.index, km.index + 120);
      var vm = win.match(/([0-9][0-9,\.]*)\s*(亿元|万元|亿|万)/);
      if (!vm) continue;
      var pre = win.slice(0, vm.index);
      // 排除 rNPV/管线/期权/市场规模/收入 等非企业估值语境
      if (/rNPV|管线|期权|加总|资产|市场规模|市场空间|收入|营收|销售额|万亿|千亿/.test(pre)) continue;
      return vm[1].replace(/,/g, '') + vm[2];
    }
    return null;
  }

  // 估值反推兜底：BP 未直接披露估值时，用"融资额 ÷ 出让股权比例"估算投后估值
  // 例："本轮计划出让股权15%-20%，所筹资金…" + "融资5000万" → 5000万 ÷ 17.5% ≈ 2.9亿元
  // 返回 { value: '2.9亿元', basis: '反推' } 或 null
  function inferValuation(text, amount) {
    if (!amount) return null;
    // 解析融资额（仅支持人民币）
    var am = String(amount).match(/^([0-9][0-9,\.]*)\s*(亿元|万元|亿|万)$/);
    if (!am) return null;
    var amt = parseFloat(am[1].replace(/,/g, ''));
    if (!isFinite(amt) || amt <= 0) return null;
    var amtYi = /亿/.test(am[2]) ? amt : amt / 10000; // 统一换算为"亿元"

    // 匹配出让/稀释股权比例（支持区间"15%-20%""10~15%"）
    var pm = text.match(/(?:出让|稀释|释放|转让|增发)[^。\n]{0,12}?([0-9]{1,2}(?:\.[0-9]+)?)\s*%\s*(?:[-~至]\s*([0-9]{1,2}(?:\.[0-9]+)?)\s*%)?/);
    if (!pm) return null;
    var lo = parseFloat(pm[1]);
    var hi = pm[2] ? parseFloat(pm[2]) : lo;
    if (!isFinite(lo) || lo <= 0 || lo > 60) return null;
    var pct = (lo + hi) / 2 / 100; // 区间取中值
    var val = amtYi / pct;
    if (!isFinite(val) || val <= 0 || val > 1000) return null;
    // 保留 1 位小数
    var rounded = Math.round(val * 10) / 10;
    return { value: rounded + '亿元', basis: '按融资额÷出让股权比例（' + lo + (hi !== lo ? '-' + hi : '') + '%）反推' };
  }



  // 抽取临床阶段：识别"最高"临床阶段（已上市 > III期 > II期 > I期 > IND > 临床前）
  // 注意：需排除"已上市8款产品""已上市竞品"等描述竞品/行业的干扰语境
  function extractStage(text) {
    // 先剔除"预计/拟/将/计划…获批上市"等未来时态，避免把"预计上市"误判为"已上市"
    var cleaned = text.replace(/(?:预计|拟|将|计划|有望|争取)[^。\n]{0,15}?(?:获批上市|上市|获批)/g, '');
    // 再剔除描述竞品/行业/他人的"拥有X款获批上市""唯一在售""竞品已上市"等语境
    cleaned = cleaned.replace(/(?:拥有|已有|竞品|行业|国内|国际|唯一|在售|其他公司)[^。\n]{0,15}?(?:获批上市|已上市|在售)/g, '');
    // 剔除假设性/未来语境："即使未来有新产品获批上市""若获批上市"等
    cleaned = cleaned.replace(/(?:即使|未来|若|如果|假设|一旦|有望)[^。\n]{0,20}?(?:获批上市|已上市|上市)/g, '');
    // 剔除"拟/预计/计划…NDA/递交NDA"等未来时态，避免把"拟2026年NDA"误判为已处于NDA
    cleaned = cleaned.replace(/(?:拟|预计|计划|将|有望|争取|目标)[^。\n]{0,12}?(?:NDA|上市申请|申报上市)/g, '');
    // 剔除带年份的"2022年提交NDA""2026 Q4 NDA申报"等时间点描述（历史里程碑或未来计划，非当前状态）
    cleaned = cleaned.replace(/[0-9]{4}\s*年?[^。\n]{0,6}?(?:提交|递交|申报|完成)?[^。\n]{0,4}?(?:NDA|上市申请)/g, '');
    cleaned = cleaned.replace(/[0-9]{4}\s*[Qq][1-4][^。\n]{0,10}?(?:NDA|上市申请)/g, '');
    // 剔除行业/竞品/全球背景描述中的阶段表述（如"全球溶瘤病毒领域临床III期项目数量已超过90项"）
    // 这类表述描述的是行业整体，而非本企业管线所处阶段
    cleaned = cleaned.replace(/(?:全球|国内|国际|行业|领域|市场|竞品|同类|其他公司|已有|目前已有)[^。\n]{0,20}?(?:临床)?(?:I{1,3}|1|2|3)\s*期[^。\n]{0,20}?(?:项目|产品|药物|管线|数量|超过|已有|共)/g, '');
    cleaned = cleaned.replace(/(?:临床)?(?:I{1,3}|1|2|3)\s*期[^。\n]{0,10}?(?:项目|产品|药物|管线)[^。\n]{0,10}?(?:数量|超过|已有|共|达)[^。\n]{0,10}/g, '');
    // 剔除"行业背景/发展现状/竞争格局"章节中的阶段统计（如"临床I-III期：国际OV>90；国内OV>20"）
    cleaned = cleaned.replace(/(?:行业背景|发展现状|竞争格局|市场分析|行业分析|背景分析)[^。\n]{0,30}?(?:临床)?(?:I{1,3}|1|2|3)\s*期[^。\n]{0,30}/g, '');
    // 剔除区间式阶段表述（如"临床I-III期""II-III期临床""II/III期临床试验"），这类多为行业统计或规划区间，非当前阶段
    cleaned = cleaned.replace(/(?:临床)?(?:I{1,3}|1|2|3)\s*[-~至\/]\s*(?:I{1,3}|1|2|3)\s*期[^。\n]{0,20}/g, '');
    // 剔除"XX期临床试验的XX药物/产品"这类行业统计句式（如"II/III期临床试验的溶瘤病毒：单药药效…"）
    cleaned = cleaned.replace(/(?:I{1,3}|1|2|3)\s*期[^。\n]{0,6}?临床试验的[^。\n]{0,20}/g, '');
    // 剔除"III期临床验证生存获益""II期临床（单药+联合）"等未来计划句式（无"已/正在/处于"等当前状态词）
    cleaned = cleaned.replace(/(?:I{1,3}|1|2|3)\s*期临床(?:验证|试验|研究|开发|推进|开展)[^。\n]{0,25}/g, '');
    // 剔除"关键里程碑/里程碑规划"章节中的阶段表述（如"完成I期临床试验全部工作，确认II期推荐剂量"）
    // 里程碑描述的是未来要达成的目标，不代表当前所处阶段
    cleaned = cleaned.replace(/(?:关键里程碑|里程碑|发展规划|路线图|roadmap)[^。\n]{0,20}?(?:完成|实现|达成|推进)[^。\n]{0,20}?(?:I{1,3}|1|2|3)\s*期[^。\n]{0,30}/gi, '');
    // 剔除"完成XX期临床试验""确认XX期推荐剂量""开展关键性XX期临床"等目标句式
    cleaned = cleaned.replace(/(?:完成|确认|开展|推进|启动|进入)[^。\n]{0,10}?(?:I{1,3}|1|2|3)\s*期(?:临床)?[^。\n]{0,20}/g, '');
    // 剔除竞品对标表格行（如"亦诺微 | MVR-T3011 | 临床II期 | 8-12亿 | 传统基因删除"）
    // 判定：同一行含"|"分隔符且出现阶段表述，属于竞品/对标数据，非本企业阶段
    cleaned = cleaned.split('\n').filter(function (line) {
      if (line.indexOf('|') === -1) return true;
      return !/(?:I{1,3}|1|2|3)\s*期/.test(line);
    }).join('\n');
    // 剔除退出路径/资本化规划中的阶段表述（如"依托II期临床核心数据，冲刺科创板""II期数据读出后启动上市申报"）
    cleaned = cleaned.replace(/(?:退出路径|退出方式|资本化|上市退出|IPO退出|并购退出|价值跃升)[^。\n]{0,30}?(?:I{1,3}|1|2|3)\s*期[^。\n]{0,30}/g, '');
    cleaned = cleaned.replace(/(?:I{1,3}|1|2|3)\s*期[^。\n]{0,10}?(?:数据读出|数据披露)[^。\n]{0,20}/g, '');
    // 剔除"依托II期临床核心数据，冲刺科创板/港股18A"等退出路径句式
    cleaned = cleaned.replace(/(?:依托|基于|凭借)[^。\n]{0,10}?(?:I{1,3}|1|2|3)\s*期[^。\n]{0,20}?(?:冲刺|申报|上市|退出|并购)[^。\n]{0,20}/g, '');

    // 剔除"为XX期推荐剂量（RP2D）选择提供数据支撑"等方案设计描述
    cleaned = cleaned.replace(/(?:为|用于)[^。\n]{0,10}?(?:I{1,3}|1|2|3)\s*期[^。\n]{0,20}?(?:提供|选择|支撑|准备)[^。\n]{0,15}/g, '');



    // 剔除未来开发计划中的阶段表述（如"2029-2032年完成II-III期临床""H2启动I期临床"）
    cleaned = cleaned.replace(/[0-9]{4}\s*[-~至]\s*[0-9]{4}\s*年[^。\n]{0,20}?(?:I{1,3}|1|2|3)\s*期[^。\n]{0,20}/g, '');
    cleaned = cleaned.replace(/(?:H[12]|第[一二三四]季度|Q[1-4])[^。\n]{0,10}?(?:启动|开展|完成)[^。\n]{0,10}?(?:I{1,3}|1|2|3)\s*期[^。\n]{0,20}/g, '');
    cleaned = cleaned.replace(/(?:分阶段开发计划|开发计划|研发计划|里程碑规划)[^。\n]{0,40}?(?:I{1,3}|1|2|3)\s*期[^。\n]{0,30}/g, '');


    var STAGES = [
      // 已上市：药品获批上市，或医疗器械取得注册证/获证（NMPA/FDA/CE 等）
      { re: /(?:公司|产品|管线|核心产品|本品|该药)[^。\n]{0,10}(?:已上市|已获批上市|获批上市)|(?:已上市|获批上市)[^。\n]{0,6}(?:销售|商业化)/, name: '已上市' },
      // 已获批适应症（含附条件批准）：药品已获 NMPA 批准上市，如"已获批适应症（附条件批准）"
      { re: /已获批适应症|获批适应症|附条件批准上市|附条件获批|已获(?:国家)?(?:药监|NMPA)[^。\n]{0,10}?批准/, name: '已上市' },

      // 医疗器械：取得注册证/获证（如"NMPA二类医疗器械注册证""7款获证""全线产品均已获得注册证"）
      // 注意：必须明确为"注册证/获证"，不能是"批件/资格/孤儿药认证"等临床批文或药品资格
      { re: /(?:获得|取得|已获|均已获|获批)[^。\n]{0,12}?注册证|(?:NMPA|FDA|CE|MDA)[^。\n]{0,6}?注册证|[0-9]+\s*款[^。\n]{0,6}?获证|获证[^。\n]{0,6}?产品/, name: '已获证' },
      // IVD/体外诊断：一类备案证、二类/三类注册证（如"获准一类备案证""获准二类注册证"）
      { re: /(?:获准|获得|取得|已获)[^。\n]{0,8}?(?:一类|二类|三类)[^。\n]{0,6}?(?:备案证|注册证)|(?:一类|二类|三类)(?:医疗器械)?(?:备案证|注册证)/, name: '已获证' },



      // NDA：要求"处于NDA阶段/正在NDA审评/NDA已受理"等明确当前状态的表述
      { re: /(?:处于|正在|已进入)[^。\n]{0,6}?(?:NDA|新药上市申请|上市申请)|(?:NDA|新药上市申请)[^。\n]{0,4}?(?:阶段|审评中|已受理|审评)/, name: 'NDA阶段' },
      // 药品注册申报：获得备案号/受理号/申报中（如"获得备案号""申报中（备案号）""已启动申报"）
      { re: /(?:获得|取得|已获)[^。\n]{0,8}?备案号|(?:申报|注册)[^。\n]{0,4}?中|已启动申报|受理号|CTR[0-9]{6,}/, name: '注册申报' },
      { re: /III期|临床III期|Phase\s*III|注册性临床/, name: '临床III期' },
      { re: /II期|临床II期|Phase\s*II/, name: '临床II期' },
      { re: /I期|临床I期|Phase\s*I/, name: '临床I期' },
      { re: /IND|IND申报|IND准备/, name: 'IND阶段' },
      { re: /临床前|Preclinical/, name: '临床前' },
      // 医疗器械类阶段
      { re: /创新医疗器械特别审查|创新器械审查|特别审查程序/, name: '创新器械审查' },
      { re: /型检证书|型式检验|注册检验/, name: '注册检验' },
      { re: /临床试验备案|临床验证试验/, name: '临床验证' }
    ];

    for (var i = 0; i < STAGES.length; i++) {
      if (STAGES[i].re.test(cleaned)) return STAGES[i].name;
    }
    // 非药械赛道识别：功能性食品/健康消费品/化工材料等，本身不存在临床阶段
    // 避免笼统返回"未识别"造成误判（如"药食同源"食品、底涂剂材料、健康饮品）
    var NON_PHARMA = [
      { re: /药食同源|功能性食品|保健食品|膳食补充|食品生产许可|SC证|食品经营许可/, name: '非药械·食品' },
      { re: /底涂剂|密封胶|聚合物|化工|材料|涂料|胶粘剂/, name: '非药械·材料' },
      // 健康消费品：产品手册类文档（如"血管健康""主动健康管理""品牌口号""产品手册"）
      { re: /健康饮品|饮品|口服液|茶饮|营养品|康养|产品手册|品牌口号|公司愿景|主动健康管理|健康管理新风向|天然植物|植物能量/, name: '非药械·消费品' }
    ];

    for (var k = 0; k < NON_PHARMA.length; k++) {
      if (NON_PHARMA[k].re.test(cleaned)) return NON_PHARMA[k].name;
    }
    return '未识别';
  }


  // 靶点词典：按类别组织，便于维护与扩展
  // 注意：匹配时统一做大小写不敏感 + 边界处理，避免 "CD3" 命中 "CD30"、"C3" 命中 "C30" 等误判
  var TARGET_DICT = [
    // 免疫检查点
    'PD-1', 'PD-L1', 'PD-L2', 'CTLA-4', 'TIGIT', 'LAG-3', 'TIM-3', 'VISTA', 'B7-H3', 'B7-H4', '4-1BB', 'CD137', 'OX40', 'CD27', 'CD28', 'ICOS', 'NKG2A', 'KIR',
    // 血液瘤 / 细胞治疗
    'CD19', 'CD20', 'CD22', 'CD30', 'CD33', 'CD38', 'CD47', 'CD70', 'CD99', 'CD123', 'CD138', 'CD3', 'BCMA', 'GPRC5D', 'SLAMF7', 'CS1', 'FcRH5',
    // 实体瘤
    'HER2', 'EGFR', 'ALK', 'ROS1', 'RET', 'MET', 'c-Met', 'KRAS', 'BRAF', 'MEK', 'NTRK', 'TRK', 'FGFR', 'VEGFR', 'VEGF', 'TROP2', 'Nectin-4', 'CLDN18.2', 'Claudin18.2', 'MSLN', 'Mesothelin', 'GPC3', 'AFP', 'PSMA', 'FAP', 'CA9', 'GPR87', 'MUC1', 'MUC16', 'CEA', 'EpCAM', 'DLL3', 'SSTR2', 'Integrin',
    // 信号通路 / 激酶
    'BTK', 'JAK', 'JAK1', 'JAK2', 'JAK3', 'TYK2', 'PI3K', 'AKT', 'mTOR', 'SHP2', 'EZH2', 'IDH1', 'IDH2', 'FLT3', 'KIT', 'ABL', 'BCR-ABL', 'PARP', 'CDK4', 'CDK6', 'CDK12', 'HDAC', 'DNMT', 'Wnt', 'Hedgehog', 'STING', 'TLR', 'NLRP3', 'Bcl-2', 'MDM2', 'p53', 'RAS', 'MYC',
    // 代谢 / 心血管 / 慢病
    'GLP-1', 'GLP-2', 'GIP', 'GCGR', 'PCSK9', 'ANGPTL3', 'Lp(a)', 'Factor XI', 'FXIa', 'P2Y12', 'SGLT2', 'DPP-4', 'PPAR', 'FXR', 'THR-β',
    // 免疫 / 炎症
    'TNF-α', 'IL-2', 'IL-6', 'IL-15', 'IL-17', 'IL-23', 'IgE', 'TSLP', 'S1P', 'α4β7', 'MAdCAM-1', 'TGF-β', 'C3', 'C5', 'CFB', 'CD32a', 'CD32α', 'GP120',
    // 生殖 / 内分泌 / 代谢标志物
    'POI', 'AMH', 'FSH', 'LH', 'E2', 'AMHR2', 'BMP15', 'GDF9', 'INSR', 'IGF-1R', 'GCGR', 'GIPR', 'MC4R', 'FGF21', 'FGF23', 'Klotho',
    // 神经 / 精神
    'Aβ', 'Tau', 'α-synuclein', 'BDNF', 'NGF', 'TrkB', 'NMDA', 'AMPA', 'GABA-A', '5-HT', 'DRD2', 'M1', 'M4', 'α7nAChR',
    // 抗感染 / 疫苗（仅保留明确作为药物靶点/抗原的缩写；HBV/HCV/HIV 等病原体名
    // 在 BP 中多为流行病学描述，不纳入靶点词典，避免"全球慢性HBV感染者2.4亿"误判）
    'Spike', 'RBD', 'RSV-F', 'gD', 'L1',
    // 眼科 / 其他
    'VEGF-A', 'VEGFR2', 'CFH', 'C3b', 'RPE65', 'CEP290', 'RHO', 'ABCA4',
    // 活性氧 / 光动力 / 物理作用机制（非蛋白靶点，但属于核心技术机制）
    'ROS', 'PDT', '光敏剂', '单线态氧',
    // 气体标志物（呼气诊断类 IVD）
    '氢气', '甲烷', '硫化氢', '一氧化氮', 'CH4', 'H2S'
  ];

  // 仅在"技术/机制"语境下才计为靶点的词：这些词在 BP 中常出现在
  // 流行病学、营养成分、时间表述等非靶点语境（如"2029年H2启动I期""n-HA再矿化牙膏"）
  var TARGET_CONTEXT_REQUIRED = {
    'ROS': /(?:活性氧|氧化应激|清除|产生|诱导|光动力|光敏|单线态氧|自由基)/,
    'PDT': /(?:光动力|光敏剂|治疗|疗法|机制)/,
    'H2S': /(?:硫化氢|气体|呼气|标志物|检测)/,
    'CH4': /(?:甲烷|气体|呼气|标志物|检测)/,
    'NO': /(?:一氧化氮|气体|呼气|标志物|信号|通路)/,
    'L1': /(?:HPV|病毒|疫苗|抗原|蛋白)/,
    'gD': /(?:病毒|疫苗|抗原|蛋白|HSV)/,
    'RHO': /(?:视紫红质|基因|突变|视网膜)/,
    'M1': /(?:巨噬细胞|受体|亚型|毒蕈碱)/,
    'M4': /(?:受体|亚型|毒蕈碱)/,
    'E2': /(?:雌二醇|激素|受体)/,
    'LH': /(?:促黄体|激素|受体)/,
    'FSH': /(?:促卵泡|激素|受体)/,
    'NA': /(?:神经氨酸酶|抗原|疫苗|流感)/
  };



  // 靶点匹配的"伪命中"排除表：这些英文单词/缩写包含靶点子串，但不是靶点
  // 例：Intelligent 含 IgE、Breakthrough 含 AKT、GRAS 含 RAS、Target 含 RET
  var TARGET_FALSE_POSITIVE = /GRAS|Breakthrough|Intelligent|Intelligence|Target|Targeting|Targeted|Retention|Return|Returns|Retail|Retina|Retinal|Metabolic|Metabolism|Metal|Method|Methods|Metric|Metrics|Signal|Signaling|Digital|Digitalization|Kit\b|Kits\b|Ablation|Ablation|C3\s*(?:转化酶|补体)?(?:$|[^0-9])/i;

  // 非药械赛道（食品/材料/消费品）通常不存在药物靶点，其文本中的"活性氧""抗氧化"
  // 等属于营养成分机理描述，不应被识别为靶点
  // 注意：必须使用"强信号"词，避免"化工""康养""产品手册"等泛词把药企 BP 误判为非药械
  // （如 CAR-T BP 中的"化工级原料"、康复器械 BP 中的"康养"）
  var NON_PHARMA_TRACK_RE = /药食同源|功能性食品|保健食品|膳食补充|食品生产许可|SC证|底涂剂|密封胶|聚合物|涂料|胶粘剂|健康饮品|茶饮|品牌口号/;

  // 抽取核心靶点：按出现频次排序，取最高频靶点
  function extractTarget(text) {
    // 非药械赛道直接返回"不适用"，避免把营养成分机理误判为药物靶点
    // 但若文本中已出现明确的药物靶点（如 CD19/PD-1），仍以靶点为准
    if (NON_PHARMA_TRACK_RE.test(text) && !/(?:CD19|CD30|PD-1|PD-L1|HER2|BCMA|PCSK9|BTK|EGFR|CLDN18\.2)/i.test(text)) {
      return '不适用（非药械赛道）';
    }


    var best = null, bestCount = 0;
    TARGET_DICT.forEach(function (t) {

      // 转义正则特殊字符
      var esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 左右边界：前后不能紧邻英文字母，避免 "Intelligent" 命中 IgE、"Breakthrough" 命中 AKT
      // 右边界额外排除数字，避免 CD3 命中 CD30、C3 命中 C30
      var re = new RegExp('(?<![A-Za-z])' + esc + '(?![A-Za-z0-9])', 'gi');
      var m = text.match(re);
      if (!m) return;
      // 过滤伪命中：检查每个命中位置的上下文
      var valid = 0;
      var re2 = new RegExp('(?<![A-Za-z])' + esc + '(?![A-Za-z0-9])', 'gi'), mm;
      var ctxRule = TARGET_CONTEXT_REQUIRED[t] || TARGET_CONTEXT_REQUIRED[t.toUpperCase()];
      while ((mm = re2.exec(text)) !== null) {
        var ctx = text.slice(Math.max(0, mm.index - 12), mm.index + t.length + 12);
        if (TARGET_FALSE_POSITIVE.test(ctx)) continue;
        // 语境约束：ROS/H2S/NO 等易混淆词必须出现在技术/机制语境中
        if (ctxRule && !ctxRule.test(ctx)) continue;
        valid++;
      }

      if (valid > bestCount) { bestCount = valid; best = t; }
    });
    return best || '未识别';
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
    var amount = extractAmount(text, ['亿元', '万元']);
    var stage = extractStage(text);
    var disclosed = extractValuation(text);
    var inferred = disclosed ? null : inferValuation(text, amount);

    // 估值系统：原文披露 > 股权比例反推 > 多因子模型（保证任何 BP 都有估值评估）
    var valuation = disclosed, valuationBasis = disclosed ? '原文披露' : null;
    var valuationConfidence = disclosed ? '高' : null;
    var valuationMethod = disclosed ? 'BP 原文披露' : null;
    var valuationRange = null, valuationDetail = null;

    if (!valuation && inferred) {
      valuation = inferred.value;
      valuationBasis = inferred.basis;
      valuationConfidence = '中高';
      valuationMethod = '股权比例反推';
    }
    // 兜底：多因子估值模型（即使无任何估值信息也能给出评估）
    if (!valuation && global.ValuationEngine) {
      var ve = global.ValuationEngine.estimate({
        text: text, stage: stage, hits: hits, amount: amount
      });
      if (ve) {
        valuation = ve.value;
        valuationBasis = ve.basis;
        valuationConfidence = ve.confidence;
        valuationMethod = ve.method;
        valuationRange = { low: ve.low, high: ve.high };
        valuationDetail = ve.factors;
      }
    }

    var extracted = {
      companyName: extractCompany(text),
      financingAmount: amount,
      valuation: valuation,
      valuationBasis: valuationBasis,
      valuationConfidence: valuationConfidence,
      valuationMethod: valuationMethod,
      valuationRange: valuationRange,
      valuationDetail: valuationDetail,
      stage: stage,
      target: extractTarget(text),
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

    // ---------- 3.5 风险扣分（基于风险实质，而非仅内容覆盖度） ----------
    // 说明：内容齐全 ≠ 风险低。以下扣分项反映 BP 中暴露的实质性风险。
    var penalties = [];
    // 临床阶段越早，研发不确定性越高（B维度扣分）
    var stagePenalty = {
      '临床前': 4, 'IND阶段': 3, '临床I期': 2, '临床II期': 1, '临床III期': 0, 'NDA阶段': 0, '已上市': 0,
      '临床验证': 2, '注册检验': 1, '创新器械审查': 1, '未识别': 1,
      // 医疗器械/药品注册路径：已获证≈已上市（0），注册申报略高于已上市（1）
      '已获证': 0, '注册申报': 1
    };

    var sp = stagePenalty[extracted.stage] || 0;
    if (sp > 0) {
      scores.pipeline = clamp(scores.pipeline - sp, 0, 30);
      var stageReason = extracted.stage === '未识别'
        ? '未能识别明确的临床/注册阶段，研发进度信息不足'
        : '核心管线处于' + extracted.stage + '，研发不确定性较高';
      penalties.push({ dim: 'pipeline', points: sp, reason: stageReason });
    }
    // 合规风险表述（D维度扣分）
    RISKY_PHRASES.forEach(function (rp) {
      if (rp.re.test(text)) {
        var p = rp.level === 'high' ? 3 : 1;
        scores.risk = clamp(scores.risk - p, 0, 20);
        penalties.push({ dim: 'risk', points: p, reason: rp.title });
      }
    });
    // 资金缺口/融资断档风险（C维度扣分）
    if (/资金缺口|融资断档|现金耗尽|资金链断裂|需融资/.test(text)) {
      scores.capital = clamp(scores.capital - 2, 0, 20);
      penalties.push({ dim: 'capital', points: 2, reason: 'BP披露存在资金缺口或融资断档风险' });
    }
    // 缺少估值依据（C维度扣分）
    if (hits.valuation === 0) {
      scores.capital = clamp(scores.capital - 2, 0, 20);
      penalties.push({ dim: 'capital', points: 2, reason: '缺少估值模型或可比依据' });
    }
    // 缺少现金流披露（D维度扣分）
    if (hits.cashflow === 0) {
      scores.risk = clamp(scores.risk - 2, 0, 20);
      penalties.push({ dim: 'risk', points: 2, reason: '未披露现金流/现金跑道' });
    }
    // 市场空间/临床价值存疑（A维度扣分）：BP或分析报告中出现"市场空间有限/临床价值不足/过于乐观"等实质性质疑
    if (/市场空间(十分)?有限|市场规模极小|临床价值(存疑|不足)|增量价值不足|过于乐观|难以形成独立|不具备独立市场价值|预期过高/.test(text)) {
      scores.framework = clamp(scores.framework - 4, 0, 30);
      penalties.push({ dim: 'framework', points: 4, reason: '市场空间或临床价值存在实质性质疑' });
    }
    // 收入预测与市场规模严重不匹配（C维度扣分）
    if (/产销计划|销量预测|收入预测/.test(text) && /显著高于|远高于|高于全球市场|不匹配/.test(text)) {
      scores.capital = clamp(scores.capital - 3, 0, 20);
      penalties.push({ dim: 'capital', points: 3, reason: '收入/销量预测与市场规模不匹配' });
    }

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
      hits: hits,
      penalties: penalties
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

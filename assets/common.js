/* ============================================================
   BioFin 智投引擎 · 公共脚本 (common.js)
   提供：模块注册表、真实模块跳转、通用切换/重置、HTML 转义
   ============================================================ */
(function (global) {
  'use strict';

  /* ----------------------------------------------------------
     模块注册表：编号 -> { file, name }
     与 README 的 A/B/C/D/E/F/G 体系保持一致
     ---------------------------------------------------------- */
  var MODULES = {
    1:  { file: '模块1_文档解析与OCR引擎.html',            name: '文档解析与OCR引擎' },
    2:  { file: '模块2_结构化信息抽取器.html',            name: '结构化信息抽取器' },
    3:  { file: '模块3_行业知识库搭建.html',              name: '行业知识库搭建' },
    4:  { file: '模块4_18A案例库搭建.html',               name: '18A案例库搭建' },
    5:  { file: '模块5_估值参数库搭建.html',              name: '估值参数库搭建' },
    6:  { file: '模块6_垂直大模型微调.html',              name: '垂直大模型微调' },
    7:  { file: '模块7_RAG检索增强模块.html',             name: 'RAG检索增强模块' },
    8:  { file: '模块8_A1结构完整性扫描.html',            name: 'A1 结构完整性扫描' },
    9:  { file: '模块9_A2商业逻辑闭环校验.html',          name: 'A2 商业逻辑闭环校验' },
    10: { file: '模块10_A3叙事流畅度评估.html',           name: 'A3 叙事流畅度评估' },
    11: { file: '模块11_B1临床数据解析与分期校验.html',   name: 'B1 临床数据解析与分期校验' },
    12: { file: '模块12_B2技术差异化与竞争格局.html',     name: 'B2 技术差异化与竞争格局' },
    13: { file: '模块13_B3专利壁垒与IP评估.html',         name: 'B3 专利壁垒与IP评估' },
    14: { file: '模块14_C1估值合理性校验.html',           name: 'C1 估值合理性校验' },
    15: { file: '模块15_C2融资金额与稀释测算.html',       name: 'C2 融资金额与稀释测算' },
    16: { file: '模块16_C3资金使用计划审查.html',         name: 'C3 资金使用计划审查' },
    17: { file: '模块17_D1合规风险筛查.html',             name: 'D1 合规风险筛查' },
    18: { file: '模块18_D2现金流与资金链压力.html',       name: 'D2 现金流与资金链压力' },
    19: { file: '模块19_D3研发失败率与临床风险.html',     name: 'D3 研发失败率与临床风险' },
    20: { file: '模块20_E3评分模型与权重体系.html',       name: 'E3 评分模型与权重体系' },
    21: { file: '模块21_E4诊断报告生成器.html',           name: 'E4 诊断报告生成器' },
    22: { file: '模块22_E5可视化诊断看板.html',           name: 'E5 可视化诊断看板' },
    23: { file: '模块23_F1用户与权限管理.html',           name: 'F1 用户与权限管理' },
    24: { file: '模块24_F2计费与套餐管理.html',           name: 'F2 计费与套餐管理' },
    25: { file: '模块25_F3数据安全与合规审计.html',       name: 'F3 数据安全与合规审计' },
    26: { file: '模块26_F4运营后台与数据看板.html',       name: 'F4 运营后台与数据看板' },
    27: { file: '模块27_G1-G4远期增强模块.html',          name: 'G1-G4 远期增强模块' }
  };

  /* ----------------------------------------------------------
     HTML 转义：防止动态数据注入（XSS 防护）
     ---------------------------------------------------------- */
  // 使用 Unicode 转义，避免被格式化工具还原为原始字符
  var ESCAPE_MAP = {
    '&': '\u0026amp;',
    '<': '\u0026lt;',
    '>': '\u0026gt;',
    '"': '\u0026quot;',
    "'": '\u0026#39;'
  };
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, function (ch) {
      return ESCAPE_MAP[ch];
    });
  }

  /* ----------------------------------------------------------
     跳转到指定编号的模块
     ---------------------------------------------------------- */
  function goToModule(moduleNo) {
    var mod = MODULES[moduleNo];
    if (!mod) {
      console.warn('[BioFin] 未找到模块 #' + moduleNo);
      return;
    }
    global.location.href = mod.file;
  }

  /* ----------------------------------------------------------
     通用「下一步」：跳转到当前模块的下一模块
     页面通过 <body data-module="1"> 声明自身编号
     ---------------------------------------------------------- */
  function nextModule() {
    var current = parseInt(document.body.getAttribute('data-module'), 10);
    if (isNaN(current)) {
      console.warn('[BioFin] 页面未声明 data-module，无法跳转');
      return;
    }
    var next = current + 1;
    if (!MODULES[next]) {
      alert('🎉 已到达最后一个模块（#' + current + '）。');
      return;
    }
    goToModule(next);
  }

  /* ----------------------------------------------------------
     通用「重置视图」：恢复首个导航项/内容为激活态
     ---------------------------------------------------------- */
  function resetAll() {
    var navSelectors = ['.sc-nav-item', '.db-nav-item', '.tab', '.file-type'];
    navSelectors.forEach(function (sel) {
      var items = document.querySelectorAll(sel);
      items.forEach(function (n, i) { n.classList.toggle('active', i === 0); });
    });
    var contentSelectors = ['.sc-content', '.db-content', '.tab-content'];
    contentSelectors.forEach(function (sel) {
      var items = document.querySelectorAll(sel);
      items.forEach(function (c, i) { c.classList.toggle('active', i === 0); });
    });
    global.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ----------------------------------------------------------
     通用切换：在给定容器内切换 active 项
     ---------------------------------------------------------- */
  function switchGroup(el, targetId, itemSelector, contentSelector) {
    document.querySelectorAll(itemSelector).forEach(function (n) {
      n.classList.remove('active');
    });
    el.classList.add('active');
    document.querySelectorAll(contentSelector).forEach(function (c) {
      c.classList.remove('active');
    });
    var target = document.getElementById(targetId);
    if (target) target.classList.add('active');
  }

  /* ----------------------------------------------------------
     导航栏点击：为 .nav-link[data-module] 绑定跳转
     ---------------------------------------------------------- */
  function initNav() {
    document.querySelectorAll('.nav-link[data-module]').forEach(function (link) {
      link.addEventListener('click', function () {
        goToModule(parseInt(link.getAttribute('data-module'), 10));
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNav);
  } else {
    initNav();
  }

  /* ----------------------------------------------------------
     导出到全局
     ---------------------------------------------------------- */
  global.BioFin = {
    MODULES: MODULES,
    escapeHtml: escapeHtml,
    goToModule: goToModule,
    nextModule: nextModule,
    resetAll: resetAll,
    switchGroup: switchGroup
  };

  // 兼容各模块页面直接调用的全局函数名
  global.nextModule = nextModule;
  global.resetAll = resetAll;
  global.escapeHtml = escapeHtml;
})(window);

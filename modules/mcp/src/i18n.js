// 简体中文叠加层。由 scripts/mcp-mirror.ts 内联进页面，在原站的数据脚本之后、渲染器之前执行。
// 默认简体中文；选择记在 localStorage（存不了时退回地址参数 ?lang=）。英文模式下除了切换按钮，什么都不改。
(() => {
  const KEY = 'mcp-explained:lang';
  const I18N = window.__MCP_I18N__;
  const pick = (value) => (value === 'en' || value === 'zh-CN' ? value : null);
  const stored = () => {
    try {
      return pick(localStorage.getItem(KEY));
    } catch {
      return null;
    }
  };
  const lang = pick(new URLSearchParams(location.search).get('lang')) ?? stored() ?? 'zh-CN';
  const zh = lang === 'zh-CN';
  const data = new Map(Object.entries(I18N.data));
  const ui = new Map(Object.entries(I18N.ui));
  /** 没找到译文的文字。正常应该为空，端到端测试会检查。 */
  const misses = [];
  I18N.lang = lang;
  I18N.misses = misses;

  const lookup = (table, text) => {
    if (!zh) return text;
    if (table.has(text)) return table.get(text);
    if (!misses.includes(text)) misses.push(text);
    return text;
  };
  const fill = (text, args) => text.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)]));

  /** 界面文字。key 是英文原文，{0}、{1} 依次换成 args。 */
  window.__t = (key, ...args) => fill(lookup(ui, key), args);
  /** 就地翻译一个对象里的全部字符串（攻击面说明 RISKS）。 */
  window.__tx = (object) => {
    for (const value of Object.values(object)) {
      for (const key of Object.keys(value)) if (typeof value[key] === 'string') value[key] = lookup(ui, value[key]);
    }
  };
  // 原站按 length × 字宽估算图上文字的宽度。中日韩文字和全角符号约是拉丁字母的两倍宽，按两个算。
  const wide = (code) => (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6);
  window.__len = (value) => {
    const text = String(value);
    let n = text.length;
    for (let i = 0; i < text.length; i++) if (wide(text.charCodeAt(i))) n++;
    return n;
  };
  /** 时序图的消息标签超过 max 宽就截断，和原站的 slice(0, max - 1) + "…" 一样，只是按宽度算。 */
  window.__clip = (label, max) => {
    if (window.__len(label) <= max) return label;
    let out = label;
    while (window.__len(out) > max - 1) out = out.slice(0, -1);
    return `${out}…`;
  };

  // 切换按钮放在主题按钮前面。
  const theme = document.querySelector('header .theme');
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'btn-lang';
  button.lang = zh ? 'en' : 'zh-CN';
  button.textContent = zh ? 'EN' : '中文';
  button.title = zh ? 'Switch to English' : '切换到简体中文';
  button.setAttribute('aria-label', button.title);
  button.addEventListener('click', () => {
    const next = zh ? 'en' : 'zh-CN';
    let saved = false;
    try {
      localStorage.setItem(KEY, next);
      saved = localStorage.getItem(KEY) === next;
    } catch {
      saved = false;
    }
    const url = new URL(location.href);
    if (saved) url.searchParams.delete('lang');
    else url.searchParams.set('lang', next);
    if (url.href === location.href) location.reload();
    else location.replace(url.href);
  });
  theme.prepend(button);
  const style = document.createElement('style');
  style.textContent = '.theme #btn-lang{width:auto;min-width:32px;padding:0 8px;font:500 12px/1 var(--sans);letter-spacing:.02em}';
  document.head.append(style);
  if (!zh) return;

  // ── 以下只在中文模式执行
  document.documentElement.lang = 'zh-CN';
  const cjk = document.createElement('style');
  cjk.textContent = ":root{--sans:'Geist','Inter',system-ui,-apple-system,'PingFang SC','Hiragino Sans GB','Noto Sans CJK SC','Microsoft YaHei',sans-serif;--mono:'Geist Mono',ui-monospace,monospace,'PingFang SC','Hiragino Sans GB','Noto Sans CJK SC','Microsoft YaHei'}";
  document.head.append(cjk);
  // 手机底栏的“日志”按钮很窄，中文会被逐字折成两行。
  cjk.textContent += '#mb-log span{white-space:nowrap}';

  // 课程数据：在渲染器读取之前就地换成中文。
  // 字典里 "字段|原文" 的条目只用在那个字段，比如注释键里的 HTTP 头名 Authorization 不跟着课程名译成“授权”。
  __mcpWalk((text, where) => {
    const scoped = `${where.key}|${text}`;
    return data.has(scoped) ? data.get(scoped) : lookup(data, text);
  });

  // 静态骨架：[选择器, 位置, 英文原文]。位置是属性名，或 text（整段文字）、html、first（第一个文字节点）。
  // 当前值和英文原文不一致时不改，记进 misses，说明上游改了这里。
  const STATIC = [
    ['title', 'text', 'MCP Explained · how the Model Context Protocol works'],
    ['meta[name="description"]', 'content', 'An interactive guide to the Model Context Protocol: every JSON-RPC message on the wire, step by step. Transports, OAuth, tools, resources, sampling, elicitation, tasks, tool search and codemode.'],
    ['.brand .by', 'aria-label', 'by Runlayer'],
    ['#btn-light', 'title', 'Light mode'],
    ['#btn-light', 'aria-label', 'Light mode'],
    ['#btn-dark', 'title', 'Dark mode'],
    ['#btn-dark', 'aria-label', 'Dark mode'],
    ['#left', 'aria-label', 'Lessons'],
    ['#bl-name', 'text', 'Lessons'],
    ['#bv-name', 'text', 'Spec'],
    ['#left .tm', 'aria-label', 'Spec version'],
    ['#left .tmh span', 'text', 'Spec version'],
    ['#variants', 'aria-label', 'Who does it'],
    ['[data-view="network"]', 'text', 'Network'],
    ['[data-view="sequence"]', 'text', 'Sequence'],
    ['#net', 'aria-label', 'Message diagram'],
    ['#seq', 'aria-label', 'Sequence diagram'],
    ['.flow .fh h2', 'first', 'Message flow '],
    ['#btn-play', 'title', 'Play / pause (space)'],
    ['#btn-step', 'title', 'Next message (→)'],
    ['#btn-step', 'first', 'Step'],
    ['#btn-reset', 'title', 'Back to the start'],
    ['#btn-reset', 'text', 'Reset'],
    ['#flowt thead th:nth-child(2)', 'text', 'From'],
    ['#flowt thead th:nth-child(3)', 'text', 'To'],
    ['#flowt thead th:nth-child(4)', 'text', 'Method'],
    ['#flowt thead th:nth-child(5)', 'text', 'Info'],
    ['#right', 'aria-label', 'Overview'],
    ['#ov-ns .nstag', 'text', 'Not in the MCP spec'],
    ['#ov-ns p', 'html', 'A harness implementation detail, not part of MCP. Nothing new on the wire: the client and servers still speak plain <code>tools/list</code> and <code>tools/call</code>.'],
    ['.insp-h h2', 'text', 'Message'],
    ['#right .foot', 'html', 'MCP spec 2025-11-25. Token counts are illustrative.<br>Made by <a href="https://runlayer.com" target="_blank" rel="noopener">Runlayer</a>, the operating layer for AI. <a href="https://github.com/Runlayer/mcp-explained" target="_blank" rel="noopener">Source</a>.'],
    ['#mbar', 'aria-label', 'Playback'],
    ['#mb-prev', 'aria-label', 'Previous message'],
    ['#mb-next', 'aria-label', 'Next message'],
    ['#mb-log span', 'text', 'Log'],
  ];
  for (const [selector, where, en] of STATIC) {
    const node = document.querySelector(selector);
    const target = where === 'first' ? node?.firstChild : node;
    const current = !target ? undefined : where === 'text' || where === 'first' ? target.textContent : where === 'html' ? target.innerHTML : target.getAttribute(where);
    if (current !== en) {
      misses.push(`页面骨架 ${selector} ${where}`);
      continue;
    }
    const text = lookup(ui, en);
    if (where === 'text' || where === 'first') target.textContent = text;
    else if (where === 'html') target.innerHTML = text;
    else target.setAttribute(where, text);
  }
})();

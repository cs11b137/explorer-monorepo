// 把 MCP Explained（Runlayer）镜像接入主站，并叠加简体中文。
//
// modules/mcp/site/ 是上游 public/ 的逐字节镜像，永远不动。提供给浏览器的 index.html 是在它的副本上做几处替换得到的：
//   1. favicon 改成相对路径，部署到子路径也能找到；
//   2. 在原站的数据脚本和渲染器之间插入翻译叠加层（字典 + modules/mcp/src 下的两个脚本）；
//   3. 渲染器里的界面文字换成 __t(...) 调用。英文模式下 __t 原样返回英文，页面和原站一致。
// 每处替换都核对命中次数。上游改版后对不上，构建直接失败，不会部署一个半翻译的坏站。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';

const PAGE_DIR = 'modules/mcp';

/** 在原站页面上做的替换：[原文, 替换, 应命中次数]。 */
export const PATCHES: ReadonlyArray<readonly [string, string, number]> = [
  ['<link rel="icon" href="/favicon.svg"', '<link rel="icon" href="favicon.svg"', 1],
  // 图上的文字宽度按字符数估算。中文字宽约是拉丁字母的两倍，按两个字符算；纯英文时结果不变。
  ['String(s).length * px', '__len(s) * px', 1],
  ['z.label.length * 8.9', '__len(z.label) * 8.9', 2],
  ['z.sub.length * 7.6', '__len(z.sub) * 7.6', 1],
  ['label.length > 44 ? label.slice(0, 43) + "…" : label', '__clip(label, 44)', 1],
  [
    'const KIND = { req: "Request", res: "Result", err: "Error", note: "Notification", http: "Transport", host: "In the host" };',
    'const KIND = { req: __t("Request"), res: __t("Result"), err: __t("Error"), note: __t("Notification"), http: __t("Transport"), host: __t("In the host") };',
    1,
  ],
  [
    '{ title: "Not in this version", desc: `${l.code} arrived in ${since}. Move the timeline forward to see it.`, msgs: [] }',
    '{ title: __t("Not in this version"), desc: __t("{0} arrived in {1}. Move the timeline forward to see it.", l.code, since), msgs: [] }',
    1,
  ],
  ['const riskOf = (m, L) => {', '__tx(RISKS);\nconst riskOf = (m, L) => {', 1],
  ['aria-label="Attack surface: ${RISKS[k].title}"', 'aria-label="${__t("Attack surface: {0}", RISKS[k].title)}"', 1],
  // 课程列表
  ['` <i class="deptag">deprecated</i>`', '` <i class="deptag">${__t("deprecated")}</i>`', 2],
  ['"extension" : l.tag', '__t("extension") : l.tag', 1],
  ['`<s>${esc(method)}</s> <i class="deptag">deprecated</i>`', '`<s>${esc(method)}</s> <i class="deptag">${__t("deprecated")}</i>`', 1],
  [`' <i class="deptag">deprecated</i>'`, `' <i class="deptag">' + __t("deprecated") + '</i>'`, 1],
  [`' <i class="depsome">has deprecated parts</i>'`, `' <i class="depsome">' + __t("has deprecated parts") + '</i>'`, 1],
  ['"Arrives in " + since', '__t("Arrives in {0}", since)', 1],
  [`<div class="gh wn">What's next</div>`, `<div class="gh wn">\${__t("What's next")}</div>`, 1],
  ['"Lessons. Current: " + st.lesson.code', '__t("Lessons. Current: {0}", st.lesson.code)', 1],
  // 概览
  ['` <span class="deptag">Deprecated in ${DEPRECATED_IN[L.id]}</span>`', '` <span class="deptag">${__t("Deprecated in {0}", DEPRECATED_IN[L.id])}</span>`', 1],
  ['"Read more" : "Spec"', '__t("Read more") : __t("Spec")', 1],
  ['(st.version === "2024-11-05" ? "Spec " : "Changelog ") + st.version + " ↗"', '__t(st.version === "2024-11-05" ? "Spec {0}" : "Changelog {0}", st.version) + " ↗"', 1],
  [
    '<span class="nexttag">Not in ${st.version}</span><ul><li>${esc(L.code)} arrived in ${esc(L.absent)}.</li></ul>',
    '<span class="nexttag">${__t("Not in {0}", st.version)}</span><ul><li>${esc(__t("{0} arrived in {1}.", L.code, L.absent))}</li></ul>',
    1,
  ],
  ['<span class="nexttag">In ${st.version}</span>', '<span class="nexttag">${__t("In {0}", st.version)}</span>', 2],
  ['<li>No changes to this lesson worth showing; the flow matches 2025-11-25.</li>', '<li>${__t("No changes to this lesson worth showing; the flow matches 2025-11-25.")}</li>', 1],
  ['<span class="nexttag">What changes in ${NEXT}</span>', '<span class="nexttag">${__t("What changes in {0}", NEXT)}</span>', 1],
  ['ext(NEXT_URL + "/changelog", "Changelog ↗")', 'ext(NEXT_URL + "/changelog", __t("Changelog") + " ↗")', 1],
  ['<span class="wiptag">In progress</span>', '<span class="wiptag">${__t("In progress")}</span>', 1],
  // 检查器、标题、弹窗
  ['<p class="empty">Press <b>Play</b> or <b>Step</b> to send the first message.</p>', '<p class="empty">${__t("Press <b>Play</b> or <b>Step</b> to send the first message.")}</p>', 1],
  ['<span class="deptag">Deprecated</span>', '<span class="deptag">${__t("Deprecated")}</span>', 2],
  ['<b>Attack surface: ${esc(RISKS[m.risk].title)}.</b>', '<b>${esc(__t("Attack surface: {0}.", RISKS[m.risk].title))}</b>', 1],
  ['See the attack →', '${__t("See the attack →")}', 2],
  ['Step ${i + 1} of ${L.steps.length}', '${__t("Step {0} of {1}", i + 1, L.steps.length)}', 1],
  // 网络图和时序图
  ['class="pdep">DEPRECATED</text>', 'class="pdep">${__t("DEPRECATED")}</text>', 1],
  ['<tspan class="sdep">DEPRECATED </tspan>', '<tspan class="sdep">${__t("DEPRECATED")} </tspan>', 1],
  // 播放控制、时间线、变体
  ['`${MSGS.length} messages · ${st.lesson.steps.length} steps`', '__t("{0} messages · {1} steps", MSGS.length, st.lesson.steps.length)', 1],
  ['st.playing ? "Pause" : atEnd ? "Replay" : "Play"', '__t(st.playing ? "Pause" : atEnd ? "Replay" : "Play")', 1],
  ['"Next lesson: " + nxt.code', '__t("Next lesson: {0}", nxt.code)', 1],
  ['</svg>Pause`', '</svg>${__t("Pause")}`', 1],
  ['${st.idx >= MSGS.length - 1 && st.idx >= 0 ? "Replay" : "Play"}', '${__t(st.idx >= MSGS.length - 1 && st.idx >= 0 ? "Replay" : "Play")}', 1],
  ['$("#bv-name").textContent = "Spec " + st.version;', '$("#bv-name").textContent = __t("Spec {0}", st.version);', 1],
  ['" · latest" : st.version === SPEC ? " · default" : ""', '" · " + __t("latest") : st.version === SPEC ? " · " + __t("default") : ""', 1],
  ['"The client does this itself, no gateway" : "Runlayer does this in the gateway"', '__t("The client does this itself, no gateway") : __t("Runlayer does this in the gateway")', 1],
  ['$("#bl-name").textContent = on ? "Close" : st.lesson.code;', '$("#bl-name").textContent = on ? __t("Close") : st.lesson.code;', 1],
];

/** 叠加层插在原站的数据脚本和渲染器之间：数据已经定义好，渲染器还没开始画。 */
export const INSERT_AT = '</script>\n<script>(() => {';

export interface Translations {
  /** 课程数据里的讲解文字：英文原文 → 中文。 */
  data: Record<string, string>;
  /** 界面文字，{0}、{1} 是占位符。 */
  ui: Record<string, string>;
}

const count = (text: string, part: string) => text.split(part).length - 1;

/** 由原站页面生成实际提供的页面。上游对不上时抛错。 */
export function buildPage(html: string, translations: Translations, runtime: string): string {
  const problems: string[] = [];
  let out = html;
  for (const [from, to, times] of PATCHES) {
    const found = count(out, from);
    if (found !== times) problems.push(`应命中 ${times} 次，实际 ${found} 次：${from}`);
    out = out.split(from).join(to);
  }
  if (count(out, INSERT_AT) !== 1) problems.push(`插入点应该正好有一个：${JSON.stringify(INSERT_AT)}`);
  if (problems.length) throw new Error(`MCP Explained 镜像和翻译补丁对不上，可能是上游改版了：\n${problems.join('\n')}`);
  // 字典里的 < 转义成 \u003c，译文里出现 </script> 也不会提前结束脚本。
  const json = JSON.stringify(translations).replace(/</g, '\\u003c');
  const overlay = `</script>\n<script>window.__MCP_I18N__ = ${json};\n${runtime.replace(/<\/script/gi, '<\\/script')}</script>\n<script>(() => {`;
  return out.replace(INSERT_AT, () => overlay);
}

/** 读取模块目录里的字典和运行时脚本。 */
export function loadOverlay(moduleDir: string): { translations: Translations; runtime: string } {
  const read = (path: string) => readFileSync(join(moduleDir, path), 'utf8');
  return {
    translations: { data: JSON.parse(read('i18n/zh-CN.json')), ui: JSON.parse(read('i18n/ui.zh-CN.json')) },
    runtime: `${read('src/walk.js')}\n${read('src/i18n.js')}`,
  };
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export function mcpMirror(root: string): Plugin {
  const moduleDir = resolve(root, PAGE_DIR);
  const site = join(moduleDir, 'site');
  const manifest = JSON.parse(readFileSync(join(moduleDir, 'MANIFEST.json'), 'utf8')) as { files: Array<{ path: string }> };
  const files = manifest.files.map((file) => file.path);
  const page = () => {
    const { translations, runtime } = loadOverlay(moduleDir);
    return buildPage(readFileSync(join(site, 'index.html'), 'utf8'), translations, runtime);
  };
  let base = '/';

  return {
    name: 'mcp-mirror',
    configResolved(config) {
      base = config.base;
    },
    buildStart() {
      for (const path of files) {
        if (existsSync(join(root, 'public', PAGE_DIR, path))) this.error(`public/${PAGE_DIR}${path} 和 MCP Explained 镜像占用了同一个路径`);
      }
      try {
        page();
      } catch (error) {
        this.error((error as Error).message);
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const full = req.url?.split('?')[0] ?? '';
        const prefix = `${base}${PAGE_DIR}/`;
        if (!full.startsWith(prefix)) return next();
        const path = `/${full.slice(prefix.length)}`;
        if (path === '/' || path === '/index.html') {
          res.setHeader('Content-Type', TYPES['.html']);
          res.end(page());
          return;
        }
        if (!files.includes(path) || path === '/index.html') return next();
        res.setHeader('Content-Type', TYPES[extname(path)] ?? 'application/octet-stream');
        res.end(readFileSync(join(site, path)));
      });
    },
    writeBundle(options) {
      const outDir = join(options.dir ?? resolve(root, 'dist'), PAGE_DIR);
      mkdirSync(outDir, { recursive: true });
      for (const path of files) {
        const target = join(outDir, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, path === '/index.html' ? page() : readFileSync(join(site, path)));
      }
    },
  };
}

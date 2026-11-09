// 在 node:vm 里执行原站的数据脚本和 src/walk.js，收集所有需要翻译的讲解文字。不碰 DOM，不联网。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_START = '<script>// MCP Explainer lesson data.';

/** 原站页面里的数据脚本（不含 <script> 标签）。 */
export function dataScript(html) {
  const start = html.indexOf(DATA_START);
  if (start < 0 || html.indexOf(DATA_START, start + 1) >= 0) throw new Error('原站页面里应该正好有一个数据脚本');
  return html.slice(start + '<script>'.length, html.indexOf('</script>', start));
}

/** 按页面中出现的顺序返回 [{ en, where: ['lesson · key', …] }]。 */
export function collectStrings(html = readFileSync(join(ROOT, 'site/index.html'), 'utf8')) {
  const found = new Map();
  const context = vm.createContext({});
  vm.runInContext(dataScript(html), context);
  vm.runInContext(readFileSync(join(ROOT, 'src/walk.js'), 'utf8'), context);
  context.__mcpWalk((text, where) => {
    const place = `${where.lesson} · ${where.key}`;
    const entry = found.get(text) ?? { en: text, where: [] };
    if (!entry.where.includes(place)) entry.where.push(place);
    found.set(text, entry);
    return text;
  });
  return [...found.values()];
}

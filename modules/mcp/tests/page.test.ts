import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import { buildPage, INSERT_AT, loadOverlay, PATCHES } from '../../../scripts/mcp-mirror';
import { collectStrings, dataScript } from '../scripts/strings.mjs';

const MODULE = join(import.meta.dirname, '..');
const html = readFileSync(join(MODULE, 'site/index.html'), 'utf8');
const { translations, runtime } = loadOverlay(MODULE);
const { data, ui } = translations;
const strings = collectStrings(html);
const CJK = /[一-鿿]/;

describe('生成页面', () => {
  const page = buildPage(html, translations, runtime);

  test('叠加层插在数据脚本和渲染器之间', () => {
    const data = page.indexOf('<script>// MCP Explainer lesson data.');
    const overlay = page.indexOf('<script>window.__MCP_I18N__ = ');
    const renderer = page.indexOf('<script>(() => {');
    expect(data).toBeGreaterThan(0);
    expect(overlay).toBeGreaterThan(data);
    expect(renderer).toBeGreaterThan(overlay);
    expect(page.indexOf('</script>', data)).toBeLessThan(overlay);
  });

  test('除了补丁和叠加层，其他字节都和原站一样', () => {
    // 把生成页面里的叠加层去掉、补丁还原，必须得到原文件。
    const start = page.indexOf('<script>window.__MCP_I18N__ = ');
    const end = page.indexOf('</script>\n', start) + '</script>\n'.length;
    let restored = page.slice(0, start) + page.slice(end);
    expect(restored.includes(INSERT_AT)).toBe(true);
    for (const [from, to] of [...PATCHES].reverse()) restored = restored.split(to).join(from);
    expect(restored).toBe(html);
  });

  test('favicon 用相对路径，页面不再引用任何根路径', () => {
    expect(page).toContain('<link rel="icon" href="favicon.svg"');
    expect(page).not.toMatch(/\b(?:href|src)="\/(?!\/)/);
  });

  test('字典里的 </script> 不会提前结束脚本', () => {
    const tricky = buildPage(html, { data: { x: '</script><b>' }, ui }, runtime);
    const start = tricky.indexOf('<script>window.__MCP_I18N__ = ');
    expect(tricky.indexOf('</script>', start)).toBe(tricky.indexOf('</script>\n<script>(() => {', start));
  });

  test('上游改版、补丁对不上时直接报错', () => {
    expect(() => buildPage(html.replace('"Arrives in " + since', '"Since " + since'), translations, runtime)).toThrow(/Arrives in/);
    expect(() => buildPage(html.replace(INSERT_AT, '</script><script>(() => {'), translations, runtime)).toThrow(/插入点/);
  });

  test('渲染器拼出的 HTML 里不再有写死的英文', () => {
    const renderer = page.slice(page.indexOf('<script>(() => {'));
    const words = [...renderer.matchAll(/>([A-Za-z][A-Za-z ']*)</g)].map((match) => match[1]);
    // 只剩 __t("Press <b>Play</b> or <b>Step</b> …") 这个键里的两个词。
    expect(words).toEqual(['Play', 'Step']);
  });

  test('生成的脚本都能解析', () => {
    for (const match of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new vm.Script(match[1])).not.toThrow();
  });
});

describe('课程数据的译文', () => {
  test('每条讲解文字都有译文，字典里没有多余的键', () => {
    const wanted = new Set(strings.flatMap((entry) => [entry.en, ...entry.where.map((place) => `${place.split(' · ')[1]}|${entry.en}`)]));
    expect(strings.filter((entry) => !(entry.en in data)).map((entry) => entry.en)).toEqual([]);
    expect(Object.keys(data).filter((key) => !wanted.has(key))).toEqual([]);
  });

  test('课程名、摘要、步骤说明都是中文', () => {
    const prose = strings.filter((entry) => entry.where.some((place) => / · (?:name|summary|desc)$/.test(place)));
    expect(prose.length).toBeGreaterThan(250);
    expect(prose.filter((entry) => !CJK.test(data[entry.en])).map((entry) => entry.en)).toEqual([]);
  });

  test('译文保留原文里的方法名、字段名、版本号和规范关键词', () => {
    // 这几条是有意的：WG 译成“工作组”，斜杠连接的英文词译成中文，Name/version 写成字段名 name/version。
    const allowed = new Set(['Name/version', 'WG', 'tool/input', 'cost/speed/intelligence', '2026-07-28-only']);
    const tokens = (text: string) =>
      text
        .split(/\s+/)
        .map((word) => word.replace(/^[("'“‘[]+|[.,;:!?)"'”’\]]+$/g, ''))
        .filter((word) => word && !allowed.has(word) && (/[/_{}<>@=]|[a-z][A-Z]|^-?\d|^\$/.test(word) || /^(?:MUST|SHOULD|MAY|NOT|REQUIRED|OPTIONAL)$/.test(word)));
    const lost = strings.flatMap((entry) => tokens(entry.en).filter((token) => !data[entry.en].includes(token)).map((token) => `${token} ← ${entry.en}`));
    expect(lost).toEqual([]);
  });

  test('注释键里的 HTTP 头 Authorization 保持英文，课程名照常翻译', () => {
    expect(data['notes.key|Authorization']).toBe('Authorization');
    expect(data.Authorization).toBe('授权');
  });

  test('线上报文不在待译文字里', () => {
    const context = vm.createContext({});
    vm.runInContext(dataScript(html), context);
    const texts = new Set(strings.map((entry) => entry.en));
    // overview 第一步：工具描述是报文的一部分，不翻译；步骤标题和 Info 列要翻译。
    const first = vm.runInContext('LESSONS[0].steps[0]', context);
    expect(texts.has(first.title)).toBe(true);
    expect(texts.has(first.msgs[0].info)).toBe(true);
    expect(texts.has('Open a new issue in a repository.')).toBe(false);
  });
});

describe('界面文字的译文', () => {
  const sources = [readFileSync(join(MODULE, '../../scripts/mcp-mirror.ts'), 'utf8'), readFileSync(join(MODULE, 'src/i18n.js'), 'utf8')].join('\n');
  const risks = vm.runInNewContext(`(${html.slice(html.indexOf('const RISKS = {') + 'const RISKS = '.length, html.indexOf('\n};', html.indexOf('const RISKS = {')) + 2)})`) as Record<string, { title: string; text: string }>;
  const used = new Set<string>([
    // __t("…") 和三元表达式 __t(a ? "…" : "…") 里的每个字面量
    ...[...sources.matchAll(/__t\(((?:"(?:[^"\\]|\\.)*"|[^()",])*)/g)]
      .flatMap((match) => [...match[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((part) => JSON.parse(`"${part[1]}"`) as string))
      // 三元表达式的条件里有版本号比较，不是文字。
      .filter((text) => !/^\d{4}-\d{2}-\d{2}$/.test(text)),
    // 页面骨架表 STATIC 的第三列
    ...[...sources.matchAll(/^\s+\['[^']+', '[^']+', '((?:[^'\\]|\\.)*)'\],$/gm)].map((match) => match[1].replace(/\\'/g, "'")),
    ...Object.values(risks).flatMap((risk) => [risk.title, risk.text]),
  ]);

  test('用到的每条界面文字都有译文，字典里没有多余的键', () => {
    expect(used.size).toBeGreaterThan(70);
    expect([...used].filter((key) => !(key in ui))).toEqual([]);
    expect(Object.keys(ui).filter((key) => !used.has(key))).toEqual([]);
  });

  test('占位符一一对应，原文的 HTML 标签都还在', () => {
    const all = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match[0]).sort();
    for (const [en, zh] of Object.entries(ui)) {
      expect(all(zh, /\{\d+\}/g), en).toEqual(all(en, /\{\d+\}/g));
      // 页脚在译文里多一句“简体中文译本”，所以只要求原文的标签一个不少。
      const tags = all(zh, /<\/?[a-z]+/g);
      for (const tag of all(en, /<\/?[a-z]+/g)) {
        expect(tags, en).toContain(tag);
        tags.splice(tags.indexOf(tag), 1);
      }
    }
  });

  test('链接地址原样保留', () => {
    const links = (text: string) => [...text.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    for (const [en, zh] of Object.entries(ui)) for (const link of links(en)) expect(links(zh), en).toContain(link);
  });
});

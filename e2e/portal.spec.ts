import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { mirrorUrl, rewriteMirror } from '../scripts/protocol-mirror';
import { LESSONS as agent } from '../modules/agent/src/lessons';
import { LESSONS as algo } from '../modules/algo/src/lessons';
import { LESSONS as codegen } from '../modules/codegen/src/lessons';
import { LESSONS as context } from '../modules/context/src/lessons';
import { LESSONS as cpu } from '../modules/cpu/src/lessons';
import { LESSONS as db } from '../modules/db/src/lessons';
import { LESSONS as llm } from '../modules/llm/src/lessons';
import { LESSONS as llmops } from '../modules/llmops/src/lessons';
import { LESSONS as os } from '../modules/os/src/lessons';
import { LESSONS as rag } from '../modules/rag/src/lessons';

const MODULES = ['protocol', 'os', 'algo', 'codegen', 'cpu', 'db', 'llm', 'context', 'rag', 'agent', 'llmops', 'mcp'];
/** 两个镜像不用引擎：课程列表的选择器不同，也没有引擎模块的品牌区和 manifest。 */
const MIRRORS = ['protocol', 'mcp'];
const LESSON_ITEM: Record<string, string> = { mcp: '#list .li' };

/** 每个模块的课数。引擎模块直接取各自的 LESSONS，加课不用改这里；Protocol 和 MCP Explained 是镜像，固定 14 课和 23 课。 */
const LESSON_COUNTS: Record<string, number> = { protocol: 14, os: os.length, algo: algo.length, codegen: codegen.length, cpu: cpu.length, db: db.length, llm: llm.length, context: context.length, rag: rag.length, agent: agent.length, llmops: llmops.length, mcp: 23 };

test('首页没有资源错误，也不横向溢出', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
  });
  await page.goto('./');
  await expect(page.locator('.course')).toHaveCount(MODULES.length);
  await expect.poll(() => page.locator('.course img').evaluateAll((images) => images.every((image) => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await page.setViewportSize({ width: 390, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(problems).toEqual([]);
});

for (const name of MODULES) {
  test(`从首页进入 ${name} 模块`, async ({ page }) => {
    const problems: string[] = [];
    const context = page.context();
    context.on('weberror', (error) => problems.push(error.error().message));
    context.on('response', (response) => {
      if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
    });
    await page.goto('./');
    const [course] = await Promise.all([context.waitForEvent('page'), page.click(`.course[data-module="${name}"]`)]);
    await expect(course).toHaveURL(`modules/${name}/`);
    await expect(course.locator(LESSON_ITEM[name] ?? '.proto')).toHaveCount(LESSON_COUNTS[name]);
    await expect(page).toHaveURL('./');
    expect(problems).toEqual([]);
  });
}

test('首页可以切换浅色和深色主题，刷新后保留选择', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('./');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('[data-theme-choice="dark"]')).toHaveAttribute('aria-pressed', 'true');
  const darkBg = await page.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor);

  await page.click('[data-theme-choice="light"]');
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('[data-theme-choice="light"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('body')).not.toHaveCSS('background-color', darkBg);

  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.goto('404.html');
  await expect(html).toHaveAttribute('data-theme', 'light');
});

test('课程可以按分类筛选', async ({ page }) => {
  await page.goto('./');
  const visible = page.locator('.course:visible');
  await expect(page.locator('[data-filter="all"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-filter="all"] .count')).toHaveText(String(MODULES.length));
  await expect(visible).toHaveCount(MODULES.length);

  const expected: Record<string, string[]> = { system: ['cpu', 'os', 'codegen'], 'network-data': ['protocol', 'db'], algorithm: ['algo'], ai: ['llm', 'context', 'rag', 'agent', 'mcp', 'llmops'] };
  for (const [filter, modules] of Object.entries(expected)) {
    await page.click(`[data-filter="${filter}"]`);
    await expect(page.locator(`[data-filter="${filter}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(`[data-filter="${filter}"] .count`)).toHaveText(String(modules.length));
    await expect(visible).toHaveCount(modules.length);
    expect(await visible.evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.module))).toEqual(modules);
  }
  await page.click('[data-filter="all"]');
  await expect(visible).toHaveCount(MODULES.length);
});

test('课程链接在新标签页打开', async ({ page }) => {
  await page.goto('./');
  for (const course of await page.locator('.course').all()) {
    await expect(course).toHaveAttribute('target', '_blank');
    await expect(course).toHaveAttribute('rel', /noopener/);
  }
});

for (const name of MODULES.filter((module) => !MIRRORS.includes(module))) {
  test(`${name} 模块的品牌区回到首页`, async ({ page }) => {
    await page.goto(`modules/${name}/`);
    await page.click('a.brand');
    await expect(page).toHaveURL('./');
    await expect(page.locator('.course')).toHaveCount(MODULES.length);
  });

  test(`${name} 模块的 manifest 和图标都能加载`, async ({ request }) => {
    const manifest = await (await request.get(`modules/${name}/site.webmanifest`)).json();
    expect(manifest.start_url).toBe('./');
    expect((await request.get(`modules/${name}/${manifest.icons[0].src}`)).status()).toBe(200);
  });
}

test('不带斜杠的模块地址也能进入', async ({ page }) => {
  await page.goto('modules/os?x=1');
  await expect(page).toHaveURL('modules/os/?x=1');
  await expect(page.locator('.proto')).toHaveCount(LESSON_COUNTS.os);
  await page.goto('modules/protocol');
  await expect(page).toHaveURL('modules/protocol/');
  await expect(page.locator('.proto')).toHaveCount(LESSON_COUNTS.protocol);
  await page.goto('modules/mcp');
  await expect(page).toHaveURL('modules/mcp/');
  await expect(page.locator(LESSON_ITEM.mcp)).toHaveCount(LESSON_COUNTS.mcp);
});

test('不存在的地址返回 404，不会落回首页', async ({ request }) => {
  expect((await request.get('modules/nope/')).status()).toBe(404);
});

test('404 页面能加载样式，并能回到首页', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
  });
  await page.goto('404.html');
  await expect(page.locator('h1')).toHaveText('404');
  await expect(page.locator('body')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  expect(problems).toEqual([]);
  await page.click('.portal-head a');
  await expect(page).toHaveURL('./');
  await expect(page.locator('.course')).toHaveCount(MODULES.length);
});

test('部署的 Protocol 镜像只改动了路径，二进制文件逐字节不变', async ({ request, baseURL }) => {
  const base = new URL(baseURL!).pathname;
  const manifest = JSON.parse(readFileSync('modules/protocol/MANIFEST.json', 'utf8')) as { files: Array<{ path: string; sha256: string }> };
  for (const file of manifest.files) {
    const source = readFileSync(`modules/protocol/site${file.path}`);
    expect(createHash('sha256').update(source).digest('hex'), file.path).toBe(file.sha256);
    const url = mirrorUrl(file.path).slice(1);
    const response = await request.get(url);
    expect(response.status(), url).toBe(200);
    expect(Buffer.compare(await response.body(), rewriteMirror(file.path, source, base)), url).toBe(0);
  }
});

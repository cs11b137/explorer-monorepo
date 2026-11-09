import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const ORIGINAL = readFileSync('modules/mcp/site/index.html', 'utf8');
const VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28'];
const LESSONS = 23;
const KEY = 'mcp-explained:lang';

/** 记录所有异常：请求失败、访问外部域名、控制台报错。镜像必须完全自给自足。 */
function watch(page: Page) {
  const problems: string[] = [];
  page.on('requestfailed', (request) => problems.push(`失败 ${request.url()}`));
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') && url.hostname !== 'localhost') problems.push(`外部请求 ${request.url()}`);
  });
  page.on('pageerror', (error) => problems.push(`异常 ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`控制台 ${message.text()}`);
  });
  return problems;
}

/** 原始的上游页面，挂在同一目录下的另一个地址上，作为英文模式的对照。 */
async function openOriginal(page: Page, hash: string) {
  await page.route('**/modules/mcp/original.html', (route) => route.fulfill({ body: ORIGINAL, contentType: 'text/html; charset=utf-8' }));
  await page.goto(`original.html${hash}`);
}

async function setLang(page: Page, lang: 'en' | 'zh-CN') {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [KEY, lang]);
}

interface Snapshot {
  key: string;
  html: string;
  json: string;
}

/**
 * 在当前规范版本下，依次打开每一课、每个变体，一步步走到最后，记录每一步界面上的全部文字。
 * 列表、概览、检查器、消息表、时间线比较 innerHTML（连 title、aria-label 一起比）；图只比文字，动画的坐标每次不同。
 */
function traverse(page: Page): Promise<Snapshot[]> {
  return page.evaluate(() => {
    const $ = (selector: string) => document.querySelector(selector) as HTMLElement;
    const html = () =>
      ['#list', '#ov-title', '#ov-name', '#ov-sum', '#ov-facts', '#ov-more', '#caption', '#tbody', '#insp', '#variants', '#tm-cur', '#tm-line', '#flowcount', '#btn-play', '#bl-name', '#bv-name', '#mb-count', '#mb-lname']
        .map((selector) => `${selector}=${$(selector).innerHTML}`)
        .concat(['#btn-lessons', '#mb-play', '#mb-lesson'].map((selector) => `${selector}=${$(selector).getAttribute('aria-label')}`))
        .concat(`#net=${$('#net').textContent}`)
        .join('\n');
    const out: Array<{ key: string; html: string; json: string }> = [];
    const record = (key: string) => out.push({ key, html: html(), json: $('#insp pre.json')?.textContent ?? '' });
    const lessons = [...document.querySelectorAll<HTMLElement>('#list .lh[data-l]')].map((button) => button.dataset.l!);
    for (const lesson of lessons) {
      $(`#list .lh[data-l="${lesson}"]`).click();
      const variants = [...document.querySelectorAll<HTMLElement>('#variants [data-variant]')].map((button) => button.dataset.variant!);
      for (const variant of variants.length ? variants : ['']) {
        if (variant) $(`#variants [data-variant="${variant}"]`).click();
        const key = `${lesson}${variant ? `:${variant}` : ''}`;
        record(`${key} 开始`);
        for (let step = 1; !($('#btn-step') as HTMLButtonElement).disabled; step++) {
          $('#btn-step').click();
          record(`${key} #${step}`);
        }
        $('[data-view="sequence"]').click();
        out.push({ key: `${key} 时序图`, html: $('#seq').textContent ?? '', json: '' });
        $('[data-view="network"]').click();
      }
    }
    return out;
  });
}

test('默认简体中文，页面加载后不依赖任何外部资源', async ({ page }) => {
  const problems = watch(page);
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('#list .li')).toHaveCount(LESSONS);
  await expect(page).toHaveTitle('MCP Explained · 看懂 Model Context Protocol 如何工作');
  await expect(page.locator('#ov-title')).toHaveText('MCP 是什么？');
  await expect(page.locator('#btn-play')).toHaveText('播放');
  await expect(page.locator('#btn-lang')).toHaveText('EN');
  expect(await page.evaluate(() => (window as unknown as { __MCP_I18N__: { misses: string[] } }).__MCP_I18N__.misses)).toEqual([]);
  await page.waitForTimeout(500);
  expect(problems).toEqual([]);
});

for (const version of VERSIONS) {
  test(`英文模式和原站逐字一致：规范 ${version} 的全部课程和步骤`, async ({ page }) => {
    await setLang(page, 'en');
    const problems = watch(page);
    await page.goto(`./#overview@${version}`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    const ours = await traverse(page);
    expect(problems).toEqual([]);

    const original = await page.context().newPage();
    await openOriginal(original, `#overview@${version}`);
    const theirs = await traverse(original);

    expect(ours.length).toBeGreaterThan(LESSONS * 5);
    expect(ours.map((item) => item.key)).toEqual(theirs.map((item) => item.key));
    for (let i = 0; i < ours.length; i++) expect(ours[i].html, ours[i].key).toBe(theirs[i].html);
  });

  test(`中文模式全部译出，线上报文和英文一致：规范 ${version}`, async ({ page }) => {
    const problems = watch(page);
    await page.goto(`./#overview@${version}`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    const zh = await traverse(page);
    expect(await page.evaluate(() => (window as unknown as { __MCP_I18N__: { misses: string[] } }).__MCP_I18N__.misses)).toEqual([]);
    expect(problems).toEqual([]);

    const english = await page.context().newPage();
    await openOriginal(english, `#overview@${version}`);
    const en = await traverse(english);
    expect(zh.map((item) => item.key)).toEqual(en.map((item) => item.key));
    for (let i = 0; i < zh.length; i++) expect(zh[i].json, zh[i].key).toBe(en[i].json);
    // 概览摘要每课都是中文。
    const summaries = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#list .lh[data-l]')].map((button) => (button.click(), document.querySelector('#ov-sum')!.textContent ?? '')));
    expect(summaries.filter((text) => !/[一-鿿]/.test(text))).toEqual([]);
  });
}

test('切换语言后刷新，记住选择，当前课和规范版本不变', async ({ page }) => {
  await page.goto('./#auth@2025-03-26');
  await expect(page.locator('#ov-title')).toHaveText('授权');
  await expect(page.locator('#bv-name')).toHaveText('规范 2025-03-26');
  await page.click('#btn-lang');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#btn-lang')).toHaveText('中文');
  await expect(page.locator('#ov-title')).toHaveText('Authorization');
  await expect(page.locator('#bv-name')).toHaveText('Spec 2025-03-26');
  expect(new URL(page.url()).hash).toBe('#auth@2025-03-26');
  expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBe('en');

  await page.reload();
  await expect(page.locator('#ov-title')).toHaveText('Authorization');
  await page.click('#btn-lang');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('#ov-title')).toHaveText('授权');
  expect(new URL(page.url()).hash).toBe('#auth@2025-03-26');
});

test('存不了 localStorage 时，用地址参数记住语言', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('blocked');
      },
    });
  });
  await page.goto('./#tools');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await page.click('#btn-lang');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(new URL(page.url()).searchParams.get('lang')).toBe('en');
  expect(new URL(page.url()).hash).toBe('#tools');
});

test('原站的交互照常：快捷键、时序图、风险弹窗、版本时间线', async ({ page }) => {
  const problems = watch(page);
  await page.goto('./#tools');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#mb-count')).toHaveText('3/' + (await page.locator('#tbody tr').count()));
  await expect(page.locator('#insp .ir')).toContainText('宿主内部');
  // 工具列表的结果上有“工具投毒”的风险提示。
  await page.locator('#tbody .risk').first().click();
  await expect(page.locator('#riskpop')).toBeVisible();
  await expect(page.locator('#riskpop b')).toHaveText('工具投毒');
  await page.keyboard.press('Escape');
  await expect(page.locator('#riskpop')).toBeHidden();
  await page.click('[data-view="sequence"]');
  await expect(page.locator('#seqwrap')).toBeVisible();
  await page.click('[data-view="network"]');
  await page.click('#tm-line [data-ver="2024-11-05"]');
  await expect(page).toHaveURL(/#tools@2024-11-05$/);
  await expect(page.locator('#tm-cur')).toHaveText('2024-11-05');
  await expect(page.locator('#tm-line [data-ver="2024-11-05"] span')).toHaveText('2024.11');
  await page.click('#btn-reset');
  await expect(page.locator('#insp .empty')).toContainText('发出第一条消息');
  expect(problems).toEqual([]);
});

test('手机宽度下不横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('./#transports');
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('镜像的文件逐字节提供', async ({ request }) => {
  const manifest = JSON.parse(readFileSync('modules/mcp/MANIFEST.json', 'utf8')) as { files: Array<{ path: string }> };
  for (const file of manifest.files.filter((item) => item.path !== '/index.html')) {
    const response = await request.get(file.path.slice(1));
    expect(response.status(), file.path).toBe(200);
    expect(Buffer.compare(await response.body(), readFileSync(`modules/mcp/site${file.path}`)), file.path).toBe(0);
  }
  expect((await request.get('favicon.svg')).headers()['content-type']).toContain('image/svg+xml');
});

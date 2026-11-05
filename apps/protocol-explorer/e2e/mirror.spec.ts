import { expect, test } from '@playwright/test';

const LANGUAGES = ['en', 'es', 'pt', 'fr', 'de', 'tr', 'uk', 'id', 'ja', 'zh', 'zh-TW', 'ko', 'hi', 'ar', 'he'];

/** 记录所有异常：请求失败、访问外部域名、控制台报错。镜像必须完全自给自足。 */
function watch(page: import('@playwright/test').Page) {
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

test('页面加载后不依赖任何外部资源', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/');
  await expect(page.locator('.proto')).toHaveCount(14);
  await page.waitForTimeout(800);
  expect(problems).toEqual([]);
});

test('15 种语言都能从本地切换', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/');
  await expect(page.locator('.proto')).toHaveCount(14);
  await expect(page.locator('[data-lang]')).toHaveCount(LANGUAGES.length);
  const english = await page.locator('.proto').first().locator('.proto-full, .proto-row').first().innerText();
  for (const lang of LANGUAGES) {
    await page.locator('.menu-btn[aria-haspopup="menu"]').first().click();
    await page.locator(`[data-lang="${lang}"]`).click();
    await expect(page.locator(`[data-lang="${lang}"]`)).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('html')).toHaveAttribute('lang', new RegExp(`^${lang.split('-')[0]}`));
  }
  await page.locator('.menu-btn[aria-haspopup="menu"]').first().click();
  await page.locator('[data-lang="zh"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', /^zh/);
  await expect.poll(() => page.locator('.proto').first().locator('.proto-full, .proto-row').first().innerText()).not.toBe(english);
  expect(problems).toEqual([]);
});

test('14 节课都能播放并打开解码器', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/');
  await expect(page.locator('.proto')).toHaveCount(14);
  const ids = await page.locator('.proto').evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.lesson ?? item.getAttribute('data-protocol') ?? ''));
  expect(new Set(ids).size).toBe(14);
  for (let index = 0; index < 14; index++) {
    await page.locator('.proto').nth(index).locator('.proto-row').evaluate((row) => (row as HTMLElement).click());
    await page.waitForTimeout(250);
    await page.keyboard.press('ArrowRight');
    const row = page.locator('tbody tr[data-packet]:not([hidden])').first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.evaluate((element) => (element as HTMLElement).click());
    await expect(page.locator('.inspector')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  }
  expect(problems).toEqual([]);
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { mirrorUrl, rewriteMirror } from '../scripts/protocol-mirror';

const MODULES = ['protocol', 'os', 'algo', 'codegen', 'cpu', 'db'];
/** 各模块的课数。 */
const LESSON_COUNT: Record<string, number> = { protocol: 14, os: 18, algo: 20, codegen: 16, cpu: 16, db: 15 };

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
    page.on('pageerror', (error) => problems.push(error.message));
    page.on('response', (response) => {
      if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
    });
    await page.goto('./');
    await page.click(`.course[data-module="${name}"]`);
    await expect(page).toHaveURL(`modules/${name}/`);
    await expect(page.locator('.proto')).toHaveCount(LESSON_COUNT[name]);
    expect(problems).toEqual([]);
  });
}

for (const name of MODULES.filter((module) => module !== 'protocol')) {
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
  await expect(page.locator('.proto')).toHaveCount(LESSON_COUNT.os);
  await page.goto('modules/protocol');
  await expect(page).toHaveURL('modules/protocol/');
  await expect(page.locator('.proto')).toHaveCount(LESSON_COUNT.protocol);
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
  await expect(page.locator('.course')).toHaveCount(6);
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

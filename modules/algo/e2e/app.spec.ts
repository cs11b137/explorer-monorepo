import { expect, test, type Page } from '@playwright/test';

const LESSON_IDS = ['dynarray', 'linkedlist', 'ringqueue', 'hashtable', 'binarysearch', 'heap', 'avl', 'unionfind', 'bfs', 'dijkstra', 'quicksort', 'mergesort', 'lcs', 'kmp'];

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function open(page: Page): Promise<void> {
  await page.goto('./');
  await page.waitForSelector('html[data-ready]');
}

const noHorizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

test.describe('每节课都能从头播到尾', () => {
  for (const id of LESSON_IDS) {
    test(`${id}：结构图 2×`, async ({ page }) => {
      const errors = watchErrors(page);
      await open(page);
      await page.click('[data-action="speed"]');
      await page.click('[data-action="speed"]');
      await expect(page.locator('.speed-label')).toHaveText('2×');
      if (id !== LESSON_IDS[0]) await page.click(`.proto[data-lesson="${id}"] .proto-row`);
      await expect(page.locator(`.proto[data-lesson="${id}"]`)).toHaveClass(/is-active/);
      await page.click('[data-action="toggle"]');
      await expect(page.locator('.toggle')).toHaveClass(/is-done/, { timeout: 180_000 });
      await expect(page.locator(`.proto[data-lesson="${id}"] .status-dot`)).toHaveClass(/done/);
      await expect(page.locator('.overview .panel-title')).toHaveText('课程总结');
      const rows = page.locator('tr[data-packet]');
      const count = await rows.count();
      expect(count).toBeGreaterThan(0);
      await expect(rows.locator('visible=true')).toHaveCount(count);
      // 结构图显示着数据结构本身。
      expect(await page.locator('.network .ds-item').count()).toBeGreaterThan(0);
      expect(errors).toEqual([]);
    });
  }
});

test.describe('播放控制', () => {
  test('空格、方向键、Esc', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await page.click('.proto[data-lesson="binarysearch"] .proto-row');
    await page.keyboard.press('Space');
    await expect(page.locator('.toggle')).toHaveClass(/is-playing/);
    await page.keyboard.press('Space');
    await expect(page.locator('.toggle')).not.toHaveClass(/is-playing/);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.proto[data-lesson="binarysearch"] .step[data-step="1"]')).toHaveClass(/is-active/);
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.proto[data-lesson="binarysearch"] .step[data-step="0"]')).toHaveClass(/is-active/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.overview .panel-title')).toHaveText('概览');
    expect(errors).toEqual([]);
  });

  test('点步骤跳转，单步按钮一次一个事件', async ({ page }) => {
    await open(page);
    await page.click('.proto[data-lesson="binarysearch"] .proto-row');
    await page.click('.proto[data-lesson="binarysearch"] .step[data-step="3"] .step-btn');
    await expect(page.locator('.explain-title')).toHaveText('目标不存在');
    await expect(page.locator('.proto[data-lesson="binarysearch"] .step[data-step="2"]')).toHaveClass(/is-done/);
    await page.click('[data-action="reset"]');
    await expect(page.locator('.overview .panel-title')).toHaveText('概览');
    await page.click('[data-action="step"]');
    await expect(page.locator('.toggle')).not.toHaveClass(/is-playing/);
  });

  test('切换视图：V 键和按钮，时序图箭头可点', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await page.click('.proto[data-lesson="binarysearch"] .proto-row');
    await page.keyboard.press('v');
    await expect(page.locator('.simulation')).toHaveClass(/is-sequence/);
    await page.click('[data-action="toggle"]');
    await expect(page.locator('.seq-arrow.is-shown').first()).toBeVisible({ timeout: 10_000 });
    await page.locator('.seq-arrow.is-shown .seq-hit').first().click({ force: true });
    await expect(page.locator('.inspector')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.inspector')).toBeHidden();
    await page.click('.view-switch [data-view="network"]');
    await expect(page.locator('.simulation')).not.toHaveClass(/is-sequence/);
    expect(errors).toEqual([]);
  });

  test('标签页筛选', async ({ page }) => {
    await open(page);
    await page.click('.tab[data-group="linear"]');
    await expect(page.locator('.proto:visible')).toHaveCount(5);
    await page.click('.tab[data-group="tree"]');
    await expect(page.locator('.proto:visible')).toHaveCount(5);
    await page.click('.tab[data-group="strategy"]');
    await expect(page.locator('.proto:visible')).toHaveCount(4);
    await page.click('.tab[data-group="all"]');
    await expect(page.locator('.proto:visible')).toHaveCount(14);
  });
});

test.describe('检查器', () => {
  test('字段与字节双向联动，方向键翻事件', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await page.click('.proto[data-lesson="linkedlist"] .proto-row');
    // 第 3 个事件写节点：struct node 共 16 字节，val 4 + 填充 4 + next 8。
    await page.locator('tr[data-packet="2"]').click();
    await expect(page.locator('.inspector')).toBeVisible();
    await expect(page.locator('.ins-title b')).toHaveText('n->next = head');
    await expect(page.locator('.hx')).toHaveCount(16);

    const next = page.locator('.ins-field', { hasText: 'next · +8' }).first();
    await next.hover();
    await expect(page.locator('.hx.is-lit')).toHaveCount(8);

    await page.locator('.hx[data-i="1"]').hover();
    await expect(page.locator('.ins-field.is-lit .ins-name')).toHaveText('val · +0');

    await page.locator('.ins-field', { hasText: '填充 · +4' }).first().hover();
    await expect(page.locator('.hx.is-lit')).toHaveCount(4);
    await expect(page.locator('.hx.is-lit.is-unknown')).toHaveCount(4);

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.ins-title b')).toHaveText('head = n');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.ins-title b')).toHaveText('n->next = head');
    await page.keyboard.press('Escape');
    await expect(page.locator('.inspector')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('所有事件都能打开，字节数与结构一致', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    for (const id of LESSON_IDS) {
      if (id !== LESSON_IDS[0]) await page.click(`.proto[data-lesson="${id}"] .proto-row`);
      await expect(page.locator(`.packets`)).toHaveAttribute('data-lesson', id);
      const count = await page.locator('tr[data-packet]').count();
      await page.locator('tr[data-packet="0"]').click();
      await expect(page.locator('.inspector')).toBeVisible();
      for (let index = 1; index < count; index++) await page.keyboard.press('ArrowRight');
      await expect(page.locator('.ins-badge')).toHaveText(String(count));
      await page.keyboard.press('Escape');
      await expect(page.locator('.inspector')).toBeHidden();
    }
    expect(errors).toEqual([]);
  });
});

test.describe('结构图', () => {
  test('数据结构随事件变化，跳步和后退后状态一致', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await page.click('.proto[data-lesson="quicksort"] .proto-row');
    const cells = () => page.locator('.network [data-node="array"] .ds-v').allTextContents();
    expect(await cells()).toEqual(['5', '2', '9', '1', '7', '3', '8', '4']);
    // 跳到最后一步：之前的事件立即生效，数组已经排好。
    await page.click('.proto[data-lesson="quicksort"] .step[data-step="4"] .step-btn');
    await page.keyboard.press('Space');
    await expect.poll(async () => (await cells()).map(Number).join(' '), { timeout: 8000 }).toBe('1 2 3 4 5 7 8 9');
    await page.keyboard.press('Escape');
    await expect(page.locator('.overview .panel-title')).toHaveText('概览');
    expect(await cells()).toEqual(['5', '2', '9', '1', '7', '3', '8', '4']);
    expect(errors).toEqual([]);
  });

  test('复杂度色块：标题提示写清最好和最坏', async ({ page }) => {
    await open(page);
    await page.click('.proto[data-lesson="quicksort"] .proto-row');
    await expect(page.locator('.layer-name')).toHaveText('O(n log n) – O(n²)');
    await expect(page.locator('.layer-chips span.is-active')).toHaveCount(2);
    const title = await page.locator('.layer').getAttribute('title');
    expect(title).toContain('最好');
    expect(title).toContain('最坏');
  });

  test('轨迹表列名', async ({ page }) => {
    await open(page);
    await expect(page.locator('.packet-table th')).toHaveText(['序号', '操作数', '来源', '目标', '类型', '说明', '大小']);
    await expect(page.locator('.packets .panel-title')).toHaveText('操作轨迹');
  });
});

test.describe('状态保留', () => {
  test('进度、主题、视图、速度刷新后都在', async ({ page }) => {
    await open(page);
    await page.click('.proto[data-lesson="binarysearch"] .proto-row');
    await page.click('.proto[data-lesson="binarysearch"] .step[data-step="1"] .step-btn');
    await expect(page.locator('.proto[data-lesson="binarysearch"] .status-dot')).toHaveClass(/progress/);
    await page.click('[data-theme-choice="dark"]');
    await page.click('.view-switch [data-view="sequence"]');
    await page.click('[data-action="speed"]');
    await page.reload();
    await page.waitForSelector('html[data-ready]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('.simulation')).toHaveClass(/is-sequence/);
    await expect(page.locator('.speed-label')).toHaveText('1.5×');
    await expect(page.locator('.proto[data-lesson="binarysearch"] .status-dot')).toHaveClass(/progress/);
  });
});

test.describe('响应式', () => {
  for (const width of [1440, 1100, 900, 640, 380]) {
    for (const theme of ['light', 'dark']) {
      test(`${width} 宽 ${theme}：无横向溢出，能打开课程`, async ({ page }) => {
        const errors = watchErrors(page);
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => localStorage.setItem('algo-explorer:theme', value), theme);
        await open(page);
        expect(await noHorizontalOverflow(page)).toBe(true);
        if (width < 1100) {
          await page.click('.drawer-btn');
          await expect(page.locator('.sidebar')).toBeInViewport();
        }
        await page.click('.proto[data-lesson="heap"] .proto-row');
        await expect(page.locator('.packets')).toHaveAttribute('data-lesson', 'heap');
        await page.waitForTimeout(600);
        if (width < 1100) await expect(page.locator('.sidebar')).not.toBeInViewport();
        expect(await noHorizontalOverflow(page)).toBe(true);
        await page.locator('[data-action="toggle"]').click();
        await page.waitForTimeout(800);
        expect(await noHorizontalOverflow(page)).toBe(true);
        expect(errors).toEqual([]);
      });
    }
  }

  test('减弱动效时也能走完', async ({ page }) => {
    const errors = watchErrors(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    await page.click('.proto[data-lesson="binarysearch"] .proto-row');
    await page.click('[data-action="toggle"]');
    await expect(page.locator('.toggle')).toHaveClass(/is-done/, { timeout: 60_000 });
    expect(errors).toEqual([]);
  });
});

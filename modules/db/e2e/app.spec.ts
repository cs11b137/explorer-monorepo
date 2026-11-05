import { expect, test, type Page } from '@playwright/test';

const LESSON_IDS = ['parse', 'planner', 'indexscan', 'hashjoin', 'extsort', 'heappage', 'bufferpool', 'btreeinsert', 'vacuum', 'mvcc', 'isolation', 'locks', 'walcommit', 'recovery'];

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

/** 选课。已经选中的课再点一次会折叠手风琴，所以要先判断。 */
async function select(page: Page, id: string): Promise<void> {
  const item = page.locator(`.proto[data-lesson="${id}"]`);
  if (!(await item.evaluate((element) => element.classList.contains('is-active')))) await item.locator('.proto-row').click();
  await expect(page.locator('.packets')).toHaveAttribute('data-lesson', id);
  await expect(item).toHaveClass(/is-open/);
}

const noHorizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

/** 所有结构板里的文字都不能跑出外框。用浏览器真实量到的字宽，补单元测试里估算的不足。 */
const boardOverflow = (page: Page) =>
  page.evaluate(() => {
    const problems: string[] = [];
    document.querySelectorAll<SVGGElement>('.board-slot').forEach((slot) => {
      if (slot.style.visibility === 'hidden') return;
      const panel = slot.querySelector<SVGRectElement>('.bd-panel');
      if (!panel) return;
      const box = panel.getBBox();
      slot.querySelectorAll<SVGTextElement>('text').forEach((text) => {
        const t = text.getBBox();
        if (t.x < box.x - 1 || t.x + t.width > box.x + box.width + 1 || t.y + t.height > box.y + box.height + 2) problems.push(`${slot.dataset.board}: ${text.textContent}`);
      });
    });
    return problems;
  });

test.describe('每节课都能从头播到尾', () => {
  for (const id of LESSON_IDS) {
    test(`${id}：结构图 2×`, async ({ page }) => {
      const errors = watchErrors(page);
      await open(page);
      await page.click('[data-action="speed"]');
      await page.click('[data-action="speed"]');
      await expect(page.locator('.speed-label')).toHaveText('2×');
      await select(page, id);
      await expect(page.locator(`.proto[data-lesson="${id}"]`)).toHaveClass(/is-active/);
      const initial = await page.locator('.board-layer').innerHTML();
      await page.click('[data-action="toggle"]');
      await expect(page.locator('.toggle')).toHaveClass(/is-done/, { timeout: 200_000 });
      await expect(page.locator(`.proto[data-lesson="${id}"] .status-dot`)).toHaveClass(/done/);
      await expect(page.locator('.overview .panel-title')).toHaveText('课程总结');
      const rows = page.locator('tr[data-packet]');
      const count = await rows.count();
      expect(count).toBeGreaterThan(0);
      await expect(rows.locator('visible=true')).toHaveCount(count);
      // 结构图确实跟着事件变化了。
      expect(await page.locator('.board-layer').innerHTML()).not.toBe(initial);
      expect(await boardOverflow(page)).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
});

test.describe('结构板', () => {
  test('每一步的结构板文字都不越框，后退能恢复到同样的内容', async ({ page }) => {
    const errors = watchErrors(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    for (const id of LESSON_IDS) {
      await select(page, id);
      await expect(page.locator('.packets')).toHaveAttribute('data-lesson', id);
      const steps = await page.locator(`.proto[data-lesson="${id}"] .step`).count();
      const seen: string[] = [];
      for (let step = 0; step < steps; step++) {
        await page.locator(`.proto[data-lesson="${id}"] .step[data-step="${step}"] .step-btn`).click();
        await page.keyboard.press('Space');
        seen.push(await page.locator('.board-layer').innerHTML());
        expect(await boardOverflow(page), `${id} 第 ${step + 1} 步`).toEqual([]);
      }
      // 跳回第一步：状态由事件序列重算，和第一次看到的相同。
      await page.locator(`.proto[data-lesson="${id}"] .step[data-step="0"] .step-btn`).click();
      await page.keyboard.press('Space');
      expect(await page.locator('.board-layer').innerHTML()).toBe(seen[0]);
      await page.keyboard.press('Escape');
    }
    expect(errors).toEqual([]);
  });

  test('结构图直接显示状态：行指针和元组、帧和计数、树节点', async ({ page }) => {
    await open(page);
    await select(page, 'heappage');
    await expect(page.locator('.board-slot[data-board="page"] .s-head')).toHaveCount(1);
    await page.locator('.proto[data-lesson="heappage"] .step[data-step="4"] .step-btn').click();
    await page.keyboard.press('Space');
    await expect(page.locator('.board-slot[data-board="page"] .s-lp')).toHaveCount(3);
    await expect(page.locator('.board-slot[data-board="page"] .s-tup')).toHaveCount(3);
    await select(page, 'bufferpool');
    await expect(page.locator('.board-slot[data-board="frames"] .bd-frame')).toHaveCount(8);
    await select(page, 'btreeinsert');
    await page.locator('.proto[data-lesson="btreeinsert"] .step[data-step="5"] .step-btn').click();
    await page.keyboard.press('Space');
    await expect(page.locator('.board-slot[data-board="tree"] .bd-node').first()).toBeVisible();
    expect(await page.locator('.board-slot[data-board="tree"] .bd-node').count()).toBeGreaterThan(3);
  });
});

test.describe('播放控制', () => {
  test('空格、方向键、Esc', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await select(page, 'parse');
    await page.keyboard.press('Space');
    await expect(page.locator('.toggle')).toHaveClass(/is-playing/);
    await page.keyboard.press('Space');
    await expect(page.locator('.toggle')).not.toHaveClass(/is-playing/);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.proto[data-lesson="parse"] .step[data-step="1"]')).toHaveClass(/is-active/);
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.proto[data-lesson="parse"] .step[data-step="0"]')).toHaveClass(/is-active/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.overview .panel-title')).toHaveText('概览');
    expect(errors).toEqual([]);
  });

  test('点步骤跳转，单步按钮一次一个事件', async ({ page }) => {
    await open(page);
    await select(page, 'parse');
    await page.click('.proto[data-lesson="parse"] .step[data-step="3"] .step-btn');
    await expect(page.locator('.explain-title')).toHaveText('查系统目录');
    await expect(page.locator('.proto[data-lesson="parse"] .step[data-step="2"]')).toHaveClass(/is-done/);
    await page.click('[data-action="reset"]');
    await expect(page.locator('.overview .panel-title')).toHaveText('概览');
    await page.click('[data-action="step"]');
    await expect(page.locator('.toggle')).not.toHaveClass(/is-playing/);
  });

  test('切换视图：V 键和按钮，时序图箭头可点', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await select(page, 'parse');
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

  test('时序图放得下所有课的节点', async ({ page }) => {
    await open(page);
    await page.keyboard.press('v');
    for (const id of LESSON_IDS) {
      await select(page, id);
      await expect(page.locator('.packets')).toHaveAttribute('data-lesson', id);
      const fits = await page.evaluate(() => {
        const scroll = document.querySelector<HTMLElement>('.seq-scroll')!;
        return scroll.scrollWidth <= scroll.clientWidth + 1;
      });
      expect(fits, id).toBe(true);
    }
  });

  test('标签页筛选', async ({ page }) => {
    await open(page);
    await page.click('.tab[data-group="storage"]');
    await expect(page.locator('.proto:visible')).toHaveCount(4);
    await page.click('.tab[data-group="query"]');
    await expect(page.locator('.proto:visible')).toHaveCount(5);
    await page.click('.tab[data-group="txn"]');
    await expect(page.locator('.proto:visible')).toHaveCount(5);
    await page.click('.tab[data-group="all"]');
    await expect(page.locator('.proto:visible')).toHaveCount(14);
  });
});

test.describe('检查器', () => {
  test('字段与字节双向联动，方向键翻事件', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await select(page, 'heappage');
    await page.locator('tr[data-packet="2"]').click();
    await expect(page.locator('.inspector')).toBeVisible();
    await expect(page.locator('.ins-title b')).toHaveText('heap_insert');
    // 页头 24 + 1 个行指针 4 + 元组 36。
    await expect(page.locator('.hx')).toHaveCount(64);

    const field = page.locator('.ins-field', { hasText: 'pd_lower' }).first();
    await field.hover();
    await expect(page.locator('.hx.is-lit')).toHaveCount(2);

    await page.locator('.hx[data-i="30"]').hover();
    await expect(page.locator('.ins-field.is-lit .ins-name')).toHaveText('t_xmin');

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.ins-badge')).toHaveText('4');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.ins-badge')).toHaveText('3');
    await page.keyboard.press('Escape');
    await expect(page.locator('.inspector')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('地址列显示真实的页内偏移', async ({ page }) => {
    await open(page);
    await select(page, 'heappage');
    await page.locator('tr[data-packet="2"]').click();
    // 元组在偏移 8152 = 0x1fd8。
    await expect(page.locator('.hx-at', { hasText: '1fd8' })).toHaveCount(1);
  });

  test('所有事件都能打开，字节数与结构一致', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    for (const id of LESSON_IDS) {
      await select(page, id);
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

test.describe('状态保留', () => {
  test('进度、主题、视图、速度刷新后都在', async ({ page }) => {
    await open(page);
    await select(page, 'parse');
    await page.click('.proto[data-lesson="parse"] .step[data-step="1"] .step-btn');
    await expect(page.locator('.proto[data-lesson="parse"] .status-dot')).toHaveClass(/progress/);
    await page.click('[data-theme-choice="dark"]');
    await page.click('.view-switch [data-view="sequence"]');
    await page.click('[data-action="speed"]');
    await page.reload();
    await page.waitForSelector('html[data-ready]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('.simulation')).toHaveClass(/is-sequence/);
    await expect(page.locator('.speed-label')).toHaveText('1.5×');
    await expect(page.locator('.proto[data-lesson="parse"] .status-dot')).toHaveClass(/progress/);
    const keys = await page.evaluate(() => Object.keys(localStorage));
    expect(keys.every((key) => key.startsWith('db-explorer:'))).toBe(true);
  });
});

test.describe('响应式', () => {
  for (const width of [1440, 1100, 900, 640, 380]) {
    for (const theme of ['light', 'dark']) {
      test(`${width} 宽 ${theme}：无横向溢出，能打开课程`, async ({ page }) => {
        const errors = watchErrors(page);
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => localStorage.setItem('db-explorer:theme', value), theme);
        await open(page);
        expect(await noHorizontalOverflow(page)).toBe(true);
        if (width < 1100) {
          await page.click('.drawer-btn');
          await expect(page.locator('.sidebar')).toBeInViewport();
        }
        await page.click('.proto[data-lesson="heappage"] .proto-row');
        await expect(page.locator('.packets')).toHaveAttribute('data-lesson', 'heappage');
        await page.waitForTimeout(600);
        if (width < 1100) await expect(page.locator('.sidebar')).not.toBeInViewport();
        expect(await noHorizontalOverflow(page)).toBe(true);
        await page.locator('[data-action="toggle"]').click();
        await page.waitForTimeout(800);
        expect(await noHorizontalOverflow(page)).toBe(true);
        expect(await boardOverflow(page)).toEqual([]);
        expect(errors).toEqual([]);
      });
    }
  }

  test('减弱动效时也能走完', async ({ page }) => {
    const errors = watchErrors(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    await select(page, 'parse');
    await page.click('[data-action="toggle"]');
    await expect(page.locator('.toggle')).toHaveClass(/is-done/, { timeout: 60_000 });
    expect(errors).toEqual([]);
  });
});

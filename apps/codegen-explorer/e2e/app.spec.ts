import { expect, test, type Page } from '@playwright/test';

const LESSON_IDS = ['lexer', 'llparser', 'lrparser', 'typecheck', 'irgen', 'dataflow', 'ssa', 'optimize', 'licm', 'isel', 'regalloc', 'frame', 'encoding', 'link'];

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function open(page: Page): Promise<void> {
  await page.goto('/');
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
      await page.click(`.proto[data-lesson="${id}"] .proto-row`);
      await expect(page.locator(`.proto[data-lesson="${id}"]`)).toHaveClass(/is-active/);
      await page.click('[data-action="toggle"]');
      await expect(page.locator('.toggle')).toHaveClass(/is-done/, { timeout: 230_000 });
      await expect(page.locator(`.proto[data-lesson="${id}"] .status-dot`)).toHaveClass(/done/);
      await expect(page.locator('.overview .panel-title')).toHaveText('课程总结');
      const rows = page.locator('tr[data-packet]');
      const count = await rows.count();
      expect(count).toBeGreaterThan(0);
      await expect(rows.locator('visible=true')).toHaveCount(count);
      expect(errors).toEqual([]);
    });
  }
});

test.describe('产物面板', () => {
  test('播放时结构图直接显示中间产物，并随事件变化', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await expect(page.locator('.art-panel[data-panel="src"]')).toContainText('int sum(int n)');
    await expect(page.locator('.art-panel[data-panel="toks"]')).toContainText('return');
    await page.click('[data-action="step"]');
    await page.click('[data-action="step"]');
    await page.click('[data-action="step"]');
    await expect(page.locator('.overview .panel-title')).toHaveText('步骤详情');
    // 开始播放后回到初始状态，token 面板要等事件填入。
    await expect(page.locator('.art-panel[data-panel="toks"]')).toHaveCount(0);
    await page.click('.proto[data-lesson="lexer"] .step[data-step="4"] .step-btn');
    await expect(page.locator('.art-panel[data-panel="toks"]')).toContainText('int');
    expect(errors).toEqual([]);
  });

  test('各种产物都能画出来', async ({ page }) => {
    await open(page);
    const expectations: Array<[string, string, string]> = [
      ['llparser', 'tree', '语法树'],
      ['lrparser', 'table', 'acc'],
      ['irgen', 'ir', 'load i32'],
      ['dataflow', 'cfg', 'while.cond'],
      ['ssa', 'cfg', 'phi'],
      ['regalloc', 'regs', 'ebx'],
      ['encoding', 'list', '48 89 e5'],
      ['link', 'table', '0xfd4'],
    ];
    for (const [id, slot, text] of expectations) {
      await page.click(`.proto[data-lesson="${id}"] .proto-row`);
      await expect(page.locator(`.art-panel[data-panel="${slot}"]`)).toContainText(text);
    }
  });

  test('前进和跳回得到同样的画面', async ({ page }) => {
    await open(page);
    await page.click('.proto[data-lesson="ssa"] .proto-row');
    await page.click('.proto[data-lesson="ssa"] .step[data-step="3"] .step-btn');
    await page.click('[data-action="toggle"]');
    await page.click('.proto[data-lesson="ssa"] .step[data-step="1"] .step-btn');
    await page.click('[data-action="toggle"]');
    const early = await page.locator('.art-panel[data-panel="vars"]').innerHTML();
    await page.click('.proto[data-lesson="ssa"] .step[data-step="3"] .step-btn');
    await page.click('[data-action="toggle"]');
    await page.click('.proto[data-lesson="ssa"] .step[data-step="1"] .step-btn');
    await page.click('[data-action="toggle"]');
    expect(await page.locator('.art-panel[data-panel="vars"]').innerHTML()).toBe(early);
  });
});

test.describe('播放控制', () => {
  test('空格、方向键、Esc', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await page.click('.proto[data-lesson="typecheck"] .proto-row');
    await page.keyboard.press('Space');
    await expect(page.locator('.toggle')).toHaveClass(/is-playing/);
    await page.keyboard.press('Space');
    await expect(page.locator('.toggle')).not.toHaveClass(/is-playing/);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.proto[data-lesson="typecheck"] .step[data-step="1"]')).toHaveClass(/is-active/);
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.proto[data-lesson="typecheck"] .step[data-step="0"]')).toHaveClass(/is-active/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.overview .panel-title')).toHaveText('概览');
    expect(errors).toEqual([]);
  });

  test('点步骤跳转，单步按钮一次一个事件', async ({ page }) => {
    await open(page);
    await page.click('.proto[data-lesson="typecheck"] .proto-row');
    await page.click('.proto[data-lesson="typecheck"] .step[data-step="3"] .step-btn');
    await expect(page.locator('.explain-title')).toHaveText('标注类型');
    await expect(page.locator('.proto[data-lesson="typecheck"] .step[data-step="2"]')).toHaveClass(/is-done/);
    await page.click('[data-action="reset"]');
    await expect(page.locator('.overview .panel-title')).toHaveText('概览');
    await page.click('[data-action="step"]');
    await expect(page.locator('.toggle')).not.toHaveClass(/is-playing/);
  });

  test('切换视图：V 键和按钮，时序图箭头可点', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await page.click('.proto[data-lesson="typecheck"] .proto-row');
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
    await page.click('.tab[data-group="front"]');
    await expect(page.locator('.proto:visible')).toHaveCount(4);
    await page.click('.tab[data-group="middle"]');
    await expect(page.locator('.proto:visible')).toHaveCount(5);
    await page.click('.tab[data-group="back"]');
    await expect(page.locator('.proto:visible')).toHaveCount(5);
    await page.click('.tab[data-group="all"]');
    await expect(page.locator('.proto:visible')).toHaveCount(14);
  });
});

test.describe('检查器', () => {
  test('字段与字节双向联动，方向键翻事件', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await page.click('.proto[data-lesson="link"] .proto-row');
    await page.locator('tr[data-packet="0"]').click();
    await expect(page.locator('.inspector')).toBeVisible();
    await expect(page.locator('.ins-title b')).toHaveText('文件头');
    await expect(page.locator('.hx')).toHaveCount(64);

    const field = page.locator('.ins-field', { hasText: 'e_shoff' }).first();
    await field.hover();
    await expect(page.locator('.hx.is-lit')).toHaveCount(8);

    await page.locator('.hx[data-i="17"]').hover();
    await expect(page.locator('.ins-field.is-lit .ins-name')).toHaveText('e_type');

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.ins-title b')).toHaveText('.text');
    await expect(page.locator('.hx')).toHaveCount(64);
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.ins-title b')).toHaveText('文件头');
    await page.keyboard.press('Escape');
    await expect(page.locator('.inspector')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('指令的 REX、ModRM、SIB 逐字段联动', async ({ page }) => {
    await open(page);
    await page.click('.proto[data-lesson="encoding"] .proto-row');
    const row = page.locator('tr[data-packet]').filter({ hasText: 'lea esi' }).first();
    await row.click();
    await expect(page.locator('.hx')).toHaveCount(3);
    await page.locator('.ins-field', { hasText: 'SIB' }).first().hover();
    await expect(page.locator('.hx.is-lit')).toHaveCount(1);
    await expect(page.locator('.hx.is-lit')).toHaveText('0f');
    await page.keyboard.press('Escape');
  });

  test('所有事件都能打开，字节数与结构一致', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    for (const id of LESSON_IDS) {
      await page.click(`.proto[data-lesson="${id}"] .proto-row`);
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
    await page.click('.proto[data-lesson="typecheck"] .proto-row');
    await page.click('.proto[data-lesson="typecheck"] .step[data-step="1"] .step-btn');
    await expect(page.locator('.proto[data-lesson="typecheck"] .status-dot')).toHaveClass(/progress/);
    await page.click('[data-theme-choice="dark"]');
    await page.click('.view-switch [data-view="sequence"]');
    await page.click('[data-action="speed"]');
    await page.reload();
    await page.waitForSelector('html[data-ready]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('.simulation')).toHaveClass(/is-sequence/);
    await expect(page.locator('.speed-label')).toHaveText('1.5×');
    await expect(page.locator('.proto[data-lesson="typecheck"] .status-dot')).toHaveClass(/progress/);
  });
});

test.describe('响应式', () => {
  for (const width of [1440, 1100, 900, 640, 380]) {
    for (const theme of ['light', 'dark']) {
      test(`${width} 宽 ${theme}：无横向溢出，能打开课程`, async ({ page }) => {
        const errors = watchErrors(page);
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => localStorage.setItem('codegen-explorer:theme', value), theme);
        await open(page);
        expect(await noHorizontalOverflow(page)).toBe(true);
        if (width < 1100) {
          await page.click('.drawer-btn');
          await expect(page.locator('.sidebar')).toBeInViewport();
        }
        await page.click('.proto[data-lesson="ssa"] .proto-row');
        await expect(page.locator('.packets')).toHaveAttribute('data-lesson', 'ssa');
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

  test('窄屏时相机对准正在变化的面板，代码字号不小于 10 像素', async ({ page }) => {
    await page.setViewportSize({ width: 380, height: 800 });
    await open(page);
    await page.click('.drawer-btn');
    await page.click('.proto[data-lesson="irgen"] .proto-row');
    await page.waitForTimeout(600);
    await page.locator('.proto[data-lesson="irgen"] .step[data-step="3"] .step-btn').evaluate((button) => (button as HTMLElement).click());
    await page.waitForTimeout(800);
    const size = await page.evaluate(() => {
      const svg = document.querySelector<SVGSVGElement>('svg.network')!;
      const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
      return 13.5 * scale;
    });
    expect(size).toBeGreaterThan(10);
  });

  test('减弱动效时也能走完', async ({ page }) => {
    const errors = watchErrors(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    await page.click('.proto[data-lesson="typecheck"] .proto-row');
    await page.click('[data-action="toggle"]');
    await expect(page.locator('.toggle')).toHaveClass(/is-done/, { timeout: 60_000 });
    expect(errors).toEqual([]);
  });
});

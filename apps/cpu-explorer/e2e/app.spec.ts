import { expect, test, type Page } from '@playwright/test';

const LESSON_IDS = ['integer', 'float', 'alu', 'encoding', 'datapath', 'control', 'pipeline', 'hazard', 'branch', 'cache', 'writepolicy', 'coherence', 'dram', 'dma'];

const MAIN_PANELS: Record<string, string[]> = {
  integer: ['adder'],
  float: ['table'],
  alu: ['alu', 'shifter', 'multiplier'],
  encoding: ['word'],
  datapath: ['regfile', 'alu'],
  control: ['table'],
  pipeline: ['table'],
  hazard: ['table'],
  branch: ['table'],
  cache: ['cache'],
  writepolicy: ['cache', 'cache1'],
  coherence: ['history'],
  dram: ['timing'],
  dma: ['strip'],
};

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
      await expect(page.locator('.toggle')).toHaveClass(/is-done/, { timeout: 200_000 });
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

test.describe('品牌和文案', () => {
  test('站名、副标题、轨迹表和抽象层级', async ({ page }) => {
    await open(page);
    await expect(page).toHaveTitle(/CPU Explorer/);
    await expect(page.locator('.brand-text h1')).toContainText('CPU');
    await expect(page.locator('.brand-text p')).toHaveText('看懂计算机如何执行每条指令');
    await expect(page.locator('.sidebar .panel-title')).toHaveText('计算机组成原理');
    await expect(page.locator('.packets .panel-title')).toHaveText('周期轨迹');
    await expect(page.locator('.packet-table th').nth(1)).toHaveText('周期');
    await expect(page.locator('.layer-label')).toHaveText('抽象层级');
    await expect(page.locator('.layer-chips span').first()).toHaveAttribute('title', /晶体管/);
    await expect(page.locator('.layer-chips span').last()).toHaveAttribute('title', /高级语言/);
    await expect(page.locator('.credit')).toHaveAttribute('href', 'https://x.com/DilumSanjaya');
  });
});

test.describe('结构图显示部件里的当前值', () => {
  test('流水线课：跳到满负荷后，5 级面板显示不同的指令', async ({ page }) => {
    await open(page);
    await page.click('.proto[data-lesson="pipeline"] .proto-row');
    await page.click('.proto[data-lesson="pipeline"] .step[data-step="4"] .step-btn');
    await page.keyboard.press('Space');
    const sid = page.locator('.widget[data-widget="sid"]');
    await expect(sid).toContainText(/addi x\d, x0, \d/);
    await expect(page.locator('.widget[data-widget="table"]')).toContainText('流水线图');
  });

  test('前进和跳步得到相同的面板内容', async ({ page }) => {
    await open(page);
    await page.click('.proto[data-lesson="cache"] .proto-row');
    await page.click('.proto[data-lesson="cache"] .step[data-step="2"] .step-btn');
    await page.keyboard.press('Space');
    await expect(page.locator('.widget[data-widget="cache"]')).toContainText('0x40');
    const before = await page.locator('.widget[data-widget="cache"]').textContent();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Space');
    await page.click('.proto[data-lesson="cache"] .step[data-step="2"] .step-btn');
    await page.keyboard.press('Space');
    await expect(page.locator('.widget[data-widget="cache"]')).toHaveText(before!);
  });

  test('窄屏把面板放到读数区', async ({ page }) => {
    await page.setViewportSize({ width: 380, height: 800 });
    await open(page);
    await expect(page.locator('.simulation')).toHaveClass(/is-strip/);
    await expect(page.locator('.strip-item').first()).toBeVisible();
    expect(await page.locator('.widget-layer .widget').count()).toBe(0);
  });
});

test.describe('1280×800', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  const inside = (page: Page, id: string) =>
    page.evaluate((panel) => {
      const element = document.querySelector(`.strip-item[data-widget="${panel}"]`);
      const box = document.querySelector('.simulation')!.getBoundingClientRect();
      const strip = document.querySelector('.state-strip')!.getBoundingClientRect();
      if (!element) return 'missing';
      const rect = element.getBoundingClientRect();
      const ok = rect.width > 100 && rect.top >= Math.max(box.top, strip.top) - 1 && rect.bottom <= Math.min(box.bottom, strip.bottom) + 1 && rect.left >= box.left - 1 && rect.right <= box.right + 1;
      return ok ? 'ok' : `top ${rect.top} bottom ${rect.bottom} strip ${strip.top}-${strip.bottom} sim ${box.top}-${box.bottom}`;
    }, id);

  for (const [id, mains] of Object.entries(MAIN_PANELS)) {
    test(`${id}：主面板不滚动就能完整看到`, async ({ page }) => {
      const errors = watchErrors(page);
      await open(page);
      await expect(page.locator('.simulation')).toHaveClass(/is-strip/);
      // 用 DOM 点击：不触发 Playwright 的自动滚动，也不受手风琴动画影响，这里只关心 .simulation 内部。
      await page.locator(`.proto[data-lesson="${id}"]`).evaluate((item) => {
        if (!item.classList.contains('is-active')) item.querySelector<HTMLElement>('.proto-row')!.click();
      });
      await expect(page.locator('.packets')).toHaveAttribute('data-lesson', id);
      const steps = await page.locator(`.proto[data-lesson="${id}"] .step`).count();
      await page.locator(`.proto[data-lesson="${id}"] .step[data-step="${Math.floor(steps / 2)}"] .step-btn`).evaluate((button: HTMLElement) => button.click());
      await page.keyboard.press('Space');
      await page.waitForTimeout(300);
      for (const main of mains) expect(await inside(page, main), `${id}/${main}`).toBe('ok');
      expect(await page.locator('.state-strip').evaluate((element) => element.scrollTop)).toBe(0);
      expect(errors).toEqual([]);
    });
  }

  test('HAZARD：五级面板压成一行', async ({ page }) => {
    await open(page);
    await page.locator('.proto[data-lesson="hazard"] .proto-row').evaluate((row: HTMLElement) => row.click());
    await expect(page.locator('.packets')).toHaveAttribute('data-lesson', 'hazard');
    await page.waitForTimeout(300);
    const tops = await page.evaluate(() => ['sif', 'sid', 'sex', 'smem', 'swb'].map((id) => document.querySelector(`.strip-item[data-widget="${id}"]`)!.getBoundingClientRect().top));
    expect(new Set(tops).size).toBe(1);
  });
});

test.describe('播放控制', () => {
  test('空格、方向键、Esc', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await page.click('.proto[data-lesson="alu"] .proto-row');
    await page.keyboard.press('Space');
    await expect(page.locator('.toggle')).toHaveClass(/is-playing/);
    await page.keyboard.press('Space');
    await expect(page.locator('.toggle')).not.toHaveClass(/is-playing/);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.proto[data-lesson="alu"] .step[data-step="1"]')).toHaveClass(/is-active/);
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.proto[data-lesson="alu"] .step[data-step="0"]')).toHaveClass(/is-active/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.overview .panel-title')).toHaveText('概览');
    expect(errors).toEqual([]);
  });

  test('点步骤跳转，单步按钮一次一个事件', async ({ page }) => {
    await open(page);
    await page.click('.proto[data-lesson="datapath"] .proto-row');
    await page.click('.proto[data-lesson="datapath"] .step[data-step="3"] .step-btn');
    await expect(page.locator('.explain-title')).toHaveText('lw');
    await expect(page.locator('.proto[data-lesson="datapath"] .step[data-step="2"]')).toHaveClass(/is-done/);
    await page.click('[data-action="reset"]');
    await expect(page.locator('.overview .panel-title')).toHaveText('概览');
    await page.click('[data-action="step"]');
    await expect(page.locator('.toggle')).not.toHaveClass(/is-playing/);
  });

  test('切换视图：V 键和按钮，时序图箭头可点', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await page.click('.proto[data-lesson="datapath"] .proto-row');
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

  test('时序图的箭头不跑出面板', async ({ page }) => {
    await open(page);
    for (const id of LESSON_IDS) {
      await page.click(`.proto[data-lesson="${id}"] .proto-row`);
      await page.click('.view-switch [data-view="sequence"]');
      const fits = await page.locator('.seq-scroll').evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
      expect(fits, id).toBe(true);
      await page.click('.view-switch [data-view="network"]');
    }
  });

  test('标签页筛选', async ({ page }) => {
    await open(page);
    await page.click('.tab[data-group="data"]');
    await expect(page.locator('.proto:visible')).toHaveCount(3);
    await page.click('.tab[data-group="cpu"]');
    await expect(page.locator('.proto:visible')).toHaveCount(6);
    await page.click('.tab[data-group="memio"]');
    await expect(page.locator('.proto:visible')).toHaveCount(5);
    await page.click('.tab[data-group="all"]');
    await expect(page.locator('.proto:visible')).toHaveCount(14);
  });
});

test.describe('检查器', () => {
  test('指令解码到位：字段和位、字节双向联动，方向键翻事件', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await page.click('.proto[data-lesson="encoding"] .proto-row');
    const index = await page.$$eval('tr[data-packet]', (rows) => rows.findIndex((row) => row.textContent!.includes('beq x1, x2, -8')));
    await page.locator(`tr[data-packet="${index}"]`).click();
    await expect(page.locator('.inspector')).toBeVisible();
    await expect(page.locator('.ins-title b')).toHaveText('汇编');
    await expect(page.locator('.bt')).toHaveCount(32);
    await expect(page.locator('.hx')).toHaveCount(4);

    await page.locator('.ins-field', { hasText: 'opcode' }).first().hover();
    await expect(page.locator('.bt.is-lit')).toHaveCount(7);
    await expect(page.locator('.hx.is-lit')).toHaveCount(1);

    await page.locator('.ins-field', { hasText: 'imm[11]' }).first().hover();
    await expect(page.locator('.bt.is-lit')).toHaveCount(1);
    await expect(page.locator('.bt.is-lit')).toHaveAttribute('data-b', '0:7');

    await page.locator('.bt[data-b="0:31"]').hover();
    await expect(page.locator('.ins-field.is-lit .ins-name')).toContainText('imm[12]');

    await page.locator('.bt[data-b="0:13"]').hover();
    await expect(page.locator('.ins-field.is-lit .ins-name')).toContainText('funct3');
    await expect(page.locator('.bt.is-lit')).toHaveCount(3);

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.ins-title b')).toHaveText('取指');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.ins-title b')).toHaveText('汇编');
    await page.keyboard.press('Escape');
    await expect(page.locator('.inspector')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('浮点解码到符号、阶码、尾数', async ({ page }) => {
    await open(page);
    await page.click('.proto[data-lesson="float"] .proto-row');
    await page.locator('tr[data-packet="1"]').click();
    await expect(page.locator('.ins-title b')).toHaveText('编码 -0.1');
    await page.locator('.ins-field', { hasText: '阶码' }).first().hover();
    await expect(page.locator('.bt.is-lit')).toHaveCount(8);
    await page.locator('.ins-field', { hasText: '尾数' }).first().hover();
    await expect(page.locator('.bt.is-lit')).toHaveCount(23);
    await expect(page.locator('.ins-field', { hasText: '符号' }).first()).toContainText('1');
  });

  test('缓存地址解码到 tag、index、offset', async ({ page }) => {
    await open(page);
    await page.click('.proto[data-lesson="cache"] .proto-row');
    await page.locator('tr[data-packet="0"]').click();
    await page.locator('.ins-field', { hasText: '标记' }).first().hover();
    await expect(page.locator('.bt.is-lit')).toHaveCount(26);
    await page.locator('.ins-field', { hasText: '组索引' }).first().hover();
    await expect(page.locator('.bt.is-lit')).toHaveCount(2);
    await page.locator('.ins-field', { hasText: '块内偏移' }).first().hover();
    await expect(page.locator('.bt.is-lit')).toHaveCount(4);
  });

  test('所有事件都能打开', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    for (const id of LESSON_IDS) {
      await page.click(`.proto[data-lesson="${id}"] .proto-row`);
      await expect(page.locator('.packets')).toHaveAttribute('data-lesson', id);
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
    await page.click('.proto[data-lesson="alu"] .proto-row');
    await page.click('.proto[data-lesson="alu"] .step[data-step="1"] .step-btn');
    await expect(page.locator('.proto[data-lesson="alu"] .status-dot')).toHaveClass(/progress/);
    await page.click('[data-theme-choice="dark"]');
    await page.click('.view-switch [data-view="sequence"]');
    await page.click('[data-action="speed"]');
    await page.reload();
    await page.waitForSelector('html[data-ready]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('.simulation')).toHaveClass(/is-sequence/);
    await expect(page.locator('.speed-label')).toHaveText('1.5×');
    await expect(page.locator('.proto[data-lesson="alu"] .status-dot')).toHaveClass(/progress/);
    const keys = await page.evaluate(() => Object.keys(localStorage));
    for (const key of keys) expect(key.startsWith('cpu-explorer:')).toBe(true);
  });
});

test.describe('响应式', () => {
  for (const width of [1440, 1100, 900, 640, 380]) {
    for (const theme of ['light', 'dark']) {
      test(`${width} 宽 ${theme}：无横向溢出，能打开课程`, async ({ page }) => {
        const errors = watchErrors(page);
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => localStorage.setItem('cpu-explorer:theme', value), theme);
        await open(page);
        expect(await noHorizontalOverflow(page)).toBe(true);
        if (width < 1100) {
          await page.click('.drawer-btn');
          await expect(page.locator('.sidebar')).toBeInViewport();
        }
        await page.click('.proto[data-lesson="hazard"] .proto-row');
        await expect(page.locator('.packets')).toHaveAttribute('data-lesson', 'hazard');
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
    await page.click('.proto[data-lesson="alu"] .proto-row');
    await page.click('[data-action="toggle"]');
    await expect(page.locator('.toggle')).toHaveClass(/is-done/, { timeout: 120_000 });
    expect(errors).toEqual([]);
  });
});

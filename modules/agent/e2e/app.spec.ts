import { expect, test, type Page } from '@playwright/test';
import { LESSONS, PLANNED } from '../src/lessons';
import { numbers, react } from '../src/lessons/react';
import { packetsOf } from '../src/lessons/types';

// 课程清单直接取自源码：后续加课不用改这里。
const LESSON_IDS = LESSONS.map((lesson) => lesson.id);
const FIRST = LESSON_IDS[0];

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

/** 切到某节课。点已经选中的课只会折叠它的步骤列表，所以只在没选中时点。 */
async function select(page: Page, id: string): Promise<void> {
  const item = page.locator(`.proto[data-lesson="${id}"]`);
  if (!/is-active/.test((await item.getAttribute('class')) ?? '')) await item.locator('.proto-row').click();
  await expect(item).toHaveClass(/is-active/);
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
      await select(page, id);
      await page.click('[data-action="toggle"]');
      await expect(page.locator('.toggle')).toHaveClass(/is-done/, { timeout: 180_000 });
      await expect(page.locator(`.proto[data-lesson="${id}"] .status-dot`)).toHaveClass(/done/);
      await expect(page.locator('.overview .panel-title')).toHaveText('课程总结');
      const rows = page.locator('tr[data-packet]');
      const count = await rows.count();
      expect(count).toBeGreaterThan(0);
      await expect(rows.locator('visible=true')).toHaveCount(count);
      expect(await page.locator('.network .ds-item').count()).toBeGreaterThan(0);
      expect(errors).toEqual([]);
    });
  }
});

test.describe('播放控制', () => {
  test('空格、方向键、Esc', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await select(page, FIRST);
    await page.keyboard.press('Space');
    await expect(page.locator('.toggle')).toHaveClass(/is-playing/);
    await page.keyboard.press('Space');
    await expect(page.locator('.toggle')).not.toHaveClass(/is-playing/);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator(`.proto[data-lesson="${FIRST}"] .step[data-step="1"]`)).toHaveClass(/is-active/);
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator(`.proto[data-lesson="${FIRST}"] .step[data-step="0"]`)).toHaveClass(/is-active/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.overview .panel-title')).toHaveText('概览');
    expect(errors).toEqual([]);
  });

  test('点步骤跳转，单步按钮一次一个事件', async ({ page }) => {
    await open(page);
    await select(page, FIRST);
    await page.click(`.proto[data-lesson="${FIRST}"] .step[data-step="3"] .step-btn`);
    await expect(page.locator('.explain-title')).toHaveText(react.steps[3].title);
    await expect(page.locator(`.proto[data-lesson="${FIRST}"] .step[data-step="2"]`)).toHaveClass(/is-done/);
    await page.click('[data-action="reset"]');
    await expect(page.locator('.overview .panel-title')).toHaveText('概览');
    await page.click('[data-action="step"]');
    await expect(page.locator('.toggle')).not.toHaveClass(/is-playing/);
  });

  test('切换视图：V 键和按钮，时序图箭头可点', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await select(page, FIRST);
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

  test('标签页筛选：每组的课数和源码一致', async ({ page }) => {
    await open(page);
    for (const group of ['loop', 'mcp', 'multi']) {
      await page.click(`.tab[data-group="${group}"]`);
      await expect(page.locator('.proto:visible')).toHaveCount(LESSONS.filter((lesson) => lesson.group === group).length);
    }
    await page.click('.tab[data-group="all"]');
    await expect(page.locator('.proto:visible')).toHaveCount(LESSONS.length);
    expect(LESSONS.length).toBe(PLANNED.length);
  });
});

test.describe('检查器', () => {
  test('字段与字节双向联动，方向键翻事件', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await select(page, FIRST);
    // 第 2 个事件：第一轮的 HTTP 请求（头 + JSON 请求体），x-api-key 打码。
    await page.locator('tr[data-packet="1"]').click();
    await expect(page.locator('.inspector')).toBeVisible();
    await expect(page.locator('.ins-title b')).toHaveText('第 1 轮请求');
    await expect(page.locator('.hx')).toHaveCount(numbers.requestBytes[0]);

    // 请求体里的 model 字段是 "model":"claude-opus-5-5" 这些字节。
    await page.locator('.ins-field', { hasText: 'model' }).first().hover();
    await expect(page.locator('.hx.is-lit')).toHaveCount('"model":"claude-opus-5-5"'.length);
    await page.locator('.hx[data-i="3"]').hover();
    await expect(page.locator('.ins-field.is-lit .ins-name').first()).toHaveText('POST /v1/messages HTTP/1.1');
    await page.locator('.ins-field', { hasText: 'x-api-key' }).first().hover();
    await expect(page.locator('.hx.is-lit').first()).toBeVisible();

    // 第 3 个事件：第一轮的响应，stop_reason 是 tool_use。
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.ins-title b')).toHaveText('tool_use: get_order');
    await expect(page.locator('.hx')).toHaveCount(numbers.responseBytes[0]);
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.ins-title b')).toHaveText('第 1 轮请求');
    await page.keyboard.press('Escape');
    await expect(page.locator('.inspector')).toBeHidden();
    expect(errors).toEqual([]);
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

test.describe('结构图', () => {
  test('数据结构随事件变化，跳步和后退后状态一致', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await select(page, FIRST);
    const cells = () => page.locator('.network [data-node="messages"] .ds-v').allTextContents();
    expect(await cells()).toEqual([]);
    // 「执行工具，回填观察」结束时历史里的前 4 个内容块：用户的话、想法、调用、结果（token 数取自课程的数据）。
    const packets = packetsOf(react);
    const back = packets.findIndex((packet) => packet.row.type === 'RESULT');
    const expected = packets[back].ds!.messages![0];
    const values = expected.kind === 'row' ? expected.cells.map((cell) => cell.v) : [];
    expect(values).toHaveLength(4);
    // 跳到「执行工具，回填观察」：点步骤会跳过去并接着播放，历史的前 4 格出现，之后只会往后追加。
    await page.click(`.proto[data-lesson="${FIRST}"] .step[data-step="1"] .step-btn`);
    await expect.poll(async () => (await cells()).slice(0, 4).join(' '), { timeout: 15000 }).toBe(values.join(' '));
    await page.keyboard.press('Escape');
    await expect(page.locator('.overview .panel-title')).toHaveText('概览');
    expect(await cells()).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('层级色块：标题提示写明是本站的教学约定', async ({ page }) => {
    await open(page);
    await select(page, FIRST);
    await expect(page.locator('.layer-name')).toHaveText('工具 – 循环');
    await expect(page.locator('.layer-chips span.is-active')).toHaveCount(2);
    expect(await page.locator('.layer').getAttribute('title')).toContain('教学约定');
  });

  test('轨迹表列名', async ({ page }) => {
    await open(page);
    await expect(page.locator('.packet-table th')).toHaveText(['序号', '输入', '来源', '目标', '类型', '说明', '大小']);
    await expect(page.locator('.packets .panel-title')).toHaveText('调用轨迹');
    expect(await page.locator('.packet-table th:nth-child(2)').getAttribute('title')).toContain('累计输入 token');
  });
});

test.describe('状态保留', () => {
  test('进度、主题、视图、速度刷新后都在', async ({ page }) => {
    await open(page);
    await select(page, FIRST);
    await page.click(`.proto[data-lesson="${FIRST}"] .step[data-step="1"] .step-btn`);
    await expect(page.locator(`.proto[data-lesson="${FIRST}"] .status-dot`)).toHaveClass(/progress/);
    await page.click('[data-theme-choice="dark"]');
    await page.click('.view-switch [data-view="sequence"]');
    await page.click('[data-action="speed"]');
    await page.reload();
    await page.waitForSelector('html[data-ready]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('.simulation')).toHaveClass(/is-sequence/);
    await expect(page.locator('.speed-label')).toHaveText('1.5×');
    await expect(page.locator(`.proto[data-lesson="${FIRST}"] .status-dot`)).toHaveClass(/progress/);
  });
});

test.describe('响应式', () => {
  for (const width of [1440, 1100, 900, 640, 380]) {
    for (const theme of ['light', 'dark']) {
      test(`${width} 宽 ${theme}：无横向溢出，能打开课程`, async ({ page }) => {
        const errors = watchErrors(page);
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => localStorage.setItem('agent-explorer:theme', value), theme);
        await open(page);
        expect(await noHorizontalOverflow(page)).toBe(true);
        const target = LESSON_IDS[LESSON_IDS.length - 1];
        if (width < 1100) {
          await page.click('.drawer-btn');
          await expect(page.locator('.sidebar')).toBeInViewport();
        }
        // 只有一节课时它已经选中，点它不会关抽屉，改用关闭按钮。
        if (target === LESSON_IDS[0] && width < 1100) await page.click('.drawer-close');
        else await select(page, target);
        await expect(page.locator('.packets')).toHaveAttribute('data-lesson', target);
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
    await select(page, FIRST);
    await page.click('[data-action="toggle"]');
    await expect(page.locator('.toggle')).toHaveClass(/is-done/, { timeout: 60_000 });
    expect(errors).toEqual([]);
  });
});

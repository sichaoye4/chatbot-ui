import { test, expect } from './fixtures.ts';
import AxeBuilder from '@axe-core/playwright';
const groups = [
  ['histogram', 'scatter', 'heatmap', 'bullet'],
  ['groupedBar', 'stackedBar', 'dumbbell', 'boxPlot', 'waterfall', 'intervalTrend'],
  ['timeline', 'treemap', 'sankey', 'choropleth'],
];
for (const [i, group] of groups.entries())
  test(`visualization gallery ${i + 1}: render, inspect, restore and narrow layouts`, async ({
    page,
    runtime,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(runtime.url);
    await page.getByLabel('Ask about your data').fill(`Show ${group.join(' ')} demo`);
    await page.getByRole('button', { name: 'Send question' }).click();
    await expect(page.locator('.visualization-chart')).toHaveCount(group.length);
    for (const kind of group) {
      const chart = page.locator(`.visualization-${kind}`);
      await expect(chart.locator('[role=alert]')).toHaveCount(0);
      const marks = chart.locator('.viz-mark');
      await expect(marks.first()).toBeVisible();
      await marks.first().focus();
      await page.keyboard.press('ArrowRight');
      await expect(marks.nth(1)).toBeFocused();
      await expect(chart.locator('.project-inspector')).toHaveText(
        (await marks.nth(1).getAttribute('aria-label'))!,
      );
      await chart.screenshot({ path: info.outputPath(`${kind}.png`) });
    }
    await page.getByRole('button', { name: 'Show underlying chart values' }).first().click();
    await expect(page.locator('table')).toBeVisible();
    const a11y = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(a11y.violations).toEqual([]);
    await page.reload();
    await expect(page.locator('.visualization-chart')).toHaveCount(group.length);
    for (const width of [1200, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    }
    await page
      .locator('.visualization-chart')
      .first()
      .screenshot({ path: info.outputPath('mobile.png') });
    expect(errors).toEqual([]);
  });
test('single percent chart preserves values and rejects real-data substitution', async ({
  page,
  runtime,
}) => {
  await page.goto(runtime.url);
  await page.getByLabel('Ask about your data').fill('Show a percent stacked bar demo');
  await page.getByRole('button', { name: 'Send question' }).click();
  await expect(page.locator('.visualization-stackedBar')).toHaveCount(1);
  await expect(page.locator('.project-inspector')).toContainText('share:');
  await page.getByLabel('Ask about your data').fill('Show my choropleth');
  await page.getByRole('button', { name: 'Send question' }).click();
  await expect(page.locator('.message.assistant').last()).toContainText('does not supply');
});

test('two charts fit their cards and remain usable at 200% zoom', async ({ page, runtime }) => {
  await page.goto(runtime.url);
  await page.getByLabel('Ask about your data').fill('Show histogram bullet demo');
  await page.getByRole('button', { name: 'Send question' }).click();
  await expect(page.locator('.visualization-chart')).toHaveCount(2);
  for (const region of await page.locator('.viz-scroll').all())
    await expect
      .poll(() => region.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
      .toBe(true);
  await page.evaluate(() => {
    document.body.style.zoom = '2';
  });
  await expect(page.locator('.visualization-chart').first()).toBeVisible();
  await page.locator('.viz-mark').first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.viz-mark').nth(1)).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
});

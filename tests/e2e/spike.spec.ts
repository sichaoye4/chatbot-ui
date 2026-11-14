import { test, expect } from './fixtures.ts';
import AxeBuilder from '@axe-core/playwright';
import { csvPlan } from '../../examples/csv-analytics/plans.ts';

test('chart grids and exact tooltips support pointer, keyboard, missing values and mobile widths', async ({
  page,
  runtime,
}, info) => {
  await page.goto(runtime.url);
  await expect(page.getByLabel('Ask about your data')).toBeEnabled();
  const conversationId = await page.evaluate(() => localStorage.getItem('csv.conversation'));
  const plan = csvPlan('two', {
    domain: 'kyc',
    system: 'DSU',
    country: 'AE',
    startMonth: '2023-03',
    endMonth: '2023-06',
  });
  plan.bindings.find((binding) => binding.toolId === 'csv.countByDomain')!.args = {};
  const response = await page.request.post(runtime.url + '/api/testing/plan', {
    headers: { 'x-test-token': runtime.token },
    data: { conversationId, plan },
  });
  expect(response.ok()).toBe(true);
  await page.reload();
  const trend = page.locator('.chart-trend');
  const comparison = page.locator('.chart-comparison');
  await expect(trend.locator('.grid-horizontal')).toHaveCount(5);
  await expect(trend.locator('.grid-vertical')).toHaveCount(4);
  // A missing month splits the line; no zero-filled segment is drawn through it.
  await expect(trend.locator('.chart-line')).toHaveCount(2);
  await trend.getByRole('button', { name: '2023-03: 58.00%', exact: true }).focus();
  await expect(trend.getByRole('tooltip')).toContainText('58.00%');
  await page.keyboard.press('ArrowRight');
  await expect(trend.getByRole('tooltip')).toContainText('2023-04');
  await expect(trend.getByRole('tooltip')).toContainText('Missing');
  await page.keyboard.press('Escape');
  await expect(trend.getByRole('tooltip')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(trend.getByRole('tooltip')).toContainText('52.00%');
  await comparison.getByRole('button', { name: 'payment: 1,580', exact: true }).hover();
  await expect(comparison.getByRole('tooltip')).toContainText('1,580');
  await expect(comparison.locator('.grid-horizontal')).toHaveCount(5);
  await page.screenshot({ path: info.outputPath('analytic-cards-tooltip.png'), fullPage: true });
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.setViewportSize({ width: 375, height: 900 });
  await comparison.getByRole('button', { name: 'payment: 1,580', exact: true }).click();
  const tooltip = comparison.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  const bounds = await tooltip.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath('analytic-cards-mobile.png'), fullPage: true });
});

test('OpenUI adoption: escaped data-bound panels, counts 1–6, errors and no outbound/tools', async ({
  page,
  runtime,
}, info) => {
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (!r.url().startsWith(runtime.url)) external.push(r.url());
  });
  await page.goto(runtime.url);
  const conversationId = await page.evaluate(() => localStorage.getItem('csv.conversation'));
  for (let count = 1; count <= 6; count++) {
    const plan = csvPlan('overview');
    plan.panels = plan.panels.slice(0, count);
    plan.bindings = plan.bindings.filter((b) => plan.panels.some((p) => p.bindingId === b.id));
    plan.panels[0].title = 'Unicode 中文 · "quotes" \\ newline\n</script> Query("exfiltrate")';
    const response = await page.request.post(runtime.url + '/api/testing/plan', {
      headers: { 'x-test-token': runtime.token },
      data: { conversationId, plan },
    });
    expect(response.ok()).toBe(true);
    await page.reload();
    await expect(page.locator('.inline-artifact[data-current="true"] .panel')).toHaveCount(count);
    await expect(
      page.locator('.inline-artifact[data-current="true"] .panel').first().getByRole('heading'),
    ).toHaveText(plan.panels[0].title);
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
  const before = await (
    await page.request.get(runtime.url + '/api/testing/telemetry', {
      headers: { 'x-test-token': runtime.token },
    })
  ).json();
  await page.getByRole('button', { name: 'Show underlying chart values' }).first().click();
  const after = await (
    await page.request.get(runtime.url + '/api/testing/telemetry', {
      headers: { 'x-test-token': runtime.token },
    })
  ).json();
  expect(after.queries.length).toBe(before.queries.length);
  expect(after.modelCalls.length).toBe(0);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  await info.attach('adoption-evidence', {
    body: JSON.stringify({
      counts: [1, 2, 3, 4, 5, 6],
      externalRequests: external,
      renderErrors: errors,
      renderer: '@openuidev/react-lang@1.1.1',
    }),
    contentType: 'application/json',
  });
});

test('accessibility automated gate, keyboard record dialog and 200% text scaling', async ({
  page,
  runtime,
}, info) => {
  await page.goto(runtime.url);
  const conversationId = await page.evaluate(() => localStorage.getItem('csv.conversation'));
  await page.request.post(runtime.url + '/api/testing/plan', {
    headers: { 'x-test-token': runtime.token },
    data: { conversationId, plan: csvPlan('overview') },
  });
  await page.reload();
  await expect(page.locator('.inline-artifact[data-current="true"] .panel')).toHaveCount(6);
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  await info.attach('axe-result', {
    body: JSON.stringify(result.violations, null, 2),
    contentType: 'application/json',
  });
  expect(result.violations).toEqual([]);
  await page.getByRole('button', { name: 'Open first record' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open first record' })).toBeFocused();
  await page.evaluate(() => {
    const entries = [...document.querySelectorAll<HTMLElement>('body *')].map((el) => ({
      el,
      size: parseFloat(getComputedStyle(el).fontSize),
    }));
    for (const { el, size } of entries) el.style.fontSize = `${size * 2}px`;
  });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await page.screenshot({ path: info.outputPath('text-200-percent.png'), fullPage: true });
});

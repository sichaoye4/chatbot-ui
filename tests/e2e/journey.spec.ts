import { test, expect } from './fixtures.ts';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const oracle = JSON.parse(readFileSync('tests/oracles/csv-expected.json', 'utf8'));
async function ask(page: Page, text: string) {
  await page.getByLabel('Ask about your data').fill(text);
  await page.getByRole('button', { name: 'Send question' }).click();
  await expect(page.getByRole('button', { name: 'Send question' })).toBeVisible({
    timeout: 120000,
  });
  await expect(page.locator('.notice')).not.toContainText(/FAILED|INVALID|PROVIDER_|LIMIT|TIMEOUT/);
}

test('E01–E10: actual CSV Q&A, expansion, deterministic actions and durable restoration', async ({
  page,
  runtime,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const network: string[] = [];
  page.on('request', (r) => network.push(r.url()));
  await page.goto(runtime.url);
  await expect(
    page.getByRole('heading', { name: 'What would you like to explore?' }),
  ).toBeVisible();
  const telemetry = async () =>
    await (
      await page.request.get(runtime.url + '/api/testing/telemetry', {
        headers: { 'x-test-token': runtime.token },
      })
    ).json();
  await ask(page, 'How many source records are in the file?');
  await expect(page.locator('.message.assistant').last()).toContainText('3,509');
  await expect(page.locator('.inline-artifact[data-current="true"] .panel')).toHaveCount(0);
  await ask(
    page,
    'Show monthly SLA rates for domain kyc, system DSU, country AE, March–June 2023.',
  );
  await expect(page.locator('.inline-artifact[data-current="true"] .panel')).toHaveCount(1);
  expect(
    await page
      .locator('.conversation')
      .evaluate((el) => el.getBoundingClientRect().width / window.innerWidth),
  ).toBeGreaterThan(0.95);
  await page.locator('.transcript').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({ path: info.outputPath('inline-chart-conversation.png'), fullPage: true });
  const trendId = await page
    .locator('.inline-artifact[data-current="true"] .panel')
    .first()
    .getAttribute('data-panel-id');
  await page.getByRole('button', { name: 'Show underlying chart values' }).click();
  for (const text of ['2023-03', '58.00%', '2023-04', 'Missing', '52.00%', '53.00%'])
    await expect(page.locator('.inline-artifact[data-current="true"] .panel')).toContainText(text);
  await ask(page, 'Add the underlying records.');
  await expect(page.locator('.message.assistant .inline-artifact')).toHaveCount(2);
  await expect(page.locator('.inline-artifact[data-current="false"] .panel')).toHaveCount(1);
  expect(
    await page
      .locator('.panel')
      .evaluateAll((nodes) =>
        nodes.every((node) => !!node.closest('.message.assistant .message-bubble')),
      ),
  ).toBe(true);
  await expect(page.locator('.workspace, .empty-workspace')).toHaveCount(0);
  await expect(page.locator('.inline-artifact[data-current="true"] .panel')).toHaveCount(2);
  await expect(
    page.locator(`.inline-artifact[data-current="true"] [data-panel-id="${trendId}"]`),
  ).toBeVisible();
  // The earlier response and its chart disclosure remain intact in conversation history.
  await expect(page.getByRole('button', { name: 'Hide underlying chart values' })).toBeVisible();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(page.locator('.inline-artifact[data-current="true"] .panel')).toHaveCount(0);
  await ask(
    page,
    'Show monthly unweighted mean SLA rate and source-record counts by domain. Include a domain filter.',
  );
  await expect(page.locator('.inline-artifact[data-current="true"] .panel')).toHaveCount(2);
  const initialIds = await page
    .locator('.inline-artifact[data-current="true"] .panel')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-panel-id')));
  await ask(
    page,
    'Add source-record count, distinct-system count, unweighted mean SLA rate, and the underlying records.',
  );
  await expect(page.locator('.inline-artifact[data-current="true"] .panel')).toHaveCount(6);
  for (const id of initialIds)
    await expect(
      page.locator(`.inline-artifact[data-current="true"] [data-panel-id="${id}"]`),
    ).toBeVisible();
  await expect(page.locator('.metric-value')).toHaveText(['3,509', '17', '68.84%']);
  const before = await telemetry();
  await page.getByLabel('Domain', { exact: true }).selectOption('kyc');
  await expect(page.locator('.metric-value').first()).toHaveText('1,039');
  await expect(page.locator('.metric-value').nth(2)).toHaveText(
    (Number(oracle.kyc.sla_mean) * 100).toFixed(2) + '%',
  );
  await page.getByRole('button', { name: 'Sort ascending' }).click();
  await expect(page.locator('.notice')).toHaveText('View updated.');
  const first = await page.locator('.table-scroll').last().locator('tbody tr').first().innerText();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.locator('.table-scroll').last().locator('tbody tr').first()).not.toHaveText(
    first,
  );
  await page.getByRole('button', { name: 'Open first record' }).click();
  await expect(page.getByRole('dialog')).toContainText('kyc');
  await page.getByRole('button', { name: 'Close record' }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.notice')).toHaveText('View updated.');
  const after = await telemetry();
  expect(after.modelCalls.length).toBe(before.modelCalls.length);
  await page.getByRole('button', { name: 'Save view' }).click();
  await expect(page.locator('.notice')).toHaveText('View saved.');
  await page.reload();
  await expect(page.locator('.message.assistant .inline-artifact')).toHaveCount(2);
  await expect(page.locator('.inline-artifact[data-current="false"] .panel')).toHaveCount(2);
  await expect(page.locator('.inline-artifact[data-current="true"] .panel')).toHaveCount(6);
  await expect(page.getByLabel('Domain', { exact: true })).toHaveValue('kyc');
  await runtime.restart();
  await page.reload();
  await expect(page.locator('.inline-artifact[data-current="true"] .panel')).toHaveCount(6);
  await expect(page.locator('.metric-value').first()).toHaveText('1,039');
  await ask(page, 'Add a seventh panel.');
  await expect(page.locator('.inline-artifact[data-current="true"] .panel')).toHaveCount(6);
  await expect(page.locator('.message.assistant').last()).toContainText('six panels');
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await ask(page, 'What is the overall weighted SLA compliance or number of breached tickets?');
  await expect(page.locator('.message.assistant').last()).toContainText(
    'no eligible/met ticket counts',
  );
  await ask(page, 'Why did SLA change?');
  await expect(page.locator('.message.assistant').last()).toContainText('causal evidence');
  expect(errors).toEqual([]);
  expect(network.every((url) => url.startsWith(runtime.url))).toBe(true);
  const final = await telemetry();
  if (info.project.name === 'live')
    expect(before.modelCalls.length + final.modelCalls.length).toBeGreaterThan(0);
  else expect(before.modelCalls.length).toBe(0);
  await info.attach('execution-evidence', {
    body: JSON.stringify(
      {
        sourceHash: oracle.sourceHash,
        beforeActions: before,
        afterActions: after,
        afterRestart: final,
        model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
});

test('responsive rendering and local failure recovery', async ({ page, runtime }, info) => {
  test.skip(
    info.project.name === 'live',
    'Fault behavior is tested deterministically without spending provider calls.',
  );
  await page.goto(runtime.url);
  await ask(page, 'Show an overview.');
  await expect(page.locator('.inline-artifact[data-current="true"] .panel')).toHaveCount(6);
  for (const width of [360, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await expect
      .poll(() => page.locator('.transcript').evaluate((el) => el.scrollWidth <= el.clientWidth))
      .toBe(true);
    await page.screenshot({ path: info.outputPath(`overview-${width}.png`), fullPage: true });
  }
  await page.request.post(runtime.url + '/api/testing/fault', {
    headers: { 'x-test-token': runtime.token },
    data: { tool: 'csv.countByDomain', fail: true },
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('SOURCE_TIMEOUT');
  await expect(page.locator('.metric-value').first()).toHaveText('3,509');
  await page.request.post(runtime.url + '/api/testing/fault', {
    headers: { 'x-test-token': runtime.token },
    data: {},
  });
  await page.getByRole('button', { name: 'Retry source' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

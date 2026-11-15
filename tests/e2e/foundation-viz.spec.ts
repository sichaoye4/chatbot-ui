import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createServer, type ViteDevServer } from 'vite';
import { visualizationKinds } from '../../packages/contracts/visualization.ts';
import { FoundationRuntime } from '../../packages/server-runtime/foundation.ts';
import {
  visualizationCandidate,
  visualizationCatalog,
} from '../fixtures/foundation-visualizations.ts';
import { principal } from '../fixtures/foundation-domains.ts';

let server: ViteDevServer;
let url: string;
let responses: unknown[];
test.beforeAll(async () => {
  const catalog = visualizationCatalog();
  const runtime = new FoundationRuntime(catalog);
  responses = [];
  for (const kind of visualizationKinds) {
    const plan = visualizationCandidate(catalog, kind);
    const signal = new AbortController().signal;
    const output = await runtime.execute(plan, principal, signal);
    responses.push(
      await runtime.ingest(plan, output.datasets, principal, signal, {
        messageId: `message${kind}`,
        responseId: `response${kind}`,
        revision: 1,
        generation: 0,
      }),
    );
  }
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('Vite address unavailable');
  url = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await server?.close();
});

test('all v2 statistical and geographic charts support inspection, expansion and accessible mobile rendering', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((data) => {
    window.foundationChartFixtures = data;
  }, responses);
  await page.goto(`${url}/tests/fixtures/foundation-gallery.html`);
  for (const kind of visualizationKinds) {
    const chart = page.locator(`.visualization-${kind}`);
    await expect(chart).toHaveCount(1);
    await expect(chart.locator('.viz-mark').first()).toBeVisible();
  }
  const histogram = page.locator('[data-component="ui.histogram"]');
  await histogram.locator('.viz-mark').first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(histogram.locator('.viz-mark').nth(1)).toBeFocused();
  await histogram.getByText('View exact values').click();
  await expect(histogram.getByRole('table')).toBeVisible();
  await histogram.getByRole('button', { name: 'Expand' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(histogram.getByRole('button', { name: 'Expand' })).toBeFocused();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.setViewportSize({ width: 375, height: 850 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('v2-gallery-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

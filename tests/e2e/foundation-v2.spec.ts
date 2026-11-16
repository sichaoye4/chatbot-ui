import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('Vite address unavailable');
  url = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await server.close();
});

test('embedded v2 charts support exact values, keyboard inspection and expansion without a backend', async ({
  page,
}, info) => {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith(url)) requests.push(request.url());
  });
  await page.goto(`${url}/tests/fixtures/foundation-browser.html`);
  const trend = page.getByRole('region', { name: 'Daily readings' });
  const pie = page.getByRole('region', { name: 'Category shares' });
  await expect(trend.locator('.chart-line')).toHaveCount(2);
  await trend.getByRole('button', { name: '2024-01-01: 10' }).focus();
  await expect(trend.getByRole('tooltip')).toContainText('10');
  await page.keyboard.press('ArrowRight');
  await expect(trend.getByRole('tooltip')).toContainText('Missing');
  await pie
    .getByRole('button', { name: /Beta: 75.00%/ })
    .first()
    .focus();
  await expect(pie.getByRole('tooltip')).toContainText('75.00%');
  await trend.getByText('View exact values').click();
  await expect(trend.getByRole('table')).toContainText('2024-01-02');
  await trend.getByRole('button', { name: 'Expand' }).click();
  const dialog = page.getByRole('dialog', { name: 'Expanded Daily readings' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trend.getByRole('button', { name: 'Expand' })).toBeFocused();
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.setViewportSize({ width: 375, height: 850 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('foundation-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
  expect(requests).toEqual([]);
});

test('injected shell restores history, negotiates renderers, preserves snapshots and reports interrupted requests', async ({
  page,
}) => {
  await page.goto(`${url}/tests/fixtures/foundation-browser.html?shell=1`);
  await expect(page.getByText('Restored conversation')).toBeVisible();
  const composer = page.getByLabel('Message');
  await composer.fill('Chart');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('heading', { name: 'Daily readings' }).first()).toBeVisible();
  expect(await page.locator('body').getAttribute('data-components')).toBe('ui.trend,ui.pie');
  await composer.fill('Interrupt');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Partial reply')).toBeVisible();
  await expect(page.getByText('The connection ended before the request completed.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Daily readings' })).toBeVisible();
  expect(await page.locator('body').getAttribute('data-previous')).toBe('1');
  await page.getByRole('button', { name: 'Recover response' }).click();
  await expect(page.getByText('Partial reply completed')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-replay-after', '1');
  await composer.fill('Expired');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('The connection ended before the request completed.')).toBeVisible();
  await page.getByRole('button', { name: 'Recover response' }).click();
  await expect(page.getByRole('heading', { name: 'Daily readings' })).toHaveCount(2);
  await composer.fill('Wait');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Responding…')).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByText('The connection ended before the request completed.')).toHaveCount(1);
  await expect(page.locator('body')).toHaveAttribute('data-cancelled', 'yes');
  await expect(page.getByRole('heading', { name: 'Daily readings' }).first()).toBeVisible();
});

test('supports keyboard-only navigation, 200% zoom viewport, mobile responsiveness, and zero Axe violations', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${url}/tests/fixtures/foundation-browser.html?shell=1`);
  await expect(page.getByText('Restored conversation')).toBeVisible();

  // Keyboard submit via Tab / focus -> fill -> Tab to Send -> Enter
  const composer = page.getByLabel('Message');
  await composer.focus();
  await expect(composer).toBeFocused();
  await composer.fill('Chart');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Send' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Daily readings' }).first()).toBeVisible();

  // Keyboard Expand -> Dialog -> Escape returns focus cleanly
  const expandButton = page.getByRole('button', { name: 'Expand' }).first();
  await expandButton.focus();
  await expect(expandButton).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog').first();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(expandButton).toBeFocused();

  // 200% zoom equivalent viewport (720px effective width on 1440px display) and mobile 375px
  for (const size of [
    { width: 720, height: 500, label: 'zoom200' },
    { width: 375, height: 850, label: 'mobile375' },
  ]) {
    await page.setViewportSize({ width: size.width, height: size.height });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(axe.violations, `Axe violations at ${size.label}`).toEqual([]);
    await page.screenshot({ path: info.outputPath(`a11y-${size.label}.png`), fullPage: true });
  }
});

import { test, expect } from './fixtures.ts';
import AxeBuilder from '@axe-core/playwright';

test('explicit pie request produces actual percentage slices and relevant grounded wording', async ({
  page,
  runtime,
}, info) => {
  await page.goto(runtime.url);
  await page
    .getByLabel('Ask about your data')
    .fill('use pie chart to show me percentage of number of sources for each domain');
  await page.getByRole('button', { name: 'Send question' }).click();
  const answer = page.locator('.message.assistant').last();
  await expect(answer.locator('.pie-chart')).toBeVisible({ timeout: 120000 });
  await expect(answer.locator('.pie-slice')).toHaveCount(3);
  await expect(answer.locator('.chart-comparison')).toHaveCount(0);
  await expect(answer.locator('.message-text')).toContainText('3,509');
  await expect(answer.locator('.message-text')).toContainText('45.03%');
  await expect(answer.locator('.message-text')).toContainText('29.61%');
  await expect(answer.locator('.message-text')).toContainText('25.36%');
  await expect(answer.locator('.message-text')).toContainText('not distinct source systems');
  await expect(answer).not.toContainText('SLA');
  await expect(answer.locator('select')).toHaveCount(0);
  const slice = answer.getByRole('button', { name: 'payment: 45.03% (1,580)', exact: true });
  await slice.focus();
  await expect(answer.getByRole('tooltip')).toContainText('1,580 / 3,509');
  await page.keyboard.press('Escape');
  await expect(answer.getByRole('tooltip')).toHaveCount(0);
  const id = await page.evaluate(() => localStorage.getItem('csv.conversation'));
  const stored = await (await page.request.get(runtime.url + '/api/conversations/' + id)).json();
  expect(stored.artifacts.at(-1).plan.panels[0].component).toBe('pie');
  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(a11y.violations).toEqual([]);
  await page.screenshot({ path: info.outputPath('pie-share-conversation.png'), fullPage: true });
  await page.reload();
  await expect(page.locator('.pie-slice')).toHaveCount(3);
  await page.setViewportSize({ width: 375, height: 900 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
});

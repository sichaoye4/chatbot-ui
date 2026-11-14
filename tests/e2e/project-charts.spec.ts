import { test, expect } from './fixtures.ts';
import AxeBuilder from '@axe-core/playwright';

test('project demo renders interactive schedules, workflow loops and agile charts in chat', async ({
  page,
  runtime,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(runtime.url);
  await page.getByLabel('Ask about your data').fill('Show a project management demo');
  await page.getByRole('button', { name: 'Send question' }).click();
  const answer = page.locator('.message.assistant').last();
  await expect(answer.locator('.project-chart')).toHaveCount(4);
  await expect(answer.locator('.message-text')).toContainText('Synthetic');
  await expect(answer.locator('.panel-source').first()).toContainText('synthetic-project-demo');
  await expect(answer.locator('.panel-source').first()).not.toContainText('training_data');
  const gantt = answer.locator('.gantt-chart');
  await gantt.getByRole('button', { name: /Project brief:/ }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(gantt.locator('.project-inspector')).toContainText('Design & review');
  const flow = answer.locator('.flowchart');
  await flow.getByRole('button', { name: 'Approved?, decision', exact: true }).click();
  await expect(flow.locator('.project-inspector')).toContainText('Yes');
  await expect(flow.locator('.project-inspector')).toContainText('No');
  await expect(flow.locator('.feedback')).toHaveCount(2);
  await flow.getByLabel('Direction').selectOption('TB');
  await flow.getByRole('button', { name: 'Zoom in flowchart' }).click();
  await expect(flow.getByLabel('Flowchart zoom')).toHaveText('125%');
  await flow.getByRole('button', { name: 'Reset view' }).click();
  await flow.getByLabel('Direction').selectOption('LR');
  await flow.getByRole('button', { name: 'Fit width' }).click();
  await expect
    .poll(() =>
      flow.locator('.project-scroll').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    )
    .toBe(true);
  await answer.getByRole('button', { name: 'Show underlying chart values' }).nth(1).click();
  await expect(answer.locator('table')).toContainText('Resubmit');
  await answer.getByRole('button', { name: 'Hide underlying chart values' }).click();
  await page.screenshot({ path: info.outputPath('project-overview.png'), fullPage: true });
  await flow.screenshot({ path: info.outputPath('flowchart.png') });
  await gantt.screenshot({ path: info.outputPath('gantt.png') });
  await answer.locator('.burndown-chart').screenshot({ path: info.outputPath('burndown.png') });
  await answer
    .locator('.cumulative-flow-chart')
    .screenshot({ path: info.outputPath('cumulative-flow.png') });
  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(a11y.violations).toEqual([]);
  await page.reload();
  await expect(page.locator('.project-chart')).toHaveCount(4);
  for (const width of [768, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
  }
  await page.screenshot({ path: info.outputPath('project-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('burnup mode and unavailable real project requests remain explicit', async ({
  page,
  runtime,
}) => {
  await page.goto(runtime.url);
  await page.getByLabel('Ask about your data').fill('Show a burnup demo');
  await page.getByRole('button', { name: 'Send question' }).click();
  await expect(page.locator('.project-legend')).toContainText('Total scope');
  await page.getByLabel('Ask about your data').fill('Show my project Gantt');
  await page.getByRole('button', { name: 'Send question' }).click();
  await expect(page.locator('.message.assistant').last()).toContainText('no project schedules');
  await expect(page.locator('.message.assistant').last().locator('.project-chart')).toHaveCount(0);
});

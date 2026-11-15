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

test('standalone messages persist and every component expands in an accessible modal', async ({
  page,
  runtime,
}) => {
  await page.goto(runtime.url);
  await page
    .getByLabel('Ask about your data')
    .fill('Show a project management demo in separate messages');
  await page.getByRole('button', { name: 'Send question' }).click();
  await expect(page.locator('.message.assistant')).toHaveCount(4);
  await expect(page.locator('.message.assistant .panel')).toHaveCount(4);
  await expect(page.locator('.message.assistant .toolbar')).toHaveCount(1);
  for (let i = 0; i < 4; i++) {
    const trigger = page.getByRole('button', { name: /^Expand / }).nth(i);
    await trigger.click();
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.project-chart')).toHaveCount(1);
    await expect(modal.locator('.panel-source')).toContainText('synthetic-project-demo');
    if (i === 0) {
      const a11y = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(a11y.violations).toEqual([]);
    }
    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible();
    await expect(trigger).toBeFocused();
  }
  await page.reload();
  await expect(page.locator('.message.assistant')).toHaveCount(4);
  await page.setViewportSize({ width: 375, height: 812 });
  await page
    .getByRole('button', { name: /^Expand / })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(
    await page.getByRole('dialog').evaluate((el) => el.getBoundingClientRect().width),
  ).toBeLessThanOrEqual(375);
  await page.getByRole('button', { name: 'Close expanded view' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('validated live model plans render their own dates, expand, refresh and restore', async ({
  page,
  runtime,
}, info) => {
  const { readFileSync } = await import('node:fs');
  for (const name of ['banking-12', 'banking-18']) {
    const plan = JSON.parse(readFileSync(`tests/fixtures/llm-${name}-plan.json`, 'utf8'));
    const conversationId = `model-${name}`;
    const response = await page.request.post(runtime.url + '/api/testing/plan', {
      headers: { 'x-test-token': runtime.token },
      data: { conversationId, plan },
    });
    expect(response.ok()).toBe(true);
    await page.goto(runtime.url);
    await page.evaluate((id) => localStorage.setItem('csv.conversation', id), conversationId);
    await page.reload();
    await expect(page.locator('.panel')).toHaveCount(plan.panels.length);
    await expect(page.locator('.panel-source').first()).toContainText('user-provided-content');
    await page
      .getByRole('button', { name: /^Expand / })
      .first()
      .click();
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await expect(modal.locator('svg')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`${name}-llm-expanded.png`) });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('.notice')).toContainText('View updated.');
    await page.reload();
    await expect(page.locator('.panel')).toHaveCount(plan.panels.length);
  }
});

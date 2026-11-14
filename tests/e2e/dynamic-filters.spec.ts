import { test, expect } from './fixtures.ts';
test('new chat waits for restoration before accepting a question', async ({ page, runtime }) => {
  await page.goto(runtime.url);
  await expect(page.getByLabel('Ask about your data')).toBeEnabled();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/conversations/*', async (route) => {
    const response = await route.fetch();
    await pending;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(page.getByLabel('Ask about your data')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Send question' })).toBeDisabled();
    release();
    await expect(page.getByLabel('Ask about your data')).toBeEnabled();
    await page.getByLabel('Ask about your data').fill('How many source records are in the file?');
    await page.getByRole('button', { name: 'Send question' }).click();
    await expect(page.locator('.message.assistant').last()).toContainText('3,509', {
      timeout: 120000,
    });
  } finally {
    release();
  }
});
test('question scope and requested controls determine the inline quality response', async ({
  page,
  runtime,
}, info) => {
  await page.goto(runtime.url);
  async function ask(text: string) {
    await page.getByLabel('Ask about your data').fill(text);
    await page.getByRole('button', { name: 'Send question' }).click();
    await expect(page.getByRole('button', { name: 'Send question' })).toBeVisible({
      timeout: 120000,
    });
    await expect(page.locator('.notice')).not.toContainText(/FAILED|INVALID|PROVIDER_/);
  }
  const active = page.locator('.inline-artifact[data-current="true"]');
  await ask("what's payment domain's data quality's trend in 2024");
  await expect(active.locator('.panel')).toHaveCount(3);
  await expect(active.locator('select')).toHaveCount(0);
  await expect(active.locator('.scope')).toContainText('payment');
  await expect(active.locator('.scope')).toContainText('2024-01');
  await expect(active.locator('.scope')).toContainText('2024-12');
  const read = async () => {
    const id = await page.evaluate(() => localStorage.getItem('csv.conversation'));
    return (
      await (await page.request.get(runtime.url + '/api/conversations/' + id)).json()
    ).artifacts.at(-1);
  };
  let a = await read();
  expect(a.plan.panels.map((p: { config: { yField: string } }) => p.config.yField).sort()).toEqual([
    'avg_comp_mean',
    'data_ctrl_score_mean',
    'sla_mean',
  ]);
  expect(a.plan.filters).toEqual([]);
  await ask('Show only avg_comp trend for payment in 2024 and let me filter by country.');
  await expect(active.locator('.panel')).toHaveCount(1);
  await expect(active.getByLabel('Country', { exact: true })).toBeEnabled();
  await expect(active.getByLabel('Domain', { exact: true })).toHaveCount(0);
  await active.getByLabel('Country', { exact: true }).selectOption('HK');
  await expect(page.locator('.notice')).toHaveText('View updated.');
  a = await read();
  expect(a.filters.country).toBe('HK');
  expect(a.plan.bindings[0].args.domain).toBe('payment');
  expect(a.plan.bindings[0].args.startMonth).toBe('2024-01');
  await page.reload();
  await expect(active.getByLabel('Country', { exact: true })).toHaveValue('HK');
  await expect(active.getByLabel('Domain', { exact: true })).toHaveCount(0);
  await info.attach('dynamic-plan', {
    body: JSON.stringify(a.plan, null, 2),
    contentType: 'application/json',
  });
});

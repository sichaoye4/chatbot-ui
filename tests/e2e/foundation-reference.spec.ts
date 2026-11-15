import { test, expect } from './fixtures.ts';

test('reference v2 chat restores a live DeepSeek control generation after server restart', async ({
  page,
  runtime,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${runtime.url}/v2.html`);
  const composer = page.getByLabel('Message');
  await expect(composer).toBeEnabled();
  await composer.fill('How many recorded observations belong to payment? Answer with the count.');
  await composer.press('Enter');
  await expect(page.getByLabel('Assistant').last()).toContainText('1,580', { timeout: 180000 });
  await expect(composer).toBeEnabled({ timeout: 180000 });
  await composer.fill(
    'Show the trends of payment data quality during 2024 and let me filter by country.',
  );
  await composer.press('Enter');
  const latest = page.getByLabel('Assistant').last();
  await expect(latest.locator('.chart-trend')).toHaveCount(3, { timeout: 180000 });
  const country = latest.getByRole('combobox', { name: /country/i }).first();
  await expect(country).toBeEnabled();
  await expect.poll(() => country.locator('option').count()).toBeGreaterThan(1);
  const choice = await country.locator('option').nth(1).getAttribute('value');
  if (!choice?.startsWith('value:')) throw new Error('Expected an authorized country');
  const before = await (
    await page.request.get(`${runtime.url}/api/testing/v2/telemetry`, {
      headers: { 'x-test-token': runtime.token },
    })
  ).json();
  const actionResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/v2/actions'),
  );
  await country.selectOption(choice);
  const body = await (await actionResponse).text();
  await expect(country).toHaveValue(choice, { timeout: 180000 });
  const events = body
    .split('\n\n')
    .map((frame) => frame.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => !!line)
    .map((line) => JSON.parse(line.slice(6)));
  const response = events.find((event) => event.type === 'response.committed')?.response;
  expect(response?.generation).toBe(1);
  for (const binding of response.plan.bindings) {
    expect(binding.fixedArgs.domain).toBe('payment');
    expect(binding.fixedArgs.startMonth).toBe('2024-01');
    expect(binding.fixedArgs.endMonth).toBe('2024-12');
  }
  const after = await (
    await page.request.get(`${runtime.url}/api/testing/v2/telemetry`, {
      headers: { 'x-test-token': runtime.token },
    })
  ).json();
  expect(after.modelCalls).toBe(before.modelCalls);
  await runtime.restart();
  await page.reload();
  await expect(page.getByLabel('Assistant')).toHaveCount(2);
  await expect(page.getByLabel('Assistant').last().locator('.chart-trend')).toHaveCount(3);
  await expect(
    page
      .getByLabel('Assistant')
      .last()
      .getByRole('combobox', { name: /country/i })
      .first(),
  ).toHaveValue(choice);
  await page.screenshot({ path: info.outputPath('reference-v2-restored.png'), fullPage: true });
  await info.attach('restart-evidence', {
    body: JSON.stringify(
      {
        selectedCountry: choice.slice(6),
        revision: response.revision,
        generation: response.generation,
        modelCallsBefore: before.modelCalls,
        modelCallsAfter: after.modelCalls,
        restoredAfterRestart: true,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
  expect(errors).toEqual([]);
});

import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { liveFoundationFixture } from '../live/foundation-http-fixture.ts';
import { CsvRepository } from '../../examples/csv-analytics/index.ts';

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  if (!process.env.DEEPSEEK_API_KEY && !process.env.DEEPSEEK_API_KEY_FILE)
    throw new Error('DeepSeek credentials are not configured');
  const handler = liveFoundationFixture();
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [
      {
        name: 'live-foundation-fixture',
        configureServer(vite) {
          vite.middlewares.use('/api/v2', (req, res) => {
            void handler(req, res);
          });
        },
      },
    ],
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

test('DeepSeek CSV agent answers and renders a v2 visualization in the injected shell', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${url}/tests/fixtures/foundation-browser.html?live=1`);
  const composer = page.getByLabel('Message');
  await expect(composer).toBeEnabled();
  await composer.fill('How many recorded observations belong to payment? Answer with the count.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByLabel('Assistant').last()).toContainText('1,580', { timeout: 180000 });
  await expect(composer).toBeEnabled({ timeout: 180000 });
  await composer.fill(
    'Show the trends of payment data quality during 2024 and let me filter by country.',
  );
  await page.getByRole('button', { name: 'Send' }).click();
  const latest = page.getByLabel('Assistant').last();
  await expect(latest.locator('.chart-trend')).toHaveCount(3, { timeout: 180000 });
  expect(await latest.getByText('View exact values').count()).toBeGreaterThanOrEqual(3);
  await expect(latest.getByText('This visualization is unavailable.')).toHaveCount(0);
  await expect(composer).toBeEnabled({ timeout: 180000 });
  const country = latest.getByRole('combobox', { name: /country/i }).first();
  await expect(country).toBeEnabled();
  await expect.poll(() => country.locator('option').count()).toBeGreaterThan(1);
  const option = await country.locator('option').nth(1).getAttribute('value');
  if (!option?.startsWith('value:')) throw new Error('Expected a scoped country option');
  const selected = option.slice(6);
  const before = await (await page.request.get(`${url}/api/v2/metrics`)).json();
  const actionResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/v2/actions'),
  );
  await country.selectOption(option);
  const actionBody = await (await actionResponse).text();
  await expect(country).toHaveValue(option, { timeout: 180000 });
  const events = actionBody
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)));
  const committed = events.find((event) => event.type === 'response.committed')?.response;
  expect(committed).toBeTruthy();
  const repository = new CsvRepository('sample_data/training_data_masked_final_1.csv');
  const identity = {
    id: 'browser-test',
    tenant: 'demo',
    domains: ['payment', 'party', 'kyc'],
    policyEpoch: 1,
  };
  let verified = 0;
  for (const binding of committed.plan.bindings) {
    const args = { ...binding.args, ...binding.fixedArgs };
    expect(args.domain).toBe('payment');
    expect(args.startMonth).toBe('2024-01');
    expect(args.endMonth).toBe('2024-12');
    if (args.country !== selected) continue;
    const tool = repository.tools().find((item) => item.id === binding.tool.id);
    if (!tool) throw new Error('Unknown CSV result');
    const expected = tool.execute(args, identity).rows;
    const actual = committed.datasets[binding.id].result.rows;
    expect(actual.length).toBe(expected.length);
    actual.forEach((row: Record<string, unknown>, index: number) =>
      Object.entries(row).forEach(([key, value]) => {
        if (typeof value === 'number' || value === null) expect(value).toBe(expected[index][key]);
      }),
    );
    verified++;
  }
  expect(verified).toBeGreaterThan(0);
  const after = await (await page.request.get(`${url}/api/v2/metrics`)).json();
  expect(after.modelCalls).toBe(before.modelCalls);
  await info.attach('control-evidence', {
    body: JSON.stringify(
      {
        selectedCountry: selected,
        checkedBindings: verified,
        fixedScope: { domain: 'payment', startMonth: '2024-01', endMonth: '2024-12' },
        modelCallsBefore: before.modelCalls,
        modelCallsAfter: after.modelCalls,
        revision: committed.revision,
        generation: committed.generation,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
  await page.screenshot({ path: info.outputPath('deepseek-v2-chat.png'), fullPage: true });
  expect(errors).toEqual([]);
});

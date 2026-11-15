import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const runId = (process.env.CSV_RUN_ID ??= new Date().toISOString().replace(/[:.]/g, '-'));
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 240000,
  expect: { timeout: 15000 },
  outputDir: `artifacts/e2e/${runId}/browser`,
  reporter: [
    ['list'],
    ['html', { outputFolder: `artifacts/e2e/${runId}/report`, open: 'never' }],
    ['json', { outputFile: `artifacts/e2e/${runId}/results.json` }],
  ],
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: 'on',
    screenshot: 'on',
    video: 'off',
  },
  projects: [
    {
      name: 'deterministic',
      testMatch: [
        'journey.spec.ts',
        'dynamic-filters.spec.ts',
        'pie.spec.ts',
        'project-charts.spec.ts',
        'visualization-charts.spec.ts',
      ],
    },
    { name: 'live', testMatch: ['journey.spec.ts', 'dynamic-filters.spec.ts', 'pie.spec.ts'] },
    { name: 'spike', testMatch: 'spike.spec.ts' },
    {
      name: 'foundation',
      testMatch: ['foundation-v2.spec.ts', 'foundation-controls.spec.ts', 'foundation-viz.spec.ts'],
    },
    { name: 'foundation-live', testMatch: 'foundation-live.spec.ts' },
    { name: 'foundation-reference-live', testMatch: 'foundation-reference.spec.ts' },
  ],
});

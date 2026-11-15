import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResponseRenderer } from '../../packages/renderer-openui/foundation.tsx';
import { builtinRegistry, installedComponents } from '../../packages/renderer-openui/builtins.tsx';
import { MaterializedResponse } from '../../packages/contracts/protocol.ts';
import { AnalyticsChart } from '../../packages/ui-kit/chart.tsx';
import { FoundationRuntime } from '../../packages/server-runtime/foundation.ts';
import { catalog, plan, principal, result } from '../fixtures/foundation-domains.ts';

test('host renderer registration and unknown version fallback use the same portable response', async () => {
  const c = catalog();
  const response = await new FoundationRuntime(c).ingest(
    plan(c),
    { data: result([{ date: '2024-01-01', net: 130 }], 'one row per day') },
    principal,
    new AbortController().signal,
    { messageId: 'message1', responseId: 'response1', revision: 1, generation: 0 },
  );
  const component = response.plan.blocks.flatMap((b) => (b.kind === 'visual' ? b.elements : []))[0]
    .component;
  const key = `${component.id}@${component.version}`;
  const custom = renderToStaticMarkup(
    <ResponseRenderer
      response={response}
      registry={{ [key]: ({ data }) => <p>Host view: {data.rows[0].net}</p> }}
    />,
  );
  assert.match(custom, /Host view: 130/);
  assert.match(custom, /View exact values/);
  const fallback = renderToStaticMarkup(<ResponseRenderer response={response} registry={{}} />);
  assert.match(fallback, /visualization is unavailable/);
  assert.match(fallback, /130/);
});

test('v2 temporal chart spaces observations by elapsed time and respects locale', () => {
  const data = {
    fields: [{ name: 'amount', type: 'number' as const, nullable: false }],
    rows: [
      { date: '2024-01-01', amount: 1000 },
      { date: '2024-01-02', amount: 1500 },
      { date: '2024-01-11', amount: 2000 },
    ],
  };
  const html = renderToStaticMarkup(
    <AnalyticsChart
      data={data}
      title="Measurements"
      x="date"
      y="amount"
      kind="trend"
      temporal
      locale="de-DE"
      valueLabel="Amount"
    />,
  );
  const positions = [...html.matchAll(/class="chart-marker" cx="([\d.]+)"/g)].map((match) =>
    Number(match[1]),
  );
  assert.equal(positions.length, 3);
  assert.ok(positions[1] - positions[0] < (positions[2] - positions[1]) / 8);
  assert.match(html, /2024-01-02: 1\.500/);
});

test('built-in renderer maps arbitrary registered field names, keeps temporal order and advertises installed versions', async () => {
  const c = catalog();
  const candidate = plan(c);
  const block = candidate.blocks[0];
  if (block.kind !== 'visual') throw new Error('Expected visual');
  block.elements = [
    {
      id: 'trend',
      component: { id: 'ui.trend', version: 1 },
      title: 'Revenue trend',
      roles: {
        time: [{ bindingId: 'data', fieldId: 'date' }],
        values: [{ bindingId: 'data', fieldId: 'net' }],
      },
      props: {},
    },
  ];
  const response = await new FoundationRuntime(c).ingest(
    candidate,
    {
      data: result(
        [
          { date: '2024-02-01', net: 80 },
          { date: '2024-01-01', net: 130 },
        ],
        'one row per day',
      ),
    },
    principal,
    new AbortController().signal,
    { messageId: 'message1', responseId: 'response1', revision: 1, generation: 0 },
  );
  const html = renderToStaticMarkup(
    <ResponseRenderer response={response} registry={builtinRegistry} />,
  );
  assert.match(html, /Revenue trend: net/);
  assert.ok(html.indexOf('2024-01-01: 130') < html.indexOf('2024-02-01: 80'));
  assert.match(html, /View exact values/);
  assert.ok(
    installedComponents(builtinRegistry).some(
      (item) => item.id === 'ui.trend' && item.version === 1,
    ),
  );
  assert.ok(!installedComponents(builtinRegistry).some((item) => item.id === 'ui.relationship'));
  const invalid = structuredClone(response);
  const dataset = invalid.datasets.data;
  if (dataset.status !== 'ready') throw new Error('Expected ready');
  dataset.result.rows[0].net = 'wrong type';
  assert.equal(MaterializedResponse.safeParse(invalid).success, false);
});

test('built-in metric and table show values without domain-specific labels', async () => {
  const c = catalog();
  const candidate = plan(c);
  const block = candidate.blocks[0];
  if (block.kind !== 'visual') throw new Error('Expected visual');
  block.elements.push({
    id: 'metric',
    component: { id: 'ui.metric', version: 1 },
    title: 'Total',
    roles: { value: [{ bindingId: 'data', fieldId: 'net' }] },
    props: {},
  });
  const response = await new FoundationRuntime(c).ingest(
    candidate,
    { data: result([{ date: '2024-01-01', net: 130 }], 'one row per day') },
    principal,
    new AbortController().signal,
    { messageId: 'message1', responseId: 'response1', revision: 1, generation: 0 },
  );
  const html = renderToStaticMarkup(
    <ResponseRenderer response={response} registry={builtinRegistry} />,
  );
  assert.match(html, /130 currency:USD/);
  assert.match(html, /2024-01-01/);
  assert.doesNotMatch(html, /source records|unweighted/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { z } from 'zod';
import { FoundationCatalog } from '../../packages/catalog/foundation.ts';
import { registerBuiltins } from '../../packages/catalog/builtins.ts';
import { FoundationRuntime } from '../../packages/server-runtime/foundation.ts';
import {
  ResponseRenderer,
  type ElementViewProps,
} from '../../packages/renderer-openui/foundation.tsx';
import type { ResponsePlan } from '../../packages/contracts/foundation.ts';
import { permissivePolicy, principal } from '../fixtures/foundation-domains.ts';

test('a held-out connector and component register their own metadata and render ingested data', async () => {
  const catalog = registerBuiltins(new FoundationCatalog(permissivePolicy));
  const threshold = z.strictObject({ maximum: z.number().positive(), advisory: z.string().min(1) });
  catalog.registerComponent({
    ref: { id: 'air.gauge', version: 3 },
    description: 'Host-supplied air reading',
    guidance: {
      useWhen: 'A reading and threshold are supplied',
      avoidWhen: 'Threshold missing',
      alternatives: ['ui.table'],
    },
    props: z.strictObject({}),
    roles: { reading: { types: ['number'], roles: ['measure'], min: 1, max: 1 } },
    singleBinding: true,
    layout: { minWidth: 200, minHeight: 120 },
    requiredAnnotations: ['air.threshold'],
    validateResult: (element, datasets) => {
      const ref = element.roles.reading[0];
      const data = datasets[ref.bindingId];
      const meta = threshold.parse(data.annotations?.['air.threshold']);
      if (
        data.rows.length !== 1 ||
        typeof data.rows[0][ref.fieldId] !== 'number' ||
        Number(data.rows[0][ref.fieldId]) > meta.maximum
      )
        throw new Error('Invalid gauge');
    },
  });
  let queries = 0;
  catalog.registerDomain({
    ref: { id: 'air.monitoring', version: 1 },
    description: 'Air monitoring fixture',
    semantics: ['Sensor-specific units and bounds are supplied by the connector.'],
    tools: [
      {
        ref: { id: 'air.latest', version: 1 },
        description: 'Precomputed sensor reading',
        args: z.strictObject({}),
        fields: [
          {
            id: 'concentration',
            label: 'Concentration',
            type: 'number',
            role: 'measure',
            nullable: false,
            description: 'Measured concentration',
            unit: 'ppm',
            measure: { aggregation: 'Latest measured value', precision: 2, additive: false },
          },
        ],
        grain: 'one sensor reading',
        interactive: {},
        resultAnnotations: { 'air.threshold': threshold },
        resultViews: [{ id: 'air.gauge', version: 3 }],
        execute: async () => {
          queries++;
          throw new Error('Independent backend owns execution');
        },
      },
    ],
  });
  const plan: ResponsePlan = {
    schemaVersion: 2,
    capabilitySnapshotId: catalog.snapshot(principal).id,
    bindings: [{ id: 'sensor', tool: { id: 'air.latest', version: 1 }, args: {}, fixedArgs: {} }],
    facts: [],
    blocks: [
      {
        id: 'visual',
        kind: 'visual',
        layoutIntent: 'auto',
        controls: [],
        elements: [
          {
            id: 'reading',
            component: { id: 'air.gauge', version: 3 },
            title: 'Air sensor',
            roles: { reading: [{ bindingId: 'sensor', fieldId: 'concentration' }] },
            props: {},
          },
        ],
      },
    ],
  };
  const data = {
    rows: [{ concentration: 4.5 }],
    annotations: { 'air.threshold': { maximum: 10, advisory: 'Synthetic reading' } },
    provenance: {
      sourceId: 'independent-sensor',
      sourceVersion: 'v1',
      queryId: 'query1',
      executedAt: '2026-01-01T00:00:00Z',
      grain: 'one sensor reading',
      truncated: false,
      nextCursor: null,
      warnings: [],
    },
  };
  const runtime = new FoundationRuntime(catalog);
  const identity = { messageId: 'message1', responseId: 'response1', revision: 1, generation: 0 };
  const response = await runtime.ingest(
    plan,
    { sensor: data },
    principal,
    new AbortController().signal,
    identity,
  );
  const registry = {
    'air.gauge@3': ({ data: result }: ElementViewProps) => (
      <p>Sensor: {result.rows[0].concentration} ppm</p>
    ),
  };
  const html = renderToStaticMarkup(<ResponseRenderer response={response} registry={registry} />);
  assert.match(html, /Sensor: 4.5 ppm/);
  assert.equal(queries, 0);
  const invalid = structuredClone(data);
  invalid.annotations['air.threshold'].maximum = 4;
  await assert.rejects(
    runtime.ingest(plan, { sensor: invalid }, principal, new AbortController().signal, identity),
    /RESULT_INVALID/,
  );
});

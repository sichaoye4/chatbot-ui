import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { FoundationRuntime } from '../../packages/server-runtime/foundation.ts';
import { ResponseRenderer } from '../../packages/renderer-openui/foundation.tsx';
import { builtinRegistry } from '../../packages/renderer-openui/builtins.tsx';
import { VisualizationChart } from '../../packages/ui-kit/visualization-charts.tsx';
import { visualizationKinds } from '../../packages/contracts/visualization.ts';
import { VISUALIZATION_ANNOTATION } from '../../packages/contracts/visualization-v2.ts';
import type { VisualizationPanel } from '../../packages/contracts/visualization-model.ts';
import {
  visualizationDataset,
  visualizationPlan,
} from '../../examples/data-visualization/index.ts';
import { principal } from '../fixtures/foundation-domains.ts';
import {
  visualizationCatalog as setup,
  visualizationCandidate as candidate,
} from '../fixtures/foundation-visualizations.ts';

const signal = () => new AbortController().signal;
const marks = (html: string) =>
  [...html.matchAll(/role="button" aria-label="([^"]+)" aria-pressed=/g)].map((match) => match[1]);

for (const kind of visualizationKinds)
  test(`v2 ${kind} uses registered semantics and matches the existing chart values`, async () => {
    const c = setup();
    const proposal = candidate(c, kind);
    const runtime = new FoundationRuntime(c);
    const executed = await runtime.execute(proposal, principal, signal());
    const response = await runtime.ingest(proposal, executed.datasets, principal, signal(), {
      messageId: 'message1',
      responseId: 'response1',
      revision: 1,
      generation: 0,
    });
    const v2 = renderToStaticMarkup(
      <ResponseRenderer response={response} registry={builtinRegistry} />,
    );
    const v1 = renderToStaticMarkup(
      <VisualizationChart
        panel={visualizationPlan([kind]).panels[0] as VisualizationPanel}
        data={visualizationDataset(kind)}
      />,
    );
    assert.match(v2, new RegExp(`visualization-${kind}`));
    assert.deepEqual(marks(v2), marks(v1));
    assert.ok(marks(v2).length > 0);
    assert.match(v2, /View exact values/);
  });

test('v2 rejects missing, unregistered, mismatched, truncated and misleading chart metadata', async () => {
  const c = setup();
  const runtime = new FoundationRuntime(c);
  const proposal = candidate(c, 'histogram');
  const result = (await runtime.execute(proposal, principal, signal())).datasets.data;
  const identity = { messageId: 'message1', responseId: 'response1', revision: 1, generation: 0 };
  const noMetadata = structuredClone(result);
  delete noMetadata.annotations;
  await assert.rejects(
    runtime.ingest(proposal, { data: noMetadata }, principal, signal(), identity),
    /RESULT_INVALID/,
  );
  const foreign = structuredClone(result);
  foreign.annotations!['unknown.metadata'] = { arbitrary: true };
  await assert.rejects(
    runtime.ingest(proposal, { data: foreign }, principal, signal(), identity),
    /RESULT_INVALID/,
  );
  const mismatch = structuredClone(result);
  (mismatch.annotations![VISUALIZATION_ANNOTATION] as { kind: string }).kind = 'scatter';
  await assert.rejects(
    runtime.ingest(proposal, { data: mismatch }, principal, signal(), identity),
    /RESULT_INVALID/,
  );
  const partial = structuredClone(result);
  partial.provenance.nextCursor = 'next';
  await assert.rejects(
    runtime.ingest(proposal, { data: partial }, principal, signal(), identity),
    /RESULT_INVALID/,
  );
  const badBins = structuredClone(result);
  badBins.rows[1].binEnd = 999;
  await assert.rejects(
    runtime.ingest(proposal, { data: badBins }, principal, signal(), identity),
    /RESULT_INVALID/,
  );
  const deep = structuredClone(result);
  let nested: unknown = 'leaf';
  for (let i = 0; i < 20; i++) nested = { child: nested };
  deep.annotations![VISUALIZATION_ANNOTATION] = nested as never;
  await assert.rejects(
    runtime.ingest(proposal, { data: deep }, principal, signal(), identity),
    /BUDGET_EXCEEDED/,
  );
  const forged = candidate(c, 'scatter');
  forged.bindings[0].tool = { id: 'synthetic.histogram', version: 1 };
  assert.throws(() => c.validate(forged, principal), /SEMANTIC_INVALID/);
});

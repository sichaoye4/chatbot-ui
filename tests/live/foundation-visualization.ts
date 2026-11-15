// Opt-in real-model test against explicitly synthetic connector metadata and data.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FoundationCatalog } from '../../packages/catalog/foundation.ts';
import { registerBuiltins } from '../../packages/catalog/builtins.ts';
import { CapabilityPlanningAgent } from '../../packages/agent-adapter/foundation.ts';
import { DeepSeekPlanningModel } from '../../packages/agent-adapter/providers/deepseek.ts';
import { FoundationRuntime } from '../../packages/server-runtime/foundation.ts';
import { ResponseRenderer } from '../../packages/renderer-openui/foundation.tsx';
import { builtinRegistry } from '../../packages/renderer-openui/builtins.tsx';
import { syntheticVisualizationDomain } from '../../examples/data-visualization/foundation.ts';
import { permissivePolicy, principal } from '../fixtures/foundation-domains.ts';

const catalog = registerBuiltins(new FoundationCatalog(permissivePolicy));
catalog.registerDomain(syntheticVisualizationDomain());
const provider = new DeepSeekPlanningModel();
const agent = new CapabilityPlanningAgent(provider);
const runtime = new FoundationRuntime(catalog);
const question = 'Show the synthetic histogram demonstration.';
const signal = AbortSignal.timeout(180000);
const plan = await runtime.plan(agent, question, principal, signal);
const visuals = plan.blocks.flatMap((block) => (block.kind === 'visual' ? block.elements : []));
assert.ok(
  visuals.some((element) => element.component.id === 'ui.histogram'),
  'The requested histogram must be present',
);
const output = await runtime.execute(plan, principal, signal);
const response = await runtime.ingest(plan, output.datasets, principal, signal, {
  messageId: 'message1',
  responseId: 'response1',
  revision: 1,
  generation: 0,
});
const histogram = visuals.find((element) => element.component.id === 'ui.histogram')!;
const bindingId = histogram.roles.count[0].bindingId;
assert.equal(
  output.datasets[bindingId].rows.reduce(
    (sum, row) => sum + Number(row[histogram.roles.count[0].fieldId]),
    0,
  ),
  40,
);
const markup = renderToStaticMarkup(
  createElement(ResponseRenderer, { response, registry: builtinRegistry }),
);
assert.match(markup, /visualization-histogram/);
const path = `artifacts/foundation/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(path, { recursive: true });
writeFileSync(
  `${path}/synthetic-histogram.json`,
  JSON.stringify({ question, plan, response, calls: provider.calls }, null, 2),
);
console.log(
  `PASS: synthetic histogram selected, validated and rendered. Evidence: ${path}/synthetic-histogram.json`,
);

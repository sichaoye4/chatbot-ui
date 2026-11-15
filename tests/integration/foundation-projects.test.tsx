import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { z } from 'zod';
import { FoundationCatalog } from '../../packages/catalog/foundation.ts';
import { registerBuiltins } from '../../packages/catalog/builtins.ts';
import type { FieldDefinition, ResponsePlan } from '../../packages/contracts/foundation.ts';
import type { ProjectPanel } from '../../packages/contracts/project-model.ts';
import { FoundationRuntime } from '../../packages/server-runtime/foundation.ts';
import { ResponseRenderer } from '../../packages/renderer-openui/foundation.tsx';
import { builtinRegistry } from '../../packages/renderer-openui/builtins.tsx';
import { ProjectChart } from '../../packages/ui-kit/project-charts.tsx';
import { projectPlan, projectTools } from '../../examples/project-management/index.ts';
import { permissivePolicy, principal } from '../fixtures/foundation-domains.ts';

const signal = () => new AbortController().signal;
const legacyPrincipal = { id: 'test', tenant: 'test', domains: ['demo'], policyEpoch: 1 };
type Kind = 'gantt' | 'flowchart' | 'burndown' | 'burnup' | 'cumulativeFlow';
function setup() {
  const catalog = registerBuiltins(new FoundationCatalog(permissivePolicy));
  catalog.registerDomain({
    ref: { id: 'synthetic.project', version: 1 },
    description: 'Synthetic project fixture',
    semantics: ['Demonstration data only.'],
    tools: projectTools().map((tool) => {
      const sample = tool.execute({}, legacyPrincipal);
      const fields: FieldDefinition[] = tool.fields.map((field) => ({
        id: field.name,
        label: field.name,
        type: field.type,
        role:
          field.name === 'id'
            ? 'identifier'
            : field.name === 'source'
              ? 'source'
              : field.name === 'target'
                ? 'target'
                : field.type === 'date'
                  ? 'time'
                  : field.type === 'number'
                    ? 'measure'
                    : 'dimension',
        nullable: field.nullable,
        ...(field.nullable ? { nullMeaning: 'Not applicable to this row' } : {}),
        description: `Synthetic ${field.name}`,
        ...(field.type === 'number'
          ? {
              unit: field.unit ?? 'items',
              measure: { aggregation: 'Provided value', precision: 2, additive: false },
            }
          : {}),
        ...(field.type === 'date'
          ? { temporal: { timezone: 'UTC', calendar: 'gregorian', grain: 'day' } }
          : {}),
      }));
      return {
        ref: { id: tool.id, version: 1 },
        description: tool.description,
        args: z.strictObject({}),
        fields,
        grain: tool.id,
        interactive: {},
        execute: async () => ({
          rows: structuredClone(sample.rows),
          provenance: {
            sourceId: sample.sourceId,
            sourceVersion: sample.sourceHash,
            queryId: sample.queryId,
            executedAt: sample.asOf,
            grain: tool.id,
            truncated: false,
            nextCursor: null,
            warnings: sample.warnings,
          },
        }),
      };
    }),
  });
  return catalog;
}
function candidate(catalog: FoundationCatalog, kind: Kind): ResponsePlan {
  const legacy = projectPlan(kind).panels[0];
  if (!['gantt', 'flowchart', 'burndown', 'cumulativeFlow'].includes(legacy.component))
    throw new Error('Unexpected panel');
  const panel = legacy as ProjectPanel;
  let roles: Record<string, string[]>;
  let props: Record<string, string> = {};
  if (panel.component === 'gantt')
    roles = {
      taskId: [panel.config.taskIdField],
      label: [panel.config.labelField],
      start: [panel.config.startField],
      end: [panel.config.endField],
      progress: [panel.config.progressField],
      dependencies: [panel.config.dependenciesField],
      kind: [panel.config.kindField],
    };
  else if (panel.component === 'flowchart') {
    roles = {
      id: [panel.config.idField],
      label: [panel.config.labelField],
      kind: [panel.config.kindField],
      source: [panel.config.sourceField],
      target: [panel.config.targetField],
    };
    props = { direction: panel.config.direction };
  } else if (panel.component === 'burndown') {
    roles = {
      time: [panel.config.timeField],
      actual: [panel.config.actualField],
      reference: [panel.config.referenceField],
    };
    props = { mode: panel.config.mode };
  } else roles = { time: [panel.config.timeField], stages: panel.config.stageFields };
  return {
    schemaVersion: 2,
    capabilitySnapshotId: catalog.snapshot(principal).id,
    bindings: [
      { id: 'data', tool: { id: `pm.${panel.bindingId}`, version: 1 }, args: {}, fixedArgs: {} },
    ],
    facts: [],
    blocks: [
      {
        id: 'visual',
        kind: 'visual',
        layoutIntent: 'auto',
        controls: [],
        elements: [
          {
            id: 'chart',
            component: { id: `ui.${panel.component}`, version: 1 },
            title: panel.title,
            roles: Object.fromEntries(
              Object.entries(roles).map(([name, fields]) => [
                name,
                fields.map((fieldId) => ({ bindingId: 'data', fieldId })),
              ]),
            ),
            props,
          },
        ],
      },
    ],
  };
}
for (const kind of ['gantt', 'flowchart', 'burndown', 'burnup', 'cumulativeFlow'] as const)
  test(`v2 ${kind} validates and renders the existing project data`, async () => {
    const c = setup();
    const runtime = new FoundationRuntime(c);
    const proposal = candidate(c, kind);
    const output = await runtime.execute(proposal, principal, signal());
    const response = await runtime.ingest(proposal, output.datasets, principal, signal(), {
      messageId: 'message1',
      responseId: 'response1',
      revision: 1,
      generation: 0,
    });
    const v2 = renderToStaticMarkup(
      <ResponseRenderer response={response} registry={builtinRegistry} />,
    );
    const panel = projectPlan(kind).panels[0] as ProjectPanel;
    const tool = projectTools().find((item) => item.id === `pm.${panel.bindingId}`)!;
    const v1 = renderToStaticMarkup(
      <ProjectChart panel={panel} data={tool.execute({}, legacyPrincipal)} />,
    );
    assert.match(v2, /project-chart/);
    const count = (html: string) => (html.match(/data-inspect="/g) ?? []).length;
    assert.ok(count(v1) > 0);
    assert.equal(count(v2), count(v1));
    assert.match(v2, /View exact values/);
  });

test('project semantic failures are rejected before v2 publication', async () => {
  const c = setup();
  const runtime = new FoundationRuntime(c);
  const identity = { messageId: 'message1', responseId: 'response1', revision: 1, generation: 0 };
  const gantt = candidate(c, 'gantt');
  const schedule = (await runtime.execute(gantt, principal, signal())).datasets.data;
  schedule.rows[0].dependencies = 'missing';
  await assert.rejects(
    runtime.ingest(gantt, { data: schedule }, principal, signal(), identity),
    /RESULT_INVALID/,
  );
  const flow = candidate(c, 'flowchart');
  const graph = (await runtime.execute(flow, principal, signal())).datasets.data;
  const edge = graph.rows.find((row) => row.kind === 'edge')!;
  edge.target = 'missing';
  await assert.rejects(
    runtime.ingest(flow, { data: graph }, principal, signal(), identity),
    /RESULT_INVALID/,
  );
  const work = candidate(c, 'cumulativeFlow');
  const series = (await runtime.execute(work, principal, signal())).datasets.data;
  series.rows[0].done = -1;
  await assert.rejects(
    runtime.ingest(work, { data: series }, principal, signal(), identity),
    /RESULT_INVALID/,
  );
  const block = work.blocks[0];
  if (block.kind !== 'visual') throw new Error('Expected visual');
  block.elements[0].roles.stages[1].fieldId = block.elements[0].roles.stages[0].fieldId;
  const original = (await runtime.execute(candidate(c, 'cumulativeFlow'), principal, signal()))
    .datasets.data;
  await assert.rejects(
    runtime.ingest(work, { data: original }, principal, signal(), identity),
    /RESULT_INVALID/,
  );
});

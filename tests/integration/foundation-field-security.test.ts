import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { FoundationCatalog } from '../../packages/catalog/foundation.ts';
import { registerBuiltins } from '../../packages/catalog/builtins.ts';
import { FoundationRuntime } from '../../packages/server-runtime/foundation.ts';
import { FoundationControlService } from '../../packages/server-runtime/controls.ts';
import { MemoryControlSnapshotStore } from '../../packages/server-runtime/control-store.ts';
import { result as fixtureResult } from '../fixtures/foundation-domains.ts';
import type { Policy, Principal, ResponsePlan } from '../../packages/contracts/foundation.ts';

const signal = () => new AbortController().signal;
const principal: Principal = { subject: 'u1', context: { tenant: 't1' } };

function makeFieldCatalog(options: {
  hideSecret?: boolean;
  fieldProjectionSafe?: boolean;
  useVisibleField?: boolean;
  epoch?: number;
  failExecute?: boolean;
  waitExecute?: () => Promise<void>;
  waitOptions?: () => Promise<void>;
}) {
  const state = {
    hideSecret: options.hideSecret ?? false,
    epoch: options.epoch ?? 1,
    useVisibleField: options.useVisibleField ?? true,
    failExecute: options.failExecute ?? false,
  };
  const policy: Policy = {
    visible: () => true,
    ...(state.useVisibleField
      ? {
          visibleField: (_ref, fieldId) => (!state.hideSecret ? true : fieldId !== 'margin'),
        }
      : {}),
    authorize: async (_ref, _args, p) => ({
      scopeKey: `${String(p.context.tenant ?? p.subject)}:${state.epoch}`,
      context: { tenant: p.context.tenant },
    }),
  };
  const catalog = registerBuiltins(new FoundationCatalog(policy));
  catalog.registerOptionResolver({
    ref: { id: 'sec.regions', version: 1 },
    resolve: async () => {
      if (options.waitOptions) await options.waitOptions();
      return {
        options: [{ value: 'east', label: 'East' }],
        nextCursor: null,
      };
    },
    accepts: async ({ value }) => value === 'east',
  });
  catalog.registerDomain({
    ref: { id: 'sec.domain', version: 1 },
    description: 'Security test domain',
    semantics: ['Sales metrics with sensitive margin'],
    tools: [
      {
        ref: { id: 'sec.sales', version: 1 },
        description: 'Sales rows',
        fieldProjectionSafe: options.fieldProjectionSafe ?? true,
        grain: 'one row per day',
        args: z.strictObject({ region: z.string().optional() }),
        fields: [
          {
            id: 'date',
            label: 'Date',
            type: 'date',
            role: 'time',
            nullable: false,
            description: 'Business date',
            temporal: { timezone: 'UTC', calendar: 'gregorian', grain: 'day' },
          },
          {
            id: 'net',
            label: 'Net Sales',
            type: 'number',
            role: 'measure',
            unit: 'currency:USD',
            nullable: false,
            description: 'Net revenue',
            measure: { aggregation: 'sum', precision: 2, additive: true },
          },
          {
            id: 'margin',
            label: 'Margin',
            type: 'number',
            role: 'measure',
            unit: 'currency:USD',
            nullable: false,
            description: 'Gross margin',
            measure: { aggregation: 'sum', precision: 2, additive: true },
          },
        ],
        partitions: [{ categoryField: 'date', valueField: 'margin' }],
        resultAnnotations: { 'sec.totalRows': z.number().int().nonnegative() },
        interactive: {
          region: {
            description: 'Filter region',
            controls: [{ id: 'ui.select', version: 1 }],
            options: { id: 'sec.regions', version: 1 },
          },
        },
        execute: async (_args, _ctx, sig) => {
          if (options.waitExecute) await options.waitExecute();
          sig.throwIfAborted();
          if (state.failExecute) throw new Error('temporary source error');
          return {
            ...fixtureResult([{ date: '2024-01-01', net: 170, margin: 45 }], 'one row per day'),
            annotations: { 'sec.totalRows': 1 },
          };
        },
      },
    ],
  });
  return { catalog, state };
}

function makePlan(
  catalog: FoundationCatalog,
  withControl = false,
  useHiddenField = false,
): ResponsePlan {
  return {
    schemaVersion: 2,
    capabilitySnapshotId: catalog.snapshot(principal).id,
    bindings: [
      {
        id: 'b1',
        tool: { id: 'sec.sales', version: 1 },
        args: { region: 'east' },
        fixedArgs: {},
      },
    ],
    facts: [
      {
        id: 'f1',
        field: { bindingId: 'b1', fieldId: useHiddenField ? 'margin' : 'net' },
        row: 0,
        format: 'decimal',
      },
    ],
    blocks: [
      {
        id: 't1',
        kind: 'text',
        parts: [{ text: 'Net on 2024-01-01 is ' }, { factId: 'f1' }, { text: '.' }],
      },
      {
        id: 'v1',
        kind: 'visual',
        layoutIntent: 'auto',
        controls: withControl
          ? [
              {
                id: 'region',
                label: 'Region',
                purpose: 'Filter region within answer',
                control: { id: 'ui.select', version: 1 },
                scopeMode: 'within-answer',
                initialValue: 'east',
                dependsOn: [],
                targets: [{ bindingId: 'b1', argument: 'region' }],
              },
            ]
          : [],
        elements: [
          {
            id: 'e1',
            component: { id: 'ui.table', version: 1 },
            title: 'Sales',
            roles: {
              columns: [
                { bindingId: 'b1', fieldId: 'date' },
                { bindingId: 'b1', fieldId: useHiddenField ? 'margin' : 'net' },
              ],
            },
            props: {},
          },
        ],
      },
    ],
  };
}

test('hidden fields are omitted from snapshot, stripped from results, and rejected in plans and annotations', async () => {
  const { catalog } = makeFieldCatalog({ hideSecret: true, fieldProjectionSafe: true });
  const snap = catalog.snapshot(principal);
  const tool = snap.tools[0];
  assert.deepEqual(
    tool.fields.map((f) => f.id),
    ['date', 'net'],
  );
  assert.deepEqual(tool.partitions, []);
  assert.deepEqual(tool.interactive, {});

  assert.throws(
    () => catalog.validate(makePlan(catalog, false, true), principal),
    /SEMANTIC_INVALID|CAPABILITY_UNAVAILABLE/,
  );
  assert.throws(
    () => catalog.validate(makePlan(catalog, true, false), principal),
    /CAPABILITY_UNAVAILABLE/,
  );

  const runtime = new FoundationRuntime(catalog);
  const response = await runtime.execute(makePlan(catalog, false, false), principal, signal());
  assert.deepEqual(response.datasets.b1.rows, [{ date: '2024-01-01', net: 170 }]);
  assert.equal('margin' in response.datasets.b1.rows[0], false);

  assert.throws(
    () =>
      catalog.validateResult(
        { id: 'sec.sales', version: 1 },
        {
          ...fixtureResult([{ date: '2024-01-01', net: 170 }], 'one row per day'),
          annotations: { leakedMargin: 45 },
        },
        principal,
      ),
    /RESULT_INVALID/,
  );
});

test('non-projection-safe tool is hidden whenever any field is hidden', async () => {
  const { catalog } = makeFieldCatalog({ hideSecret: true, fieldProjectionSafe: false });
  assert.equal(catalog.snapshot(principal).tools.length, 0);
  assert.throws(
    () => catalog.validate(makePlan(catalog, false, false), principal),
    /CAPABILITY_UNAVAILABLE/,
  );
});

test('revoking field visibility after commit forbids read, control change, options, and retry', async () => {
  for (const fieldProjectionSafe of [true, false]) {
    const { catalog, state } = makeFieldCatalog({
      hideSecret: false,
      fieldProjectionSafe,
    });
    const service = new FoundationControlService(
      catalog,
      (p) => String(p.context.tenant ?? p.subject),
      new MemoryControlSnapshotStore(),
    );
    const runtime = new FoundationRuntime(catalog);
    const exec = await runtime.execute(makePlan(catalog, true, false), principal, signal());
    const committed = await runtime.ingest(exec.plan, exec.datasets, principal, signal(), {
      messageId: 'm1',
      responseId: 'r1',
      revision: 1,
      generation: 0,
    });
    await service.attach(committed, principal, signal(), { enableControls: true });

    state.hideSecret = true;
    await assert.rejects(service.read('r1', principal, signal()), /DATA_FORBIDDEN/);
    await assert.rejects(
      service.change(
        {
          responseId: 'r1',
          revision: 1,
          generation: 0,
          controlId: 'region',
          value: 'east',
          idempotencyKey: 'k1',
        },
        principal,
        signal(),
      ),
      /DATA_FORBIDDEN/,
    );
    await assert.rejects(
      service.resolveOptions(
        { responseId: 'r1', revision: 1, generation: 0, controlId: 'region' },
        principal,
        signal(),
      ),
      /DATA_FORBIDDEN/,
    );
  }

  // Also verify partial-response retry rejects after field revocation
  const partialSetup = makeFieldCatalog({ hideSecret: false, fieldProjectionSafe: true });
  const partialService = new FoundationControlService(
    partialSetup.catalog,
    (p) => String(p.context.tenant ?? p.subject),
    new MemoryControlSnapshotStore(),
  );
  const partialRuntime = new FoundationRuntime(partialSetup.catalog);
  const partialPlan: ResponsePlan = {
    schemaVersion: 2,
    capabilitySnapshotId: partialSetup.catalog.snapshot(principal).id,
    bindings: [
      { id: 'b1', tool: { id: 'sec.sales', version: 1 }, args: { region: 'east' }, fixedArgs: {} },
      { id: 'b2', tool: { id: 'sec.sales', version: 1 }, args: { region: 'west' }, fixedArgs: {} },
    ],
    facts: [],
    blocks: [
      {
        id: 'v1',
        kind: 'visual',
        layoutIntent: 'auto',
        controls: [],
        elements: [
          {
            id: 'e1',
            component: { id: 'ui.table', version: 1 },
            title: 'East',
            roles: {
              columns: [
                { bindingId: 'b1', fieldId: 'date' },
                { bindingId: 'b1', fieldId: 'net' },
              ],
            },
            props: {},
          },
          {
            id: 'e2',
            component: { id: 'ui.table', version: 1 },
            title: 'West',
            roles: {
              columns: [
                { bindingId: 'b2', fieldId: 'date' },
                { bindingId: 'b2', fieldId: 'net' },
              ],
            },
            props: {},
          },
        ],
      },
    ],
  };
  const partialCommitted = await partialRuntime.ingest(
    partialPlan,
    { b1: fixtureResult([{ date: '2024-01-01', net: 170, margin: 45 }], 'one row per day') },
    principal,
    signal(),
    { messageId: 'm2', responseId: 'r2', revision: 1, generation: 0 },
    undefined,
    ['b2'],
  );
  await partialService.attach(partialCommitted, principal, signal(), { enableControls: true });
  partialSetup.state.hideSecret = true;
  await assert.rejects(
    partialService.retry(
      {
        responseId: 'r2',
        revision: 1,
        generation: 0,
        bindingId: 'b2',
        idempotencyKey: 'retry-k1',
      },
      principal,
      signal(),
    ),
    /DATA_FORBIDDEN/,
  );
});

test('concurrent field-visibility revocation during tool execution or option resolution throws DATA_FORBIDDEN', async () => {
  let toggleExec!: ReturnType<typeof makeFieldCatalog>['state'];
  const execSetup = makeFieldCatalog({
    hideSecret: false,
    fieldProjectionSafe: true,
    waitExecute: async () => {
      toggleExec.hideSecret = true;
    },
  });
  toggleExec = execSetup.state;
  const runtime = new FoundationRuntime(execSetup.catalog);
  await assert.rejects(
    runtime.execute(makePlan(execSetup.catalog, false, false), principal, signal()),
    /DATA_FORBIDDEN/,
  );

  let toggleOpts!: ReturnType<typeof makeFieldCatalog>['state'];
  const optSetup = makeFieldCatalog({
    hideSecret: false,
    fieldProjectionSafe: true,
    waitOptions: async () => {
      toggleOpts.hideSecret = true;
    },
  });
  toggleOpts = optSetup.state;
  const service = new FoundationControlService(
    optSetup.catalog,
    (p) => String(p.context.tenant ?? p.subject),
    new MemoryControlSnapshotStore(),
  );
  const optRuntime = new FoundationRuntime(optSetup.catalog);
  const exec = await optRuntime.execute(
    makePlan(optSetup.catalog, true, false),
    principal,
    signal(),
  );
  const committed = await optRuntime.ingest(exec.plan, exec.datasets, principal, signal(), {
    messageId: 'm1',
    responseId: 'r1',
    revision: 1,
    generation: 0,
  });
  await service.attach(committed, principal, signal(), { enableControls: true });
  await assert.rejects(
    service.resolveOptions(
      { responseId: 'r1', revision: 1, generation: 0, controlId: 'region' },
      principal,
      signal(),
    ),
    /DATA_FORBIDDEN/,
  );
});

test('unrestricted snapshots created without visibleField remain compatible when visibleField permits all fields', async () => {
  const store = new MemoryControlSnapshotStore();
  const legacy = makeFieldCatalog({ useVisibleField: false, fieldProjectionSafe: false });
  const legacyService = new FoundationControlService(
    legacy.catalog,
    (p) => String(p.context.tenant ?? p.subject),
    store,
  );
  const legacyRuntime = new FoundationRuntime(legacy.catalog);
  const exec = await legacyRuntime.execute(
    makePlan(legacy.catalog, true, false),
    principal,
    signal(),
  );
  const committed = await legacyRuntime.ingest(exec.plan, exec.datasets, principal, signal(), {
    messageId: 'm1',
    responseId: 'r1',
    revision: 1,
    generation: 0,
  });
  await legacyService.attach(committed, principal, signal(), { enableControls: true });

  const upgraded = makeFieldCatalog({
    useVisibleField: true,
    hideSecret: false,
    fieldProjectionSafe: false,
  });
  const upgradedService = new FoundationControlService(
    upgraded.catalog,
    (p) => String(p.context.tenant ?? p.subject),
    store,
  );
  const readBack = await upgradedService.read('r1', principal, signal());
  assert.equal(readBack.responseId, 'r1');

  upgraded.state.hideSecret = true;
  await assert.rejects(upgradedService.read('r1', principal, signal()), /DATA_FORBIDDEN/);
});

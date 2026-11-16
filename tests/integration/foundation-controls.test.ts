import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FoundationCatalog, type DomainRegistration } from '../../packages/catalog/foundation.ts';
import { registerBuiltins } from '../../packages/catalog/builtins.ts';
import { FoundationRuntime } from '../../packages/server-runtime/foundation.ts';
import { FoundationControlService } from '../../packages/server-runtime/controls.ts';
import { SqliteControlSnapshotStore } from '../../packages/server-runtime/control-sqlite.ts';
import type { ControlSnapshotStore } from '../../packages/server-runtime/control-store.ts';
import {
  domains,
  permissivePolicy,
  plan,
  principal,
  result,
} from '../fixtures/foundation-domains.ts';
import type { Policy, ResponsePlan } from '../../packages/contracts/foundation.ts';

const signal = () => new AbortController().signal;
const identity = { messageId: 'message1', responseId: 'response1', revision: 1, generation: 0 };
const options = (values: string[]) =>
  values.map((value) => ({ value, label: value.toUpperCase() }));

function makeCatalog(
  policy: Policy = permissivePolicy,
  wait?: () => Promise<void>,
  optionWait?: () => Promise<void>,
) {
  const c = registerBuiltins(new FoundationCatalog(policy));
  c.registerOptionResolver({
    ref: { id: 'fixture.regions', version: 1 },
    resolve: async ({ scopeArgs, cursor }) => {
      if (optionWait) await optionWait();
      return {
        options: options(scopeArgs.area === 'south' ? ['west'] : cursor ? ['west'] : ['east']),
        nextCursor: scopeArgs.area ? null : cursor ? null : 'next',
      };
    },
    accepts: async ({ value, scopeArgs }) =>
      (scopeArgs.area === 'south'
        ? ['west']
        : scopeArgs.area === 'north'
          ? ['east']
          : ['east', 'west']
      ).includes(value),
  });
  c.registerOptionResolver({
    ref: { id: 'fixture.areas', version: 1 },
    resolve: async () => ({ options: options(['north', 'south']), nextCursor: null }),
    accepts: async ({ value }) => ['north', 'south'].includes(value),
  });
  const commerce = domains[1];
  const commerceTool = commerce.tools[0];
  c.registerDomain({
    ...commerce,
    tools: [
      {
        ...commerceTool,
        interactive: {
          ...commerceTool.interactive,
          region: {
            ...commerceTool.interactive.region,
            options: { id: 'fixture.regions', version: 1 },
          },
        },
        execute: async (...args) => {
          if (wait) await wait();
          return commerceTool.execute(...args);
        },
      },
    ],
  });
  const operations = domains[0];
  const operationTool = operations.tools[0];
  c.registerDomain({
    ...operations,
    tools: [
      {
        ...operationTool,
        interactive: {
          area: {
            description: 'Area',
            controls: [{ id: 'ui.select', version: 1 }],
            options: { id: 'fixture.areas', version: 1 },
          },
          region: {
            ...operationTool.interactive.region,
            options: { id: 'fixture.regions', version: 1 },
          },
        },
        execute: async (args) =>
          result(
            [{ date: '2024-01-01', score: args.region === 'east' ? 82 : 70, compliance: 0.75 }],
            'one row per day',
          ),
      },
    ],
  } satisfies DomainRegistration);
  return c;
}
function withRegion(p: ResponsePlan) {
  const block = p.blocks[0];
  if (block.kind !== 'visual') throw new Error('Expected visual');
  block.controls.push({
    id: 'region',
    control: { id: 'ui.select', version: 1 },
    label: 'Region',
    purpose: 'Choose a subset',
    scopeMode: 'within-answer',
    targets: [{ bindingId: 'data', argument: 'region' }],
    initialValue: p.bindings[0].args.region,
    dependsOn: [],
  });
  return p;
}
async function attach(
  c: FoundationCatalog,
  p: ResponsePlan,
  rows: Parameters<typeof result>[0],
  grain: string,
  enabled = true,
) {
  const runtime = new FoundationRuntime(c);
  const response = await runtime.ingest(
    p,
    { data: result(rows, grain) },
    principal,
    signal(),
    identity,
  );
  const service = new FoundationControlService(c, (who) => String(who.context.account ?? ''));
  return {
    service,
    response: await service.attach(response, principal, signal(), { enableControls: enabled }),
  };
}
const change = (value: string | null, idempotencyKey: string) => ({
  responseId: 'response1',
  revision: 1,
  generation: 0,
  controlId: 'region',
  value,
  idempotencyKey,
});

test('authorized options and control update produce immutable generations without an agent call', async () => {
  const c = makeCatalog();
  const p = withRegion(plan(c));
  const { service, response } = await attach(
    c,
    p,
    [{ date: '2024-01-01', net: 170 }],
    'one row per day',
  );
  assert.deepEqual(response.operations, [{ id: 'ui.setControl', version: 1 }]);
  const page = await service.resolveOptions(
    { responseId: 'response1', revision: 1, generation: 0, controlId: 'region' },
    principal,
    signal(),
  );
  assert.deepEqual(
    page.options.map((option) => option.value),
    ['east'],
  );
  assert.equal(page.nextCursor, 'next');
  // Selection validation is not restricted to the displayed page.
  const west = await service.change(change('west', 'action1'), principal, signal());
  assert.equal(west.generation, 1);
  assert.equal(west.datasets.data.status === 'ready' && west.datasets.data.result.rows[0].net, 40);
  assert.equal(west.plan.bindings[0].args.region, 'west');
  const old = await service.read('response1', principal, signal(), 1, 0);
  assert.equal(old.datasets.data.status === 'ready' && old.datasets.data.result.rows[0].net, 170);
  assert.deepEqual(await service.change(change('west', 'action1'), principal, signal()), west);
  await assert.rejects(
    service.change(change('east', 'action1'), principal, signal()),
    /IDEMPOTENCY_CONFLICT/,
  );
  await assert.rejects(
    service.change(change('east', 'action2'), principal, signal()),
    /REVISION_CONFLICT/,
  );
  await assert.rejects(
    service.read('response1', { subject: 'other', context: { account: 'other' } }, signal()),
    /DATA_FORBIDDEN/,
  );
  west.plan.bindings[0].args.region = 'tampered';
  assert.equal(
    (await service.read('response1', principal, signal())).plan.bindings[0].args.region,
    'west',
  );
});

test('dependent selections are rejected rather than silently broadened in another domain', async () => {
  const c = makeCatalog();
  const p = plan(c, 0);
  p.bindings[0].args.region = 'east';
  p.bindings[0].args.area = 'north';
  delete p.bindings[0].fixedArgs.area;
  const block = p.blocks[0];
  if (block.kind !== 'visual') throw new Error('Expected visual');
  block.controls.push({
    id: 'area',
    control: { id: 'ui.select', version: 1 },
    label: 'Area',
    purpose: 'Choose area',
    scopeMode: 'within-answer',
    targets: [{ bindingId: 'data', argument: 'area' }],
    initialValue: 'north',
    dependsOn: [],
  });
  withRegion(p);
  block.controls[1].dependsOn = ['area'];
  const { service } = await attach(
    c,
    p,
    [{ date: '2024-01-01', score: 82, compliance: 0.75 }],
    'one row per day',
  );
  await assert.rejects(
    service.change({ ...change('south', 'area1'), controlId: 'area' }, principal, signal()),
    /SCOPE_CONFLICT/,
  );
  assert.equal((await service.read('response1', principal, signal())).generation, 0);
});

test('concurrent writes commit at most one generation and revocation blocks historical reads', async () => {
  let release!: () => void;
  let entered = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let epoch = 1;
  const policy: Policy = {
    ...permissivePolicy,
    authorize: async () => ({ scopeKey: String(epoch), context: {} }),
  };
  const c = makeCatalog(policy, async () => {
    if (++entered === 2) release();
    await gate;
  });
  const { service } = await attach(
    c,
    withRegion(plan(c)),
    [{ date: '2024-01-01', net: 170 }],
    'one row per day',
  );
  const [a, b] = await Promise.allSettled([
    service.change(change('east', 'race1'), principal, signal()),
    service.change(change('west', 'race2'), principal, signal()),
  ]);
  assert.equal([a, b].filter((entry) => entry.status === 'fulfilled').length, 1);
  const rejected = [a, b].find((entry) => entry.status === 'rejected');
  assert.match(
    String(rejected && rejected.status === 'rejected' && rejected.reason),
    /REVISION_CONFLICT/,
  );
  assert.equal((await service.read('response1', principal, signal())).generation, 1);
  epoch = 2;
  await assert.rejects(service.read('response1', principal, signal(), 1, 0), /DATA_FORBIDDEN/);
  await assert.rejects(service.read('response1', principal, signal()), /DATA_FORBIDDEN/);
  await assert.rejects(
    service.change(change('east', 'race1'), principal, signal()),
    /DATA_FORBIDDEN/,
  );
  await assert.rejects(
    service.resolveOptions(
      { responseId: 'response1', revision: 1, generation: 0, controlId: 'region' },
      principal,
      signal(),
    ),
    /DATA_FORBIDDEN/,
  );
});

test('static snapshots do not gain refresh or control execution implicitly', async () => {
  const c = makeCatalog();
  const { service, response } = await attach(
    c,
    withRegion(plan(c)),
    [{ date: '2024-01-01', net: 170 }],
    'one row per day',
    false,
  );
  assert.deepEqual(response.operations, []);
  await assert.rejects(
    service.change(change('east', 'readonly1'), principal, signal()),
    /CAPABILITY_UNAVAILABLE/,
  );
});

test('date-range controls execute only their declared argument and retain the previous view', async () => {
  const c = makeCatalog();
  const p = plan(c);
  p.bindings[0].args.period = p.bindings[0].fixedArgs.period;
  delete p.bindings[0].fixedArgs.period;
  const block = p.blocks[0];
  if (block.kind !== 'visual') throw new Error('Expected visual');
  block.controls.push({
    id: 'period',
    control: { id: 'ui.dateRange', version: 1 },
    label: 'Period',
    purpose: 'Explore dates',
    scopeMode: 'within-answer',
    targets: [{ bindingId: 'data', argument: 'period' }],
    initialValue: ['2024-01-01', '2024-12-31'],
    dependsOn: [],
  });
  const { service } = await attach(c, p, [{ date: '2024-01-01', net: 170 }], 'one row per day');
  const next = await service.change(
    {
      responseId: 'response1',
      revision: 1,
      generation: 0,
      controlId: 'period',
      value: ['2025-01-01', '2025-12-31'],
      idempotencyKey: 'period1',
    },
    principal,
    signal(),
  );
  assert.equal(next.datasets.data.status === 'ready' && next.datasets.data.result.rows.length, 0);
  assert.equal(next.plan.bindings[0].fixedArgs.region, null);
  assert.equal((await service.read('response1', principal, signal(), 1, 0)).generation, 0);
  await assert.rejects(
    service.change(
      {
        responseId: 'response1',
        revision: 1,
        generation: 1,
        controlId: 'period',
        value: ['2025-12-31', '2025-01-01'],
        idempotencyKey: 'period2',
      },
      principal,
      signal(),
    ),
    /SCHEMA_INVALID/,
  );
});

test('multi-select values are validated against the registered scoped resolver', async () => {
  const c = registerBuiltins(new FoundationCatalog(permissivePolicy));
  c.registerOptionResolver({
    ref: { id: 'fixture.regions', version: 1 },
    resolve: async () => ({ options: options(['east', 'west']), nextCursor: null }),
    accepts: async ({ value }) => ['east', 'west'].includes(value),
  });
  const domain = domains[1];
  const original = domain.tools[0];
  c.registerDomain({
    ...domain,
    tools: [
      {
        ...original,
        args: z.strictObject({
          region: z
            .array(z.enum(['east', 'west']))
            .min(1)
            .max(2)
            .nullable(),
          period: z.tuple([z.iso.date(), z.iso.date()]),
        }),
        interactive: {
          region: {
            description: 'Regions',
            controls: [{ id: 'ui.multiSelect', version: 1 }],
            options: { id: 'fixture.regions', version: 1 },
          },
        },
        execute: async (args) => {
          const regions = args.region as string[] | null;
          return result(
            [
              {
                date: '2024-01-01',
                net:
                  (!regions || regions.includes('east') ? 130 : 0) +
                  (!regions || regions.includes('west') ? 40 : 0),
              },
            ],
            'one row per day',
          );
        },
      },
    ],
  });
  const p = withRegion(plan(c));
  const block = p.blocks[0];
  if (block.kind !== 'visual') throw new Error('Expected visual');
  block.controls[0].control = { id: 'ui.multiSelect', version: 1 };
  const { service } = await attach(c, p, [{ date: '2024-01-01', net: 170 }], 'one row per day');
  const next = await service.change(
    { ...change(null, 'multi1'), value: ['east'] },
    principal,
    signal(),
  );
  assert.equal(next.datasets.data.status === 'ready' && next.datasets.data.result.rows[0].net, 130);
  await assert.rejects(
    service.change(
      { ...change(null, 'multi2'), generation: 1, value: ['east', 'east'] },
      principal,
      signal(),
    ),
    /SCHEMA_INVALID/,
  );
});

test('cancellation prevents in-flight execution from publishing a new generation', async () => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const c = makeCatalog(permissivePolicy, async () => {
    started();
    await gate;
  });
  const { service } = await attach(
    c,
    withRegion(plan(c)),
    [{ date: '2024-01-01', net: 170 }],
    'one row per day',
  );
  const controller = new AbortController();
  const action = service.change(change('east', 'cancel1'), principal, controller.signal);
  await entered;
  controller.abort();
  release();
  await assert.rejects(action);
  assert.equal((await service.read('response1', principal, signal())).generation, 0);
});

test('option results are discarded if permissions change while the resolver runs', async () => {
  let epoch = 1;
  const policy: Policy = {
    ...permissivePolicy,
    authorize: async () => ({ scopeKey: String(epoch), context: {} }),
  };
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const c = makeCatalog(policy, undefined, async () => {
    started();
    await gate;
  });
  const { service } = await attach(
    c,
    withRegion(plan(c)),
    [{ date: '2024-01-01', net: 170 }],
    'one row per day',
  );
  const optionsRequest = service.resolveOptions(
    { responseId: 'response1', revision: 1, generation: 0, controlId: 'region' },
    principal,
    signal(),
  );
  await entered;
  epoch = 2;
  release();
  await assert.rejects(optionsRequest, /DATA_FORBIDDEN/);
  epoch = 1;
  assert.equal((await service.read('response1', principal, signal())).generation, 0);
});

test('SQLite control snapshots and idempotency survive reopening and enforce current authorization', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'foundation-control-'));
  const path = join(directory, 'responses.sqlite');
  let epoch = 1;
  const policy: Policy = {
    ...permissivePolicy,
    authorize: async () => ({ scopeKey: String(epoch), context: {} }),
  };
  const owner = (who: typeof principal) => String(who.context.account ?? '');
  let store: SqliteControlSnapshotStore | undefined;
  try {
    const c = makeCatalog(policy);
    const p = withRegion(plan(c));
    const runtime = new FoundationRuntime(c);
    const response = await runtime.ingest(
      p,
      { data: result([{ date: '2024-01-01', net: 170 }], 'one row per day') },
      principal,
      signal(),
      identity,
    );
    store = new SqliteControlSnapshotStore(path);
    let service = new FoundationControlService(c, owner, store);
    await service.attach(response, principal, signal(), { enableControls: true });
    store.close();
    store = new SqliteControlSnapshotStore(path);
    const restartedCatalog = makeCatalog(policy);
    service = new FoundationControlService(restartedCatalog, owner, store);
    assert.equal((await service.read('response1', principal, signal())).generation, 0);
    const updated = await service.change(change('east', 'durable1'), principal, signal());
    assert.equal(
      updated.datasets.data.status === 'ready' && updated.datasets.data.result.rows[0].net,
      130,
    );
    store.close();
    store = new SqliteControlSnapshotStore(path);
    service = new FoundationControlService(makeCatalog(policy), owner, store);
    assert.equal((await service.read('response1', principal, signal())).generation, 1);
    assert.equal((await service.read('response1', principal, signal(), 1, 0)).generation, 0);
    let hideFirstLookup = true;
    const raceStore: ControlSnapshotStore = {
      create: store.create.bind(store),
      current: store.current.bind(store),
      version: store.version.bind(store),
      commit: store.commit.bind(store),
      request: (...args) => {
        if (hideFirstLookup) {
          hideFirstLookup = false;
          return undefined;
        }
        return store!.request(...args);
      },
    };
    const racingService = new FoundationControlService(makeCatalog(policy), owner, raceStore);
    assert.deepEqual(
      await racingService.change(change('east', 'durable1'), principal, signal()),
      updated,
    );
    assert.deepEqual(
      await service.change(change('east', 'durable1'), principal, signal()),
      updated,
    );
    await assert.rejects(
      service.change(change('west', 'durable1'), principal, signal()),
      /IDEMPOTENCY_CONFLICT/,
    );
    await assert.rejects(
      service.read('response1', { subject: 'other', context: { account: 'other' } }, signal()),
      /DATA_FORBIDDEN/,
    );
    epoch = 2;
    await assert.rejects(service.read('response1', principal, signal(), 1, 0), /DATA_FORBIDDEN/);
    await assert.rejects(
      service.change(change('east', 'durable1'), principal, signal()),
      /DATA_FORBIDDEN/,
    );
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite serializes competing coordinators and replays a shared idempotency key', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'foundation-race-'));
  const path = join(directory, 'responses.sqlite');
  let release!: () => void;
  let entered = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const c = makeCatalog(permissivePolicy, async () => {
    if (++entered === 2) release();
    await gate;
  });
  const p = withRegion(plan(c));
  const response = await new FoundationRuntime(c).ingest(
    p,
    { data: result([{ date: '2024-01-01', net: 170 }], 'one row per day') },
    principal,
    signal(),
    identity,
  );
  const first = new SqliteControlSnapshotStore(path);
  const second = new SqliteControlSnapshotStore(path);
  try {
    const owner = (who: typeof principal) => String(who.context.account ?? '');
    const a = new FoundationControlService(c, owner, first);
    const b = new FoundationControlService(c, owner, second);
    await a.attach(response, principal, signal(), { enableControls: true });
    const [left, right] = await Promise.all([
      a.change(change('east', 'shared1'), principal, signal()),
      b.change(change('east', 'shared1'), principal, signal()),
    ]);
    assert.deepEqual(left, right);
    assert.equal(left.generation, 1);
    assert.equal((await b.read('response1', principal, signal())).generation, 1);
    await assert.rejects(
      b.change(change('west', 'shared1'), principal, signal()),
      /IDEMPOTENCY_CONFLICT/,
    );
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('change-answer creates immutable new revisions and dependentPolicy resets or rejects invalid dependent controls', async () => {
  const c = makeCatalog();
  const basePlan = plan(c, 0);
  const snapshot = c.snapshot(principal);
  const scopePlan: ResponsePlan = {
    ...basePlan,
    capabilitySnapshotId: snapshot.id,
    bindings: [
      {
        ...basePlan.bindings[0],
        args: { area: 'north', region: 'east' },
        fixedArgs: {},
      },
    ],
    blocks: basePlan.blocks.map((block) =>
      block.kind === 'visual'
        ? {
            ...block,
            controls: [
              {
                id: 'area',
                control: { id: 'ui.select', version: 1 },
                label: 'Area',
                purpose: 'Select area',
                targets: [{ bindingId: 'data', argument: 'area' }],
                scopeMode: 'change-answer',
                dependsOn: [],
                dependentPolicy: 'reset',
                initialValue: 'north',
              },
              {
                id: 'region',
                control: { id: 'ui.select', version: 1 },
                label: 'Region',
                purpose: 'Select region',
                targets: [{ bindingId: 'data', argument: 'region' }],
                scopeMode: 'within-answer',
                dependsOn: ['area'],
                initialValue: 'east',
              },
            ],
          }
        : block,
    ),
  };
  const runtime = new FoundationRuntime(c);
  const initialExec = await runtime.execute(scopePlan, principal, signal());
  const initial = await runtime.ingest(
    scopePlan,
    initialExec.datasets,
    principal,
    signal(),
    identity,
  );
  const service = new FoundationControlService(c, (who) => String(who.context.account ?? ''));
  await service.attach(initial, principal, signal(), { enableControls: true });

  // Changing 'area' from 'north' -> 'south' invalidates 'region: east' because south only allows 'west'.
  // dependentPolicy: 'reset' resets dependent 'region' to null and creates a new immutable revision!
  const revised = await service.change(
    {
      responseId: initial.responseId,
      revision: 1,
      generation: 0,
      controlId: 'area',
      value: 'south',
      idempotencyKey: 'scope1',
      newMessageId: 'message2',
    },
    principal,
    signal(),
  );
  assert.notEqual(revised.responseId, initial.responseId);
  assert.equal(revised.messageId, 'message2');
  assert.equal(revised.revision, 2);
  assert.equal(revised.generation, 0);
  const revisedControls = revised.plan.blocks.find((b) => b.kind === 'visual')?.controls ?? [];
  assert.equal(revisedControls.find((ctrl) => ctrl.id === 'area')?.initialValue, 'south');
  assert.equal(revisedControls.find((ctrl) => ctrl.id === 'region')?.initialValue, null);
  assert.ok(
    revised.diagnostics.some((d) => d.code === 'SCOPE_CONFLICT' && d.targetId === 'region'),
  );
  // Original revision remains untouched and readable.
  const prior = await service.read(initial.responseId, principal, signal(), 1, 0);
  assert.equal(prior.revision, 1);
  assert.equal(
    prior.plan.blocks.find((b) => b.kind === 'visual')?.controls.find((ctrl) => ctrl.id === 'area')
      ?.initialValue,
    'north',
  );

  // dependentPolicy: 'reject' fails instead of resetting.
  const rejectPlan: ResponsePlan = {
    ...scopePlan,
    blocks: scopePlan.blocks.map((block) =>
      block.kind === 'visual'
        ? {
            ...block,
            controls: block.controls.map((ctrl) =>
              ctrl.id === 'area' ? { ...ctrl, dependentPolicy: 'reject' as const } : ctrl,
            ),
          }
        : block,
    ),
  };
  const rejectIdentity = {
    messageId: 'm_reject',
    responseId: 'r_reject',
    revision: 1,
    generation: 0,
  };
  const rejectExec = await runtime.execute(rejectPlan, principal, signal());
  const rejectInitial = await runtime.ingest(
    rejectPlan,
    rejectExec.datasets,
    principal,
    signal(),
    rejectIdentity,
  );
  await service.attach(rejectInitial, principal, signal(), { enableControls: true });
  await assert.rejects(
    service.change(
      {
        responseId: 'r_reject',
        revision: 1,
        generation: 0,
        controlId: 'area',
        value: 'south',
        idempotencyKey: 'reject1',
        newMessageId: 'm_reject_2',
      },
      principal,
      signal(),
    ),
    /SCOPE_CONFLICT/,
  );
});

test('ui.sort, ui.paginate, ui.refresh, and custom host actions update responses safely and obey static snapshot barriers', async () => {
  const c = registerBuiltins(new FoundationCatalog(permissivePolicy));
  let refreshCount = 0;
  let customNoteApplied = '';
  const allRows = [
    { date: '2024-01-01', item: 'alpha', amount: 10 },
    { date: '2024-01-02', item: 'beta', amount: 30 },
    { date: '2024-01-03', item: 'gamma', amount: 20 },
  ];
  c.registerDomain({
    ref: { id: 'orders.domain', version: 1 },
    description: 'Orders domain',
    semantics: ['Orders'],
    tools: [
      {
        ref: { id: 'orders.list', version: 1 },
        description: 'Orders list',
        args: z.strictObject({
          sort: z.enum(['date', 'item', 'amount']).optional(),
          direction: z.enum(['asc', 'desc']).optional(),
          cursor: z.string().optional(),
        }),
        fields: [
          {
            id: 'date',
            label: 'Date',
            description: 'Order date',
            type: 'date',
            role: 'time',
            nullable: false,
            temporal: { timezone: 'UTC', calendar: 'gregorian', grain: 'day' },
          },
          {
            id: 'item',
            label: 'Item',
            description: 'Order item',
            type: 'string',
            role: 'dimension',
            nullable: false,
          },
          {
            id: 'amount',
            label: 'Amount',
            description: 'Order amount',
            type: 'number',
            role: 'measure',
            nullable: false,
            unit: 'USD',
            measure: { aggregation: 'sum', precision: 0, additive: true },
          },
        ],
        grain: 'one row per order',
        interactive: {},
        refreshable: true,
        sorting: {
          fieldArg: 'sort',
          directionArg: 'direction',
          fields: ['date', 'item', 'amount'],
          localSort: false,
        },
        pagination: { cursorArg: 'cursor' },
        execute: async (args) => {
          refreshCount++;
          const sorted = [...allRows].sort((a, b) => {
            const key = (args.sort as 'date' | 'item' | 'amount' | undefined) ?? 'date';
            const dir = args.direction === 'desc' ? -1 : 1;
            const cmp = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
            return cmp * dir;
          });
          const offset = args.cursor === 'page2' ? 2 : 0;
          const page = sorted.slice(offset, offset + 2);
          return {
            rows: page,
            provenance: {
              sourceId: 'orders',
              sourceVersion: `v${refreshCount}`,
              queryId: `q${refreshCount}`,
              executedAt: new Date().toISOString(),
              sourceAsOf: new Date().toISOString(),
              grain: 'one row per order',
              truncated: offset + page.length < sorted.length,
              nextCursor: offset + page.length < sorted.length ? 'page2' : null,
              warnings: [],
            },
          };
        },
      },
    ],
  });
  c.registerAction({
    ref: { id: 'orders.tagNote', version: 1 },
    description: 'Attach host tag diagnostic note',
    payload: z.strictObject({ note: z.string().min(1).max(40) }),
    sideEffects: 'stateful',
    execute: async ({ payload }) => {
      customNoteApplied = String(payload.note);
      return {
        diagnostics: [
          { code: 'SCOPE_CONFLICT', message: `Tag: ${customNoteApplied}`, retryable: false },
        ],
      };
    },
  });

  const snap = c.snapshot(principal);
  assert.ok(snap.actions.some((a) => a.ref.id === 'orders.tagNote'));
  const ordersPlan: ResponsePlan = {
    schemaVersion: 2,
    capabilitySnapshotId: snap.id,
    bindings: [{ id: 'orders', tool: { id: 'orders.list', version: 1 }, args: {}, fixedArgs: {} }],
    facts: [
      {
        id: 'topAmount',
        field: { bindingId: 'orders', fieldId: 'amount' },
        row: 0,
        format: 'integer',
      },
    ],
    blocks: [
      {
        id: 'summary',
        kind: 'text',
        parts: [{ text: 'Top visible order amount: ' }, { factId: 'topAmount' }],
      },
      {
        id: 'view',
        kind: 'visual',
        layoutIntent: 'auto',
        controls: [],
        elements: [
          {
            id: 'tbl',
            component: { id: 'ui.table', version: 1 },
            title: 'Orders',
            roles: {
              columns: [
                { bindingId: 'orders', fieldId: 'date' },
                { bindingId: 'orders', fieldId: 'item' },
                { bindingId: 'orders', fieldId: 'amount' },
              ],
            },
            props: {},
          },
        ],
      },
    ],
  };

  const ordersRuntime = new FoundationRuntime(c);
  const initialExec = await ordersRuntime.execute(ordersPlan, principal, signal());
  const initial = await ordersRuntime.ingest(
    ordersPlan,
    initialExec.datasets,
    principal,
    signal(),
    identity,
  );
  const service = new FoundationControlService(c, (who) => String(who.context.account ?? ''));
  await service.attach(initial, principal, signal(), { enableControls: true });
  const attached = await service.read('response1', principal, signal());
  assert.deepEqual(attached.operations.map((o) => o.id).sort(), [
    'orders.tagNote',
    'ui.paginate',
    'ui.refresh',
    'ui.sort',
  ]);

  // Paginate to page 2
  const page2 = await service.performAction(
    {
      responseId: 'response1',
      revision: 1,
      generation: 0,
      action: { id: 'ui.paginate', version: 1 },
      payload: { bindingId: 'orders', cursor: 'page2' },
      idempotencyKey: 'act_page2',
    },
    principal,
    signal(),
  );
  assert.equal(page2.generation, 1);
  assert.equal(
    page2.datasets.orders.status === 'ready' && page2.datasets.orders.result.rows[0].item,
    'gamma',
  );

  // Sorting invalidates active cursor back to undefined!
  const sorted = await service.performAction(
    {
      responseId: 'response1',
      revision: 1,
      generation: 1,
      action: { id: 'ui.sort', version: 1 },
      payload: { bindingId: 'orders', fieldId: 'amount', direction: 'desc' },
      idempotencyKey: 'act_sort',
    },
    principal,
    signal(),
  );
  assert.equal(sorted.generation, 2);
  assert.equal(sorted.plan.bindings[0].args.cursor, undefined);
  assert.equal(
    sorted.datasets.orders.status === 'ready' && sorted.datasets.orders.result.rows[0].amount,
    30,
  );

  // Refresh re-executes binding cleanly preserving sort!
  const beforeRefresh = refreshCount;
  const refreshed = await service.performAction(
    {
      responseId: 'response1',
      revision: 1,
      generation: 2,
      action: { id: 'ui.refresh', version: 1 },
      payload: { bindingId: 'orders' },
      idempotencyKey: 'act_refresh',
    },
    principal,
    signal(),
  );
  assert.equal(refreshCount, beforeRefresh + 1);
  assert.equal(refreshed.generation, 3);
  assert.equal(refreshed.plan.bindings[0].args.sort, 'amount');

  // Custom host action executes & updates generation
  const tagged = await service.performAction(
    {
      responseId: 'response1',
      revision: 1,
      generation: 3,
      action: { id: 'orders.tagNote', version: 1 },
      payload: { note: 'verified' },
      idempotencyKey: 'act_custom',
    },
    principal,
    signal(),
  );
  assert.equal(customNoteApplied, 'verified');
  assert.equal(tagged.generation, 4);

  // Static snapshot (`enableControls: false`) exposes no operations and denies actions.
  const staticExec = await ordersRuntime.execute(ordersPlan, principal, signal());
  const staticResp = await ordersRuntime.ingest(
    ordersPlan,
    staticExec.datasets,
    principal,
    signal(),
    {
      messageId: 'm_static',
      responseId: 'r_static',
      revision: 1,
      generation: 0,
    },
  );
  await service.attach(staticResp, principal, signal(), { enableControls: false });
  const readStatic = await service.read('r_static', principal, signal());
  assert.deepEqual(readStatic.operations, []);
  await assert.rejects(
    service.performAction(
      {
        responseId: 'r_static',
        revision: 1,
        generation: 0,
        action: { id: 'ui.sort', version: 1 },
        payload: { bindingId: 'orders', fieldId: 'amount', direction: 'desc' },
        idempotencyKey: 'act_denied',
      },
      principal,
      signal(),
    ),
    /CAPABILITY_UNAVAILABLE/,
  );
});

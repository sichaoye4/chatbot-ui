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

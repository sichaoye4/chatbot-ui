import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { CsvRepository } from '../../examples/csv-analytics/index.ts';
import {
  csvFoundationDomain,
  csvFoundationPolicy,
  registerCsvFoundation,
  csvOptionResolver,
} from '../../examples/csv-analytics/foundation.ts';
import { FoundationCatalog } from '../../packages/catalog/foundation.ts';
import { registerBuiltins } from '../../packages/catalog/builtins.ts';
import { FoundationRuntime } from '../../packages/server-runtime/foundation.ts';
import { FoundationControlService } from '../../packages/server-runtime/controls.ts';
import type { ResponsePlan } from '../../packages/contracts/foundation.ts';

test('real CSV aggregate executes through generic v2 contracts and host policy', async () => {
  const c = registerBuiltins(new FoundationCatalog(csvFoundationPolicy));
  c.registerDomain(
    csvFoundationDomain(new CsvRepository('sample_data/training_data_masked_final_1.csv')),
  );
  const p = {
    subject: 'csv-user',
    context: {
      csvIdentity: { id: 'csv-user', tenant: 'demo', domains: ['payment'], policyEpoch: 1 },
    },
  };
  const candidate: ResponsePlan = {
    schemaVersion: 2,
    capabilitySnapshotId: c.snapshot(p).id,
    bindings: [
      {
        id: 'records',
        tool: { id: 'csv.summary', version: 1 },
        args: {},
        fixedArgs: { domain: 'payment' },
      },
    ],
    facts: [
      {
        id: 'count',
        field: { bindingId: 'records', fieldId: 'record_count' },
        row: 0,
        format: 'integer',
      },
    ],
    blocks: [
      {
        id: 'answer',
        kind: 'text',
        parts: [{ factId: 'count' }, { text: ' recorded observations.' }],
      },
    ],
  };
  const output = await new FoundationRuntime(c).execute(candidate, p, new AbortController().signal);
  assert.equal(output.facts.count, '1,580'); // Existing independently verified source oracle.
  assert.equal(output.datasets.records.rows.length, 1);
  candidate.bindings[0].fixedArgs.domain = 'kyc';
  await assert.rejects(
    new FoundationRuntime(c).execute(candidate, p, new AbortController().signal),
    /DATA_FORBIDDEN/,
  );
});

test('CSV option cursors are bound to scope, identity epoch and search', async () => {
  const repository = {
    tools: () => [
      {
        id: 'csv.filterOptions',
        args: z.record(z.string(), z.unknown()),
        execute: () => ({
          rows: Array.from({ length: 150 }, (_, index) => ({
            value: `value${String(index).padStart(3, '0')}`,
          })),
        }),
      },
    ],
  } as unknown as CsvRepository;
  const resolver = csvOptionResolver(repository);
  const context = { id: 'csv-user', tenant: 'demo', domains: ['payment'], policyEpoch: 1 };
  const request = {
    scopeArgs: { domain: 'payment' },
    argument: 'system',
    context,
    signal: new AbortController().signal,
  };
  const first = await resolver.resolve(request);
  assert.equal(first.options.length, 100);
  assert.ok(first.nextCursor);
  const second = await resolver.resolve({ ...request, cursor: first.nextCursor });
  assert.equal(second.options.length, 50);
  assert.equal(second.nextCursor, null);
  await assert.rejects(
    resolver.resolve({ ...request, scopeArgs: { domain: 'kyc' }, cursor: first.nextCursor }),
    /scope changed/,
  );
  await assert.rejects(
    resolver.resolve({
      ...request,
      context: { ...context, policyEpoch: 2 },
      cursor: first.nextCursor,
    }),
    /scope changed/,
  );
  await assert.rejects(
    resolver.resolve({ ...request, search: 'value1', cursor: first.nextCursor }),
    /scope changed/,
  );
  await assert.rejects(
    resolver.resolve({ ...request, cursor: `${first.nextCursor}x` }),
    /Invalid option cursor/,
  );
});

test('CSV country options and control updates remain within fixed authorized scope', async () => {
  const repository = new CsvRepository('sample_data/training_data_masked_final_1.csv');
  const c = registerCsvFoundation(
    registerBuiltins(new FoundationCatalog(csvFoundationPolicy)),
    repository,
  );
  const identity = { id: 'csv-user', tenant: 'demo', domains: ['payment'], policyEpoch: 1 };
  const principal = { subject: 'csv-user', context: { csvIdentity: identity } };
  const proposal: ResponsePlan = {
    schemaVersion: 2,
    capabilitySnapshotId: c.snapshot(principal).id,
    bindings: [
      {
        id: 'records',
        tool: { id: 'csv.summary', version: 1 },
        args: { country: null },
        fixedArgs: { domain: 'payment', startMonth: '2024-01', endMonth: '2024-12' },
      },
    ],
    facts: [],
    blocks: [
      {
        id: 'visual',
        kind: 'visual',
        layoutIntent: 'auto',
        elements: [
          {
            id: 'count',
            component: { id: 'ui.metric', version: 1 },
            title: 'Count',
            roles: { value: [{ bindingId: 'records', fieldId: 'record_count' }] },
            props: {},
          },
        ],
        controls: [
          {
            id: 'country',
            control: { id: 'ui.select', version: 1 },
            label: 'Country',
            purpose: 'Select a country',
            scopeMode: 'within-answer',
            targets: [{ bindingId: 'records', argument: 'country' }],
            initialValue: null,
            dependsOn: [],
          },
        ],
      },
    ],
  };
  const runtime = new FoundationRuntime(c);
  const signal = new AbortController().signal;
  const output = await runtime.execute(proposal, principal, signal);
  const response = await runtime.ingest(proposal, output.datasets, principal, signal, {
    messageId: 'message1',
    responseId: 'response1',
    revision: 1,
    generation: 0,
  });
  const service = new FoundationControlService(c, (who) => who.subject);
  await service.attach(response, principal, signal, { enableControls: true });
  const page = await service.resolveOptions(
    { responseId: 'response1', revision: 1, generation: 0, controlId: 'country' },
    principal,
    signal,
  );
  assert.ok(page.options.length > 0);
  const country = page.options[0].value;
  const updated = await service.change(
    {
      responseId: 'response1',
      revision: 1,
      generation: 0,
      controlId: 'country',
      value: country,
      idempotencyKey: 'country1',
    },
    principal,
    signal,
  );
  const args = { domain: 'payment', startMonth: '2024-01', endMonth: '2024-12', country };
  const expected = repository
    .tools()
    .find((tool) => tool.id === 'csv.summary')!
    .execute(args, identity).rows[0].record_count;
  assert.equal(
    updated.datasets.records.status === 'ready' &&
      updated.datasets.records.result.rows[0].record_count,
    expected,
  );
  assert.equal(updated.plan.bindings[0].fixedArgs.domain, 'payment');
  await assert.rejects(
    service.change(
      {
        responseId: 'response1',
        revision: 1,
        generation: 1,
        controlId: 'country',
        value: 'ZZ',
        idempotencyKey: 'country2',
      },
      principal,
      signal,
    ),
    /SCOPE_CONFLICT/,
  );
});

test('v2 pie validates its data partition before execution or ingestion is published', async () => {
  const repository = new CsvRepository('sample_data/training_data_masked_final_1.csv');
  const c = registerBuiltins(new FoundationCatalog(csvFoundationPolicy));
  c.registerDomain(csvFoundationDomain(repository));
  const principal = {
    subject: 'csv-user',
    context: {
      csvIdentity: {
        id: 'csv-user',
        tenant: 'demo',
        domains: ['payment', 'party', 'kyc'],
        policyEpoch: 1,
      },
    },
  };
  const proposal: ResponsePlan = {
    schemaVersion: 2,
    capabilitySnapshotId: c.snapshot(principal).id,
    bindings: [
      { id: 'data', tool: { id: 'csv.countByDomain', version: 1 }, args: {}, fixedArgs: {} },
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
            id: 'pie',
            component: { id: 'ui.pie', version: 1 },
            title: 'Shares',
            props: {},
            roles: {
              category: [{ bindingId: 'data', fieldId: 'domain' }],
              value: [{ bindingId: 'data', fieldId: 'record_count' }],
            },
          },
        ],
      },
    ],
  };
  const runtime = new FoundationRuntime(c);
  const signal = new AbortController().signal;
  const data = (await runtime.execute(proposal, principal, signal)).datasets.data;
  const identity = { messageId: 'message1', responseId: 'response1', revision: 1, generation: 0 };
  await assert.doesNotReject(runtime.ingest(proposal, { data }, principal, signal, identity));
  const negative = structuredClone(data);
  negative.rows[0].record_count = -1;
  await assert.rejects(
    runtime.ingest(proposal, { data: negative }, principal, signal, identity),
    /RESULT_INVALID/,
  );
  const duplicated = structuredClone(data);
  duplicated.rows[1].domain = duplicated.rows[0].domain;
  await assert.rejects(
    runtime.ingest(proposal, { data: duplicated }, principal, signal, identity),
    /RESULT_INVALID/,
  );
  const paged = structuredClone(data);
  paged.provenance.nextCursor = 'next';
  await assert.rejects(
    runtime.ingest(proposal, { data: paged }, principal, signal, identity),
    /RESULT_INVALID/,
  );
});

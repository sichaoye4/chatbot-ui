import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CsvRepository } from '../../examples/csv-analytics/index.ts';
import {
  csvFoundationDomain,
  csvFoundationPolicy,
} from '../../examples/csv-analytics/foundation.ts';
import { FoundationCatalog } from '../../packages/catalog/foundation.ts';
import { registerBuiltins } from '../../packages/catalog/builtins.ts';
import { FoundationRuntime } from '../../packages/server-runtime/foundation.ts';
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

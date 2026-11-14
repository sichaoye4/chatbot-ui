import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { FoundationCatalog } from '../../packages/catalog/foundation.ts';
import { registerBuiltins } from '../../packages/catalog/builtins.ts';
import { ResponsePlan, type Control, type Policy } from '../../packages/contracts/foundation.ts';
import {
  catalog,
  domains,
  field,
  permissivePolicy,
  plan,
  principal,
  result,
} from '../fixtures/foundation-domains.ts';

test('v2 descriptors and contracts support three different domains without domain enums', () => {
  const c = catalog();
  for (let i = 0; i < domains.length; i++) {
    const input = plan(c, i);
    const validated = c.validate(input, principal);
    assert.deepEqual(validated.bindings[0].fixedArgs, {
      ...input.bindings[0].args,
      ...input.bindings[0].fixedArgs,
    });
    assert.deepEqual(validated.bindings[0].args, {});
  }
  const snapshot = JSON.parse(JSON.stringify(c.snapshot(principal)));
  assert.equal(snapshot.tools.length, 3);
  assert.equal(
    snapshot.components.find(
      (component: { ref: { id: string } }) => component.ref.id === 'ui.trend',
    ).guidance.useWhen,
    'Show temporal change at the declared grain',
  );
  assert.equal(snapshot.tools[1].arguments.additionalProperties, false);
  assert.equal('execute' in snapshot.tools[0], false);
  assert.equal(snapshot.tools[2].grain, 'one row per edge');
});
test('text and clarification need no bindings or visual artifact', () => {
  const c = catalog();
  for (const block of [
    { id: 'answer', kind: 'text', parts: [{ text: 'Hello' }] },
    {
      id: 'answer',
      kind: 'clarification',
      question: 'Which definition?',
      choices: [{ id: 'net', label: 'Net revenue' }],
    },
  ])
    assert.equal(
      c.validate(
        {
          schemaVersion: 2,
          capabilitySnapshotId: c.snapshot(principal).id,
          bindings: [],
          facts: [],
          blocks: [block],
        },
        principal,
      ).bindings.length,
      0,
    );
});
test('unknown versions, unsafe properties, invalid roles and incompatible units are rejected', () => {
  const c = catalog();
  const p = plan(c, 0);
  const block = p.blocks[0];
  if (block.kind !== 'visual') throw new Error();
  block.elements[0].component.version = 99;
  assert.throws(() => c.validate(p, principal), /CAPABILITY_UNAVAILABLE/);
  block.elements[0].component = { id: 'ui.trend', version: 1 };
  block.elements[0].roles = {
    time: [{ bindingId: 'data', fieldId: 'date' }],
    values: [
      { bindingId: 'data', fieldId: 'score' },
      { bindingId: 'data', fieldId: 'compliance' },
    ],
  };
  assert.throws(() => c.validate(p, principal), /SEMANTIC_INVALID/);
  block.elements[0].roles.values.pop();
  c.validate(p, principal);
  block.elements[0].props = { script: 'alert(1)' };
  assert.throws(() => c.validate(p, principal), /SCHEMA_INVALID/);
  block.elements[0].props = {};
  block.elements[0].roles.time = [{ bindingId: 'data', fieldId: 'score' }];
  assert.throws(() => c.validate(p, principal), /SEMANTIC_INVALID/);
});
const regionControl: Control = {
  id: 'region',
  control: { id: 'ui.select', version: 1 },
  label: 'Region',
  purpose: 'Explore the regional subset',
  scopeMode: 'within-answer',
  targets: [{ bindingId: 'data', argument: 'region' }],
  initialValue: null,
  dependsOn: [],
};
test('controls have explicit targets and cannot silently override fixed scope or tool identity', () => {
  const c = catalog();
  const p = plan(c);
  const block = p.blocks[0];
  if (block.kind !== 'visual') throw new Error();
  block.controls.push(structuredClone(regionControl));
  c.validate(p, principal);
  p.bindings[0].fixedArgs.region = 'east';
  delete p.bindings[0].args.region;
  assert.throws(() => c.validate(p, principal), /SCOPE_CONFLICT/);
  block.controls[0].scopeMode = 'change-answer';
  assert.throws(() => c.validate(p, principal), /SCOPE_CONFLICT/);
  block.controls[0].initialValue = 'east';
  c.validate(p, principal);
  block.controls[0].targets[0].argument = 'subject';
  assert.throws(() => c.validate(p, principal), /SEMANTIC_INVALID/);
});
test('control graph rejects cycles, duplicate targets and cross-block references', () => {
  const c = catalog();
  const p = plan(c);
  const block = p.blocks[0];
  if (block.kind !== 'visual') throw new Error();
  block.controls = [structuredClone(regionControl)];
  block.controls[0].dependsOn = ['region'];
  assert.throws(() => ResponsePlan.parse(p), /Cyclic/);
  block.controls[0].dependsOn = [];
  block.controls.push({ ...structuredClone(regionControl), id: 'duplicate' });
  assert.throws(() => ResponsePlan.parse(p), /Multiple controls/);
  block.controls.pop();
  block.controls[0].targets[0].bindingId = 'other';
  assert.throws(() => ResponsePlan.parse(p), /outside/);
});
test('discovery hides denied capabilities and stale snapshots cannot validate', () => {
  let denied = false;
  const c = catalog({
    ...permissivePolicy,
    visible: (ref) => !denied || !ref.id.startsWith('commerce.'),
  });
  const p = plan(c);
  denied = true;
  assert.equal(
    c.snapshot(principal).tools.some((t) => t.ref.id === 'commerce.revenue'),
    false,
  );
  assert.throws(() => c.validate(p, principal), /STALE_CAPABILITIES/);
  p.capabilitySnapshotId = c.snapshot(principal).id;
  assert.throws(() => c.validate(p, principal), /CAPABILITY_UNAVAILABLE/);
});
test('registering a new component and numeric-range control needs no core union changes', () => {
  const c = catalog();
  c.registerComponent({
    ref: { id: 'extension.sparkline', version: 3 },
    description: 'Small temporal series',
    guidance: {
      useWhen: 'Compact trend',
      avoidWhen: 'Precise inspection',
      alternatives: ['ui.table'],
    },
    props: z.strictObject({}),
    singleBinding: true,
    layout: { minWidth: 180, minHeight: 80 },
    roles: { values: { types: ['number'], min: 1, max: 1 } },
  });
  c.registerControl({
    ref: { id: 'extension.numericRange', version: 1 },
    description: 'Inclusive numeric range',
    guidance: {
      useWhen: 'Inspect a numeric interval',
      avoidWhen: 'Discrete categories',
      alternatives: [],
    },
    value: z.tuple([z.number(), z.number()]).refine(([a, b]) => a <= b),
  });
  const p = plan(c);
  const block = p.blocks[0];
  if (block.kind !== 'visual') throw new Error();
  block.elements[0].component = { id: 'extension.sparkline', version: 3 };
  block.elements[0].roles = { values: [{ bindingId: 'data', fieldId: 'net' }] };
  c.validate(p, principal);
  assert.ok(c.snapshot(principal).controls.some((v) => v.ref.id === 'extension.numericRange'));
});
test('malformed domain registration is atomic and cannot publish incomplete schemas', () => {
  const c = registerBuiltins(new FoundationCatalog(permissivePolicy));
  const d = {
    ...domains[0],
    tools: [
      ...domains[0].tools,
      { ...domains[1].tools[0], fields: [field('missingUnit', 'number', 'measure')] },
    ],
  };
  assert.throws(() => c.registerDomain(d));
  assert.equal(c.snapshot(principal).tools.length, 0);
});
test('result validation rejects extra fields, wrong grain/types, missing values and invalid dates', () => {
  const c = catalog();
  const ref = domains[1].tools[0].ref;
  c.validateResult(ref, result([{ date: '2024-01-01', net: 130 }], 'one row per day'), principal);
  for (const value of [
    result([{ date: '2024-01-01', net: 130, secret: 'hidden' }], 'one row per day'),
    result([{ date: '2024-01-01', net: 130 }], 'one row per order'),
    result([{ date: '2024-02-31', net: 130 }], 'one row per day'),
    result([{ date: '2024-01-01', net: null }], 'one row per day'),
  ])
    assert.throws(() => c.validateResult(ref, value, principal), /RESULT_INVALID/);
});
test('renamed business fields preserve validation when semantic metadata is preserved', () => {
  const c = registerBuiltins(new FoundationCatalog(permissivePolicy));
  const d = domains[1];
  const t = d.tools[0];
  c.registerDomain({
    ...d,
    tools: [
      {
        ...t,
        fields: t.fields.map((f) => ({ ...f, id: f.id === 'net' ? 'unseenMeasure' : f.id })),
      },
    ],
  });
  const p = plan(c);
  const block = p.blocks[0];
  if (block.kind !== 'visual') throw new Error();
  block.elements[0].roles.columns[1].fieldId = 'unseenMeasure';
  c.validate(p, principal);
});

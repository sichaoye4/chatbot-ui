import { z } from 'zod';

/** V2 is deliberately independent of the v1 CSV protocol in index.ts. */
export const LocalId = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/)
  .refine((id) => !['constructor', 'prototype', '__proto__'].includes(id), 'Reserved identifier');
export const CapabilityId = z.string().regex(/^[a-z][a-z0-9-]*(\.[a-zA-Z][a-zA-Z0-9_-]*)+$/);
export const CapabilityRef = z.strictObject({
  id: CapabilityId,
  version: z.number().int().positive(),
});
export type CapabilityRef = z.infer<typeof CapabilityRef>;
export const Scalar = z.union([z.string().max(16000), z.number().finite(), z.boolean(), z.null()]);
export type Scalar = z.infer<typeof Scalar>;
export const InputValue = z.union([Scalar, z.array(Scalar).max(100)]);
export const Arguments = z.record(LocalId, InputValue);
export type Arguments = z.infer<typeof Arguments>;

export const FieldDefinition = z
  .strictObject({
    id: LocalId,
    label: z.string().min(1).max(160),
    type: z.enum(['string', 'number', 'boolean', 'date', 'datetime']),
    role: z.enum(['dimension', 'measure', 'identifier', 'time', 'source', 'target']),
    nullable: z.boolean(),
    nullMeaning: z.string().min(1).max(500).optional(),
    unit: z.string().min(1).max(80).optional(),
    description: z.string().min(1).max(1000),
    temporal: z
      .strictObject({
        timezone: z.string().min(1).max(80),
        calendar: z.string().min(1).max(80),
        grain: z.string().min(1).max(80),
      })
      .optional(),
    measure: z
      .strictObject({
        aggregation: z.string().min(1).max(160),
        denominator: z.string().min(1).max(500).optional(),
        precision: z.number().int().min(0).max(12),
        additive: z.boolean(),
      })
      .optional(),
  })
  .superRefine((field, ctx) => {
    if (field.nullable && !field.nullMeaning)
      ctx.addIssue({ code: 'custom', message: 'Nullable fields require null semantics' });
    if (field.role === 'measure' && (field.type !== 'number' || !field.measure || !field.unit))
      ctx.addIssue({
        code: 'custom',
        message: 'Measures require numeric type, unit and aggregation semantics',
      });
    if (['date', 'datetime'].includes(field.type) && !field.temporal)
      ctx.addIssue({
        code: 'custom',
        message: 'Temporal fields require timezone, calendar and grain',
      });
  });
export type FieldDefinition = z.infer<typeof FieldDefinition>;
export const FieldRef = z.strictObject({ bindingId: LocalId, fieldId: LocalId });
export type FieldRef = z.infer<typeof FieldRef>;
export const Binding = z
  .strictObject({
    id: LocalId,
    tool: CapabilityRef,
    // Both are tool arguments. fixedArgs are initial answer scope, not authorization.
    args: Arguments,
    fixedArgs: Arguments,
  })
  .superRefine((binding, ctx) => {
    if (Object.keys(binding.args).some((key) => key in binding.fixedArgs))
      ctx.addIssue({ code: 'custom', message: 'An argument cannot have two initial values' });
  });
export const Element = z.strictObject({
  id: LocalId,
  component: CapabilityRef,
  title: z.string().min(1).max(160),
  roles: z.record(LocalId, z.array(FieldRef).min(1).max(100)),
  props: Arguments,
});
export type Element = z.infer<typeof Element>;
export const Control = z.strictObject({
  id: LocalId,
  control: CapabilityRef,
  label: z.string().min(1).max(160),
  purpose: z.string().min(1).max(500),
  scopeMode: z.enum(['within-answer', 'change-answer']),
  targets: z
    .array(z.strictObject({ bindingId: LocalId, argument: LocalId }))
    .min(1)
    .max(20),
  initialValue: InputValue,
  dependsOn: z.array(LocalId).max(20),
  dependentPolicy: z.enum(['reject', 'reset']).optional(),
});
export type Control = z.infer<typeof Control>;
export const Fact = z.strictObject({
  id: LocalId,
  field: FieldRef,
  row: z.number().int().nonnegative(),
  format: z.enum(['raw', 'integer', 'decimal', 'percent']),
});
export const Block = z.discriminatedUnion('kind', [
  z.strictObject({
    id: LocalId,
    kind: z.literal('text'),
    // Each fact is a separately materialized token; no string interpolation/evaluation.
    parts: z
      .array(
        z.union([
          z.strictObject({ text: z.string().max(16000) }),
          z.strictObject({ factId: LocalId }),
        ]),
      )
      .min(1)
      .max(100),
  }),
  z.strictObject({
    id: LocalId,
    kind: z.literal('clarification'),
    question: z.string().min(1).max(2000),
    choices: z.array(z.strictObject({ id: LocalId, label: z.string().min(1).max(160) })).max(20),
  }),
  z.strictObject({
    id: LocalId,
    kind: z.literal('visual'),
    elements: z.array(Element).min(1).max(100),
    controls: z.array(Control).max(100),
    layoutIntent: z.enum(['auto', 'comparison', 'overview', 'investigation']),
  }),
]);
export const ResponsePlan = z
  .strictObject({
    schemaVersion: z.literal(2),
    capabilitySnapshotId: z.string().min(1).max(160),
    bindings: z.array(Binding).max(100),
    facts: z.array(Fact).max(100),
    blocks: z.array(Block).min(1).max(100),
  })
  .superRefine((plan, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const elements = plan.blocks.flatMap((b) => (b.kind === 'visual' ? b.elements : []));
    const controls = plan.blocks.flatMap((b) => (b.kind === 'visual' ? b.controls : []));
    for (const entries of [plan.bindings, plan.facts, plan.blocks, elements, controls])
      if (new Set(entries.map((x) => x.id)).size !== entries.length) issue('Duplicate IDs');
    const bindingIds = new Set(plan.bindings.map((b) => b.id));
    const used = new Set<string>();
    for (const field of [
      ...plan.facts.map((f) => f.field),
      ...elements.flatMap((e) => Object.values(e.roles).flat()),
    ]) {
      if (!bindingIds.has(field.bindingId)) issue('Unknown binding');
      used.add(field.bindingId);
    }
    if (plan.bindings.some((b) => !used.has(b.id))) issue('Unused binding');
    const factIds = new Set(plan.facts.map((f) => f.id));
    const usedFacts = new Set<string>();
    for (const block of plan.blocks) {
      if (block.kind === 'text')
        for (const part of block.parts)
          if ('factId' in part) {
            if (!factIds.has(part.factId)) issue('Unknown fact');
            usedFacts.add(part.factId);
          }
      if (block.kind !== 'visual') continue;
      const visibleBindings = new Set(
        block.elements.flatMap((e) =>
          Object.values(e.roles)
            .flat()
            .map((f) => f.bindingId),
        ),
      );
      const controlsById = new Map(block.controls.map((c) => [c.id, c]));
      const occupied = new Set<string>();
      const visited = new Set<string>();
      const active = new Set<string>();
      const visit = (id: string) => {
        if (active.has(id)) {
          issue('Cyclic control dependencies');
          return;
        }
        if (visited.has(id)) return;
        const dependency = controlsById.get(id);
        if (!dependency) {
          issue('Unknown control dependency');
          return;
        }
        active.add(id);
        for (const next of dependency.dependsOn) visit(next);
        active.delete(id);
        visited.add(id);
      };
      for (const control of block.controls) {
        for (const target of control.targets) {
          if (!visibleBindings.has(target.bindingId))
            issue('Control targets a binding outside its visual block');
          const key = `${target.bindingId}:${target.argument}`;
          if (occupied.has(key)) issue('Multiple controls target the same argument');
          occupied.add(key);
        }
        visit(control.id);
      }
    }
    if (plan.facts.some((f) => !usedFacts.has(f.id))) issue('Unused fact');
  });
export type ResponsePlan = z.infer<typeof ResponsePlan>;

export const DataResult = z.strictObject({
  rows: z.array(z.record(LocalId, Scalar)).max(10000),
  // Connector-owned, schema-registered metadata; plans cannot supply executable content.
  annotations: z
    .record(CapabilityId, z.json())
    .refine((value) => Object.keys(value).length <= 20, 'Too many annotations')
    .optional(),
  provenance: z.strictObject({
    sourceId: z.string().min(1).max(160),
    sourceVersion: z.string().min(1).max(160),
    queryId: z.string().min(1).max(160),
    executedAt: z.iso.datetime(),
    sourceAsOf: z.string().min(1).max(160).optional(),
    grain: z.string().min(1).max(500),
    truncated: z.boolean(),
    nextCursor: z.string().max(2048).nullable(),
    warnings: z.array(z.string().max(1000)).max(20),
  }),
});
export type DataResult = z.infer<typeof DataResult>;
export const RevisionRef = z.strictObject({
  artifactId: LocalId,
  revision: z.number().int().positive(),
  generation: z.number().int().nonnegative(),
});
export const ActionRequest = z.strictObject({
  protocolVersion: z.literal(2),
  target: RevisionRef,
  idempotencyKey: LocalId,
  action: CapabilityRef,
  payload: Arguments,
});
export type Principal = Readonly<{ subject: string; context: Readonly<Record<string, unknown>> }>;
export type Diagnostic = {
  code:
    | 'SCHEMA_INVALID'
    | 'CAPABILITY_UNAVAILABLE'
    | 'STALE_CAPABILITIES'
    | 'SEMANTIC_INVALID'
    | 'SCOPE_CONFLICT'
    | 'BUDGET_EXCEEDED'
    | 'DATA_FORBIDDEN'
    | 'RESULT_INVALID'
    | 'REVISION_CONFLICT'
    | 'IDEMPOTENCY_CONFLICT'
    | 'CANCELLED';
  path: string;
  message: string;
};
export class FoundationError extends Error {
  constructor(public diagnostic: Diagnostic) {
    super(diagnostic.code);
  }
}
export type Policy = {
  visible(ref: CapabilityRef, principal: Principal): boolean;
  /** Optional principal-scoped field visibility. Query authorization still enforces arguments and row scope. */
  visibleField?(ref: CapabilityRef, fieldId: string, principal: Principal): boolean;
  // Called server-side before every execution; no authorization is inferred from args or snapshots.
  authorize(
    ref: CapabilityRef,
    args: Arguments,
    principal: Principal,
  ): Promise<{
    scopeKey: string;
    context: unknown;
  }>;
};
export type PlanningContext = {
  question: string;
  previous?: ResponsePlan;
  capabilities: unknown;
  signal: AbortSignal;
  feedback: Diagnostic[];
  choice?: { responseId: string; blockId: string; choiceId: string; label: string };
};
export interface PlanningAgent {
  propose(context: PlanningContext): Promise<unknown>;
}

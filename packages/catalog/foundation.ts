import { z } from 'zod';
import {
  CapabilityRef,
  CapabilityId,
  DataResult,
  FieldDefinition,
  FoundationError,
  ResponsePlan,
  type Arguments,
  type Control,
  type Element,
  type FieldRef,
  type Policy,
  type Principal,
} from '../contracts/foundation.ts';

export type Guidance = { useWhen: string; avoidWhen: string; alternatives: string[] };
export type RoleDefinition = {
  types: FieldDefinition['type'][];
  roles?: FieldDefinition['role'][];
  min: number;
  max: number;
  sameUnit?: boolean;
  sameGrain?: boolean;
};
export type ComponentRegistration = {
  ref: CapabilityRef;
  description: string;
  guidance: Guidance;
  props: z.ZodType<Arguments>;
  roles: Record<string, RoleDefinition>;
  // Cross-binding roles require a registered join tool, not implicit client-side joining.
  singleBinding: boolean;
  partitionRoles?: { category: string; value: string };
  layout: { minWidth: number; minHeight: number };
  validate?: (element: Element, fields: Record<string, FieldDefinition[]>) => string[];
  requiredAnnotations?: string[];
  validateResult?: (
    element: Element,
    datasets: Record<string, DataResult>,
    fields: Record<string, FieldDefinition[]>,
  ) => void;
};
export type ControlRegistration = {
  ref: CapabilityRef;
  description: string;
  guidance: Guidance;
  value: z.ZodType;
};
export type OptionResolverRegistration = {
  ref: CapabilityRef;
  /** The target argument is excluded from scopeArgs; all other effective arguments are retained. */
  resolve(input: {
    scopeArgs: Arguments;
    argument: string;
    context: unknown;
    search?: string;
    cursor?: string;
    signal: AbortSignal;
  }): Promise<{ options: { value: string; label: string }[]; nextCursor: string | null }>;
  /** Authoritatively validate a selection independently of the currently displayed page. */
  accepts(input: {
    value: string;
    scopeArgs: Arguments;
    argument: string;
    context: unknown;
    signal: AbortSignal;
  }): Promise<boolean>;
};
export type ArgumentCapability = {
  description: string;
  controls: CapabilityRef[];
  // Resolver reference belongs to the tool, never invented by a plan.
  options?: CapabilityRef;
};
export type ToolRegistration = {
  partitions?: { categoryField: string; valueField: string }[];
  ref: CapabilityRef;
  description: string;
  args: z.ZodType<Arguments>;
  fields: FieldDefinition[];
  /** Host attests that metadata, arguments, provenance and annotations are safe under field projection. */
  fieldProjectionSafe?: boolean;
  grain: string;
  interactive: Record<string, ArgumentCapability>;
  /** The connector, not the planner, defines and supplies these result annotations. */
  resultAnnotations?: Record<string, z.ZodType>;
  resultViews?: CapabilityRef[];
  execute: (args: Arguments, context: unknown, signal: AbortSignal) => Promise<DataResult>;
};
export type DomainRegistration = {
  ref: CapabilityRef;
  description: string;
  semantics: string[];
  tools: ToolRegistration[];
};
export type Limits = {
  maxBytes: number;
  maxBindings: number;
  maxElements: number;
  maxControls: number;
  maxRows: number;
};
export const defaultLimits: Limits = {
  maxBytes: 65536,
  maxBindings: 6,
  maxElements: 6,
  maxControls: 6,
  maxRows: 2000,
};
const key = (ref: CapabilityRef) => `${ref.id}@${ref.version}`;
function fail(code: FoundationError['diagnostic']['code'], path: string, message: string): never {
  throw new FoundationError({ code, path, message });
}

/** This registry contains server registrations. snapshot() returns only JSON descriptors. */
export class FoundationCatalog {
  private tools = new Map<string, ToolRegistration>();
  private components = new Map<string, ComponentRegistration>();
  private controls = new Map<string, ControlRegistration>();
  private optionResolvers = new Map<string, OptionResolverRegistration>();
  private domains: DomainRegistration[] = [];
  private revision = 0;
  constructor(
    readonly policy: Policy,
    readonly limits: Limits = defaultLimits,
  ) {
    for (const value of Object.values(limits))
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid limits');
  }
  private add<T extends { ref: CapabilityRef }>(map: Map<string, T>, value: T) {
    CapabilityRef.parse(value.ref);
    if (map.has(key(value.ref))) throw new Error(`Duplicate registration: ${key(value.ref)}`);
    map.set(key(value.ref), value);
    this.revision++;
  }
  registerComponent(component: ComponentRegistration) {
    z.toJSONSchema(component.props);
    for (const annotation of component.requiredAnnotations ?? []) CapabilityId.parse(annotation);
    for (const role of Object.values(component.roles))
      if (
        !Number.isInteger(role.min) ||
        !Number.isInteger(role.max) ||
        role.min < 0 ||
        role.max < role.min ||
        !role.types.length
      )
        throw new Error('Invalid role bounds');
    this.add(this.components, {
      ...component,
      ref: { ...component.ref },
      guidance: structuredClone(component.guidance),
      roles: structuredClone(component.roles),
      layout: { ...component.layout },
      requiredAnnotations: component.requiredAnnotations && [...component.requiredAnnotations],
    });
    return this;
  }
  registerControl(control: ControlRegistration) {
    z.toJSONSchema(control.value);
    this.add(this.controls, {
      ...control,
      ref: { ...control.ref },
      guidance: structuredClone(control.guidance),
    });
    return this;
  }
  registerOptionResolver(resolver: OptionResolverRegistration) {
    this.add(this.optionResolvers, { ...resolver, ref: { ...resolver.ref } });
    return this;
  }
  registerDomain(domain: DomainRegistration) {
    CapabilityRef.parse(domain.ref);
    if (this.domains.some((d) => key(d.ref) === key(domain.ref)))
      throw new Error('Duplicate domain');
    const keys = new Set<string>();
    // Check the whole plugin before mutating the registry.
    for (const tool of domain.tools) {
      CapabilityRef.parse(tool.ref);
      if (keys.has(key(tool.ref)) || this.tools.has(key(tool.ref)))
        throw new Error('Duplicate tool');
      keys.add(key(tool.ref));
      z.toJSONSchema(tool.args);
      for (const [annotation, schema] of Object.entries(tool.resultAnnotations ?? {})) {
        CapabilityId.parse(annotation);
        z.toJSONSchema(schema);
      }
      const views = tool.resultViews ?? [];
      if (new Set(views.map(key)).size !== views.length) throw new Error('Duplicate result view');
      for (const view of views) {
        const component = this.components.get(key(CapabilityRef.parse(view)));
        if (
          !component ||
          (component.requiredAnnotations ?? []).some(
            (annotation) => !Object.hasOwn(tool.resultAnnotations ?? {}, annotation),
          )
        )
          throw new Error('Result view lacks required registered semantics');
      }
      tool.fields.forEach((f) => FieldDefinition.parse(f));
      if (!tool.grain || new Set(tool.fields.map((f) => f.id)).size !== tool.fields.length)
        throw new Error('Invalid result fields/grain');
      for (const capability of Object.values(tool.interactive)) {
        for (const control of capability.controls)
          if (!this.controls.has(key(control))) throw new Error('Unknown control registration');
        if (
          capability.options &&
          !this.optionResolvers.has(key(CapabilityRef.parse(capability.options)))
        )
          throw new Error('Unknown option resolver registration');
      }
    }
    const installed = {
      ...domain,
      ref: { ...domain.ref },
      semantics: [...domain.semantics],
      tools: domain.tools.map((tool) => ({
        ...tool,
        ref: { ...tool.ref },
        fields: tool.fields.map((f) => FieldDefinition.parse(f)),
        interactive: structuredClone(tool.interactive),
        resultAnnotations: tool.resultAnnotations && { ...tool.resultAnnotations },
        resultViews: tool.resultViews && structuredClone(tool.resultViews),
      })),
    };
    this.domains.push(installed);
    for (const tool of installed.tools) this.add(this.tools, tool);
    this.revision++;
    return this;
  }
  private available<T extends { ref: CapabilityRef }>(
    map: Map<string, T>,
    ref: CapabilityRef,
    principal: Principal,
  ): T {
    const entry = map.get(key(ref));
    if (!entry || !this.policy.visible(ref, principal))
      fail('CAPABILITY_UNAVAILABLE', ref.id, 'Capability is unavailable');
    return entry;
  }
  tool(ref: CapabilityRef, principal: Principal) {
    const tool = this.available(this.tools, ref, principal);
    const fields = this.permittedFields(tool, principal);
    if (!fields.length || (fields.length !== tool.fields.length && !tool.fieldProjectionSafe))
      fail('CAPABILITY_UNAVAILABLE', ref.id, 'Capability is unavailable');
    return tool;
  }
  private permittedFields(tool: ToolRegistration, principal: Principal) {
    return tool.fields.filter(
      (field) =>
        !this.policy.visibleField ||
        this.policy.visibleField(tool.ref, field.id, principal) === true,
    );
  }
  fields(ref: CapabilityRef, principal: Principal) {
    return this.permittedFields(this.tool(ref, principal), principal);
  }
  control(ref: CapabilityRef, principal: Principal) {
    return this.available(this.controls, ref, principal);
  }
  optionResolver(ref: CapabilityRef, principal: Principal) {
    return this.available(this.optionResolvers, ref, principal);
  }
  snapshot(principal: Principal, clientComponents?: CapabilityRef[]) {
    const permitted = <T extends { ref: CapabilityRef }>(map: Map<string, T>) =>
      [...map.values()].filter((entry) => this.policy.visible(entry.ref, principal));
    const tools = permitted(this.tools).filter((tool) => {
      const fields = this.permittedFields(tool, principal);
      return (
        fields.length > 0 && (fields.length === tool.fields.length || tool.fieldProjectionSafe)
      );
    });
    const components = permitted(this.components).filter(
      (entry) => !clientComponents || clientComponents.some((ref) => key(ref) === key(entry.ref)),
    );
    const controls = permitted(this.controls);
    // This is an invalidation token, never authorization evidence. Query policy is rechecked.
    const projection = tools
      .filter((tool) => this.permittedFields(tool, principal).length !== tool.fields.length)
      .map(
        (tool) =>
          `${key(tool.ref)}:${this.permittedFields(tool, principal)
            .map((field) => field.id)
            .join(',')}`,
      )
      .sort()
      .join('|');
    const snapshotId = `catalog-${this.revision}-${[...tools, ...components, ...controls]
      .map((v) => key(v.ref))
      .sort()
      .join('|')}${projection ? `-${projection}` : ''}`;
    // Bound the identifier independently of registry size using an opaque synchronous fingerprint.
    let hash = 2166136261;
    for (const char of snapshotId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return structuredClone({
      id: `catalog-${this.revision}-${(hash >>> 0).toString(16)}`,
      limits: { ...this.limits },
      domains: this.domains
        .filter(
          (d) => this.policy.visible(d.ref, principal) && d.tools.some((t) => tools.includes(t)),
        )
        .map((d) => ({ ref: d.ref, description: d.description, semantics: d.semantics })),
      tools: tools.map((t) => ({
        ref: t.ref,
        description: t.description,
        arguments: z.toJSONSchema(t.args),
        fields: this.permittedFields(t, principal),
        grain: t.grain,
        resultAnnotations: Object.fromEntries(
          Object.entries(t.resultAnnotations ?? {}).map(([name, schema]) => [
            name,
            z.toJSONSchema(schema),
          ]),
        ),
        resultViews: t.resultViews ?? [],
        partitions: (t.partitions ?? []).filter((partition) => {
          const ids = this.permittedFields(t, principal).map((field) => field.id);
          return ids.includes(partition.categoryField) && ids.includes(partition.valueField);
        }),
        interactive: Object.fromEntries(
          (this.permittedFields(t, principal).length === t.fields.length
            ? Object.entries(t.interactive)
            : []
          ).map(([name, cap]) => [
            name,
            {
              description: cap.description,
              controls: cap.controls.filter((c) => controls.some((v) => key(c) === key(v.ref))),
              ...(cap.options &&
              this.optionResolvers.has(key(cap.options)) &&
              this.policy.visible(cap.options, principal)
                ? { options: cap.options }
                : {}),
            },
          ]),
        ),
      })),
      components: components.map(
        ({
          ref,
          description,
          guidance,
          props,
          roles,
          singleBinding,
          partitionRoles,
          layout,
          requiredAnnotations,
        }) => ({
          ref,
          description,
          guidance,
          props: z.toJSONSchema(props),
          roles,
          singleBinding,
          partitionRoles,
          layout,
          requiredAnnotations: requiredAnnotations ?? [],
        }),
      ),
      controls: controls.map(({ ref, description, guidance, value }) => ({
        ref,
        description,
        guidance,
        value: z.toJSONSchema(value),
      })),
    });
  }
  validate(
    candidate: unknown,
    principal: Principal,
    clientComponents?: CapabilityRef[],
  ): ResponsePlan {
    let serialized: string;
    try {
      serialized = JSON.stringify(candidate);
    } catch {
      fail('SCHEMA_INVALID', '', 'Expected JSON plan');
    }
    if (!serialized! || new TextEncoder().encode(serialized!).length > this.limits.maxBytes)
      fail('BUDGET_EXCEEDED', '', 'Plan exceeds byte budget');
    const parsed = ResponsePlan.safeParse(candidate);
    if (!parsed.success)
      fail('SCHEMA_INVALID', '', parsed.error.issues.map((i) => i.message).join('; '));
    const plan = parsed.data;
    if (plan.capabilitySnapshotId !== this.snapshot(principal, clientComponents).id)
      fail(
        'STALE_CAPABILITIES',
        'capabilitySnapshotId',
        'Discover current capabilities before replanning',
      );
    const elements = plan.blocks.flatMap((b) => (b.kind === 'visual' ? b.elements : []));
    const controls = plan.blocks.flatMap((b) => (b.kind === 'visual' ? b.controls : []));
    if (
      plan.bindings.length > this.limits.maxBindings ||
      elements.length > this.limits.maxElements ||
      controls.length > this.limits.maxControls
    )
      fail('BUDGET_EXCEEDED', '', 'Plan exceeds execution/presentation budget');
    const bindings = new Map(plan.bindings.map((b) => [b.id, b]));
    for (const binding of plan.bindings) {
      // Safe default: an argument is fixed unless an explicit within-answer control owns it.
      // Models may place equivalent fixed constraints in either object; never interpret that
      // representational variation as permission to expose/edit a constraint later.
      for (const [argument, value] of Object.entries(binding.args)) {
        const control = controls.find((c) =>
          c.targets.some((t) => t.bindingId === binding.id && t.argument === argument),
        );
        if (!control || control.scopeMode === 'change-answer') {
          binding.fixedArgs[argument] = value;
          delete binding.args[argument];
        }
      }
      const tool = this.tool(binding.tool, principal);
      if (!tool.args.safeParse({ ...binding.args, ...binding.fixedArgs }).success)
        fail('SCHEMA_INVALID', `bindings.${binding.id}`, 'Invalid tool arguments');
    }
    const field = (ref: FieldRef) => {
      const binding = bindings.get(ref.bindingId)!;
      const definition = this.fields(binding.tool, principal).find((f) => f.id === ref.fieldId);
      if (!definition) fail('SEMANTIC_INVALID', ref.fieldId, 'Unknown result field');
      return definition;
    };
    for (const fact of plan.facts) {
      const meta = field(fact.field);
      if (
        (fact.format !== 'raw' && meta.type !== 'number') ||
        (fact.format === 'percent' && meta.unit !== 'ratio')
      )
        fail('SEMANTIC_INVALID', fact.id, 'Fact format is incompatible with field semantics');
    }
    for (const element of elements) {
      const component = this.available(this.components, element.component, principal);
      if (clientComponents && !clientComponents.some((ref) => key(ref) === key(component.ref)))
        fail('CAPABILITY_UNAVAILABLE', element.id, 'Component is not installed by the client');
      if (!component.props.safeParse(element.props).success)
        fail('SCHEMA_INVALID', element.id, 'Invalid component properties');
      if (component.requiredAnnotations?.length) {
        const bindingIds = new Set(
          Object.values(element.roles)
            .flat()
            .map((role) => role.bindingId),
        );
        if (
          !bindingIds.size ||
          [...bindingIds].some((id) => {
            const binding = bindings.get(id);
            if (!binding) return true;
            const tool = this.tool(binding.tool, principal);
            return (
              !tool.resultViews?.some((view) => key(view) === key(component.ref)) ||
              component.requiredAnnotations!.some(
                (annotation) => !Object.hasOwn(tool.resultAnnotations ?? {}, annotation),
              )
            );
          })
        )
          fail(
            'SEMANTIC_INVALID',
            element.id,
            'This source does not declare the required component semantics',
          );
      }
      if (Object.keys(element.roles).some((r) => !Object.hasOwn(component.roles, r)))
        fail('SEMANTIC_INVALID', element.id, 'Unknown component role');
      const metadata: Record<string, FieldDefinition[]> = {};
      for (const [name, role] of Object.entries(component.roles)) {
        const refs = element.roles[name] ?? [];
        if (refs.length < role.min || refs.length > role.max)
          fail('SEMANTIC_INVALID', `${element.id}.${name}`, 'Role cardinality mismatch');
        const fields = refs.map(field);
        metadata[name] = fields;
        if (
          fields.some(
            (f) => !role.types.includes(f.type) || (role.roles && !role.roles.includes(f.role)),
          )
        )
          fail('SEMANTIC_INVALID', `${element.id}.${name}`, 'Role type/meaning mismatch');
        if (role.sameUnit && new Set(fields.map((f) => f.unit)).size > 1)
          fail('SEMANTIC_INVALID', element.id, 'Incompatible units require separate elements');
        if (
          role.sameGrain &&
          new Set(refs.map((r) => this.tool(bindings.get(r.bindingId)!.tool, principal).grain))
            .size > 1
        )
          fail('SEMANTIC_INVALID', element.id, 'Incompatible result grains');
      }
      if (
        component.singleBinding &&
        new Set(
          Object.values(element.roles)
            .flat()
            .map((f) => f.bindingId),
        ).size > 1
      )
        fail(
          'SEMANTIC_INVALID',
          element.id,
          'Cross-source composition needs a registered join operation',
        );
      const issues = component.validate?.(element, metadata) ?? [];
      if (component.partitionRoles) {
        const category = element.roles[component.partitionRoles.category]?.[0];
        const value = element.roles[component.partitionRoles.value]?.[0];
        if (
          !category ||
          !value ||
          category.bindingId !== value.bindingId ||
          !this.tool(bindings.get(category.bindingId)!.tool, principal).partitions?.some(
            (p) => p.categoryField === category.fieldId && p.valueField === value.fieldId,
          )
        )
          fail(
            'SEMANTIC_INVALID',
            element.id,
            'A part-to-whole chart requires a registered category partition',
          );
      }
      if (issues.length) fail('SEMANTIC_INVALID', element.id, issues.join('; '));
    }
    for (const control of controls) this.validateControl(control, plan, principal);
    return plan;
  }
  private validateControl(control: Control, plan: ResponsePlan, principal: Principal) {
    const registration = this.available(this.controls, control.control, principal);
    if (!registration.value.safeParse(control.initialValue).success)
      fail('SCHEMA_INVALID', control.id, 'Invalid initial control value');
    for (const target of control.targets) {
      const binding = plan.bindings.find((b) => b.id === target.bindingId)!;
      const tool = this.tool(binding.tool, principal);
      if (this.fields(binding.tool, principal).length !== tool.fields.length)
        fail(
          'CAPABILITY_UNAVAILABLE',
          control.id,
          'Controls are unavailable for a restricted projection',
        );
      const capability = Object.hasOwn(tool.interactive, target.argument)
        ? tool.interactive[target.argument]
        : undefined;
      if (!capability?.controls.some((c) => key(c) === key(control.control)))
        fail('SEMANTIC_INVALID', control.id, 'Tool does not expose this argument/control pairing');
      if (target.argument in binding.fixedArgs && control.scopeMode !== 'change-answer')
        fail(
          'SCOPE_CONFLICT',
          control.id,
          'Changing fixed answer scope requires an explicit scope-changing control',
        );
      const args = { ...binding.args, ...binding.fixedArgs };
      if (JSON.stringify(args[target.argument]) !== JSON.stringify(control.initialValue))
        fail(
          'SCOPE_CONFLICT',
          control.id,
          'Control initial value must preserve initial answer scope',
        );
      if (!tool.args.safeParse({ ...args, [target.argument]: control.initialValue }).success)
        fail('SCHEMA_INVALID', control.id, 'Control value is invalid for the tool');
    }
  }
  validateResult(ref: CapabilityRef, result: unknown, principal: Principal): DataResult {
    const tool = this.tool(ref, principal);
    const permitted = this.fields(ref, principal);
    const annotations =
      result && typeof result === 'object' && 'annotations' in result
        ? result.annotations
        : undefined;
    const stack: { value: unknown; depth: number }[] = [{ value: annotations, depth: 0 }];
    let nodes = 0;
    while (stack.length) {
      const item = stack.pop()!;
      if (++nodes > 10000 || item.depth > 16)
        fail('BUDGET_EXCEEDED', ref.id, 'Result annotation nesting exceeds budget');
      if (item.value && typeof item.value === 'object')
        for (const value of Object.values(item.value)) stack.push({ value, depth: item.depth + 1 });
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(result);
    } catch {
      fail('RESULT_INVALID', ref.id, 'Result must be JSON');
    }
    if (!serialized! || new TextEncoder().encode(serialized!).length > this.limits.maxBytes)
      fail('BUDGET_EXCEEDED', ref.id, 'Result exceeds byte budget');
    const parsed = DataResult.safeParse(result);
    if (!parsed.success) fail('RESULT_INVALID', ref.id, 'Invalid result envelope');
    const data = parsed.data;
    for (const [name, value] of Object.entries(data.annotations ?? {})) {
      const schema = tool.resultAnnotations?.[name];
      if (!schema || !schema.safeParse(value).success)
        fail('RESULT_INVALID', ref.id, 'Result annotations are not registered or valid');
    }
    if (data.rows.length > this.limits.maxRows)
      fail('BUDGET_EXCEEDED', ref.id, 'Result exceeds row budget');
    if (data.provenance.grain !== tool.grain)
      fail('RESULT_INVALID', ref.id, 'Unexpected result grain');
    for (const row of data.rows) {
      const full =
        Object.keys(row).length === tool.fields.length &&
        tool.fields.every((field) => Object.hasOwn(row, field.id));
      const projected =
        Object.keys(row).length === permitted.length &&
        permitted.every((field) => Object.hasOwn(row, field.id));
      if (!full && !projected)
        fail('RESULT_INVALID', ref.id, 'Result fields do not match registered projection');
      for (const field of full ? tool.fields : permitted) {
        const value = row[field.id];
        if (value === null && field.nullable) continue;
        const valid =
          field.type === 'date'
            ? z.iso.date().safeParse(value).success
            : field.type === 'datetime'
              ? z.iso.datetime({ offset: true }).safeParse(value).success
              : typeof value === field.type;
        if (!valid)
          fail('RESULT_INVALID', field.id, 'Result value violates registered field semantics');
      }
    }
    return {
      ...data,
      rows: data.rows.map((row) =>
        Object.fromEntries(permitted.map((field) => [field.id, row[field.id]])),
      ),
    };
  }
  validatePresentationResults(
    plan: ResponsePlan,
    datasets: Record<string, DataResult>,
    principal: Principal,
  ) {
    for (const element of plan.blocks.flatMap((block) =>
      block.kind === 'visual' ? block.elements : [],
    )) {
      const component = this.available(this.components, element.component, principal);
      const bindings = [
        ...new Set(
          Object.values(element.roles)
            .flat()
            .map((role) => role.bindingId),
        ),
      ];
      for (const bindingId of bindings) {
        const data = datasets[bindingId];
        if (
          !data ||
          (component.requiredAnnotations ?? []).some(
            (name) => !Object.hasOwn(data.annotations ?? {}, name),
          )
        )
          fail('RESULT_INVALID', element.id, 'Result is missing required component semantics');
      }
      if (component.validateResult) {
        const fields = Object.fromEntries(
          bindings.map((bindingId) => {
            const binding = plan.bindings.find((item) => item.id === bindingId)!;
            return [bindingId, this.fields(binding.tool, principal)];
          }),
        );
        try {
          component.validateResult(element, datasets, fields);
        } catch {
          fail('RESULT_INVALID', element.id, 'Result does not satisfy visualization semantics');
        }
      }
    }
  }
}

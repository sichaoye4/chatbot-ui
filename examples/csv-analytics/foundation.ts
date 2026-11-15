import { z } from 'zod';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CsvRepository } from './index.ts';
import { Filters } from '../../packages/contracts/index.ts';
import type { Principal as LegacyPrincipal } from '../../packages/catalog/index.ts';
import type {
  DomainRegistration,
  FoundationCatalog,
  OptionResolverRegistration,
} from '../../packages/catalog/foundation.ts';
import {
  FoundationError,
  type FieldDefinition,
  type Policy,
} from '../../packages/contracts/foundation.ts';

const CsvIdentity = z.strictObject({
  id: z.string(),
  tenant: z.string(),
  domains: z.array(z.string()),
  policyEpoch: z.number().int(),
  revoked: z.boolean().optional(),
});
/** Host-owned bridge while the v1 demo migrates. Identity never comes from plan arguments. */
export const csvFoundationPolicy: Policy = {
  visible: (_ref, principal) => {
    const identity = CsvIdentity.safeParse(principal.context.csvIdentity);
    return identity.success && !identity.data.revoked && identity.data.domains.length > 0;
  },
  authorize: async (_ref, args, principal) => {
    const identity = CsvIdentity.safeParse(principal.context.csvIdentity);
    if (
      !identity.success ||
      identity.data.revoked ||
      !identity.data.domains.length ||
      (args.domain != null && !identity.data.domains.includes(String(args.domain)))
    )
      throw new FoundationError({ code: 'DATA_FORBIDDEN', path: '', message: 'CSV access denied' });
    return { scopeKey: JSON.stringify(identity.data), context: identity.data };
  },
};

/** Aggregate tools; interactive option support is opt-in through registerCsvFoundation. */
export function csvFoundationDomain(
  repository: CsvRepository,
  options: { interactive?: boolean } = {},
): DomainRegistration {
  const supported = new Map([
    ['csv.summary', 'one row per selected scope'],
    ['csv.monthlySla', 'one row per calendar month'],
    ['csv.monthlyQuality', 'one row per calendar month'],
    ['csv.countByDomain', 'one row per domain'],
  ]);
  const labels: Record<string, string> = {
    month: 'Month',
    domain: 'Domain',
    record_count: 'Recorded observations',
    system_count: 'Distinct systems',
    sla_mean: 'SLA met rate',
    sla_observations: 'SLA observations',
    avg_comp_mean: 'Average completion score',
    avg_comp_observations: 'Completion observations',
    data_ctrl_score_mean: 'Data control score',
    data_ctrl_score_observations: 'Data control observations',
  };
  return {
    ref: { id: 'csv.analytics', version: 1 },
    description: 'Monthly recorded operations observations',
    semantics: [
      'An unspecified data-quality request includes avg_comp, data_ctrl_score and sla_met_rate, on their separate original scales.',
      'Means are unweighted means of non-null observations. No ticket denominator or causal evidence is available.',
      'Monthly dates are represented by the first day of the month; that is a month label, not a daily observation.',
      'Fixed question scope belongs in fixedArgs. Only expose relevant exploration controls.',
    ],
    tools: repository
      .tools()
      .filter((tool) => supported.has(tool.id))
      .map((tool) => {
        const grain = supported.get(tool.id)!;
        const fields: FieldDefinition[] = tool.fields.map((f) => {
          const measure = f.type === 'number';
          const unit =
            f.unit === 'ratio'
              ? 'ratio'
              : f.name === 'avg_comp_mean'
                ? 'score:avg_comp'
                : f.name === 'data_ctrl_score_mean'
                  ? 'score:data_ctrl_score'
                  : 'count';
          return {
            id: f.name,
            label: labels[f.name] ?? f.name,
            type: f.type,
            role: measure ? 'measure' : f.type === 'date' ? 'time' : 'dimension',
            nullable: f.nullable,
            ...(f.nullable ? { nullMeaning: 'No recorded observation for this aggregate' } : {}),
            description: f.name.includes('mean')
              ? 'Unweighted mean of recorded non-null observations'
              : f.name,
            ...(measure
              ? {
                  unit,
                  measure: {
                    aggregation: f.name.includes('mean') ? 'unweighted mean' : 'count',
                    precision: f.name.includes('mean') ? 4 : 0,
                    additive: false,
                  },
                }
              : {}),
            ...(f.type === 'date'
              ? { temporal: { timezone: 'UTC', calendar: 'gregorian', grain: 'month' } }
              : {}),
          };
        });
        return {
          ref: { id: tool.id, version: 1 },
          description: tool.description,
          args: Filters,
          fields,
          grain,
          partitions: tool.partitions,
          interactive: options.interactive
            ? Object.fromEntries(
                ['domain', 'country', 'system', 'month'].map((argument) => [
                  argument,
                  {
                    description: `Filter by ${argument} within the authorized query scope`,
                    controls: [{ id: 'ui.select', version: 1 }],
                    options: { id: 'csv.filterChoices', version: 1 },
                  },
                ]),
              )
            : {},
          execute: async (args, context, signal) => {
            signal.throwIfAborted();
            const data = tool.execute(args, CsvIdentity.parse(context) as LegacyPrincipal);
            return {
              rows: data.rows.map((row) =>
                Object.fromEntries(
                  Object.entries(row).map(([name, value]) => [
                    name,
                    name === 'month' && typeof value === 'string' ? `${value}-01` : value,
                  ]),
                ),
              ),
              provenance: {
                sourceId: data.sourceId,
                sourceVersion: data.sourceHash,
                queryId: randomUUID(),
                executedAt: new Date().toISOString(),
                sourceAsOf: data.asOf,
                grain,
                truncated: data.truncated,
                nextCursor: data.nextCursor,
                warnings: data.warnings,
              },
            };
          },
        };
      }),
  };
}

/** CSV-specific option logic stays in the domain adapter; the generic runtime sees only a resolver. */
export function csvOptionResolver(repository: CsvRepository): OptionResolverRegistration {
  const tool = repository.tools().find((item) => item.id === 'csv.filterOptions')!;
  const secret = randomBytes(32);
  const values = (scopeArgs: Record<string, unknown>, argument: string, context: unknown) => {
    const identity = CsvIdentity.parse(context) as LegacyPrincipal;
    const args = tool.args.parse({ ...scopeArgs, field: argument }) as Record<string, unknown>;
    return tool.execute(args, identity).rows.map((row) => String(row.value));
  };
  return {
    ref: { id: 'csv.filterChoices', version: 1 },
    resolve: async ({ scopeArgs, argument, context, search, cursor, signal }) => {
      signal.throwIfAborted();
      const scope = createHash('sha256')
        .update(
          JSON.stringify({
            scopeArgs,
            argument,
            identity: CsvIdentity.parse(context),
            search: search ?? '',
          }),
        )
        .digest('hex');
      let offset = 0;
      if (cursor) {
        const [payload, signature, extra] = cursor.split('.');
        const expected = createHmac('sha256', secret)
          .update(payload ?? '')
          .digest();
        let supplied: Buffer;
        try {
          supplied = Buffer.from(signature ?? '', 'base64url');
        } catch {
          throw new Error('Invalid option cursor');
        }
        if (extra || expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
          throw new Error('Invalid option cursor');
        const decoded = z
          .strictObject({ scope: z.string(), offset: z.number().int().nonnegative().max(1000000) })
          .parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
        if (decoded.scope !== scope) throw new Error('Option cursor scope changed');
        offset = decoded.offset;
      }
      const filtered = values(scopeArgs, argument, context).filter(
        (value) =>
          !search || value.toLocaleLowerCase('en-US').includes(search.toLocaleLowerCase('en-US')),
      );
      const page = filtered.slice(offset, offset + 100);
      const payload = Buffer.from(JSON.stringify({ scope, offset: offset + page.length })).toString(
        'base64url',
      );
      const nextCursor =
        offset + page.length < filtered.length
          ? `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`
          : null;
      signal.throwIfAborted();
      return { options: page.map((value) => ({ value, label: value })), nextCursor };
    },
    accepts: async ({ value, scopeArgs, argument, context, signal }) => {
      signal.throwIfAborted();
      return values(scopeArgs, argument, context).includes(value);
    },
  };
}
export function registerCsvFoundation(catalog: FoundationCatalog, repository: CsvRepository) {
  catalog.registerOptionResolver(csvOptionResolver(repository));
  catalog.registerDomain(csvFoundationDomain(repository, { interactive: true }));
  return catalog;
}

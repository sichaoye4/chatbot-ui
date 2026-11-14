import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { CsvRepository } from './index.ts';
import { Filters } from '../../packages/contracts/index.ts';
import type { Principal as LegacyPrincipal } from '../../packages/catalog/index.ts';
import type { DomainRegistration } from '../../packages/catalog/foundation.ts';
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

/** Initial real-data plugin: aggregate tools only. Records/options migrate in G04–G07. */
export function csvFoundationDomain(repository: CsvRepository): DomainRegistration {
  const supported = new Map([
    ['csv.summary', 'one row per selected scope'],
    ['csv.monthlySla', 'one row per calendar month'],
    ['csv.monthlyQuality', 'one row per calendar month'],
    ['csv.countByDomain', 'one row per domain'],
  ]);
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
            label: f.name,
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
          interactive: {},
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

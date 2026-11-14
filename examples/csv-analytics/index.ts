import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import {
  AppError,
  Filters,
  Month,
  type Row,
  type Dataset,
  type FieldMeta,
} from '../../packages/contracts/index.ts';
import type { Tool, Principal } from '../../packages/catalog/index.ts';

export const SOURCE_HASH = '56fc638633ab77d75cdefb79ae988aca783c21070b96493bacca61f89f28842a';
export const columns = [
  'domain',
  'system',
  'ctry_iso_cde',
  'srce_team_base',
  'src_tier',
  'src_team_size',
  'src_infra_tech',
  'src_chg',
  'src_inc',
  'src_ctrl_score',
  'src_devops',
  'n_middle_syst',
  'xfer_team_base',
  'xfer_team_size',
  'xfer_chg',
  'xfer_inc',
  'data_team_base',
  'data_proc_team_type',
  'data_team_size',
  'data_syst_inc',
  'data_syst_chg',
  'month_id',
  'data_ctrl_score',
  'avg_comp',
  'sla_met_rate',
];
const strings = new Set([
  'domain',
  'system',
  'ctry_iso_cde',
  'srce_team_base',
  'src_infra_tech',
  'src_devops',
  'xfer_team_base',
  'data_team_base',
  'data_proc_team_type',
  'month_id',
]);
const nullable = new Set([
  'xfer_team_base',
  'xfer_team_size',
  'xfer_chg',
  'xfer_inc',
  'data_team_base',
  'data_team_size',
  'data_syst_inc',
  'data_syst_chg',
]);
export const recordFields: FieldMeta[] = [
  { name: 'rowId', type: 'string', nullable: false },
  ...columns.map((name) => ({
    name,
    type: (strings.has(name) ? 'string' : 'number') as 'string' | 'number',
    nullable: nullable.has(name),
    ...(name === 'sla_met_rate' ? { unit: 'ratio' } : {}),
  })),
];
const summaryFields: FieldMeta[] = [
  'record_count',
  'distinct_systems',
  'sla_mean',
  'sla_observations',
  'missing_transfer_size',
].map((name) => ({
  name,
  type: 'number',
  nullable: name === 'sla_mean',
  ...(name === 'sla_mean' ? { unit: 'ratio' } : {}),
}));
const monthlyFields: FieldMeta[] = [
  { name: 'month', type: 'date', nullable: false },
  { name: 'sla_mean', type: 'number', nullable: true, unit: 'ratio' },
  { name: 'sla_observations', type: 'number', nullable: false },
];
const countsFields: FieldMeta[] = [
  { name: 'domain', type: 'string', nullable: false },
  { name: 'record_count', type: 'number', nullable: false },
];
const filterShape = {
  domain: z.enum(['kyc', 'party', 'payment']).nullable().optional(),
  system: z.string().max(80).nullable().optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .optional(),
  month: Month.nullable().optional(),
  startMonth: Month.optional(),
  endMonth: Month.optional(),
};
export const RecordsArgs = z.strictObject({
  ...filterShape,
  columns: z
    .array(z.enum(columns as [string, ...string[]]))
    .min(1)
    .max(25)
    .optional(),
  sort: z.enum(['rowId', ...columns]).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export class CsvRepository {
  rows: Row[];
  fields = recordFields;
  sourceHash: string;
  private cursorKey = randomBytes(32);
  constructor(path: string, expectedHash?: string) {
    const bytes = readFileSync(path);
    this.sourceHash = createHash('sha256').update(bytes).digest('hex');
    if (expectedHash && this.sourceHash !== expectedHash)
      throw new AppError('SOURCE_HASH_MISMATCH', 503);
    const raw: string[][] = parse(bytes, { bom: true, skip_empty_lines: true });
    if (JSON.stringify(raw.shift()) !== JSON.stringify(columns))
      throw new AppError('SOURCE_SCHEMA_INVALID', 503);
    this.rows = raw.map((values, index) => {
      if (values.length !== columns.length) throw new AppError('SOURCE_ROW_INVALID', 503);
      const row: Row = { rowId: `${this.sourceHash}:${index + 1}` };
      columns.forEach((name, i) => {
        const value = values[i];
        if (!value) {
          if (!nullable.has(name)) throw new AppError('SOURCE_NULL_INVALID', 503);
          row[name] = null;
        } else if (strings.has(name)) row[name] = value;
        else {
          if (!/^-?\d+(\.\d+)?$/.test(value) || !Number.isFinite(Number(value)))
            throw new AppError('SOURCE_NUMBER_INVALID', 503);
          row[name] = Number(value);
        }
      });
      if (
        !/^\d{4}(0[1-9]|1[0-2])$/.test(String(row.month_id)) ||
        Number(row.sla_met_rate) < 0 ||
        Number(row.sla_met_rate) > 1
      )
        throw new AppError('SOURCE_VALUE_INVALID', 503);
      return row;
    });
  }
  select(input: unknown, principal: Principal) {
    const f = Filters.parse(input);
    if (principal.revoked) throw new AppError('DATA_FORBIDDEN', 403);
    if (f.domain && !principal.domains.includes(f.domain))
      throw new AppError('DATA_FORBIDDEN', 403);
    return this.rows.filter((r) => {
      const month = String(r.month_id).slice(0, 4) + '-' + String(r.month_id).slice(4);
      return (
        principal.domains.includes(String(r.domain)) &&
        (!f.domain || r.domain === f.domain) &&
        (!f.system || r.system === f.system) &&
        (!f.country || r.ctry_iso_cde === f.country) &&
        (!f.month || month === f.month) &&
        (!f.startMonth || month >= f.startMonth) &&
        (!f.endMonth || month <= f.endMonth)
      );
    });
  }
  envelope(
    rows: Row[],
    fields: FieldMeta[],
    args: Record<string, unknown>,
    count: number,
    nextCursor: string | null = null,
  ): Dataset {
    return {
      rows,
      fields,
      args,
      sourceId: 'training_data_masked_final_1',
      sourceHash: this.sourceHash,
      queryVersion: '1',
      queryId: 'pending',
      observationCount: count,
      asOf: '2025-05',
      truncated: nextCursor !== null,
      nextCursor,
      warnings: fields.some((field) => field.name.startsWith('sla_'))
        ? [
            'SLA averages are unweighted means of source-record rates; no ticket denominators are available.',
          ]
        : [],
    };
  }
  summary(args: Record<string, unknown>, p: Principal) {
    const rows = this.select(args, p);
    const rates = rows.map((r) => Number(r.sla_met_rate));
    return this.envelope(
      [
        {
          record_count: rows.length,
          distinct_systems: new Set(rows.map((r) => r.system)).size,
          sla_mean: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
          sla_observations: rates.length,
          missing_transfer_size: rows.filter((r) => r.xfer_team_size === null).length,
        },
      ],
      summaryFields,
      args,
      rows.length,
    );
  }
  monthly(args: Record<string, unknown>, p: Principal) {
    const rows = this.select(args, p);
    const groups = new Map<string, number[]>();
    for (const row of rows) {
      const month = String(row.month_id).slice(0, 4) + '-' + String(row.month_id).slice(4);
      const g = groups.get(month) ?? [];
      g.push(Number(row.sla_met_rate));
      groups.set(month, g);
    }
    const result: Row[] = [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, values]) => ({
        month,
        sla_mean: values.reduce((a, b) => a + b, 0) / values.length,
        sla_observations: values.length,
      }));
    // Explicit missing calendar buckets prevent the renderer joining over missing months.
    if (result.length) {
      const first = String(args.startMonth ?? result[0].month),
        last = String(args.endMonth ?? result.at(-1)!.month);
      let [year, month] = first.split('-').map(Number);
      for (let i = 0; i < 2400; i++) {
        const key = `${year}-${String(month).padStart(2, '0')}`;
        if (key > last) break;
        if (!groups.has(key)) result.push({ month: key, sla_mean: null, sla_observations: 0 });
        if (++month > 12) {
          year++;
          month = 1;
        }
      }
      result.sort((a, b) => String(a.month).localeCompare(String(b.month)));
    }
    return this.envelope(result, monthlyFields, args, rows.length);
  }
  countByDomain(args: Record<string, unknown>, p: Principal) {
    const rows = this.select(args, p);
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(String(r.domain), (counts.get(String(r.domain)) ?? 0) + 1);
    return this.envelope(
      [...counts]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([domain, record_count]) => ({ domain, record_count })),
      countsFields,
      args,
      rows.length,
    );
  }
  monthlyQuality(args: Record<string, unknown>, p: Principal) {
    const data = this.monthly(args, p);
    const selected = this.select(args, p);
    const extraFields = ['avg_comp', 'data_ctrl_score'];
    data.rows = data.rows.map((row) => {
      const cohort = selected.filter(
        (r) => String(r.month_id) === String(row.month).replace('-', ''),
      );
      const extra: Row = {};
      for (const field of extraFields) {
        const values = cohort
          .map((r) => r[field])
          .filter((v): v is number => typeof v === 'number');
        extra[`${field}_mean`] = values.length
          ? values.reduce((a, b) => a + b, 0) / values.length
          : null;
        extra[`${field}_observations`] = values.length;
      }
      return { ...row, ...extra };
    });
    data.fields = [
      ...data.fields,
      ...extraFields.flatMap((name) => [
        { name: `${name}_mean`, type: 'number' as const, nullable: true },
        { name: `${name}_observations`, type: 'number' as const, nullable: false },
      ]),
    ];
    data.warnings.push(
      'avg_comp and data_ctrl_score are shown as unweighted means on their raw recorded scales. They are not normalized or combined into a synthetic quality index.',
    );
    return data;
  }
  records(input: Record<string, unknown>, p: Principal) {
    const args = RecordsArgs.parse(input);
    const {
      columns: requested,
      sort = 'rowId',
      direction = 'asc',
      cursor,
      limit = 50,
      ...filters
    } = args;
    const scope = JSON.stringify({
      source: this.sourceHash,
      principal: p,
      filters,
      sort,
      direction,
      limit,
      columns: requested ?? columns,
    });
    let offset = 0;
    if (cursor) {
      try {
        const [payload, signature] = cursor.split('.');
        const mac = createHmac('sha256', this.cursorKey).update(payload).digest('hex');
        if (
          signature.length !== mac.length ||
          !timingSafeEqual(Buffer.from(signature), Buffer.from(mac))
        )
          throw new Error();
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (decoded.scope !== createHash('sha256').update(scope).digest('hex')) throw new Error();
        offset = decoded.offset;
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error();
      } catch {
        throw new AppError('CURSOR_INVALID');
      }
    }
    const all = this.select(filters, p)
      .slice()
      .sort((a, b) => {
        const av = a[sort],
          bv = b[sort];
        let order =
          av === bv
            ? 0
            : av === null
              ? 1
              : bv === null
                ? -1
                : typeof av === 'number' && typeof bv === 'number'
                  ? av - bv
                  : String(av).localeCompare(String(bv));
        if (sort === 'rowId')
          order = Number(String(av).split(':')[1]) - Number(String(bv).split(':')[1]);
        return (
          (direction === 'desc' ? -order : order) ||
          Number(String(a.rowId).split(':')[1]) - Number(String(b.rowId).split(':')[1])
        );
      });
    const keys = ['rowId', ...(requested ?? columns)];
    const result = all
      .slice(offset, offset + limit)
      .map((r) => Object.fromEntries(keys.map((k) => [k, r[k]])) as Row);
    let next: string | null = null;
    if (offset + limit < all.length) {
      const payload = Buffer.from(
        JSON.stringify({
          offset: offset + limit,
          scope: createHash('sha256').update(scope).digest('hex'),
        }),
      ).toString('base64url');
      next = payload + '.' + createHmac('sha256', this.cursorKey).update(payload).digest('hex');
    }
    return this.envelope(
      result,
      recordFields.filter((f) => keys.includes(f.name)),
      input,
      all.length,
      next,
    );
  }
  record(id: string, p: Principal) {
    const r = this.rows.find((r) => r.rowId === id);
    if (!r || p.revoked || !p.domains.includes(String(r.domain)))
      throw new AppError('DATA_FORBIDDEN', 403);
    return r;
  }
  tools(): Tool[] {
    return [
      {
        id: 'csv.monthlyQuality',
        description:
          'Monthly data-quality trends. For unspecified data quality show ALL THREE: avg_comp_mean, data_ctrl_score_mean, sla_mean. Each is a separate unweighted mean on its own scale, with observation counts. For an explicitly named field show only that field.',
        args: Filters,
        fields: [
          ...monthlyFields,
          { name: 'avg_comp_mean', type: 'number', nullable: true },
          { name: 'avg_comp_observations', type: 'number', nullable: false },
          { name: 'data_ctrl_score_mean', type: 'number', nullable: true },
          { name: 'data_ctrl_score_observations', type: 'number', nullable: false },
        ],
        execute: (a, p) => this.monthlyQuality(a, p),
      },
      {
        id: 'csv.describe',
        description:
          'Authorized source field types and semantic limits. Source observations are not tickets; weighted SLA and causes are unavailable.',
        args: z.strictObject({}),
        fields: [
          { name: 'name', type: 'string', nullable: false },
          { name: 'type', type: 'string', nullable: false },
          { name: 'nullable', type: 'string', nullable: false },
        ],
        execute: (a, p) => {
          const rows = this.select({}, p);
          return this.envelope(
            recordFields.map((f) => ({ name: f.name, type: f.type, nullable: String(f.nullable) })),
            [
              { name: 'name', type: 'string', nullable: false },
              { name: 'type', type: 'string', nullable: false },
              { name: 'nullable', type: 'string', nullable: false },
            ],
            a,
            rows.length,
          );
        },
      },
      {
        id: 'csv.filterOptions',
        description:
          'Authorized exact filter values; no arbitrary URL or identities. Field is domain, system, country or month.',
        args: z.strictObject({
          ...filterShape,
          field: z.enum(['domain', 'system', 'country', 'month']),
        }),
        fields: [{ name: 'value', type: 'string', nullable: false }],
        execute: (a, p) => {
          const { field, ...filters } = a;
          const rows = this.select(filters, p);
          const column =
            field === 'country' ? 'ctry_iso_cde' : field === 'month' ? 'month_id' : String(field);
          const values = [...new Set(rows.map((r) => String(r[column])))].sort();
          return this.envelope(
            values.map((value) => ({
              value: field === 'month' ? value.slice(0, 4) + '-' + value.slice(4) : value,
            })),
            [{ name: 'value', type: 'string', nullable: false }],
            a,
            rows.length,
          );
        },
      },
      {
        id: 'csv.summary',
        description:
          'Source record count, distinct systems, unweighted SLA mean and missing transfer-size count. Not ticket totals or weighted SLA.',
        args: Filters,
        fields: summaryFields,
        aggregate: true,
        execute: (a, p) => this.summary(a, p),
      },
      {
        id: 'csv.monthlySla',
        description:
          'Monthly unweighted mean of recorded SLA rates, with explicit missing-month gaps.',
        args: Filters,
        fields: monthlyFields,
        execute: (a, p) => this.monthly(a, p),
      },
      {
        id: 'csv.countByDomain',
        partitions: [{ categoryField: 'domain', valueField: 'record_count' }],
        description: 'Source record counts grouped by domain.',
        args: Filters,
        fields: countsFields,
        execute: (a, p) => this.countByDomain(a, p),
      },
      {
        id: 'csv.records',
        description: 'Authorized source records. Paginate; never send the full CSV to the model.',
        args: RecordsArgs,
        fields: recordFields,
        execute: (a, p) => this.records(a, p),
      },
    ];
  }
}

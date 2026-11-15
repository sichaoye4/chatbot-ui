type Row = Record<string, string | number | boolean | null>;

export type PieSlice = { label: string; value: number; share: number };
export type PieModel =
  { ok: true; total: number; slices: PieSlice[] } | { ok: false; reason: string };
/** Shared by rendering and grounded prose so their denominators cannot diverge. */
export function pieModel(
  rows: Row[],
  category: string,
  value: string,
  truncated = false,
): PieModel {
  if (truncated)
    return {
      ok: false,
      reason: 'A pie chart requires the complete category totals; this result is truncated.',
    };
  if (!rows.length) return { ok: false, reason: 'No values match this scope.' };
  if (rows.length > 12)
    return {
      ok: false,
      reason:
        'There are too many categories for a readable pie chart. Narrow the scope or request a table.',
    };
  if (
    rows.some(
      (row) =>
        row[category] == null ||
        typeof row[value] !== 'number' ||
        !Number.isFinite(row[value]) ||
        Number(row[value]) < 0,
    )
  )
    return {
      ok: false,
      reason: 'A pie chart requires known, finite, nonnegative category totals.',
    };
  if (new Set(rows.map((row) => String(row[category]))).size !== rows.length)
    return { ok: false, reason: 'A pie chart requires one total per category.' };
  const total = rows.reduce((sum, row) => sum + Number(row[value]), 0);
  if (!Number.isFinite(total) || total <= 0)
    return { ok: false, reason: 'Percentages are undefined because the total is zero or invalid.' };
  return {
    ok: true,
    total,
    slices: rows.map((row) => ({
      label: String(row[category]),
      value: Number(row[value]),
      share: Number(row[value]) / total,
    })),
  };
}
export const percent = (share: number) => `${(share * 100).toFixed(2)}%`;

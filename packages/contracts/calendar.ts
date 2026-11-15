/** Parse a real UTC Gregorian calendar date without relying on locale or implicit timezone. */
export function dateValue(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error('Expected a calendar date (YYYY-MM-DD).');
  const ms = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value)
    throw new Error('Invalid calendar date.');
  return ms;
}

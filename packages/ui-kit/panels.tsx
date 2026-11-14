import { useState } from 'react';
import { AnalyticsChart } from './chart.tsx';
import { PieChart } from './pie.tsx';
import type { Action, Dataset, Panel, Row } from '../contracts/index.ts';
export function display(value: unknown, unit?: string) {
  return value === null || value === undefined
    ? 'Missing'
    : unit === 'ratio'
      ? `${(Number(value) * 100).toFixed(2)}%`
      : typeof value === 'number'
        ? value.toLocaleString('en-US')
        : String(value);
}
export function DataTable({ data, columns }: { data: Dataset; columns: string[] }) {
  return (
    <div className="table-scroll" role="region" aria-label="Scrollable source values" tabIndex={0}>
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, i) => (
            <tr key={String(r.rowId ?? i)}>
              {columns.map((c) => (
                <td key={c}>{display(r[c], data.fields.find((f) => f.name === c)?.unit)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function PanelBody({
  panel,
  data,
  onAction,
  onRecord,
  readOnly = false,
}: {
  panel: Panel;
  data: Dataset;
  onAction: (a: Action) => void;
  onRecord: (row: Row) => void;
  readOnly?: boolean;
}) {
  const [sort, setSort] = useState(
    panel.component === 'table'
      ? panel.config.columns.includes('month_id')
        ? 'month_id'
        : panel.config.columns[0]
      : '',
  );
  const [details, setDetails] = useState(false);
  if (panel.component === 'metric')
    return (
      <>
        <p className="metric-value">
          {display(
            data.rows[0]?.[panel.config.valueField],
            panel.config.format === 'percent' ? 'ratio' : undefined,
          )}
        </p>
        <p className="muted">
          {data.observationCount.toLocaleString('en-US')} source records · unweighted where averaged
        </p>
      </>
    );
  if (!data.rows.length) return <p role="status">No source records match these filters.</p>;
  if (panel.component === 'table')
    return (
      <>
        <fieldset className="table-controls" disabled={readOnly} aria-label="Table controls">
          <label>
            Sort field{' '}
            <select aria-label="Sort field" value={sort} onChange={(e) => setSort(e.target.value)}>
              {panel.config.columns.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <button
            onClick={() =>
              onAction({ type: 'sortTable', panelId: panel.id, field: sort, direction: 'asc' })
            }
          >
            Sort ascending
          </button>
          <button
            disabled={!data.nextCursor}
            onClick={() =>
              onAction({ type: 'nextPage', panelId: panel.id, cursor: data.nextCursor! })
            }
          >
            Next page
          </button>
        </fieldset>
        <DataTable data={data} columns={panel.config.columns} />
        <p className="muted">
          Showing {data.rows.length} of {data.observationCount.toLocaleString('en-US')} source
          records
        </p>
        <button onClick={() => onRecord(data.rows[0])}>Open first record</button>
      </>
    );
  if (panel.component === 'relationship')
    return <p>Relationship rendering is not enabled for this dataset.</p>;
  if (panel.component === 'pie')
    return (
      <>
        <PieChart
          key={data.queryId}
          data={data}
          category={panel.config.categoryField}
          value={panel.config.valueField}
          title={panel.title}
        />
        <button aria-expanded={details} onClick={() => setDetails(!details)}>
          {details ? 'Hide' : 'Show'} underlying chart values
        </button>
        {details && (
          <DataTable data={data} columns={[panel.config.categoryField, panel.config.valueField]} />
        )}
      </>
    );
  const x = panel.component === 'trend' ? panel.config.xField : panel.config.categoryField;
  const y = panel.component === 'trend' ? panel.config.yField : panel.config.valueField;
  return (
    <>
      <p className="chart-summary">
        {panel.component === 'trend'
          ? 'Recorded observations · Missing values remain gaps.'
          : 'Category comparison · Zero baseline.'}
      </p>
      <AnalyticsChart
        key={`${data.queryId}-${x}-${y}`}
        data={data}
        x={x}
        y={y}
        title={panel.title}
        kind={panel.component}
      />
      <button aria-expanded={details} onClick={() => setDetails(!details)}>
        {details ? 'Hide' : 'Show'} underlying chart values
      </button>
      {details && <DataTable data={data} columns={[x, y]} />}
    </>
  );
}

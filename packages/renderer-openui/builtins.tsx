import { useState, type ComponentType } from 'react';
import type { ProjectViewData } from '../contracts/project-validation.ts';
import { projectV2Model } from '../contracts/project-v2.ts';
import { AnalyticsChart } from '../ui-kit/chart.tsx';
import { PieChart } from '../ui-kit/pie.tsx';
import { ProjectChart } from '../ui-kit/project-charts.tsx';
import { VisualizationChart } from '../ui-kit/visualization-charts.tsx';
import { visualizationKinds } from '../contracts/visualization.ts';
import { visualizationV2Model } from '../contracts/visualization-v2.ts';
import { formatCellValue, type ClientRegistry, type ElementViewProps } from './foundation.tsx';

// These are display adapters only. They do not infer units, provenance, or business meaning.
function chartData({ fields, data }: ElementViewProps): ProjectViewData {
  return {
    rows: data.rows,
    fields: fields.map((field) => ({
      name: field.id,
      type: field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'string',
      nullable: field.nullable,
      unit: field.unit,
    })),
    truncated: data.provenance.truncated || data.provenance.nextCursor !== null,
  };
}
const role = (props: ElementViewProps, name: string) => props.element.roles[name]?.[0]?.fieldId;
function fieldLabel(props: ElementViewProps, id: string) {
  return props.fields.find((field) => field.id === id)?.label ?? id;
}

function Metric(props: ElementViewProps) {
  const id = role(props, 'value');
  if (
    !id ||
    props.data.rows.length !== 1 ||
    props.data.provenance.truncated ||
    props.data.provenance.nextCursor !== null
  )
    return <p role="status">A metric requires one complete result value.</p>;
  const value = props.data.rows[0][id];
  const field = props.fields.find((item) => item.id === id);
  const formatted =
    value === null
      ? 'Unavailable'
      : typeof value === 'number'
        ? new Intl.NumberFormat(
            props.locale,
            field?.unit === 'ratio'
              ? { style: 'percent', maximumFractionDigits: 2, ...props.numberFormat }
              : { maximumFractionDigits: field?.measure?.precision ?? 4, ...props.numberFormat },
          ).format(value)
        : String(value);
  return (
    <p className="foundation-metric">
      {formatted}
      {field?.unit && field.unit !== 'ratio' ? ` ${field.unit}` : ''}
    </p>
  );
}

function Trend(props: ElementViewProps) {
  const time = role(props, 'time');
  const values = props.element.roles.values ?? [];
  if (!time || !values.length) return <p role="alert">Chart fields are unavailable.</p>;
  const data = chartData(props);
  if (!data.rows.length) return <p role="status">No observations are available.</p>;
  const timestamps = data.rows.map((row) =>
    typeof row[time] === 'string' ? Date.parse(row[time] as string) : NaN,
  );
  if (
    timestamps.some((timeValue) => !Number.isFinite(timeValue)) ||
    new Set(timestamps).size !== timestamps.length
  )
    return <p role="alert">A trend requires one observation per time value.</p>;
  data.rows = [...data.rows].sort(
    (a, b) => Date.parse(String(a[time])) - Date.parse(String(b[time])),
  );
  return (
    <>
      {values.map(({ fieldId }) => (
        <div key={fieldId}>
          <p>{fieldLabel(props, fieldId)}</p>
          <AnalyticsChart
            data={data}
            x={time}
            y={fieldId}
            title={`${props.element.title}: ${fieldLabel(props, fieldId)}`}
            kind="trend"
            temporal
            locale={props.locale}
            valueLabel={fieldLabel(props, fieldId)}
          />
        </div>
      ))}
    </>
  );
}

function Comparison(props: ElementViewProps) {
  const category = role(props, 'category');
  const value = role(props, 'value');
  if (!category || !value) return <p role="alert">Chart fields are unavailable.</p>;
  if (!props.data.rows.length) return <p role="status">No observations are available.</p>;
  return (
    <AnalyticsChart
      data={chartData(props)}
      x={category}
      y={value}
      title={props.element.title}
      kind="comparison"
      locale={props.locale}
      valueLabel={fieldLabel(props, value)}
    />
  );
}

function Pie(props: ElementViewProps) {
  const category = role(props, 'category');
  const value = role(props, 'value');
  return category && value ? (
    <PieChart
      data={chartData(props)}
      category={category}
      value={value}
      title={props.element.title}
      locale={props.locale}
    />
  ) : (
    <p role="alert">Chart fields are unavailable.</p>
  );
}

function compareSortValues(
  left: string | number | boolean | null | undefined,
  right: string | number | boolean | null | undefined,
  direction: 'asc' | 'desc',
): number {
  const leftNull = left === null || left === undefined;
  const rightNull = right === null || right === undefined;
  if (leftNull && rightNull) return 0;
  if (leftNull) return 1;
  if (rightNull) return -1;
  const base =
    typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left).localeCompare(String(right), 'en-US', { numeric: true });
  return direction === 'desc' ? -base : base;
}

function Table(props: ElementViewProps) {
  const columns = props.element.roles.columns?.map((ref) => ref.fieldId) ?? [];
  const fieldById = new Map(props.fields.map((field) => [field.id, field]));
  const idField = props.fields.find((field) => field.role === 'identifier');
  const [localSort, setLocalSort] = useState<{ field: string; direction: 'asc' | 'desc' } | null>(
    null,
  );
  const sorting = props.descriptor?.capabilities?.sorting;
  const pagination = props.descriptor?.capabilities?.pagination;
  const canUseLocalSort = Boolean(
    sorting?.localSort &&
    !props.data.provenance.truncated &&
    props.data.provenance.nextCursor === null,
  );
  const hasSortAction = Boolean(
    props.onAction && props.operations?.some((op) => op.id === 'ui.sort' && op.version === 1),
  );
  const hasPaginateAction = Boolean(
    props.onAction && props.operations?.some((op) => op.id === 'ui.paginate' && op.version === 1),
  );
  const serverSortField =
    sorting && typeof props.bindingArgs?.[sorting.fieldArg] === 'string'
      ? String(props.bindingArgs[sorting.fieldArg])
      : null;
  const serverSortDir =
    sorting && props.bindingArgs?.[sorting.directionArg] === 'desc'
      ? 'desc'
      : sorting && props.bindingArgs?.[sorting.directionArg] === 'asc'
        ? 'asc'
        : undefined;
  const activeSortField = canUseLocalSort ? (localSort?.field ?? null) : serverSortField;
  const activeSortDir = canUseLocalSort
    ? localSort?.direction
    : (serverSortDir ?? (serverSortField ? 'asc' : undefined));
  const rows =
    canUseLocalSort && localSort
      ? [...props.data.rows].sort((a, b) =>
          compareSortValues(a[localSort.field], b[localSort.field], localSort.direction),
        )
      : props.data.rows;
  const showPagination = Boolean(
    pagination &&
    hasPaginateAction &&
    props.bindingId &&
    (props.canGoPrevious || props.data.provenance.nextCursor !== null),
  );
  return (
    <div
      className="foundation-table-scroll"
      role="region"
      aria-label={props.element.title}
      tabIndex={0}
    >
      <table>
        <thead>
          <tr>
            {columns.map((id) => {
              const sortable = Boolean(
                sorting &&
                (sorting.fields.length === 0 || sorting.fields.includes(id)) &&
                (canUseLocalSort || (hasSortAction && props.bindingId)),
              );
              const isSorted = activeSortField === id;
              const nextDirection: 'asc' | 'desc' =
                isSorted && activeSortDir === 'asc' ? 'desc' : 'asc';
              return (
                <th
                  key={id}
                  scope="col"
                  aria-sort={
                    isSorted ? (activeSortDir === 'desc' ? 'descending' : 'ascending') : undefined
                  }
                >
                  {sortable ? (
                    <button
                      type="button"
                      className="foundation-sort-btn"
                      disabled={props.controlsDisabled}
                      onClick={() => {
                        if (canUseLocalSort) {
                          setLocalSort({ field: id, direction: nextDirection });
                        } else if (hasSortAction && props.bindingId) {
                          props.onAction!(
                            { id: 'ui.sort', version: 1 },
                            { bindingId: props.bindingId, fieldId: id, direction: nextDirection },
                          );
                        }
                      }}
                    >
                      {fieldLabel(props, id)}
                      {isSorted ? (activeSortDir === 'desc' ? ' ▼' : ' ▲') : ''}
                    </button>
                  ) : (
                    fieldLabel(props, id)
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const rawId = idField ? row[idField.id] : undefined;
            const selectable =
              props.bindingId &&
              idField &&
              props.onSelectRecord &&
              (typeof rawId === 'string' || typeof rawId === 'number');
            return (
              <tr key={index}>
                {columns.map((id) => {
                  const field = fieldById.get(id);
                  const formatted = formatCellValue(row[id], field, {
                    locale: props.locale,
                    timezone: props.timezone,
                    numberFormat: props.numberFormat,
                  });
                  return (
                    <td key={id}>
                      {selectable && id === idField.id ? (
                        <button
                          type="button"
                          className="foundation-link-btn"
                          aria-label={`Select ${fieldLabel(props, id)} ${rawId}`}
                          onClick={() =>
                            props.onSelectRecord!({
                              bindingId: props.bindingId!,
                              identifierField: idField.id,
                              id: rawId,
                              row,
                            })
                          }
                        >
                          {formatted}
                        </button>
                      ) : (
                        formatted
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {!rows.length && <p role="status">No observations are available.</p>}
      {showPagination && (
        <div className="foundation-table-pagination" role="navigation" aria-label="Pagination">
          {props.canGoPrevious && (
            <button
              type="button"
              disabled={props.controlsDisabled}
              onClick={() =>
                props.onAction!(
                  { id: 'ui.paginate', version: 1 },
                  { bindingId: props.bindingId!, cursor: props.previousCursor ?? null },
                )
              }
            >
              Previous page
            </button>
          )}
          {props.data.provenance.nextCursor !== null && (
            <button
              type="button"
              disabled={props.controlsDisabled}
              onClick={() =>
                props.onAction!(
                  { id: 'ui.paginate', version: 1 },
                  { bindingId: props.bindingId!, cursor: props.data.provenance.nextCursor },
                )
              }
            >
              Next page
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Project(props: ElementViewProps) {
  try {
    const { panel, data } = projectV2Model(props.element, props.data, props.fields);
    return <ProjectChart panel={panel} data={data} />;
  } catch {
    return <p role="alert">This project visualization requires valid, complete data.</p>;
  }
}

function AdvancedVisualization(props: ElementViewProps) {
  try {
    const { panel, data } = visualizationV2Model(props.element, props.data, props.fields);
    return <VisualizationChart panel={panel} data={data} />;
  } catch {
    return <p role="alert">This visualization requires valid, complete source semantics.</p>;
  }
}

export const builtinRegistry: ClientRegistry = Object.freeze({
  ...Object.fromEntries(visualizationKinds.map((kind) => [`ui.${kind}@1`, AdvancedVisualization])),
  'ui.metric@1': Metric,
  'ui.trend@1': Trend,
  'ui.comparison@1': Comparison,
  'ui.pie@1': Pie,
  'ui.table@1': Table,
  'ui.gantt@1': Project,
  'ui.flowchart@1': Project,
  'ui.burndown@1': Project,
  'ui.cumulativeFlow@1': Project,
} satisfies Record<string, ComponentType<ElementViewProps>>);
/** Advertise only renderers the host has actually installed. */
export function installedComponents(registry: ClientRegistry) {
  return Object.keys(registry).flatMap((key) => {
    const match = /^([a-z][a-z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9_-]*)+)@([1-9][0-9]*)$/.exec(key);
    return match ? [{ id: match[1], version: Number(match[2]) }] : [];
  });
}

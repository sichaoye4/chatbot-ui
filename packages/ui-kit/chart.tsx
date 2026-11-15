import { useEffect, useId, useRef, useState } from 'react';
import type { Dataset } from '../contracts/index.ts';

export function chartValue(value: unknown, unit?: string, locale?: string) {
  return value === null ||
    value === undefined ||
    (typeof value === 'number' && !Number.isFinite(value))
    ? 'Missing'
    : unit === 'ratio'
      ? new Intl.NumberFormat(locale ?? 'en-US', {
          style: 'percent',
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(Number(value))
      : typeof value === 'number'
        ? value.toLocaleString(locale ?? 'en-US')
        : String(value);
}

/** Presentation only: all points come from the supplied dataset, with no domain inference. */
export function AnalyticsChart({
  data,
  x,
  y,
  title,
  kind,
  locale,
  valueLabel,
  temporal = false,
}: {
  data: Pick<Dataset, 'rows' | 'fields'>;
  x: string;
  y: string;
  title: string;
  kind: 'trend' | 'comparison';
  locale?: string;
  valueLabel?: string;
  temporal?: boolean;
}) {
  const [active, setActive] = useState<number | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const id = useId();
  const unit = data.fields.find((field) => field.name === y)?.unit;
  const values = data.rows.map((row) =>
    typeof row[y] === 'number' && Number.isFinite(row[y]) ? Number(row[y]) : null,
  );
  const valid = values.filter((value): value is number => value !== null);
  const minimum = Math.min(0, ...valid);
  const maximum = Math.max(unit === 'ratio' ? 1 : 0, ...valid);
  const span = maximum - minimum || 1;
  const top = 24,
    bottom = 218,
    left = 66,
    right = width - 22,
    height = 260;
  const py = (value: number) => bottom - ((value - minimum) / span) * (bottom - top);
  const step = (right - left) / Math.max(1, data.rows.length);
  const times = temporal ? data.rows.map((row) => Date.parse(String(row[x]))) : [];
  const timeStart = times[0];
  const timeSpan = times.at(-1)! - timeStart;
  const px = (index: number) =>
    kind === 'comparison'
      ? left + step * (index + 0.5)
      : data.rows.length === 1
        ? (left + right) / 2
        : temporal && timeSpan > 0
          ? left + ((times[index] - timeStart) * (right - left)) / timeSpan
          : left + (index * (right - left)) / (data.rows.length - 1);
  const ticks = Array.from({ length: 5 }, (_, i) => minimum + (span * i) / 4);
  const labelCount =
    kind === 'comparison' && data.rows.length <= 4
      ? data.rows.length
      : Math.min(data.rows.length, Math.max(2, Math.min(6, Math.floor((right - left) / 70))));
  const labelIndices = [
    ...new Set(
      Array.from({ length: labelCount }, (_, i) =>
        Math.round((i * (data.rows.length - 1)) / Math.max(1, labelCount - 1)),
      ),
    ),
  ];
  const segments: { path: string; first: number; last: number }[] = [];
  let current: (typeof segments)[number] | undefined;
  values.forEach((value, index) => {
    if (value === null) {
      current = undefined;
      return;
    }
    if (!current) {
      current = { path: `M${px(index)},${py(value)}`, first: index, last: index };
      segments.push(current);
    } else {
      current.path += ` L${px(index)},${py(value)}`;
      current.last = index;
    }
  });
  const tickLabel = (value: number) =>
    unit === 'ratio'
      ? new Intl.NumberFormat(locale ?? 'en-US', {
          style: 'percent',
          maximumFractionDigits: 1,
        }).format(value)
      : new Intl.NumberFormat(locale ?? 'en-US', {
          notation: Math.abs(value) >= 10000 ? 'compact' : 'standard',
          maximumFractionDigits: 2,
        }).format(value);
  const selected = active === null ? undefined : data.rows[active];
  return (
    <div
      ref={container}
      className={`chart-container chart-${kind}`}
      onPointerLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) setActive(null);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setActive(null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setActive(null);
          event.stopPropagation();
        }
      }}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-label={`${title}. Use arrow keys to explore values.`}
        className="chart"
      >
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-line)" stopOpacity="0.12" />
            <stop offset="100%" stopColor="var(--chart-line)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className="chart-grid" aria-hidden="true">
          {ticks.map((value, index) => (
            <g key={index}>
              <line
                className="grid-horizontal"
                x1={left}
                x2={right}
                y1={py(value)}
                y2={py(value)}
              />
              <text x={left - 12} y={py(value) + 4} textAnchor="end">
                {tickLabel(value)}
              </text>
            </g>
          ))}
          {labelIndices.map((index) => (
            <g key={index}>
              <line className="grid-vertical" x1={px(index)} x2={px(index)} y1={top} y2={bottom} />
              <text
                x={px(index)}
                y={height - 18}
                textAnchor={
                  index === 0 ? 'start' : index === data.rows.length - 1 ? 'end' : 'middle'
                }
              >
                {String(data.rows[index][x]).length > 13
                  ? `${String(data.rows[index][x]).slice(0, 11)}…`
                  : String(data.rows[index][x])}
              </text>
            </g>
          ))}
        </g>
        <line
          className="chart-baseline"
          x1={left}
          x2={right}
          y1={py(0)}
          y2={py(0)}
          aria-hidden="true"
        />
        {kind === 'trend' &&
          segments.map((segment, index) => (
            <g key={index} aria-hidden="true">
              <path
                d={`${segment.path} L${px(segment.last)},${py(0)} L${px(segment.first)},${py(0)} Z`}
                fill={`url(#${id}-fill)`}
              />
              <path className="chart-line" d={segment.path} />
            </g>
          ))}
        {active !== null && (
          <line
            className="chart-crosshair"
            x1={px(active)}
            x2={px(active)}
            y1={top}
            y2={bottom}
            aria-hidden="true"
          />
        )}
        {data.rows.map((row, index) => {
          const value = values[index];
          const pointY = py(value ?? 0);
          const barWidth = Math.min(56, step * 0.55);
          const label = `${String(row[x])}: ${chartValue(row[y], unit, locale)}`;
          return (
            <g
              key={index}
              className={`chart-point ${active === index ? 'is-active' : ''}`}
              data-chart-point={index}
              role="button"
              tabIndex={active === null ? (index === 0 ? 0 : -1) : active === index ? 0 : -1}
              aria-label={label}
              aria-describedby={active === index ? `${id}-tooltip` : undefined}
              onPointerEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onClick={() => setActive(index)}
              onKeyDown={(event) => {
                const next =
                  event.key === 'ArrowRight'
                    ? Math.min(data.rows.length - 1, index + 1)
                    : event.key === 'ArrowLeft'
                      ? Math.max(0, index - 1)
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? data.rows.length - 1
                          : null;
                if (next !== null) {
                  event.preventDefault();
                  event.currentTarget.ownerSVGElement
                    ?.querySelectorAll<SVGGElement>('[data-chart-point]')
                    [next]?.focus();
                } else if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setActive(index);
                }
              }}
            >
              {kind === 'comparison' && value !== null && (
                <rect
                  className="chart-bar"
                  x={px(index) - barWidth / 2}
                  y={Math.min(pointY, py(0))}
                  width={barWidth}
                  height={Math.max(1, Math.abs(py(0) - pointY))}
                  rx="4"
                />
              )}
              {kind === 'trend' && value !== null && (
                <circle
                  className="chart-marker"
                  cx={px(index)}
                  cy={pointY}
                  r={active === index ? 5 : 3}
                />
              )}
              {value === null && (
                <circle className="chart-missing" cx={px(index)} cy={pointY} r="4" />
              )}
              {kind === 'comparison' ? (
                <rect
                  className="chart-hit"
                  x={px(index) - Math.max(16, barWidth / 2)}
                  y={Math.min(pointY, py(0)) - 8}
                  width={Math.max(32, barWidth)}
                  height={Math.max(24, Math.abs(py(0) - pointY) + 16)}
                />
              ) : (
                <circle className="chart-hit" cx={px(index)} cy={pointY} r="16" />
              )}
            </g>
          );
        })}
      </svg>
      {selected && active !== null && (
        <div
          id={`${id}-tooltip`}
          role="tooltip"
          className="chart-tooltip"
          style={{ left: `clamp(8px, ${(px(active) / width) * 100}% - 90px, calc(100% - 188px))` }}
        >
          <span className="chart-tooltip-label">{String(selected[x])}</span>
          <strong>{chartValue(selected[y], unit, locale)}</strong>
          <span className="chart-tooltip-field">{valueLabel ?? y}</span>
        </div>
      )}
      <p className="chart-hint">Hover or tap a point · Arrow keys to explore</p>
    </div>
  );
}

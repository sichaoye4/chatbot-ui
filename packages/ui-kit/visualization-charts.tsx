import { useEffect, useRef, useId, useState, type ReactNode } from 'react';
import type { Row } from '../contracts/index.ts';
import { geographyAssets } from '../contracts/geography.ts';
import {
  validateVisualizationData,
  visualizationRows,
  type VisualizationViewPanel,
  type VisualizationViewData,
} from '../contracts/visualization-validation.ts';
import { dateValue } from '../contracts/calendar.ts';

const colors = ['#586fd5', '#21838d', '#8c6598', '#a36c28', '#487b60', '#756e62'];
const fmt = (v: number) => Number(v.toPrecision(4)).toLocaleString('en-US');
const short = (v: unknown, max = 20) =>
  String(v).length > max ? `${String(v).slice(0, max - 1)}…` : String(v);
type Mark = { label: string; shape: ReactNode };
export function VisualizationChart({
  panel,
  data,
}: {
  panel: VisualizationViewPanel;
  data: VisualizationViewData;
}) {
  const [selected, setSelected] = useState(0);
  const uid = useId().replace(/:/g, '');
  const container = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(640);
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setAvailable(Math.floor(node.clientWidth) - 2));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  try {
    validateVisualizationData(panel, data);
  } catch {
    return (
      <p role="alert">This chart needs valid, complete data and trusted visualization semantics.</p>
    );
  }
  const rows = visualizationRows(panel, data),
    kind = panel.component,
    meta = data.visualization!;
  const marks: Mark[] = [],
    guides: ReactNode[] = [];
  let width = Math.max(360, available),
    height = 360;
  const n = (r: Row, k: string) => Number(r[k]);
  const label = (r: Row) =>
    Object.entries(r)
      .map(([k, v]) => `${k}: ${v === null ? 'Missing' : v}`)
      .join('; ');
  const add = (r: Row, shape: ReactNode, description = label(r)) =>
    marks.push({ label: description, shape });
  const text = (
    x: number,
    y: number,
    value: unknown,
    anchor: 'start' | 'middle' | 'end' = 'start',
  ) => (
    <text x={x} y={y} textAnchor={anchor}>
      {String(value)}
    </text>
  );
  const line = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    stroke = '#8491a6',
    dash?: string,
  ) => <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeDasharray={dash} />;
  const scale = (values: number[], start: number, end: number, zero = false) => {
    let low = Math.min(...values, zero ? 0 : Infinity),
      high = Math.max(...values, zero ? 0 : -Infinity);
    if (low === high) {
      if (!zero) low -= 1;
      high += 1;
    }
    return { at: (v: number) => start + ((v - low) / (high - low)) * (end - start), low, high };
  };
  const axis = (s: ReturnType<typeof scale>, vertical = false) => {
    for (let i = 0; i <= 4; i++) {
      const v = s.low + ((s.high - s.low) * i) / 4,
        p = s.at(v);
      guides.push(
        vertical ? (
          <g key={`y${i}`}>
            {line(80, p, width - 30, p, '#e5eaf4')}
            {text(70, p + 4, fmt(v), 'end')}
          </g>
        ) : (
          <g key={`x${i}`}>
            {line(p, 36, p, height - 45, '#e5eaf4')}
            {text(p, height - 20, fmt(v), 'middle')}
          </g>
        ),
      );
    }
  };
  const colorValue = (v: number | null) =>
    v === null
      ? '#e5eaf4'
      : `hsl(229 48% ${85 - (50 * (v - meta.domain![0])) / (meta.domain![1] - meta.domain![0])}%)`;
  if (kind === 'histogram') {
    const x = scale(
        rows.flatMap((r) => [n(r, 'binStart'), n(r, 'binEnd')]),
        80,
        width - 30,
      ),
      y = scale(
        rows.map((r) => n(r, 'count')),
        300,
        40,
        true,
      );
    axis(y, true);
    rows.forEach((r, i) =>
      add(
        r,
        <rect
          x={x.at(n(r, 'binStart'))}
          y={y.at(n(r, 'count'))}
          width={x.at(n(r, 'binEnd')) - x.at(n(r, 'binStart'))}
          height={300 - y.at(n(r, 'count'))}
          fill={colors[1]}
          stroke="white"
        />,
        `${label(r)}; ${i === rows.length - 1 ? 'upper boundary included' : 'upper boundary excluded'}`,
      ),
    );
    guides.push(
      text(80, 328, rows[0].binStart),
      text(width - 30, 328, rows.at(-1)!.binEnd, 'end'),
      text(80, 20, 'Count'),
    );
  } else if (['boxPlot', 'bullet', 'dumbbell', 'groupedBar', 'stackedBar'].includes(kind)) {
    const categories = [...new Set(rows.map((r) => String(r.category)))],
      series = [...new Set(rows.map((r) => String(r.series)))];
    const rowHeight = kind === 'groupedBar' ? Math.max(64, series.length * 23) : 58;
    height = Math.max(260, categories.length * rowHeight + 85);
    const keys =
      kind === 'boxPlot'
        ? ['lowWhisker', 'highWhisker']
        : kind === 'bullet'
          ? ['actual', 'target']
          : kind === 'dumbbell'
            ? ['before', 'after']
            : ['value'];
    const totals = categories.map((c) =>
      rows.filter((r) => r.category === c).reduce((s, r) => s + n(r, 'value'), 0),
    );
    const values =
      kind === 'stackedBar'
        ? panel.config.mode === 'percent'
          ? [100]
          : totals
        : rows.flatMap((r) => keys.map((k) => n(r, k)));
    const x = scale(values, 165, width - 30, true);
    axis(x);
    categories.forEach((c, ci) => {
      const cy = 55 + ci * rowHeight,
        group = rows.filter((r) => r.category === c);
      guides.push(text(150, cy + 5, short(c), 'end'));
      let offset = 0;
      group.forEach((r) => {
        const y = kind === 'groupedBar' ? cy + series.indexOf(String(r.series)) * 23 : cy;
        if (kind === 'boxPlot')
          add(
            r,
            <g>
              {line(x.at(n(r, 'lowWhisker')), y, x.at(n(r, 'highWhisker')), y)}
              {[n(r, 'lowWhisker'), n(r, 'highWhisker')].map((v, i) => (
                <g key={i}>{line(x.at(v), y - 10, x.at(v), y + 10)}</g>
              ))}
              <rect
                x={x.at(n(r, 'q1'))}
                y={y - 15}
                width={x.at(n(r, 'q3')) - x.at(n(r, 'q1'))}
                height={30}
                fill="#e5e8f8"
                stroke={colors[0]}
              />
              {line(x.at(n(r, 'median')), y - 15, x.at(n(r, 'median')), y + 15, colors[0])}
            </g>,
          );
        else if (kind === 'dumbbell')
          add(
            r,
            <g>
              {line(x.at(n(r, 'before')), y, x.at(n(r, 'after')), y)}
              <circle
                cx={x.at(n(r, 'before'))}
                cy={y}
                r={6}
                fill="white"
                stroke={colors[0]}
                strokeWidth={2}
              />
              <rect x={x.at(n(r, 'after')) - 5} y={y - 5} width={10} height={10} fill={colors[1]} />
              {text(width - 30, y - 12, `Δ ${fmt(n(r, 'after') - n(r, 'before'))}`, 'end')}
            </g>,
          );
        else if (kind === 'bullet')
          add(
            r,
            <g>
              <rect
                x={Math.min(x.at(0), x.at(n(r, 'actual')))}
                y={y - 8}
                width={Math.abs(x.at(n(r, 'actual')) - x.at(0))}
                height={16}
                fill={colors[1]}
              />
              {line(x.at(n(r, 'target')), y - 16, x.at(n(r, 'target')), y + 16, colors[0])}
              {text(
                width - 30,
                y - 20,
                `${fmt(n(r, 'actual'))} / target ${fmt(n(r, 'target'))}`,
                'end',
              )}
            </g>,
          );
        else {
          const value =
            kind === 'stackedBar' && panel.config.mode === 'percent'
              ? (n(r, 'value') / totals[ci]) * 100
              : n(r, 'value');
          const start = kind === 'stackedBar' ? offset : 0;
          offset += value;
          const si = series.indexOf(String(r.series));
          add(
            r,
            <g>
              <rect
                x={Math.min(x.at(start), x.at(start + value))}
                y={y - 8}
                width={Math.abs(x.at(start + value) - x.at(start))}
                height={18}
                fill={colors[si]}
                stroke="white"
              />
              {Math.abs(x.at(start + value) - x.at(start)) >= 22 && (
                <text
                  x={(x.at(start) + x.at(start + value)) / 2}
                  y={y + 5}
                  textAnchor="middle"
                  fill="white"
                >
                  {si + 1}
                </text>
              )}
            </g>,
            `${label(r)}${panel.config.mode === 'percent' ? `; share: ${fmt(value)}%` : ''}`,
          );
        }
      });
    });
    if (kind === 'groupedBar' || kind === 'stackedBar')
      guides.push(text(165, 18, series.map((s, i) => `${i + 1}: ${s}`).join(' · ')));
  } else if (kind === 'scatter') {
    const x = scale(
        rows.map((r) => n(r, 'x')),
        80,
        width - 30,
      ),
      y = scale(
        rows.map((r) => n(r, 'y')),
        300,
        40,
      );
    axis(x);
    axis(y, true);
    rows.forEach((r) =>
      add(
        r,
        <circle
          cx={x.at(n(r, 'x'))}
          cy={y.at(n(r, 'y'))}
          r={5}
          stroke={colors[0]}
          fill="white"
          strokeWidth={2}
        />,
      ),
    );
  } else if (kind === 'heatmap') {
    const rs = [...new Set(rows.map((r) => String(r.row)))],
      cs = [...new Set(rows.map((r) => String(r.column)))];
    width = Math.max(available, 160 + cs.length * 70);
    height = Math.max(280, 100 + rs.length * 42);
    rs.forEach((r, i) => guides.push(text(140, 67 + i * 42, short(r), 'end')));
    cs.forEach((c, i) => guides.push(text(185 + i * 70, 30, short(c, 9), 'middle')));
    rs.forEach((r, ri) =>
      cs.forEach((c, ci) => {
        const value = rows.find((x) => x.row === r && x.column === c);
        if (value)
          add(
            value,
            <g>
              <rect
                x={150 + ci * 70}
                y={42 + ri * 42}
                width={68}
                height={40}
                fill={colorValue(n(value, 'value'))}
              />
              <rect x={172 + ci * 70} y={53 + ri * 42} width={24} height={18} rx={2} fill="white" />
              {text(184 + ci * 70, 67 + ri * 42, fmt(n(value, 'value')), 'middle')}
            </g>,
          );
        else
          add(
            { row: r, column: c, value: null },
            <g key={`${ri}-${ci}`}>
              <rect
                x={150 + ci * 70}
                y={42 + ri * 42}
                width={68}
                height={40}
                fill={`url(#${uid})`}
              />
              {text(184 + ci * 70, 67 + ri * 42, '—', 'middle')}
            </g>,
          );
      }),
    );
  } else if (kind === 'waterfall') {
    width = Math.max(available, 640, rows.length * 85 + 100);
    let total = 0;
    const segments = rows.map((r) => {
      const start = r.kind === 'delta' ? total : 0;
      total = r.kind === 'delta' ? total + n(r, 'value') : n(r, 'value');
      return { start, end: total };
    });
    const y = scale(
      segments.flatMap((s) => [s.start, s.end]),
      290,
      40,
      true,
    );
    axis(y, true);
    rows.forEach((r, i) => {
      const s = segments[i],
        x = 85 + i * 85;
      add(
        r,
        <g>
          <rect
            x={x}
            y={Math.min(y.at(s.start), y.at(s.end))}
            width={60}
            height={Math.max(1, Math.abs(y.at(s.start) - y.at(s.end)))}
            fill={
              r.kind === 'delta' && n(r, 'value') < 0
                ? `url(#${uid})`
                : r.kind === 'delta'
                  ? colors[1]
                  : colors[0]
            }
            stroke={colors[0]}
          />
          {text(
            x + 30,
            Math.min(y.at(s.start), y.at(s.end)) - 8,
            `${n(r, 'value') > 0 && r.kind === 'delta' ? '+' : ''}${fmt(n(r, 'value'))}`,
            'middle',
          )}
        </g>,
      );
      guides.push(text(x + 30, 315, short(r.step, 10), 'middle'));
      if (i < rows.length - 1)
        guides.push(line(x + 60, y.at(s.end), x + 85, y.at(s.end), '#8491a6', '3 3'));
    });
  } else if (kind === 'intervalTrend') {
    const x = scale(
        rows.map((r) => dateValue(r.time)),
        80,
        width - 30,
      ),
      values = rows.flatMap((r) =>
        ['estimate', 'lower', 'upper'].filter((k) => r[k] !== null).map((k) => n(r, k)),
      ),
      y = scale(values.length ? values : [0, 1], 290, 40);
    axis(y, true);
    rows.forEach((r, i) => {
      if (i) {
        const prev = rows[i - 1];
        if ([r.lower, r.upper, prev.lower, prev.upper].every((v) => v !== null))
          guides.push(
            <path
              key={`band${i}`}
              d={`M${x.at(dateValue(prev.time))},${y.at(n(prev, 'lower'))} L${x.at(dateValue(r.time))},${y.at(n(r, 'lower'))} L${x.at(dateValue(r.time))},${y.at(n(r, 'upper'))} L${x.at(dateValue(prev.time))},${y.at(n(prev, 'upper'))}Z`}
              fill="#e5e8f8"
              stroke={colors[0]}
            />,
          );
        if (r.estimate !== null && prev.estimate !== null)
          guides.push(
            line(
              x.at(dateValue(prev.time)),
              y.at(n(prev, 'estimate')),
              x.at(dateValue(r.time)),
              y.at(n(r, 'estimate')),
              colors[0],
            ),
          );
      }
      if (r.estimate !== null)
        add(
          r,
          <circle
            cx={x.at(dateValue(r.time))}
            cy={y.at(n(r, 'estimate'))}
            r={5}
            fill={colors[0]}
          />,
        );
    });
    guides.push(text(80, 320, rows[0].time), text(width - 30, 320, rows.at(-1)!.time, 'end'));
  } else if (kind === 'timeline') {
    width = Math.max(available, 640);
    height = Math.max(280, rows.length * 48 + 90);
    const x = scale(
      rows.flatMap((r) => [dateValue(r.start), dateValue(r.end)]),
      180,
      width - 30,
    );
    rows.forEach((r, i) => {
      const y = 50 + i * 48,
        a = x.at(dateValue(r.start)),
        b = x.at(dateValue(r.end));
      guides.push(text(165, y + 5, short(r.entity), 'end'));
      add(
        r,
        a === b ? (
          <path d={`M${a},${y - 8} l8,8 l-8,8 l-8,-8Z`} fill={colors[0]} />
        ) : (
          <rect x={a} y={y - 8} width={b - a} height={16} fill={colors[1]} />
        ),
      );
    });
    guides.push(
      text(180, height - 20, new Date(x.low).toISOString().slice(0, 10)),
      text(width - 30, height - 20, new Date(x.high).toISOString().slice(0, 10), 'end'),
    );
  } else if (kind === 'treemap') {
    height = 400;
    const root = rows.find((r) => r.parentId === '')!;
    const draw = (
      r: Row,
      x: number,
      y: number,
      w: number,
      h: number,
      depth: number,
      path: string,
    ) => {
      const children = rows.filter((c) => c.parentId === r.nodeId);
      if (!children.length) {
        if (n(r, 'value') > 0)
          add(
            r,
            <g>
              <rect
                x={x}
                y={y}
                width={w}
                height={h}
                fill={colors[depth % colors.length]}
                stroke="white"
              />
              {w > 85 && h > 32 && (
                <text x={x + 8} y={y + 20} fill="white">
                  {short(r.label, Math.floor(w / 8) - 2)}
                </text>
              )}
            </g>,
            `${path} / ${r.label}; value: ${r.value}`,
          );
        return;
      }
      let offset = 0;
      children.forEach((c) => {
        const fraction = n(c, 'value') / n(r, 'value');
        draw(
          c,
          depth % 2 ? x : x + offset,
          depth % 2 ? y + offset : y,
          depth % 2 ? w : w * fraction,
          depth % 2 ? h * fraction : h,
          depth + 1,
          `${path} / ${r.label}`,
        );
        offset += (depth % 2 ? h : w) * fraction;
      });
    };
    draw(root, 20, 20, width - 40, 350, 0, '');
  } else if (kind === 'sankey') {
    height = 560;
    const nodes = new Map<
      string,
      {
        stage: number;
        in: number;
        out: number;
        x: number;
        y: number;
        h: number;
        usedIn: number;
        usedOut: number;
      }
    >();
    rows.forEach((r) => {
      for (const side of ['source', 'target']) {
        const id = String(r[`${side}Id`]);
        if (!nodes.has(id))
          nodes.set(id, {
            stage: n(r, `${side}Stage`),
            in: 0,
            out: 0,
            x: 0,
            y: 0,
            h: 0,
            usedIn: 0,
            usedOut: 0,
          });
      }
      nodes.get(String(r.sourceId))!.out += n(r, 'value');
      nodes.get(String(r.targetId))!.in += n(r, 'value');
    });
    const stages = [...new Set([...nodes.values()].map((n) => n.stage))].sort((a, b) => a - b);
    width = Math.max(available, 640, stages.length * 200);
    const factor = Math.min(
      ...stages.map((s) => {
        const ns = [...nodes.values()].filter((n) => n.stage === s);
        return (
          (440 - (ns.length - 1) * 24) /
          (ns.reduce((sum, n) => sum + Math.max(n.in, n.out), 0) || 1)
        );
      }),
    );
    stages.forEach((s, si) => {
      let y = 45;
      for (const [id, node] of nodes)
        if (node.stage === s) {
          node.x = 70 + (si * (width - 140)) / (stages.length - 1);
          node.y = y;
          node.h = Math.max(node.in, node.out) * factor;
          y += node.h + 24;
          guides.push(
            <g key={id}>
              <rect
                x={node.x - 6}
                y={node.y}
                width={12}
                height={Math.max(1, node.h)}
                fill={colors[0]}
              />
              {text(node.x, node.y - 8, short(id, 16), 'middle')}
            </g>,
          );
        }
    });
    rows.forEach((r) => {
      const a = nodes.get(String(r.sourceId))!,
        b = nodes.get(String(r.targetId))!,
        h = n(r, 'value') * factor,
        ay = a.y + a.usedOut,
        by = b.y + b.usedIn,
        mid = (a.x + b.x) / 2;
      a.usedOut += h;
      b.usedIn += h;
      add(
        r,
        <path
          d={`M${a.x + 6},${ay} C${mid},${ay} ${mid},${by} ${b.x - 6},${by} L${b.x - 6},${by + h} C${mid},${by + h} ${mid},${ay + h} ${a.x + 6},${ay + h}Z`}
          fill={colors[1]}
          opacity={0.65}
        />,
      );
    });
  } else if (kind === 'choropleth') {
    width = Math.max(available, 640);
    height = 400;
    const asset = geographyAssets[meta.geography!];
    Object.entries(asset.regions).forEach(([id, path]) => {
      const r = rows.find((r) => r.regionId === id);
      add(
        r ?? { regionId: id, value: null },
        <path
          d={path}
          fill={!r || r.value === null ? `url(#${uid})` : colorValue(n(r, 'value'))}
          stroke="white"
          strokeWidth={2}
        />,
      );
    });
    guides.push(text(80, 380, asset.label));
  }
  const units = Object.values(panel.config.fields)
    .map((field) => data.fields.find((f) => f.name === field))
    .filter((f) => f?.type === 'number')
    .map((f) => `${f!.name}: ${f!.unit ?? 'unit unspecified'}`);
  return (
    <div ref={container} className={`visualization-chart visualization-${kind}`}>
      <p className="viz-summary">
        {rows.length} {kind === 'histogram' ? 'bins' : 'source rows'} · {meta.grain}. {meta.note}
      </p>
      <p className="viz-units">{units.join(' · ')}</p>
      <div
        className="viz-scroll"
        role="region"
        aria-label={`${panel.title}: scrollable chart`}
        tabIndex={0}
      >
        <svg width={width} height={height} aria-label={panel.title} role="group">
          <defs>
            <pattern id={uid} width="6" height="6" patternUnits="userSpaceOnUse">
              <rect width="6" height="6" fill="#edf0f5" />
              <path d="M0,6 L6,0" stroke="#63728c" />
            </pattern>
          </defs>
          {guides.map((g, i) => (
            <g key={i}>{g}</g>
          ))}
          {marks.map((mark, i) => (
            <g
              key={i}
              role="button"
              aria-label={mark.label}
              aria-pressed={selected === i}
              tabIndex={selected === i ? 0 : -1}
              className="viz-mark"
              onClick={() => setSelected(i)}
              onFocus={() => setSelected(i)}
              onKeyDown={(e) => {
                let next = i;
                const stride = kind === 'heatmap' ? new Set(rows.map((r) => r.column)).size : 1;
                if (e.key === 'ArrowRight') next = i + 1;
                else if (e.key === 'ArrowLeft') next = i - 1;
                else if (e.key === 'ArrowDown') next = i + stride;
                else if (e.key === 'ArrowUp') next = i - stride;
                else if (e.key === 'Home') next = 0;
                else if (e.key === 'End') next = marks.length - 1;
                else if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelected(i);
                  return;
                } else return;
                e.preventDefault();
                next = Math.max(0, Math.min(marks.length - 1, next));
                const elements =
                  e.currentTarget.parentElement?.querySelectorAll<SVGGElement>('.viz-mark');
                elements?.[next]?.focus();
              }}
            >
              <title>{mark.label}</title>
              {mark.shape}
            </g>
          ))}
        </svg>
      </div>
      {meta.domain && (
        <p>
          Color scale: {fmt(meta.domain[0])} (light) to {fmt(meta.domain[1])} (dark). Hatched
          regions / — cells: missing.
        </p>
      )}
      <p className="project-inspector" aria-live="polite">
        {marks[selected]?.label ?? 'No drawable observations. View the source values below.'}
      </p>
      <p className="viz-method">
        {[
          meta.method,
          meta.interval,
          meta.calendar,
          meta.targetSource && `Target: ${meta.targetSource}; ${meta.direction} is better`,
          meta.beforeLabel && `○ ${meta.beforeLabel} → ■ ${meta.afterLabel}`,
          meta.rateDefinition,
          meta.included !== undefined && `Included: ${meta.included}`,
          meta.missing !== undefined && `Missing: ${meta.missing}`,
          meta.outside !== undefined && `Outside range: ${meta.outside}`,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
    </div>
  );
}

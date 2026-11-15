import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { dateValue } from '../contracts/calendar.ts';
import {
  flowModel,
  ganttModel,
  projectSeries,
  validateProjectData,
  type ProjectViewPanel as ProjectPanel,
  type ProjectViewData as ProjectData,
} from '../contracts/project-validation.ts';

const day = 86400000;
const progressLabel = (value: number | null) =>
  value === null ? 'Progress not supplied' : `${Math.round(value * 100)}% complete`;
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const colors = ['#586fd5', '#238793', '#8b62a8', '#b37326', '#526c8c', '#8b6173'];
function moveFocus(event: KeyboardEvent<SVGGElement>) {
  const nodes = [
    ...event.currentTarget.ownerSVGElement!.querySelectorAll<SVGGElement>('[data-inspect]'),
  ];
  const i = nodes.indexOf(event.currentTarget);
  const next =
    event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? Math.min(nodes.length - 1, i + 1)
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? Math.max(0, i - 1)
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? nodes.length - 1
            : null;
  if (next !== null) {
    event.preventDefault();
    nodes[next]?.focus();
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    event.currentTarget.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
}
function lines(text: string) {
  return text.match(/.{1,22}(?:\s|$)|.{1,22}/g)?.slice(0, 3) ?? [text];
}

export function ProjectChart({ panel, data }: { panel: ProjectPanel; data: ProjectData }) {
  try {
    validateProjectData(panel, data);
  } catch (error) {
    return <p role="alert">Unable to draw this chart: {(error as Error).message}</p>;
  }
  if (!data.rows.length) return <p role="status">No project observations match this scope.</p>;
  if (panel.component === 'gantt') return <Gantt panel={panel} data={data} />;
  if (panel.component === 'flowchart') return <Flowchart panel={panel} data={data} />;
  return <WorkChart panel={panel} data={data} />;
}

function Gantt({
  panel,
  data,
}: {
  panel: Extract<ProjectPanel, { component: 'gantt' }>;
  data: ProjectData;
}) {
  const tasks = ganttModel(data.rows, panel.config);
  const [selected, select] = useState<string | null>(null);
  const marker = useId();
  const min = Math.min(...tasks.map((t) => t.start)),
    max = Math.max(...tasks.map((t) => t.end), min + day);
  const x = (time: number) => 216 + ((time - min) / (max - min)) * 620;
  const y = (i: number) => 70 + i * 60;
  const height = tasks.length * 60 + 110;
  const picked = tasks.find((t) => t.id === selected);
  const conflicts = tasks.filter((t) =>
    t.dependencies.some((id) => tasks.find((d) => d.id === id)!.end > t.start),
  );
  return (
    <div className="project-chart gantt-chart">
      <p className="chart-summary">
        Calendar dates · Finish-to-start dependencies · Filled bars show completion; diamonds are
        milestones.
      </p>
      {!!conflicts.length && (
        <p role="status">
          Schedule conflict: {conflicts.map((t) => t.name).join(', ')} starts before a predecessor
          finishes.
        </p>
      )}
      <div
        className="project-scroll"
        role="region"
        aria-label="Scrollable project schedule"
        tabIndex={0}
      >
        <svg
          width="900"
          height={height}
          role="group"
          aria-label={`${panel.title}. Arrow keys inspect tasks.`}
        >
          <defs>
            <marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0 0 L8 4 L0 8" fill="#63728c" />
            </marker>
          </defs>
          <g className="project-axis" aria-hidden="true">
            {Array.from({ length: 5 }, (_, i) => {
              const time = min + ((max - min) * i) / 4;
              return (
                <g key={i}>
                  <line x1={x(time)} x2={x(time)} y1={44} y2={height - 30} />
                  <text x={x(time)} y="26" textAnchor="middle">
                    {date(time)}
                  </text>
                </g>
              );
            })}
          </g>
          <g aria-hidden="true">
            {tasks.flatMap((t, i) =>
              t.dependencies.map((id) => {
                const j = tasks.findIndex((d) => d.id === id),
                  a = x(tasks[j].end),
                  b = x(t.start);
                return (
                  <path
                    key={`${id}-${t.id}`}
                    className="dependency-edge"
                    markerEnd={`url(#${marker})`}
                    d={`M${a},${y(j)} H${a + 12} V${y(i) - 20} H${b - 12} V${y(i)} H${b - 3}`}
                  />
                );
              }),
            )}
          </g>
          {tasks.map((t, i) => (
            <g
              key={t.id}
              data-inspect="task"
              role="button"
              tabIndex={selected === t.id || (!selected && i === 0) ? 0 : -1}
              aria-label={`${t.name}: ${date(t.start)} to ${date(t.end)}, ${progressLabel(t.progress)}${t.kind === 'milestone' ? ', milestone' : ''}`}
              aria-pressed={selected === t.id}
              onFocus={() => select(t.id)}
              onClick={() => select(t.id)}
              onKeyDown={moveFocus}
              className={`project-mark ${selected === t.id ? 'selected' : ''}`}
            >
              <rect className="project-hit" x="0" y={y(i) - 25} width="890" height="50" rx="4" />
              <text className="project-task-label" x="8" y={y(i) - 4}>
                {t.name.length > 25 ? t.name.slice(0, 23) + '…' : t.name}
              </text>
              <text className="project-small" x="8" y={y(i) + 14}>
                {progressLabel(t.progress)} · {t.kind}
              </text>
              {t.kind === 'milestone' ? (
                <path d={`M${x(t.start)},${y(i) - 9} l9 9 -9 9 -9 -9 Z`} fill="var(--chart-line)" />
              ) : (
                <>
                  <rect
                    x={x(t.start)}
                    y={y(i) - 10}
                    width={Math.max(3, x(t.end) - x(t.start))}
                    height="20"
                    rx="4"
                    fill="#e7ecf8"
                    stroke="#586fd5"
                  />
                  <rect
                    x={x(t.start)}
                    y={y(i) - 10}
                    width={Math.max(0, x(t.end) - x(t.start)) * (t.progress ?? 0)}
                    height="20"
                    rx="4"
                    fill="var(--chart-bar)"
                  />
                </>
              )}
            </g>
          ))}
        </svg>
      </div>
      <div className="project-inspector" aria-live="polite">
        {picked ? (
          <>
            <strong>{picked.name}</strong>
            <span>
              {date(picked.start)} → {date(picked.end)} · {progressLabel(picked.progress)}
            </span>
            <span>
              Predecessors:{' '}
              {picked.dependencies.map((id) => tasks.find((t) => t.id === id)!.name).join(', ') ||
                'None'}
            </span>
          </>
        ) : (
          <span>Select a task to inspect its schedule and dependencies.</span>
        )}
      </div>
    </div>
  );
}

function Flowchart({
  panel,
  data,
}: {
  panel: Extract<ProjectPanel, { component: 'flowchart' }>;
  data: ProjectData;
}) {
  const model = flowModel(data.rows, panel.config);
  const viewport = useRef<HTMLDivElement>(null);
  const [direction, setDirection] = useState(panel.config.direction),
    [zoom, setZoom] = useState(1),
    [selected, select] = useState<string | null>(null);
  const marker = useId();
  const feedbackCount = model.edges.filter((e) => e.feedback).length;
  const margin = 70 + feedbackCount * 14;
  const nodes = model.nodes.map((n) => ({
    ...n,
    x: direction === 'LR' ? margin + n.rank * 250 : margin + n.slot * 250,
    y: direction === 'LR' ? margin + n.slot * 150 : margin + n.rank * 170,
  }));
  const width = Math.max(600, ...nodes.map((n) => n.x + 240)),
    height = Math.max(300, ...nodes.map((n) => n.y + 150));
  const selectedNode = nodes.find((n) => n.id === selected);
  const nearby = new Set(
    model.edges
      .filter((e) => e.source === selected || e.target === selected)
      .flatMap((e) => [e.source, e.target]),
  );
  return (
    <div className="project-chart flowchart">
      <div className="project-toolbar" role="group" aria-label="Flowchart view controls">
        <label>
          Direction{' '}
          <select value={direction} onChange={(e) => setDirection(e.target.value as 'LR' | 'TB')}>
            <option value="LR">Left to right</option>
            <option value="TB">Top to bottom</option>
          </select>
        </label>
        <button
          onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
          disabled={zoom <= 0.5}
          aria-label="Zoom out flowchart"
        >
          −
        </button>
        <output aria-label="Flowchart zoom">{Math.round(zoom * 100)}%</output>
        <button
          onClick={() => setZoom((z) => Math.min(2, z + 0.25))}
          disabled={zoom >= 2}
          aria-label="Zoom in flowchart"
        >
          +
        </button>
        <button
          onClick={() => setZoom(Math.min(1, (viewport.current?.clientWidth ?? width) / width))}
        >
          Fit width
        </button>
        <button
          onClick={() => {
            setZoom(1);
            select(null);
          }}
        >
          Reset view
        </button>
      </div>
      <p className="chart-summary">
        Select a step to highlight its connections. Diamonds are decisions; dashed arrows return to
        an earlier step. Scroll to explore.
      </p>
      <div
        ref={viewport}
        className="project-scroll"
        role="region"
        aria-label="Scrollable flowchart"
        tabIndex={0}
      >
        <svg
          width={width * zoom}
          height={height * zoom}
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          aria-label={`${panel.title}. Arrow keys inspect nodes.`}
        >
          <defs>
            <marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0 0 L8 4 L0 8" fill="#63728c" />
            </marker>
          </defs>
          {model.edges.map((e, i) => {
            const a = nodes.find((n) => n.id === e.source)!,
              b = nodes.find((n) => n.id === e.target)!;
            const lr = direction === 'LR';
            let d: string, tx: number, ty: number;
            if (e.feedback) {
              const rail =
                margin - 30 - model.edges.slice(0, i).filter((e) => e.feedback).length * 14;
              d = lr
                ? `M${a.x + 80},${a.y} V${rail} H${b.x + 80} V${b.y - 3}`
                : `M${a.x},${a.y + 40} H${rail} V${b.y + 40} H${b.x - 3}`;
              if (e.source === e.target)
                d = lr
                  ? `M${a.x + 160},${a.y + 40} H${a.x + 190} V${rail} H${a.x + 80} V${a.y - 3}`
                  : `M${a.x + 80},${a.y + 80} V${a.y + 110} H${rail} V${a.y + 40} H${a.x - 3}`;
              tx = lr ? (a.x + b.x) / 2 + 80 : rail - 8;
              ty = lr ? rail - 6 : (a.y + b.y) / 2 + 40;
            } else {
              const ax = lr ? a.x + 160 : a.x + 80,
                ay = lr ? a.y + 40 : a.y + 80,
                bx = lr ? b.x : b.x + 80,
                by = lr ? b.y + 40 : b.y;
              const mid = lr ? (ax + bx) / 2 : (ay + by) / 2;
              d = lr
                ? `M${ax},${ay} H${mid} V${by} H${bx - 3}`
                : `M${ax},${ay} V${mid} H${bx} V${by - 3}`;
              tx = lr ? mid : (ax + bx) / 2;
              ty = lr ? (ay + by) / 2 - 8 : mid - 8;
            }
            return (
              <g
                key={e.id}
                className={
                  selected && e.source !== selected && e.target !== selected ? 'flow-muted' : ''
                }
              >
                <path
                  className={`dependency-edge ${e.feedback ? 'feedback' : ''}`}
                  d={d}
                  markerEnd={`url(#${marker})`}
                />
                <text className="flow-edge-label" textAnchor="middle" x={tx} y={ty}>
                  {e.label.length > 18 ? e.label.slice(0, 16) + '…' : e.label}
                  <title>{e.label}</title>
                </text>
              </g>
            );
          })}
          {nodes.map((n, i) => (
            <g
              key={n.id}
              transform={`translate(${n.x},${n.y})`}
              role="button"
              data-inspect="node"
              tabIndex={selected === n.id || (!selected && i === 0) ? 0 : -1}
              aria-label={`${n.label}, ${n.kind}`}
              aria-pressed={selected === n.id}
              onClick={() => select(n.id)}
              onFocus={() => select(n.id)}
              onKeyDown={moveFocus}
              className={`flow-node project-mark ${selected === n.id ? 'selected' : ''} ${selected && selected !== n.id && !nearby.has(n.id) ? 'flow-muted' : ''}`}
            >
              {n.kind === 'decision' ? (
                <polygon points="80,0 160,40 80,80 0,40" />
              ) : (
                <rect
                  width="160"
                  height="80"
                  rx={n.kind === 'start' || n.kind === 'end' ? 40 : 8}
                />
              )}
              <text textAnchor="middle" x="80" y={40 - (lines(n.label).length - 1) * 8}>
                {lines(n.label).map((s, j) => (
                  <tspan key={j} x="80" dy={j ? 16 : 0}>
                    {s.trim()}
                  </tspan>
                ))}
              </text>
              <title>{n.label}</title>
            </g>
          ))}
        </svg>
      </div>
      <div className="project-inspector" aria-live="polite">
        {selectedNode ? (
          <>
            <strong>
              {selectedNode.label} · {selectedNode.kind}
            </strong>
            <span>
              Incoming:{' '}
              {model.edges
                .filter((e) => e.target === selected)
                .map(
                  (e) =>
                    `${nodes.find((n) => n.id === e.source)!.label}${e.label ? ` (${e.label})` : ''}`,
                )
                .join('; ') || 'None'}
            </span>
            <span>
              Outgoing:{' '}
              {model.edges
                .filter((e) => e.source === selected)
                .map(
                  (e) =>
                    `${nodes.find((n) => n.id === e.target)!.label}${e.label ? ` (${e.label})` : ''}`,
                )
                .join('; ') || 'None'}
            </span>
          </>
        ) : (
          <span>
            {nodes.length} steps · {model.edges.length} connections. Select a step to inspect its
            full label and branches.
          </span>
        )}
      </div>
    </div>
  );
}

function WorkChart({
  panel,
  data,
}: {
  panel: Extract<ProjectPanel, { component: 'burndown' | 'cumulativeFlow' }>;
  data: ProjectData;
}) {
  const { fields, points } = projectSeries(data.rows, panel.config);
  const container = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(660);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setChartWidth(Math.max(360, entry.contentRect.width - 2)),
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const [selected, select] = useState<number | null>(null);
  const stacked = panel.component === 'cumulativeFlow';
  const max = Math.max(
    1,
    ...points.map((p) =>
      stacked
        ? p.values.reduce<number>((a, v) => a + (v ?? 0), 0)
        : Math.max(0, ...p.values.map((v) => v ?? 0)),
    ),
  );
  const first = points[0].time,
    last = points.at(-1)!.time;
  const x = (time: number) =>
      64 + ((time - first) / Math.max(day, last - first)) * (chartWidth - 100),
    y = (v: number) => 260 - (v / max) * 210;
  const names = stacked
    ? fields
    : panel.config.mode === 'burnup'
      ? ['Completed', 'Total scope']
      : ['Remaining', 'Ideal remaining'];
  const unit = data.fields.find((f) => f.name === fields[0])?.unit ?? 'units';
  const sums = points.map((p) =>
    p.values.map((_, i) => p.values.slice(0, i + 1).reduce<number>((a, v) => a + (v ?? 0), 0)),
  );
  const line = (index: number) => {
    let d = '',
      gap = true;
    points.forEach((p) => {
      const value = p.values[index];
      if (value === null) {
        gap = true;
        return;
      }
      d += `${gap ? 'M' : 'L'}${x(p.time)},${y(value)} `;
      gap = false;
    });
    return d;
  };
  return (
    <div
      ref={container}
      className={`project-chart ${stacked ? 'cumulative-flow-chart' : 'burndown-chart'}`}
    >
      <p className="chart-summary">
        {stacked
          ? 'Workflow state counts at each date; band thickness shows work in that state.'
          : 'Actual observations and supplied reference; missing observations remain gaps.'}{' '}
        · {unit}
      </p>
      <div className="project-legend">
        {names.map((name, i) => (
          <span key={name}>
            <i style={{ background: colors[i] }} />
            {name}
            {!stacked && i === 1 ? ' (dashed)' : ''}
          </span>
        ))}
      </div>
      <div className="project-scroll" role="region" aria-label="Scrollable work chart" tabIndex={0}>
        <svg
          width={chartWidth}
          height="310"
          role="group"
          aria-label={`${panel.title}. Arrow keys inspect dates.`}
        >
          <g className="project-axis" aria-hidden="true">
            {Array.from({ length: 5 }, (_, i) => (i * max) / 4).map((v) => (
              <g key={v}>
                <line x1="64" x2={chartWidth - 36} y1={y(v)} y2={y(v)} />
                <text x="52" y={y(v) + 4} textAnchor="end">
                  {+v.toFixed(1)}
                </text>
              </g>
            ))}
            {[...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].map((i) => (
              <text key={i} x={x(points[i].time)} y="290" textAnchor="middle">
                {date(points[i].time)}
              </text>
            ))}
          </g>
          {fields.map((f, i) =>
            stacked ? (
              <path
                key={f}
                d={`${points.map((p, j) => `${j ? 'L' : 'M'}${x(p.time)},${y(sums[j][i])}`).join(' ')} ${[
                  ...points,
                ]
                  .reverse()
                  .map((p, k) => `L${x(p.time)},${y(i ? sums[points.length - 1 - k][i - 1] : 0)}`)
                  .join(' ')} Z`}
                fill={colors[i]}
                fillOpacity="0.65"
                stroke={colors[i]}
              />
            ) : (
              <path
                key={f}
                d={line(i)}
                fill="none"
                stroke={colors[i]}
                strokeWidth="2.5"
                strokeDasharray={i ? '6 4' : undefined}
              />
            ),
          )}
          {points.map((p, i) => (
            <g
              key={p.time}
              role="button"
              data-inspect="observation"
              tabIndex={selected === i || (selected === null && i === 0) ? 0 : -1}
              aria-label={`${date(p.time)}: ${names.map((n, j) => `${n} ${p.values[j] ?? 'Missing'} ${unit}`).join(', ')}`}
              onFocus={() => select(i)}
              onClick={() => select(i)}
              onKeyDown={moveFocus}
              className="project-mark"
            >
              <rect className="project-hit" x={x(p.time) - 10} y="40" width="20" height="225" />
              {!stacked &&
                p.values.map((v, j) =>
                  v === null ? null : (
                    <circle key={j} cx={x(p.time)} cy={y(v)} r="3" fill={colors[j]} />
                  ),
                )}
              {selected === i && (
                <line
                  x1={x(p.time)}
                  x2={x(p.time)}
                  y1="40"
                  y2="260"
                  stroke="#35465f"
                  strokeDasharray="3 4"
                />
              )}
            </g>
          ))}
        </svg>
      </div>
      <div className="project-inspector" aria-live="polite">
        {selected === null ? (
          <span>Select a date to inspect exact values.</span>
        ) : (
          <>
            <strong>{date(points[selected].time)}</strong>
            {names.map((n, j) => (
              <span key={n}>
                {n}: {points[selected].values[j] ?? 'Missing'} {unit}
              </span>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

import { useId, useState } from 'react';
import type { Dataset } from '../contracts/index.ts';
import { pieModel, percent } from './pie-model.ts';

const colors = [
  '#586fd5',
  '#299da9',
  '#9a6bc2',
  '#d99b32',
  '#da7082',
  '#667e9d',
  '#618d4b',
  '#a36b42',
  '#9c4b73',
  '#548796',
  '#9a8a3e',
  '#7c73a3',
];
export function PieChart({
  data,
  category,
  value,
  title,
}: {
  data: Dataset;
  category: string;
  value: string;
  title: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const id = useId();
  const model = pieModel(data.rows, category, value, data.truncated);
  if (!model.ok) return <p role="status">{model.reason}</p>;
  let angle = -Math.PI / 2;
  const slices = model.slices.map((slice) => {
    const start = angle;
    angle += slice.share * Math.PI * 2;
    const point = (a: number) => `${150 + 112 * Math.cos(a)},${150 + 112 * Math.sin(a)}`;
    return {
      ...slice,
      path: `M150,150 L${point(start)} A112,112 0 ${slice.share > 0.5 ? 1 : 0},1 ${point(angle)} Z`,
    };
  });
  const selected = active === null ? undefined : slices[active];
  return (
    <div
      className="pie-chart"
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
      <div className="pie-plot">
        <svg viewBox="0 0 300 300" role="group" aria-label={title}>
          {slices.map((slice, index) =>
            slice.value === 0 ? null : (
              <g
                key={slice.label}
                role="button"
                tabIndex={0}
                className={`pie-slice ${active === index ? 'is-active' : ''}`}
                aria-label={`${slice.label}: ${percent(slice.share)} (${slice.value.toLocaleString('en-US')})`}
                aria-describedby={active === index ? `${id}-tooltip` : undefined}
                onPointerEnter={() => setActive(index)}
                onFocus={() => setActive(index)}
                onClick={() => setActive(index)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setActive(index);
                  }
                }}
              >
                {slice.share === 1 ? (
                  <circle cx="150" cy="150" r="112" fill={colors[index]} />
                ) : (
                  <path d={slice.path} fill={colors[index]} />
                )}
              </g>
            ),
          )}
        </svg>
        {selected && (
          <div id={`${id}-tooltip`} role="tooltip" className="chart-tooltip pie-tooltip">
            <span>{selected.label}</span>
            <strong>{percent(selected.share)}</strong>
            <span>
              {selected.value.toLocaleString('en-US')} / {model.total.toLocaleString('en-US')}
            </span>
          </div>
        )}
      </div>
      <ul className="pie-legend" aria-label="Category percentages">
        {slices.map((slice, index) => (
          <li key={slice.label}>
            <button
              onPointerEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onClick={() => setActive(index)}
              aria-describedby={active === index ? `${id}-tooltip` : undefined}
            >
              <span
                className="pie-swatch"
                style={{ background: colors[index] }}
                aria-hidden="true"
              />
              <span>{slice.label}</span>
              <strong>{percent(slice.share)}</strong>
              <span>{slice.value.toLocaleString('en-US')}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="chart-hint">
        Total: {model.total.toLocaleString('en-US')} · Percentages are shares of this total,
        rounded.
      </p>
    </div>
  );
}

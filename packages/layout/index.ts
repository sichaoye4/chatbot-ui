import type { Panel } from '../contracts/index.ts';
import { components } from '../catalog/index.ts';
export function layout(panels: Panel[], width: number) {
  if (panels.length < 1 || panels.length > 6) throw new Error('Panel count must be 1–6');
  return panels.map((p) => {
    const cap = components[p.component];
    let span = 12;
    if (
      width >= 768 &&
      p.component !== 'table' &&
      p.component !== 'relationship' &&
      p.component !== 'gantt' &&
      ![
        'flowchart',
        'heatmap',
        'waterfall',
        'timeline',
        'treemap',
        'sankey',
        'choropleth',
      ].includes(p.component) &&
      (width - 24) / 2 >= cap.minWidth
    )
      span = 6;
    if (width >= 1200 && p.component === 'metric' && (width - 48) / 3 >= cap.minWidth) span = 4;
    if (panels.length === 1) span = 12;
    return { id: p.id, span, minHeight: cap.minHeight };
  });
}

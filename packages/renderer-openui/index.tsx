import { createContext, useContext, useState, useMemo, Component, type ReactNode } from 'react';
import { createLibrary, defineComponent, Renderer } from '@openuidev/react-lang';
import { z } from 'zod';
import type { Panel, Dataset, Action, Row } from '../contracts/index.ts';
import { PanelBody } from '../ui-kit/panels.tsx';
type Bound = {
  readOnly?: boolean;
  panel: Panel;
  data: Dataset;
  onAction: (a: Action) => void;
  onRecord: (r: Row) => void;
};
const Context = createContext<Bound | null>(null);
function BoundPanel() {
  const bound = useContext(Context);
  if (!bound) throw new Error('Missing dataset context');
  return <PanelBody {...bound} />;
}
const names = {
  histogram: 'CorporateHistogram',
  boxPlot: 'CorporateBoxPlot',
  scatter: 'CorporateScatter',
  heatmap: 'CorporateHeatmap',
  bullet: 'CorporateBullet',
  groupedBar: 'CorporateGroupedBar',
  stackedBar: 'CorporateStackedBar',
  dumbbell: 'CorporateDumbbell',
  waterfall: 'CorporateWaterfall',
  intervalTrend: 'CorporateIntervalTrend',
  timeline: 'CorporateTimeline',
  treemap: 'CorporateTreemap',
  sankey: 'CorporateSankey',
  choropleth: 'CorporateChoropleth',
  gantt: 'CorporateGantt',
  flowchart: 'CorporateFlowchart',
  burndown: 'CorporateBurndown',
  cumulativeFlow: 'CorporateCumulativeFlow',
  metric: 'CorporateMetric',
  trend: 'CorporateTrend',
  comparison: 'CorporateComparison',
  pie: 'CorporatePie',
  table: 'CorporateTable',
  relationship: 'CorporateRelationship',
};
const registered = Object.values(names).map((name) =>
  defineComponent({
    name,
    description: 'Approved data-bound corporate panel',
    props: z.object({ panelId: z.string(), title: z.string() }),
    component: () => <BoundPanel />,
  }),
);
const library = createLibrary({ root: 'CorporateTrend', components: registered });
export function compilePanel(panel: Panel) {
  return `root = ${names[panel.component]}(${JSON.stringify(panel.id)}, ${JSON.stringify(panel.title)});`;
}
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p role="alert">This panel could not render.</p>
    ) : (
      this.props.children
    );
  }
}
export function OpenUIPanel(props: Bound) {
  const [error, setError] = useState(false);
  const program = useMemo(() => compilePanel(props.panel), [props.panel]);
  return (
    <Boundary>
      <Context.Provider value={props}>
        <Renderer
          response={program}
          library={library}
          isStreaming={false}
          toolProvider={null}
          onError={(errors) => setError(errors.some((e) => e.severity !== 'warning'))}
        />
        {error && <p role="alert">This panel could not render.</p>}
      </Context.Provider>
    </Boundary>
  );
}

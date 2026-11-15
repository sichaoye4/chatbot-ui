import type { Panel } from './index.ts';
export { dateValue } from './calendar.ts';
export { ganttModel, flowModel, projectSeries, validateProjectData } from './project-validation.ts';
export type ProjectPanel = Extract<
  Panel,
  { component: 'gantt' | 'flowchart' | 'burndown' | 'cumulativeFlow' }
>;
export function isProjectPanel(panel: Panel): panel is ProjectPanel {
  return ['gantt', 'flowchart', 'burndown', 'cumulativeFlow'].includes(panel.component);
}

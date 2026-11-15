import type { Panel } from './index.ts';
import { visualizationDefinitions, type VisualizationKind } from './visualization.ts';
export {
  validateVisualizationFields,
  validateVisualizationData,
  visualizationRows,
} from './visualization-validation.ts';
export type VisualizationPanel = Extract<Panel, { component: VisualizationKind }>;
export function isVisualizationPanel(panel: Panel): panel is VisualizationPanel {
  return panel.component in visualizationDefinitions;
}

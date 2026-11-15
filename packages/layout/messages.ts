import type { Artifact } from '../contracts/index.ts';

/** Message grouping is presentation only: every group retains the same artifact identity. */
export function responseMessages(artifact: Pick<Artifact, 'plan' | 'datasets'>) {
  if (artifact.plan.messages) return artifact.plan.messages;
  const groups: { id: string; panelIds: string[] }[] = [];
  let compact: string[] = [];
  const flush = () => {
    if (compact.length) groups.push({ id: compact[0], panelIds: compact });
    compact = [];
  };
  for (const panel of artifact.plan.panels) {
    const data = artifact.datasets[panel.bindingId];
    const dense =
      ['gantt', 'flowchart', 'relationship', 'sankey', 'treemap', 'heatmap', 'timeline'].includes(
        panel.component,
      ) &&
      data?.status === 'ready' &&
      data.data.rows.length > 20;
    if (dense) {
      flush();
      groups.push({ id: panel.id, panelIds: [panel.id] });
    } else compact.push(panel.id);
  }
  flush();
  return groups;
}

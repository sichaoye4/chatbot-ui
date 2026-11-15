import { FoundationCatalog } from '../../packages/catalog/foundation.ts';
import { registerBuiltins } from '../../packages/catalog/builtins.ts';
import {
  visualizationDefinitions,
  type VisualizationKind,
} from '../../packages/contracts/visualization.ts';
import type { ResponsePlan } from '../../packages/contracts/foundation.ts';
import { syntheticVisualizationDomain } from '../../examples/data-visualization/foundation.ts';
import { visualizationPlan } from '../../examples/data-visualization/index.ts';
import { permissivePolicy, principal } from './foundation-domains.ts';

export function visualizationCatalog() {
  const catalog = registerBuiltins(new FoundationCatalog(permissivePolicy));
  catalog.registerDomain(syntheticVisualizationDomain());
  return catalog;
}
export function visualizationCandidate(
  catalog: FoundationCatalog,
  kind: VisualizationKind,
): ResponsePlan {
  const legacy = visualizationPlan([kind]).panels[0];
  return {
    schemaVersion: 2,
    capabilitySnapshotId: catalog.snapshot(principal).id,
    bindings: [
      { id: 'data', tool: { id: `synthetic.${kind}`, version: 1 }, args: {}, fixedArgs: {} },
    ],
    facts: [],
    blocks: [
      {
        id: 'visual',
        kind: 'visual',
        layoutIntent: 'auto',
        controls: [],
        elements: [
          {
            id: 'chart',
            component: { id: `ui.${kind}`, version: 1 },
            title: legacy.title,
            roles: Object.fromEntries(
              Object.keys(visualizationDefinitions[kind].roles).map((role) => [
                role,
                [{ bindingId: 'data', fieldId: role }],
              ]),
            ),
            props: kind === 'stackedBar' ? { mode: 'absolute' } : {},
          },
        ],
      },
    ],
  };
}

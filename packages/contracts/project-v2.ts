import { z } from 'zod';
import type { DataResult, Element, FieldDefinition } from './foundation.ts';
import {
  validateProjectData,
  type ProjectViewData,
  type ProjectViewPanel,
} from './project-validation.ts';

/** Translate versioned semantic roles to the same validation model used by the existing charts. */
export function projectV2Model(element: Element, result: DataResult, fields: FieldDefinition[]) {
  if (element.component.version !== 1 || !element.component.id.startsWith('ui.'))
    throw new Error('Unsupported project chart');
  const refs = Object.values(element.roles).flat();
  if (new Set(refs.map((ref) => ref.bindingId)).size !== 1)
    throw new Error('Expected one data source');
  const role = (name: string) => {
    const values = element.roles[name];
    if (!values || values.length !== 1) throw new Error('Missing field role');
    return values[0].fieldId;
  };
  const kind = element.component.id.slice(3);
  let panel: ProjectViewPanel;
  if (kind === 'gantt')
    panel = {
      component: 'gantt',
      title: element.title,
      config: {
        taskIdField: role('taskId'),
        labelField: role('label'),
        startField: role('start'),
        endField: role('end'),
        progressField: role('progress'),
        dependenciesField: role('dependencies'),
        kindField: role('kind'),
      },
    };
  else if (kind === 'flowchart')
    panel = {
      component: 'flowchart',
      title: element.title,
      config: {
        idField: role('id'),
        labelField: role('label'),
        kindField: role('kind'),
        sourceField: role('source'),
        targetField: role('target'),
        direction: z.enum(['LR', 'TB']).parse(element.props.direction),
      },
    };
  else if (kind === 'burndown')
    panel = {
      component: 'burndown',
      title: element.title,
      config: {
        timeField: role('time'),
        actualField: role('actual'),
        referenceField: role('reference'),
        mode: z.enum(['burndown', 'burnup']).parse(element.props.mode),
      },
    };
  else if (kind === 'cumulativeFlow') {
    const stages = element.roles.stages?.map((ref) => ref.fieldId) ?? [];
    if (stages.length < 2 || stages.length > 6 || new Set(stages).size !== stages.length)
      throw new Error('Distinct stages required');
    panel = {
      component: 'cumulativeFlow',
      title: element.title,
      config: { timeField: role('time'), stageFields: stages },
    };
  } else throw new Error('Unsupported project chart');
  const data: ProjectViewData = {
    rows: result.rows,
    fields: fields.map((field) => ({
      name: field.id,
      type: field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'string',
      nullable: field.nullable,
      unit: field.unit,
    })),
    truncated: result.provenance.truncated || result.provenance.nextCursor !== null,
  };
  validateProjectData(panel, data);
  return { panel, data };
}

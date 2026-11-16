import { Component, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import type { Element, FieldDefinition, DataResult } from '../contracts/foundation.ts';
import {
  MaterializedResponse,
  type BindingDescriptor,
  type MaterializedResponse as Response,
} from '../contracts/protocol.ts';
import { ControlView, type ControlHandlers } from './controls.tsx';

export type SelectRecordEvent = {
  bindingId: string;
  identifierField: string;
  id: string | number;
  row: DataResult['rows'][number];
};
export type ElementViewProps = {
  element: Element;
  fields: FieldDefinition[];
  data: DataResult;
  locale?: string;
  timezone?: string;
  numberFormat?: Intl.NumberFormatOptions;
  bindingId?: string;
  descriptor?: BindingDescriptor;
  bindingArgs?: Record<string, unknown>;
  canGoPrevious?: boolean;
  previousCursor?: string | null;
  controlsDisabled?: boolean;
  operations?: { id: string; version: number }[];
  onAction?: (action: { id: string; version: number }, payload: Record<string, unknown>) => void;
  onSelectRecord?: (record: SelectRecordEvent) => void;
};
export type ClientRegistry = Readonly<Record<string, ComponentType<ElementViewProps>>>;
export type Presentation = {
  locale?: string;
  timezone?: string;
  numberFormat?: Intl.NumberFormatOptions;
  unavailable?: string;
  valuesLabel?: string;
  provenance?: {
    sourceLabel?: string;
    asOfLabel?: string;
    grainLabel?: string;
    truncatedLabel?: string;
  };
  onSelectRecord?: (record: SelectRecordEvent) => void;
};

export function formatCellValue(
  value: string | number | boolean | null | undefined,
  field: FieldDefinition | undefined,
  presentation: Pick<Presentation, 'locale' | 'timezone' | 'numberFormat'>,
): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number' && (presentation.locale || presentation.numberFormat)) {
    const opts: Intl.NumberFormatOptions =
      field?.unit === 'ratio'
        ? { style: 'percent', maximumFractionDigits: 2, ...presentation.numberFormat }
        : {
            maximumFractionDigits: field?.measure?.precision ?? 4,
            ...presentation.numberFormat,
          };
    return new Intl.NumberFormat(presentation.locale, opts).format(value);
  }
  if (
    typeof value === 'string' &&
    field?.type === 'datetime' &&
    (presentation.timezone || presentation.locale)
  ) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return new Intl.DateTimeFormat(presentation.locale, {
        ...(presentation.timezone ? { timeZone: presentation.timezone } : {}),
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(parsed));
    }
  }
  return String(value);
}

class ElementBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p role="alert">
        This visualization could not be displayed. Exact values are available below.
      </p>
    ) : (
      this.props.children
    );
  }
}

function ExpandedDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} aria-label={`Expanded ${title}`} onClose={onClose}>
      <button type="button" onClick={() => ref.current?.close()}>
        Close
      </button>
      {children}
    </dialog>
  );
}

function Values({
  bindingId,
  fields,
  data,
  label,
  presentation,
}: {
  bindingId?: string;
  fields: FieldDefinition[];
  data: DataResult;
  label: string;
  presentation: Presentation;
}) {
  const idField = fields.find((field) => field.role === 'identifier');
  return (
    <details>
      <summary>{label}</summary>
      <table>
        <thead>
          <tr>
            {fields.map((field) => (
              <th key={field.id} scope="col">
                {field.label}
                {field.unit ? ` (${field.unit})` : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, index) => {
            const rawId = idField ? row[idField.id] : undefined;
            const selectable =
              bindingId &&
              idField &&
              presentation.onSelectRecord &&
              (typeof rawId === 'string' || typeof rawId === 'number');
            return (
              <tr key={index}>
                {fields.map((field) => (
                  <td key={field.id}>
                    {selectable && field.id === idField.id ? (
                      <button
                        type="button"
                        className="foundation-link-btn"
                        aria-label={`Select ${field.label} ${rawId}`}
                        onClick={() =>
                          presentation.onSelectRecord!({
                            bindingId,
                            identifierField: idField.id,
                            id: rawId,
                            row,
                          })
                        }
                      >
                        {formatCellValue(row[field.id], field, presentation)}
                      </button>
                    ) : (
                      formatCellValue(row[field.id], field, presentation)
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="foundation-note">
        {presentation.provenance?.sourceLabel ?? 'Source'}: {data.provenance.sourceId} (
        {data.provenance.sourceVersion}) · {presentation.provenance?.grainLabel ?? 'Grain'}:{' '}
        {data.provenance.grain}
        {data.provenance.sourceAsOf
          ? ` · ${presentation.provenance?.asOfLabel ?? 'As of'}: ${data.provenance.sourceAsOf}`
          : ''}
      </p>
      {data.provenance.truncated && (
        <p>{presentation.provenance?.truncatedLabel ?? 'Results are truncated.'}</p>
      )}
    </details>
  );
}

/** Host-installed versioned views only; no transport or server dependency. */
export function ResponseRenderer({
  response: raw,
  registry,
  presentation = {},
  onChoice,
  controls,
  controlsDisabled = false,
  onRetry,
  onAction,
}: {
  response: Response;
  registry: ClientRegistry;
  presentation?: Presentation;
  onChoice?: (blockId: string, choiceId: string) => void;
  controls?: ControlHandlers;
  controlsDisabled?: boolean;
  onRetry?: (bindingId: string) => void;
  onAction?: (action: { id: string; version: number }, payload: Record<string, unknown>) => void;
}) {
  const response = MaterializedResponse.parse(raw);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [cursorTrails, setCursorTrails] = useState<Record<string, (string | null)[]>>({});
  useEffect(() => {
    setCursorTrails({});
  }, [response.responseId, response.revision]);
  useEffect(() => {
    setCursorTrails((prev) => {
      let changed = false;
      const next: Record<string, (string | null)[]> = {};
      for (const [bid, trail] of Object.entries(prev)) {
        const desc = response.bindingDescriptors.find((d) => d.bindingId === bid);
        const planBinding = response.plan.bindings.find((b) => b.id === bid);
        const cArg = desc?.capabilities?.pagination?.cursorArg;
        const activeCursor =
          cArg && typeof planBinding?.args[cArg] === 'string'
            ? String(planBinding.args[cArg])
            : null;
        if (activeCursor === null) {
          changed = true;
        } else {
          next[bid] = trail;
        }
      }
      return changed ? next : prev;
    });
  }, [response.bindingDescriptors, response.plan.bindings]);
  const dispatchElementAction = (
    action: { id: string; version: number },
    payload: Record<string, unknown>,
  ) => {
    if (!onAction) return;
    if (action.id === 'ui.paginate' && typeof payload.bindingId === 'string') {
      const bid = payload.bindingId;
      const bDescriptor = response.bindingDescriptors.find((d) => d.bindingId === bid);
      const bPlan = response.plan.bindings.find((b) => b.id === bid);
      const cArg = bDescriptor?.capabilities?.pagination?.cursorArg;
      const currentVal =
        cArg && typeof bPlan?.args[cArg] === 'string' ? String(bPlan.args[cArg]) : null;
      const target = payload.cursor ?? null;
      setCursorTrails((prev) => {
        const trail = prev[bid] ?? [];
        if (trail.length > 0 && trail[trail.length - 1] === target) {
          const rest = trail.slice(0, -1);
          if (rest.length) return { ...prev, [bid]: rest };
          const copy = { ...prev };
          delete copy[bid];
          return copy;
        }
        return { ...prev, [bid]: [...trail, currentVal] };
      });
    }
    onAction(action, payload);
  };
  const renderFact = (factId: string, key: number) => {
    const fact = response.facts[factId];
    if (!fact) return <span key={key}>Unavailable</span>;
    const descriptor = response.bindingDescriptors.find(
      (item) => item.bindingId === fact.field.bindingId,
    );
    const state = response.datasets[fact.field.bindingId];
    const row = state?.status === 'ready' ? state.result.rows[fact.row] : undefined;
    const context =
      descriptor?.fields.filter(
        (field) =>
          field.id !== fact.field.fieldId &&
          ['time', 'dimension', 'identifier', 'source', 'target'].includes(field.role) &&
          row?.[field.id] !== undefined,
      ) ?? [];
    return (
      <span key={key}>
        {fact.value}
        {context.length > 0 && (
          <span>
            {' '}
            (
            {context
              .map(
                (field) =>
                  `${field.label}: ${row![field.id] === null ? 'Unavailable' : String(row![field.id])}`,
              )
              .join(', ')}
            )
          </span>
        )}
      </span>
    );
  };
  const renderElement = (element: Element) => {
    const bindingIds = new Set(
      Object.values(element.roles)
        .flat()
        .map((role) => role.bindingId),
    );
    const bindingId = bindingIds.size === 1 ? [...bindingIds][0] : undefined;
    const descriptor = response.bindingDescriptors.find((d) => d.bindingId === bindingId);
    const binding = response.plan.bindings.find((b) => b.id === bindingId);
    const state = bindingId ? response.datasets[bindingId] : undefined;
    const View = registry[`${element.component.id}@${element.component.version}`];
    const cursorArg = descriptor?.capabilities?.pagination?.cursorArg;
    const currentCursor =
      cursorArg && typeof binding?.args[cursorArg] === 'string'
        ? String(binding.args[cursorArg])
        : null;
    const trail = bindingId ? (cursorTrails[bindingId] ?? []) : [];
    const canGoPrevious = trail.length > 0 || currentCursor !== null;
    const previousCursor = trail.length > 0 ? trail[trail.length - 1] : null;
    const canRefresh = Boolean(
      bindingId &&
      descriptor?.capabilities?.refreshable &&
      onAction &&
      response.operations.some(
        (operation) => operation.id === 'ui.refresh' && operation.version === 1,
      ),
    );
    const elementAction = onAction ? dispatchElementAction : undefined;
    return (
      <section key={element.id} aria-label={element.title} data-component={element.component.id}>
        <h3>{element.title}</h3>
        {bindingIds.size !== 1 ? (
          <p role="status">This visualization needs a supported single data source.</p>
        ) : !state || state.status === 'pending' ? (
          <p>Loading…</p>
        ) : state.status === 'failed' ? (
          <div>
            <p role="alert">{state.diagnostic.message}</p>
            {bindingId &&
              state.diagnostic.retryable &&
              onRetry &&
              response.operations.some(
                (operation) => operation.id === 'ui.retryBinding' && operation.version === 1,
              ) && (
                <button
                  type="button"
                  disabled={controlsDisabled}
                  onClick={() => onRetry(bindingId)}
                >
                  Retry data source
                </button>
              )}
          </div>
        ) : descriptor ? (
          <>
            {View ? (
              <ElementBoundary
                key={`${response.responseId}-${response.revision}-${response.generation}-${element.id}`}
              >
                <View
                  element={element}
                  fields={descriptor.fields}
                  data={state.result}
                  locale={presentation.locale}
                  timezone={presentation.timezone}
                  numberFormat={presentation.numberFormat}
                  bindingId={bindingId}
                  descriptor={descriptor}
                  bindingArgs={binding?.args}
                  canGoPrevious={canGoPrevious}
                  previousCursor={previousCursor}
                  controlsDisabled={controlsDisabled}
                  operations={response.operations}
                  onAction={elementAction}
                  onSelectRecord={presentation.onSelectRecord}
                />
              </ElementBoundary>
            ) : (
              <p>{presentation.unavailable ?? 'This visualization is unavailable.'}</p>
            )}
            {state.result.provenance.truncated && (
              <p role="status">
                {presentation.provenance?.truncatedLabel ?? 'Results are truncated.'}
              </p>
            )}
            <Values
              bindingId={bindingId}
              fields={descriptor.fields}
              data={state.result}
              label={presentation.valuesLabel ?? 'View exact values'}
              presentation={presentation}
            />
          </>
        ) : (
          <p>Data is unavailable.</p>
        )}
        {state?.status === 'ready' && (
          <div className="foundation-element-actions">
            {canRefresh && (
              <button
                type="button"
                disabled={controlsDisabled}
                onClick={() => onAction?.({ id: 'ui.refresh', version: 1 }, { bindingId })}
              >
                Refresh data
              </button>
            )}
            <button type="button" onClick={() => setExpanded(element.id)}>
              Expand
            </button>
          </div>
        )}
        {expanded === element.id && state?.status === 'ready' && descriptor && (
          <ExpandedDialog title={element.title} onClose={() => setExpanded(null)}>
            {View && (
              <ElementBoundary>
                <View
                  element={element}
                  fields={descriptor.fields}
                  data={state.result}
                  locale={presentation.locale}
                  timezone={presentation.timezone}
                  numberFormat={presentation.numberFormat}
                  bindingId={bindingId}
                  descriptor={descriptor}
                  bindingArgs={binding?.args}
                  canGoPrevious={canGoPrevious}
                  previousCursor={previousCursor}
                  controlsDisabled={controlsDisabled}
                  operations={response.operations}
                  onAction={elementAction}
                  onSelectRecord={presentation.onSelectRecord}
                />
              </ElementBoundary>
            )}
            <Values
              bindingId={bindingId}
              fields={descriptor.fields}
              data={state.result}
              label={presentation.valuesLabel ?? 'View exact values'}
              presentation={presentation}
            />
          </ExpandedDialog>
        )}
      </section>
    );
  };
  return (
    <div className="foundation-response">
      {response.generation > 0 && (
        <p className="foundation-note" role="status">
          The data reflects the current controls. Written explanations may refer to the initial
          view.
        </p>
      )}
      {response.plan.blocks.map((block) =>
        block.kind === 'text' ? (
          <p key={block.id}>
            {block.parts.map((part, index) =>
              'text' in part ? part.text : renderFact(part.factId, index),
            )}
          </p>
        ) : block.kind === 'clarification' ? (
          <section key={block.id}>
            <p>{block.question}</p>
            {block.choices.map((choice) => (
              <button
                key={choice.id}
                type="button"
                disabled={!onChoice}
                onClick={() => onChoice?.(block.id, choice.id)}
              >
                {choice.label}
              </button>
            ))}
          </section>
        ) : (
          <div key={block.id}>
            {block.controls.map((control) => (
              <ControlView
                key={`${response.responseId}-${response.revision}-${response.generation}-${control.id}`}
                control={control}
                handlers={
                  response.operations.some(
                    (operation) => operation.id === 'ui.setControl' && operation.version === 1,
                  )
                    ? controls
                    : undefined
                }
                disabled={controlsDisabled}
              />
            ))}
            <div className="foundation-visual-group">{block.elements.map(renderElement)}</div>
            {[
              ...new Set(
                block.elements.flatMap((element) =>
                  Object.values(element.roles)
                    .flat()
                    .flatMap((ref) => {
                      const state = response.datasets[ref.bindingId];
                      return state?.status === 'ready' ? state.result.provenance.warnings : [];
                    }),
                ),
              ),
            ].map((warning) => (
              <p className="foundation-note" key={warning}>
                {warning}
              </p>
            ))}
          </div>
        ),
      )}
    </div>
  );
}

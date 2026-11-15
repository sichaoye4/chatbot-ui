import { Component, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import type { Element, FieldDefinition, DataResult } from '../contracts/foundation.ts';
import {
  MaterializedResponse,
  type MaterializedResponse as Response,
} from '../contracts/protocol.ts';
import { ControlView, type ControlHandlers } from './controls.tsx';

export type ElementViewProps = {
  element: Element;
  fields: FieldDefinition[];
  data: DataResult;
  locale?: string;
};
export type ClientRegistry = Readonly<Record<string, ComponentType<ElementViewProps>>>;
export type Presentation = { locale?: string; unavailable?: string; valuesLabel?: string };

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
  fields,
  data,
  label,
}: {
  fields: FieldDefinition[];
  data: DataResult;
  label: string;
}) {
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
          {data.rows.map((row, index) => (
            <tr key={index}>
              {fields.map((field) => (
                <td key={field.id}>{row[field.id] === null ? '—' : String(row[field.id])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.provenance.truncated && <p>Results are truncated.</p>}
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
}: {
  response: Response;
  registry: ClientRegistry;
  presentation?: Presentation;
  onChoice?: (blockId: string, choiceId: string) => void;
  controls?: ControlHandlers;
  controlsDisabled?: boolean;
  onRetry?: (bindingId: string) => void;
}) {
  const response = MaterializedResponse.parse(raw);
  const [expanded, setExpanded] = useState<string | null>(null);
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
    const state = bindingId ? response.datasets[bindingId] : undefined;
    const View = registry[`${element.component.id}@${element.component.version}`];
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
                />
              </ElementBoundary>
            ) : (
              <p>{presentation.unavailable ?? 'This visualization is unavailable.'}</p>
            )}
            {state.result.provenance.truncated && <p role="status">Results are truncated.</p>}
            <Values
              fields={descriptor.fields}
              data={state.result}
              label={presentation.valuesLabel ?? 'View exact values'}
            />
          </>
        ) : (
          <p>Data is unavailable.</p>
        )}
        {state?.status === 'ready' && (
          <button type="button" onClick={() => setExpanded(element.id)}>
            Expand
          </button>
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
                />
              </ElementBoundary>
            )}
            <Values
              fields={descriptor.fields}
              data={state.result}
              label={presentation.valuesLabel ?? 'View exact values'}
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

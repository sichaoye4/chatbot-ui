import { useEffect, useRef, useState } from 'react';
import type { Control } from '../contracts/foundation.ts';
import { OptionPage, type OptionPage as Options } from '../contracts/protocol.ts';

type Value = Control['initialValue'];
export type ControlHandlers = {
  onChange(controlId: string, value: Value): void;
  resolveOptions?(
    controlId: string,
    search: string | undefined,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<Options>;
};

/** Options are host-provided and scoped to the committed generation. */
export function ControlView({
  control,
  handlers,
  disabled,
}: {
  control: Control;
  handlers?: ControlHandlers;
  disabled: boolean;
}) {
  const [options, setOptions] = useState<Options>({ options: [], nextCursor: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Value>(control.initialValue);
  const resolver = useRef(handlers?.resolveOptions);
  const pending = useRef<AbortController | null>(null);
  resolver.current = handlers?.resolveOptions;
  const isSelect =
    control.control.version === 1 && ['ui.select', 'ui.multiSelect'].includes(control.control.id);
  const isDate = control.control.version === 1 && control.control.id === 'ui.dateRange';
  const canEdit =
    !disabled &&
    !!handlers &&
    control.scopeMode === 'within-answer' &&
    (isDate || (isSelect && !!handlers.resolveOptions));
  const load = async (cursor?: string) => {
    if (!resolver.current) return;
    pending.current?.abort();
    const abort = new AbortController();
    pending.current = abort;
    setLoading(true);
    setError(undefined);
    try {
      const page = OptionPage.parse(
        await resolver.current(control.id, query || undefined, cursor, abort.signal),
      );
      if (!abort.signal.aborted)
        setOptions((old) =>
          cursor
            ? {
                options: [
                  ...old.options,
                  ...page.options.filter(
                    (item) => !old.options.some((prior) => prior.value === item.value),
                  ),
                ],
                nextCursor: page.nextCursor,
              }
            : page,
        );
    } catch {
      if (!abort.signal.aborted) setError('Options could not be loaded.');
    } finally {
      if (!abort.signal.aborted) setLoading(false);
    }
  };
  useEffect(() => {
    setDraft(control.initialValue);
    setOptions({ options: [], nextCursor: null });
    setError(undefined);
    if (canEdit && isSelect) void load();
    return () => {
      pending.current?.abort();
    };
    // Parent keys this view by response generation and control ID; callbacks are held in a ref.
  }, [control.id, query, canEdit, isSelect]);
  if (!isSelect && !isDate)
    return <p role="status">{control.label}: this control is unavailable.</p>;
  if (!canEdit) return <p role="status">{control.label}: this control is read-only.</p>;
  const selected =
    control.initialValue === null
      ? []
      : Array.isArray(control.initialValue)
        ? control.initialValue.map(String)
        : [String(control.initialValue)];
  if (Array.isArray(draft))
    for (const value of draft) if (!selected.includes(String(value))) selected.push(String(value));
  const choices = [
    ...options.options,
    ...selected
      .filter((value) => !options.options.some((item) => item.value === value))
      .map((value) => ({ value, label: `${value} (current)` })),
  ];
  return (
    <fieldset disabled={disabled || loading}>
      <legend>{control.label}</legend>
      <p>{control.purpose}</p>
      {loading && <p role="status">Loading options…</p>}
      {isSelect && (
        <>
          <label>
            Search options{' '}
            <input value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <button type="button" onClick={() => setQuery(search)}>
            Search
          </button>
          {control.control.id === 'ui.select' ? (
            <label>
              {control.label}
              <select
                value={
                  control.initialValue === null ? 'all' : `value:${String(control.initialValue)}`
                }
                onChange={(event) =>
                  handlers?.onChange(
                    control.id,
                    event.target.value === 'all' ? null : event.target.value.slice(6),
                  )
                }
              >
                <option value="all">All permitted values</option>
                {choices.map((option) => (
                  <option key={option.value} value={`value:${option.value}`}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label>
                {control.label}
                <select
                  multiple
                  value={Array.isArray(draft) ? draft.map((value) => String(value)) : []}
                  onChange={(event) =>
                    setDraft([...event.currentTarget.selectedOptions].map((option) => option.value))
                  }
                >
                  {choices.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={!Array.isArray(draft) || !draft.length}
                onClick={() => handlers?.onChange(control.id, draft)}
              >
                Apply selection
              </button>
              <button type="button" onClick={() => handlers?.onChange(control.id, null)}>
                All permitted values
              </button>
            </>
          )}
          {options.nextCursor && (
            <button type="button" onClick={() => void load(options.nextCursor ?? undefined)}>
              More options
            </button>
          )}
        </>
      )}
      {isDate && Array.isArray(draft) && (
        <>
          <label>
            Start{' '}
            <input
              type="date"
              value={String(draft[0] ?? '')}
              onChange={(event) => setDraft([event.target.value, draft[1]])}
            />
          </label>
          <label>
            End{' '}
            <input
              type="date"
              value={String(draft[1] ?? '')}
              onChange={(event) => setDraft([draft[0], event.target.value])}
            />
          </label>
          <button
            type="button"
            disabled={!draft[0] || !draft[1] || String(draft[0]) > String(draft[1])}
            onClick={() => handlers?.onChange(control.id, draft)}
          >
            Apply dates
          </button>
        </>
      )}
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </p>
      )}
    </fieldset>
  );
}

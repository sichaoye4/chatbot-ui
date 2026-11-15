import { useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function ExpandablePanel({ title, children }: { title: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  return (
    <>
      <div className="panel-heading">
        <h3>{title}</h3>
        <button
          ref={trigger}
          aria-label={`Expand ${title}`}
          aria-haspopup="dialog"
          onClick={() => {
            setExpanded(true);
            dialog.current?.showModal();
          }}
        >
          Expand ↗
        </button>
      </div>
      {createPortal(
        <dialog
          ref={dialog}
          className="component-modal"
          aria-labelledby={titleId}
          onClose={() => {
            setExpanded(false);
            trigger.current?.focus();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) dialog.current?.close();
          }}
        >
          <header className="panel-heading">
            <h2 id={titleId}>{title}</h2>
            <button autoFocus onClick={() => dialog.current?.close()}>
              Close expanded view
            </button>
          </header>
          {expanded && <div className="expanded-panel-content">{children}</div>}
        </dialog>,
        document.body,
      )}
      {!expanded && children}
    </>
  );
}

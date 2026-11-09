import { useId, type ReactNode } from 'react';
import { useDialog } from '../../ui/useDialog';
import { PAGE_COPY as COPY } from './pageCopy';

/**
 * The importer's dialogs: edit a robot's details, and the confirms (delete, discard, replace-or-keep-both). One
 * shell, `.ds-modal` + `useDialog` (focus in, Tab trapped, Escape = cancel, focus handed back),
 * `.ds-dialog-title`, actions last with the primary rightmost (`docs/ui-standard.md` §6). A
 * destructive confirm names its target and its effect.
 */
export function Shell({
  title,
  onClose,
  children,
  actions,
}: {
  title: string;
  onClose: () => void;
  children?: ReactNode;
  actions: ReactNode;
}) {
  const ref = useDialog(onClose);
  const id = useId();
  return (
    <div className="ds-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={ref}
        className="ds-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ds-modal-h">
          <h2 className="ds-dialog-title" id={id}>
            {title}
          </h2>
        </div>
        {children ? <div className="ds-form">{children}</div> : null}
        <div className="ds-dialog-actions">{actions}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirm,
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirm: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Shell
      title={title}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="ds-btn ghost" data-padnav-back onClick={onClose}>
            {COPY.cancel}
          </button>
          <button type="button" className={`ds-btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>
            {confirm}
          </button>
        </>
      }
    >
      {body}
    </Shell>
  );
}

/** an import of a robot already in the library: replace it, or keep both under a new id */
export function DuplicateDialog({
  name,
  onReplace,
  onKeepBoth,
  onClose,
}: {
  name: string;
  onReplace: () => void;
  onKeepBoth: () => void;
  onClose: () => void;
}) {
  return (
    <Shell
      title={COPY.dupTitle(name)}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="ds-btn ghost" data-padnav-back onClick={onClose}>
            {COPY.cancel}
          </button>
          <button type="button" className="ds-btn" onClick={onKeepBoth}>
            {COPY.keepBoth}
          </button>
          <button type="button" className="ds-btn primary" onClick={onReplace}>
            {COPY.replaceIt}
          </button>
        </>
      }
    >
      <p className="ds-hint">{COPY.dupBody}</p>
    </Shell>
  );
}

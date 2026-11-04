import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useDialog } from '../../ui/useDialog';
import { PAGE_COPY as COPY } from './pageCopy';
import { ROBOT_NAME_MAX, TEAM_NAME_MAX, TEAM_NUMBER_MAX, cleanIdentity, teamNumberFrom, type RobotIdentity } from '../identity';

/**
 * The importer's dialogs: edit a robot's details, and the confirms (delete, discard, replace-or-keep-both). One
 * shell, `.ds-modal` + `useDialog` (focus in, Tab trapped, Escape = cancel, focus handed back),
 * `.ds-dialog-title`, actions last with the primary rightmost (`docs/ui-standard.md` §6). A
 * destructive confirm names its target and its effect.
 */
function Shell({
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

/**
 * WHO A ROBOT IS, edited from its card: the name, the team name and the team number, with the
 * limits and the cleaning every other door into a spec has (`identity.ts`). One dialog for an
 * imported robot (the device library) and a saved one (the settings), so the two lists edit the
 * same way. Save is off while the name is empty or nothing has changed.
 */
export function IdentityDialog({
  identity,
  onSave,
  onClose,
}: {
  identity: RobotIdentity;
  onSave: (next: RobotIdentity) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(identity.name);
  const [teamName, setTeamName] = useState(identity.teamName);
  const [teamNumber, setTeamNumber] = useState(identity.teamNumber ? String(identity.teamNumber) : '');
  const next = cleanIdentity({ name, teamName, teamNumber: teamNumberFrom(teamNumber) });
  const changed =
    !!next && (next.name !== identity.name || next.teamName !== identity.teamName || next.teamNumber !== identity.teamNumber);
  const submit = (): void => {
    if (next && changed) onSave(next as RobotIdentity);
  };
  const onEnter = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') submit();
  };
  return (
    <Shell
      title={COPY.editTitle}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="ds-btn ghost" data-padnav-back onClick={onClose}>
            {COPY.cancel}
          </button>
          <button type="button" className="ds-btn primary" disabled={!changed} onClick={submit}>
            {COPY.save}
          </button>
        </>
      }
    >
      <label>
        {COPY.robotName}
        <input
          className="ds-input"
          type="text"
          maxLength={ROBOT_NAME_MAX}
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onEnter}
        />
      </label>
      <label>
        {COPY.teamNameLabel}
        <input
          className="ds-input"
          type="text"
          maxLength={TEAM_NAME_MAX}
          value={teamName}
          onChange={(e) => setTeamName(e.target.value)}
          onKeyDown={onEnter}
        />
      </label>
      <label>
        {COPY.teamNumberLabel}
        <input
          className="ds-input"
          type="number"
          min={0}
          max={TEAM_NUMBER_MAX}
          value={teamNumber}
          onChange={(e) => setTeamNumber(e.target.value === '' ? '' : String(teamNumberFrom(e.target.value)))}
          onKeyDown={onEnter}
        />
      </label>
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

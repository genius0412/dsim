import { Suspense, lazy, useEffect, useState, type DragEvent } from 'react';
import type { GameSettings } from '../../game';
import type { RobotSpec } from '../../types';
import type { LibraryEntry } from '../types';
import { RobotCard } from '../../ui/RobotCard';
import { teamLine } from '../../ui/robotLabels';
import { standardRobotFor } from '../../settings';
import { PAGE_COPY as COPY, FORMAT_LABEL } from './pageCopy';
import { FootprintSvg } from '../../ui/FootprintSvg';
import { polyBounds as bbox } from '../../sim/imported';
import { invalidateImportedAssets } from '../../render/importedAssets';
import { libraryChanged, onRobotNotice, peekRobotNotice, postRobotNotice, takeRobotNotice } from './handoff';
import type { LibraryView } from './useLibrary';
import { libraryEntryFor } from '../libraryIds';

/**
 * CONFIGURE ▸ ROBOT'S HALF OF THE IMPORTER, in the main chunk: the Imported robots row (one card
 * per library robot and the add card), the Imported robot panel that stands in for Build while an
 * import is active, and the library actions both of them trigger (rename, duplicate, export,
 * delete). Everything heavier — the editor, the engine, three.js — is behind the editor's route.
 *
 * The DIALOGS and the EXPORT are not in the main chunk either: they load on the click that needs
 * them (a sub-1 KB chunk the editor shares), so the robot page pays only for what it draws.
 */

const RenameDialog = lazy(() => import('./LibraryDialogs').then((m) => ({ default: m.RenameDialog })));
const ConfirmDialog = lazy(() => import('./LibraryDialogs').then((m) => ({ default: m.ConfirmDialog })));

/** how long a "Saved Ironclad." notice holds the Start from title (Controls' NOTICE_MS) */
const NOTICE_MS = 4000;

/** the notice the importer posted, shown once for NOTICE_MS */
export function useRobotNotice(): string | null {
  // PEEK while rendering, TAKE in the effect: a render may run twice (StrictMode), an effect
  // commits once, so the notice is not consumed by a render that is thrown away
  const [text, setText] = useState<string | null>(() => peekRobotNotice());
  useEffect(() => {
    takeRobotNotice();
    return onRobotNotice(() => setText(takeRobotNotice()));
  }, []);
  useEffect(() => {
    if (!text) return;
    const t = window.setTimeout(() => setText(null), NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [text]);
  return text;
}

const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files');

export function ImportedRow({
  view,
  activeId,
  onPick,
  onDelete,
  onImport,
  onDropFiles,
}: {
  view: LibraryView;
  activeId: string | null;
  onPick: (e: LibraryEntry) => void;
  onDelete: (e: LibraryEntry) => void;
  onImport: () => void;
  onDropFiles: (files: File[]) => void;
}) {
  const [over, setOver] = useState(false);
  const entries = view.entries ?? [];
  const draft = view.draft;
  const draftFile = typeof draft?.sourceName === 'string' ? draft.sourceName : null;
  return (
    <div className="ds-field">
      <span className="cap">{COPY.rowCap}</span>
      <div className="ds-opts robots">
        {entries.map((e) => (
          <RobotCard
            key={e.id}
            spec={e.spec}
            game={e.game}
            on={activeId === e.id}
            imported
            team={teamLine(e.spec)}
            thumb={
              <span className="ds-robot-card-thumb">
                {view.thumbs[e.id] ? (
                  <img className="ds-import-thumb" src={view.thumbs[e.id]} alt="" />
                ) : e.spec.imported ? (
                  <FootprintSvg imported={e.spec.imported} drivetrain={e.spec.drivetrain} size={88} />
                ) : null}
              </span>
            }
            onPick={() => onPick(e)}
            onDelete={() => onDelete(e)}
          />
        ))}
        <button
          type="button"
          className={`ds-opt ds-opt-add${over ? ' on' : ''}`}
          onClick={onImport}
          onDragOver={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            setOver(false);
            onDropFiles(Array.from(e.dataTransfer.files));
          }}
        >
          <span className="ot">{draftFile ? COPY.resumeTitle : COPY.addTitle}</span>
          <span className="od">{draftFile ? COPY.resumeSub(draftFile) : COPY.addFormats}</span>
        </button>
      </div>
      {view.error ? <p className="ds-hint">{view.error}</p> : null}
    </div>
  );
}

/** the stand-in for the Build panel while the active robot is imported */
export function ImportedPanel({
  spec,
  entry,
  loaded,
  stale = false,
  error,
  onEdit,
  onRename,
  onDuplicate,
  onExport,
  onDelete,
  onImportFile,
}: {
  spec: RobotSpec;
  /** the library record, or null when this device does not have it (a synced spec) */
  entry: LibraryEntry | null;
  /** the library has been read (so a null `entry` means "not here", not "not yet") */
  loaded: boolean;
  /** `entry` is an OLDER version of this robot (edited on another device since this device's copy
   *  was made): its model is not drawn, Edit would save the old version over the new one, and the
   *  way back is the newest exported file (`sameImportedRobot`, `docs/area/robot-import.md`) */
  stale?: boolean;
  error: string | null;
  onEdit: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onDelete: () => void;
  onImportFile: () => void;
}) {
  const imp = spec.imported;
  const b = imp ? bbox(imp.hull) : null;
  const fmt = (v: number): string => (Math.round(v * 10) / 10).toFixed(1);
  return (
    <section className="ds-panel">
      <div className="ds-panel-h">
        <h2 className="ds-panel-title">{COPY.panelTitle}</h2>
        {/* AN OUT-OF-DATE COPY IS NOT EDITED: saving it would put the old version back on the
            account. The head's one action becomes the way to update it, in the same place. */}
        {entry && stale ? (
          <button type="button" className="ds-btn small" onClick={onImportFile}>
            {COPY.missingAction}
          </button>
        ) : entry ? (
          <button type="button" className="ds-btn small" onClick={onEdit}>
            {COPY.panelEdit}
          </button>
        ) : null}
      </div>
      <div className="ds-panel-body stack">
        {!entry && loaded ? (
          <div className="ds-empty">
            <p className="big">{COPY.missingBig}</p>
            <p>{COPY.missingText}</p>
            <button type="button" className="ds-btn" onClick={onImportFile}>
              {COPY.missingAction}
            </button>
          </div>
        ) : (
          <>
            {/* one line, and it arrives with the record itself (the same render that adds the File
                row), so nothing below moves after the panel has settled */}
            {entry && stale ? <p className="ds-hint warn">{COPY.staleText}</p> : null}
            <dl className="ds-facts">
              {entry ? (
                <>
                  <dt>{COPY.factFile}</dt>
                  <dd>
                    {entry.source.name} · {FORMAT_LABEL[entry.source.format] ?? entry.source.format.toUpperCase()}
                  </dd>
                </>
              ) : null}
              {imp && b ? (
                <>
                  <dt>{COPY.factFootprint}</dt>
                  <dd>{COPY.factFootprintVal(fmt(b.maxX - b.minX), fmt(b.maxY - b.minY), imp.hull.length)}</dd>
                  <dt>{COPY.factHeight}</dt>
                  <dd>{fmt(imp.heightIn)} in</dd>
                </>
              ) : null}
              {entry ? (
                <>
                  <dt>{COPY.factTriangles}</dt>
                  <dd>{entry.source.trisOut.toLocaleString('en-US')}</dd>
                </>
              ) : null}
            </dl>
            <div className="ds-actions">
              <button type="button" className="ds-btn small" disabled={!entry} onClick={onRename}>
                {COPY.rename}
              </button>
              <button type="button" className="ds-btn small" disabled={!entry} onClick={onDuplicate}>
                {COPY.duplicate}
              </button>
              <button type="button" className="ds-btn small" disabled={!entry} onClick={onExport}>
                {COPY.exportFile}
              </button>
              <button type="button" className="ds-btn small danger" disabled={!entry} onClick={onDelete}>
                {COPY.del}
              </button>
            </div>
          </>
        )}
        {error ? (
          <p className="ds-form-err" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The library actions and their dialogs. Every write announces itself (`libraryChanged`), so the
 * row, the hero and another tab all read the library again.
 */
export function useImportedActions({
  settings,
  applySpec,
  entries,
}: {
  settings: GameSettings;
  applySpec: (s: RobotSpec) => void;
  /** this device's library, so the record that answers for the active robot is the one the robot
   *  page shows (`libraryEntryFor`: its id, else a share-file copy that carried it) */
  entries?: readonly LibraryEntry[] | null;
}) {
  const [dialog, setDialog] = useState<{ kind: 'rename' | 'delete'; entry: LibraryEntry } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = settings.spec.imported?.id ?? null;
  const activeEntryId = libraryEntryFor(entries, active)?.id ?? active;
  const isActive = (e: LibraryEntry): boolean => !!active && e.id === activeEntryId;

  const rename = async (entry: LibraryEntry, name: string): Promise<void> => {
    setDialog(null);
    const { renameRobot } = await import('../library');
    const r = await renameRobot(entry.id, name);
    if (!r.ok) return setError(r.message);
    if (isActive(entry)) applySpec({ ...settings.spec, name });
    setError(null);
    invalidateImportedAssets(entry.id);
    libraryChanged();
  };

  const remove = async (entry: LibraryEntry): Promise<void> => {
    setDialog(null);
    const { deleteRobot, deleteDraft } = await import('../library');
    const r = await deleteRobot(entry.id);
    if (!r.ok) return setError(r.message);
    await deleteDraft(`${entry.game}:${entry.id}`);
    if (isActive(entry)) applySpec(standardRobotFor(settings));
    setError(null);
    invalidateImportedAssets(entry.id);
    libraryChanged();
  };

  const duplicate = async (entry: LibraryEntry): Promise<void> => {
    const { duplicateRobot } = await import('../library');
    const r = await duplicateRobot(entry.id);
    if (!r.ok) return setError(r.message);
    setError(null);
    postRobotNotice(COPY.added(r.value.spec.name));
    libraryChanged();
  };

  const exportIt = async (entry: LibraryEntry): Promise<void> => {
    const { exportLibraryRobot } = await import('./exportRobot');
    const msg = await exportLibraryRobot(entry.id);
    setError(msg);
  };

  const fallback = standardRobotFor(settings);
  const open =
    dialog?.kind === 'rename' ? (
      <RenameDialog name={dialog.entry.spec.name} onRename={(n) => void rename(dialog.entry, n)} onClose={() => setDialog(null)} />
    ) : dialog?.kind === 'delete' ? (
      <ConfirmDialog
        title={COPY.deleteTitle(dialog.entry.spec.name || 'this robot')}
        body={
          <p className="ds-hint">
            {COPY.deleteBody}
            {isActive(dialog.entry) ? ` ${COPY.deleteFallback(fallback.name || 'your standard robot')}` : ''}
          </p>
        }
        confirm={COPY.del}
        danger
        onConfirm={() => void remove(dialog.entry)}
        onClose={() => setDialog(null)}
      />
    ) : null;
  const dialogs = open ? <Suspense fallback={null}>{open}</Suspense> : null;

  return {
    error,
    dialogs,
    requestRename: (entry: LibraryEntry) => setDialog({ kind: 'rename', entry }),
    requestDelete: (entry: LibraryEntry) => setDialog({ kind: 'delete', entry }),
    duplicate: (entry: LibraryEntry) => void duplicate(entry),
    exportIt: (entry: LibraryEntry) => void exportIt(entry),
  };
}

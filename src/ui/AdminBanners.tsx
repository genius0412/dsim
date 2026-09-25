import { useState } from 'react';
import {
  adminDeleteBanner,
  adminEndBanner,
  adminFetchBanners,
  adminSaveBanner,
  type AdminBannerRow,
  type BannerDraft,
} from '../net/api';
import { SEASONS } from '../seasons';
import { BannerRow } from './BannerStack';
import { ListState, When, confirmed, usePolled } from './adminBits';
import { adminFail } from './adminCopy';
import { MarkdownInline } from './markdown';

/**
 * SITE BANNERS (0052): the strip where the restart countdown shows, for anything else players
 * should know right now. Known bugs are the main use: one line, a link to where it is tracked.
 *
 * Several can be live; players see the most important one and "N more". Each player can close
 * one, and an EDIT brings it back (the revision changes). Every machine picks a change up
 * within seconds; connected players get it pushed.
 */

const KINDS: { value: BannerDraft['kind']; label: string }[] = [
  { value: 'known-bug', label: 'Known bug' },
  { value: 'info', label: 'Notice' },
  { value: 'warning', label: 'Warning' },
];
const MAX = 280;
const KIND_NAME: Record<AdminBannerRow['kind'], string> = { 'known-bug': 'Known bug', info: 'Notice', warning: 'Warning', restart: 'Restart' };

/** datetime-local ⇄ ms. The input speaks the admin's local time, which is what they typed. */
const toLocal = (ms: number | null): string => {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocal = (v: string): number | null => {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};

const fmt = (ms: number): string =>
  new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const EMPTY: BannerDraft ={ kind: 'known-bug', message: '', startsAt: null, endsAt: null, game: null, channel: null };

export function AdminBanners() {
  const [draft, setDraft] = useState<BannerDraft>(EMPTY);
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const { data, err, reload } = usePolled(async () => {
    const r = await adminFetchBanners();
    return r.ok ? r.banners : null;
  }, 30_000);

  const put = (patch: Partial<BannerDraft>): void => setDraft((d) => ({ ...d, ...patch }));
  const save = async (): Promise<void> => {
    setBusy(true);
    const r = await adminSaveBanner(draft, editing ?? undefined);
    setBusy(false);
    if (!r.ok) {
      setStatus(r.error || adminFail('save the banner'));
      return;
    }
    setStatus(editing ? `Updated (revision ${r.banner.revision}). Players who closed it see it again.` : 'Posted.');
    setDraft(EMPTY);
    setEditing(null);
    reload();
  };
  const edit = (b: AdminBannerRow): void => {
    if (b.kind === 'restart') return;
    setEditing(b.id);
    setDraft({ kind: b.kind, message: b.message, startsAt: b.startsAt, endsAt: b.endsAt, game: b.game, channel: b.channel });
    setStatus(null);
  };
  const end = async (b: AdminBannerRow): Promise<void> => {
    const r = await adminEndBanner(b.id);
    setStatus(r.ok ? 'Ended.' : r.error);
    reload();
  };
  const del = async (b: AdminBannerRow): Promise<void> => {
    if (!confirmed('Delete', 'this banner', 'It disappears for everyone and from this list. End it instead to keep the history.')) return;
    const r = await adminDeleteBanner(b.id);
    setStatus(r.ok ? 'Deleted.' : r.error);
    if (editing === b.id) {
      setEditing(null);
      setDraft(EMPTY);
    }
    reload();
  };

  const now = Date.now();
  const preview = { id: 0, revision: 0, ...draft, message: draft.message || 'Your message' };
  const tooLong = draft.message.length > MAX;
  const badWindow = !!(draft.startsAt && draft.endsAt && draft.endsAt <= draft.startsAt);
  const open = (data ?? []).filter((b) => !b.endsAt || b.endsAt > now);
  const ended = (data ?? []).filter((b) => b.endsAt && b.endsAt <= now);

  return (
    <>
      <h2 className="ds-h2 adm-sec">Banners</h2>
      <div className="admin-card">
        <div className="adm-pair">
          <label className="admin-field col">
            <span>Type</span>
            <select className="ds-select" value={draft.kind} onChange={(e) => put({ kind: e.target.value as BannerDraft['kind'] })}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-field col">
            <span>Game</span>
            <select className="ds-select" value={draft.game ?? ''} onChange={(e) => put({ game: e.target.value || null })}>
              <option value="">Every game</option>
              {SEASONS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-field col">
            <span>Site</span>
            <select className="ds-select" value={draft.channel ?? ''} onChange={(e) => put({ channel: e.target.value || null })}>
              <option value="">Every site</option>
              <option value="stable">Production</option>
              <option value="alpha">Alpha</option>
            </select>
          </label>
        </div>
        <label className="admin-field col">
          <span>
            Message ({draft.message.length}/{MAX}). Links: [label](https://…)
          </span>
          <textarea className="ds-input admin-textarea" rows={2} value={draft.message} aria-invalid={tooLong} onChange={(e) => put({ message: e.target.value })} />
        </label>
        <div className="adm-pair">
          <label className="admin-field col">
            <span>Starts (blank: now)</span>
            <input type="datetime-local" className="ds-input" value={toLocal(draft.startsAt)} onChange={(e) => put({ startsAt: fromLocal(e.target.value) })} />
          </label>
          <label className="admin-field col">
            <span>Ends (blank: until ended)</span>
            <input type="datetime-local" className="ds-input" value={toLocal(draft.endsAt)} aria-invalid={badWindow} onChange={(e) => put({ endsAt: fromLocal(e.target.value) })} />
          </label>
        </div>
        <div className="adm-preview" aria-label="Preview">
          <BannerRow b={preview} now={now} onDismiss={() => {}} />
        </div>
        <div className="admin-buttons">
          <button className="ds-btn primary" disabled={busy || !draft.message.trim() || tooLong || badWindow} onClick={() => void save()}>
            {editing ? 'Update banner' : 'Post banner'}
          </button>
          {editing && (
            <button
              className="ds-btn ghost"
              onClick={() => {
                setEditing(null);
                setDraft(EMPTY);
              }}
            >
              Cancel edit
            </button>
          )}
        </div>
        {status && <p className="ds-hint" role="status">{status}</p>}
      </div>

      <h3 className="adm-h3">Live and scheduled</h3>
      {open.length === 0 ? (
        <ListState loading={!data && !err ? 'Loading banners…' : undefined} error={err && !data ? 'load the banners' : undefined} empty="No banners">
          Post one above.
        </ListState>
      ) : (
        <BannerTable rows={open} onEdit={edit} onEnd={(b) => void end(b)} onDelete={(b) => void del(b)} />
      )}
      {ended.length > 0 && (
        <>
          <h3 className="adm-h3">Ended</h3>
          <BannerTable rows={ended.slice(0, 20)} onDelete={(b) => void del(b)} />
        </>
      )}
    </>
  );
}

function BannerTable({
  rows,
  onEdit,
  onEnd,
  onDelete,
}: {
  rows: AdminBannerRow[];
  onEdit?: (b: AdminBannerRow) => void;
  onEnd?: (b: AdminBannerRow) => void;
  onDelete: (b: AdminBannerRow) => void;
}) {
  const game = (g: string | null) => (g ? (SEASONS.find((s) => s.key === g)?.name ?? g) : 'Every game');
  return (
    <div className="ds-table-scroll">
      <table className="ds-table adm-table">
        <thead>
          <tr>
            <th>Banner</th>
            <th>Shown to</th>
            <th>Window</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.id}>
              <td>
                <span className="ds-badge">{KIND_NAME[b.kind]}</span> <MarkdownInline text={b.message} />
                {b.revision > 1 && <span className="ds-muted"> · rev {b.revision}</span>}
              </td>
              <td className="ds-muted">
                {game(b.game)}
                {b.channel ? ` · ${b.channel === 'alpha' ? 'Alpha' : 'Production'}` : ''}
              </td>
              <td className="ds-muted">
                {b.startsAt ? fmt(b.startsAt) : <When at={b.createdAt} />} → {b.endsAt ? fmt(b.endsAt) : 'until ended'}
              </td>
              <td>
                <span className="adm-rowacts">
                {onEdit && b.kind !== 'restart' && (
                  <button className="ds-btn ghost small" onClick={() => onEdit(b)}>
                    Edit
                  </button>
                )}
                {onEnd && (
                  <button className="ds-btn ghost small" onClick={() => onEnd(b)}>
                    End
                  </button>
                )}
                <button className="ds-btn ghost small danger" onClick={() => onDelete(b)}>
                  Delete
                </button>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

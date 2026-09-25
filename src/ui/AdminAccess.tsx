import { useState } from 'react';
import {
  adminBulkGrantAccess,
  adminFetchAccess,
  adminGrantAccess,
  adminRevokeAccess,
  type AccessGrantResult,
  type AccessMemberRow,
} from '../net/api';
import { ACCESS_GROUPS, ACCESS_GROUP_LABEL, type AccessGroup } from '../net/protocol';
import { AccountName, ListState, When, confirmed, usePolled } from './adminBits';

/**
 * ACCESS GROUPS (0051): beta testers, developers, contributors. A member gets past any
 * lockdown that lists their group, and a build baked closed (the alpha) lets every group in.
 *
 * Added BY PLAYER TAG (display name, @username or account id), stored BY ACCOUNT ID: a rename
 * keeps the membership, and the list shows today's name. Each deployment keeps its own list,
 * so alpha testers are added from the alpha site's console.
 */
export function AdminAccess({ onOpenUser }: { onOpenUser?: (userId: string) => void }) {
  const [group, setGroup] = useState<AccessGroup>('beta');
  const [tag, setTag] = useState('');
  const [bulk, setBulk] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [results, setResults] = useState<AccessGrantResult[] | null>(null);
  const [filter, setFilter] = useState<AccessGroup | ''>('');

  const { data, err, reload } = usePolled(async () => {
    const r = await adminFetchAccess();
    return r.ok ? r.members : null;
  }, 60_000);

  const addOne = async (): Promise<void> => {
    if (!tag.trim()) return;
    setBusy(true);
    const r = await adminGrantAccess(group, tag.trim());
    setBusy(false);
    if (!r.ok) {
      setStatus(r.error);
      return;
    }
    setStatus(
      r.added
        ? `Added ${name(r)} to ${ACCESS_GROUP_LABEL[group].toLowerCase()}s.`
        : `${name(r)} was already a ${ACCESS_GROUP_LABEL[group].toLowerCase()}.`,
    );
    setTag('');
    reload();
  };

  const addAll = async (): Promise<void> => {
    if (!bulk.trim()) return;
    setBusy(true);
    const r = await adminBulkGrantAccess(group, bulk);
    setBusy(false);
    if (!r.ok) {
      setStatus(r.error);
      setResults(null);
      return;
    }
    const bad = r.results.filter((x) => !x.ok).length;
    setResults(r.results);
    setStatus(`${r.results.length - bad} added or already in, ${bad} not found.`);
    // keep only the tags that failed, so a corrected list can be sent again
    setBulk(r.results.filter((x) => !x.ok).map((x) => x.tag).join('\n'));
    reload();
  };

  const remove = async (m: AccessMemberRow): Promise<void> => {
    if (!confirmed('Remove', `${m.handle ?? m.userId} from ${ACCESS_GROUP_LABEL[m.group].toLowerCase()}s`, 'They lose lockdown access at their next check.')) return;
    const r = await adminRevokeAccess(m.group, m.userId);
    setStatus(r.ok ? (r.removed ? 'Removed.' : 'They were not in that group.') : r.error);
    reload();
  };

  return (
    <>
      <h2 className="ds-h2">Access groups</h2>
      <div className="admin-card">
        <label className="admin-field">
          <span>Group</span>
          <select className="ds-select" value={group} onChange={(e) => setGroup(e.target.value as AccessGroup)}>
            {ACCESS_GROUPS.map((g) => (
              <option key={g} value={g}>
                {ACCESS_GROUP_LABEL[g]}s
              </option>
            ))}
          </select>
        </label>
        <div className="adm-toolbar">
          <input
            type="text"
            className="ds-input adm-grow"
            aria-label="Player tag"
            placeholder="Player tag, @username or account id"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addOne()}
          />
          <button className="ds-btn small" disabled={busy || !tag.trim()} onClick={() => void addOne()}>
            Add
          </button>
        </div>
        <label className="admin-field col">
          <span>Add several (one tag per line, or commas)</span>
          <textarea className="ds-input admin-textarea" rows={4} value={bulk} onChange={(e) => setBulk(e.target.value)} />
        </label>
        <div className="admin-buttons">
          <button className="ds-btn" disabled={busy || !bulk.trim()} onClick={() => void addAll()}>
            Add all to {ACCESS_GROUP_LABEL[group].toLowerCase()}s
          </button>
        </div>
        {status && <p className="ds-hint" role="status">{status}</p>}
        {results && results.some((x) => !x.ok) && (
          <ul className="adm-results">
            {results
              .filter((x) => !x.ok)
              .map((x) => (
                <li key={x.tag}>{x.error}</li>
              ))}
          </ul>
        )}
      </div>

      <h2 className="ds-h2 adm-sec">Members</h2>
      <div className="adm-toolbar">
        <select className="ds-select" aria-label="Filter by group" value={filter} onChange={(e) => setFilter(e.target.value as AccessGroup | '')}>
          <option value="">Every group</option>
          {ACCESS_GROUPS.map((g) => (
            <option key={g} value={g}>
              {ACCESS_GROUP_LABEL[g]}s
            </option>
          ))}
        </select>
      </div>
      {!data || data.length === 0 ? (
        <ListState
          loading={!data && !err ? 'Loading members…' : undefined}
          error={err && !data ? 'load the members' : undefined}
          empty="Nobody yet"
        >
          Add a player above. They can sign in on the closed screen to get through.
        </ListState>
      ) : (
        <div className="ds-table-scroll">
          <table className="ds-table adm-table">
            <thead>
              <tr>
                <th>Player</th>
                <th>Group</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data
                .filter((m) => !filter || m.group === filter)
                .map((m) => (
                  <tr key={`${m.userId}.${m.group}`}>
                    <td>
                      <AccountName userId={m.userId} handle={m.handle} username={m.username} known={!!m.handle} onOpen={onOpenUser} />
                    </td>
                    <td>{ACCESS_GROUP_LABEL[m.group]}</td>
                    <td>
                      <When at={m.grantedAt} />
                    </td>
                    <td>
                      <button className="ds-btn ghost small" onClick={() => void remove(m)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const name = (r: AccessGrantResult): string => (r.username ? `@${r.username}` : (r.handle ?? r.tag));

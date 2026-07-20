import { useState } from 'react';
import { gameServers, gameServerHttpUrl, multiServer, setSelectedServer } from '../net/env';
import { estimateAll } from '../net/ping';
import { Select } from './Select';

/**
 * Region picker for the top bar. Replaces the full-screen picker that used to
 * block every record run.
 *
 * Deliberately does NOT measure on mount. Two reasons: a probe on every render
 * of the app chrome is pure noise, and the region list is a preference you set
 * once — not a decision to re-litigate before each run. The player asks for a
 * measurement with the Ping button, and the result annotates the options.
 */
export function ServerMenu({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const servers = gameServers();
  const [pings, setPings] = useState<Record<string, number | null>>({});
  const [home, setHome] = useState('');
  const [busy, setBusy] = useState(false);

  if (!multiServer()) return null;

  const measure = (): void => {
    setBusy(true);
    estimateAll(servers, gameServerHttpUrl()).then((r) => {
      setPings(r.pings);
      setHome(r.homeRegion);
      setBusy(false);
    });
  };

  // one region is measured, the rest are derived from it — `~` marks the derived
  // ones so a number never claims more precision than it has.
  const options = servers.map((s) => {
    const ms = pings[s.id];
    if (ms == null) return { value: s.id, label: s.label };
    const tilde = s.region && s.region !== home ? '~' : '';
    return { value: s.id, label: `${s.label} · ${tilde}${Math.round(ms)} ms` };
  });

  return (
    <div className="ds-server-menu">
      <Select
        value={value || servers[0]?.id || ''}
        options={options}
        ariaLabel="Server region"
        onChange={(id) => {
          setSelectedServer(id);
          onChange(id);
        }}
      />
      <button className="ds-seg" onClick={measure} disabled={busy} title="Measure latency">
        {busy ? '…' : 'Ping'}
      </button>
    </div>
  );
}

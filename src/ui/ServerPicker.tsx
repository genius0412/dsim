import { useCallback, useEffect, useState } from 'react';
import { gameServers, gameServerHttpUrl, setSelectedServer } from '../net/env';
import { estimateAll, pingQuality } from '../net/ping';

/**
 * Pre-connection server (region) picker. Pings every configured server's
 * /health up front and lets the player choose the closest one before a record
 * run or a match. `value` is the chosen server id; `onChange` both selects it
 * live (setSelectedServer) and lets the parent persist the preference to the
 * account. Renders nothing useful with a single server — callers gate on
 * `multiServer()`.
 */
export function ServerPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const servers = gameServers();
  const [pings, setPings] = useState<Record<string, number | null>>({});
  const [homeRegion, setHomeRegion] = useState('');
  const [pinging, setPinging] = useState(true);

  // ONE probe of our own region + a static RTT matrix — never a probe per region.
  // Measuring each region wakes each region's machine (see estimateAll).
  const probe = useCallback(() => {
    setPinging(true);
    let alive = true;
    estimateAll(servers, gameServerHttpUrl()).then((r) => {
      if (!alive) return;
      setPings(r.pings);
      setHomeRegion(r.homeRegion);
      setPinging(false);
    });
    return () => {
      alive = false;
    };
  }, [servers]);

  useEffect(() => probe(), [probe]);

  const choose = (id: string): void => {
    setSelectedServer(id);
    onChange(id);
  };

  return (
    <div className="server-picker">
      <div className="server-picker-h">
        <span className="ds-panel-title">Server region</span>
        <button className="ds-seg" onClick={() => probe()} disabled={pinging}>
          {pinging ? 'Measuring…' : 'Refresh'}
        </button>
      </div>
      <div className="server-list">
        {servers.map((s) => {
          const ms = pings[s.id] ?? null;
          const q = pingQuality(ms);
          const sel = s.id === value;
          const estimated = ms !== null && !!s.region && s.region !== homeRegion;
          return (
            <button
              key={s.id}
              type="button"
              className={`server-row ${sel ? 'on' : ''}`}
              onClick={() => choose(s.id)}
            >
              <span className={`ping-dot ${q}`} title={q} />
              <span className="server-name">
                {s.label}
                {s.region ? <span className="server-region"> · {s.region}</span> : null}
              </span>
              {/* only our OWN region is measured; the rest are estimated from it
                  (`~`), so we never wake an idle region just to draw this row. */}
              <span className="server-ping">
                {ms === null
                  ? pinging
                    ? '…'
                    : 'n/a'
                  : `${estimated ? '~' : ''}${Math.round(ms)} ms`}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

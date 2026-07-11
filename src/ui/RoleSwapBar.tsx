import type { StartCat } from '../types';
import type { RoleSwap } from './useRoleSwap';

const roleLabel = (r: StartCat | undefined) => (r === 'close' ? 'CLOSE' : r === 'far' ? 'FAR' : '—');

/**
 * The 2v2 start-ROLE bar: shows this robot's role (Close/Far) and drives the
 * consent-based swap handshake (propose → the partner accepts). Rendered in the
 * lobby + ranked strategy start-position section. Pure presentational over the
 * `useRoleSwap` result.
 */
export function RoleSwapBar({
  role,
  partnerName,
  rs,
  dismissed,
  onDismiss,
}: {
  role: StartCat | undefined;
  partnerName: string;
  rs: RoleSwap;
  dismissed: boolean;
  onDismiss: () => void;
}) {
  return (
    <div className="ds-roleswap">
      <span className="ds-roleswap-role">
        You are the <b>{roleLabel(role)}</b> robot
      </span>
      <div className="ds-roleswap-ctl">
        {rs.swapping ? (
          <span className="ds-roleswap-note">Swapping roles…</span>
        ) : rs.incoming && !dismissed ? (
          <>
            <span className="ds-roleswap-note">{partnerName} wants to swap roles</span>
            <button type="button" className="ds-btn small" onClick={rs.acceptSwap}>
              Accept
            </button>
            <button type="button" className="ds-btn ghost small" onClick={onDismiss}>
              Decline
            </button>
          </>
        ) : rs.requesting ? (
          <>
            <span className="ds-roleswap-note">Waiting for {partnerName} to accept…</span>
            <button type="button" className="ds-btn ghost small" onClick={rs.cancelSwap}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="ds-btn ghost small" onClick={rs.requestSwap} title="Ask your partner to swap Close/Far start roles">
            ⇄ Swap roles
          </button>
        )}
      </div>
    </div>
  );
}

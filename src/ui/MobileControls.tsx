import { useState } from 'react';
import type { InputManager } from '../input/input';
import type { GameId } from '../types';

/** a thumb action button (bottom-right cluster). `stopPropagation` keeps a press from
 * ALSO starting the turn joystick (whose touch handler is on the parent overlay). Hold
 * buttons (intake/shoot) set their flag true on press / false on release; the CR catalyst
 * command is edge-triggered in the sim, so a tap (true→false) fires exactly one action. */
function ActionButton({
  label,
  glyph,
  cls,
  onDown,
  onUp,
}: {
  label: string;
  glyph: string;
  cls: string;
  onDown: () => void;
  onUp: () => void;
}) {
  const [pressed, setPressed] = useState(false);
  const down = (e: React.TouchEvent) => {
    e.stopPropagation();
    setPressed(true);
    onDown();
  };
  const up = (e: React.TouchEvent) => {
    e.stopPropagation();
    setPressed(false);
    onUp();
  };
  return (
    <button
      type="button"
      className={`mobile-btn ${cls}${pressed ? ' pressed' : ''}`}
      onTouchStart={down}
      onTouchEnd={up}
      onTouchCancel={up}
      aria-label={label}
    >
      <span className="mb-ico" aria-hidden>
        {glyph}
      </span>
      <span className="mb-lbl">{label}</span>
    </button>
  );
}

interface JoystickProps {
  onValueChange: (value: { x: number; y: number }) => void;
  label?: string;
  active: boolean;
  basePos: { x: number; y: number };
  handlePos: { x: number; y: number };
}

function Joystick({ label, active, basePos, handlePos }: JoystickProps) {
  return (
    <div
      className="mobile-joystick-base"
      style={{
        left: `${basePos.x}px`,
        top: `${basePos.y}px`,
        opacity: active ? 1 : 0,
        pointerEvents: 'none',
        transform: 'translate(-50%, -50%)',
      }}
    >
      {label && <div className="mobile-joystick-label">{label}</div>}
      <div
        className="mobile-joystick-handle"
        style={{
          transform: `translate(${handlePos.x * 40}px, ${handlePos.y * 40}px)`,
          opacity: active ? 1 : 0.6,
        }}
      />
    </div>
  );
}

export function MobileControls({
  inputManager,
  game,
}: {
  inputManager: InputManager;
  /** the active game — the catalyst button only applies to Chain Reaction */
  game?: GameId;
}) {
  const [leftStick, setLeftStick] = useState({
    active: false,
    basePos: { x: 0, y: 0 },
    handlePos: { x: 0, y: 0 },
    touchId: null as number | null,
  });
  const [rightStick, setRightStick] = useState({
    active: false,
    basePos: { x: 0, y: 0 },
    handlePos: { x: 0, y: 0 },
    touchId: null as number | null,
  });

  const MAX_RADIUS = 60; // Max distance the handle can move from center

  const handleTouchStart = (e: React.TouchEvent) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      if (touch.clientX < window.innerWidth / 2) {
        setLeftStick({
          active: true,
          basePos: { x: touch.clientX, y: touch.clientY },
          handlePos: { x: 0, y: 0 },
          touchId: touch.identifier,
        });
      } else {
        setRightStick({
          active: true,
          basePos: { x: touch.clientX, y: touch.clientY },
          handlePos: { x: 0, y: 0 },
          touchId: touch.identifier,
        });
      }
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    for (let i = 0; i < e.touches.length; i++) {
      const touch = e.touches[i];

      if (touch.identifier === leftStick.touchId) {
        const dx = touch.clientX - leftStick.basePos.x;
        const dy = touch.clientY - leftStick.basePos.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const clampedDist = Math.min(distance, MAX_RADIUS);
        const angle = Math.atan2(dy, dx);

        const x = (Math.cos(angle) * clampedDist) / MAX_RADIUS;
        const y = (Math.sin(angle) * clampedDist) / MAX_RADIUS;

        setLeftStick((prev) => ({ ...prev, handlePos: { x, y } }));
        inputManager.setVirtualInput({ driveX: x, driveY: -y });
      }

      if (touch.identifier === rightStick.touchId) {
        const dx = touch.clientX - rightStick.basePos.x;
        const dy = touch.clientY - rightStick.basePos.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const clampedDist = Math.min(distance, MAX_RADIUS);
        const angle = Math.atan2(dy, dx);

        const x = (Math.cos(angle) * clampedDist) / MAX_RADIUS;
        const y = (Math.sin(angle) * clampedDist) / MAX_RADIUS;

        setRightStick((prev) => ({ ...prev, handlePos: { x, y } }));
        inputManager.setVirtualInput({ rotate: -x });
      }
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];

      if (touch.identifier === leftStick.touchId) {
        setLeftStick({
          active: false,
          basePos: { x: 0, y: 0 },
          handlePos: { x: 0, y: 0 },
          touchId: null,
        });
        inputManager.setVirtualInput({ driveX: 0, driveY: 0 });
      }

      if (touch.identifier === rightStick.touchId) {
        setRightStick({
          active: false,
          basePos: { x: 0, y: 0 },
          handlePos: { x: 0, y: 0 },
          touchId: null,
        });
        inputManager.setVirtualInput({ rotate: 0 });
      }
    }
  };

  return (
    <div
      className="mobile-controls"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <Joystick
        label="DRIVE"
        active={leftStick.active}
        basePos={leftStick.basePos}
        handlePos={leftStick.handlePos}
        onValueChange={() => {}}
      />
      <Joystick
        label="TURN"
        active={rightStick.active}
        basePos={rightStick.basePos}
        handlePos={rightStick.handlePos}
        onValueChange={() => {}}
      />

      {/* thumb action buttons (bottom-right). The container ignores touches so the
          gaps between buttons still fall through to the turn joystick. */}
      <div className="mobile-actions">
        <ActionButton
          label="INTAKE"
          glyph="▼"
          cls="intake"
          onDown={() => inputManager.setVirtualInput({ intake: true })}
          onUp={() => inputManager.setVirtualInput({ intake: false })}
        />
        {game === 'chain' && (
          <ActionButton
            label="CATALYST"
            glyph="⬡"
            cls="catalyst"
            onDown={() => inputManager.setVirtualInput({ catalyst: true })}
            onUp={() => inputManager.setVirtualInput({ catalyst: false })}
          />
        )}
        <ActionButton
          label="SHOOT"
          glyph="◎"
          cls="shoot"
          onDown={() => inputManager.setVirtualInput({ fire: true })}
          onUp={() => inputManager.setVirtualInput({ fire: false })}
        />
      </div>
    </div>
  );
}

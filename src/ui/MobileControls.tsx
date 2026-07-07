import { useState } from 'react';
import type { InputManager } from '../input/input';

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

export function MobileControls({ inputManager }: { inputManager: InputManager }) {
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
    </div>
  );
}

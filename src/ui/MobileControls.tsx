import { useState, useRef } from 'react';
import type { InputManager } from '../input/input';

interface JoystickProps {
  onValueChange: (value: { x: number; y: number }) => void;
  label?: string;
}

function Joystick({ onValueChange, label }: JoystickProps) {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState(false);
  const baseRef = useRef<HTMLDivElement>(null);

  const handleTouch = (clientX: number, clientY: number) => {
    if (!baseRef.current) return;
    const rect = baseRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const dx = clientX - centerX;
    const dy = clientY - centerY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const maxRadius = rect.width / 2;

    const clampedDistance = Math.min(distance, maxRadius);
    const angle = Math.atan2(dy, dx);

    const x = (Math.cos(angle) * clampedDistance) / maxRadius;
    const y = (Math.sin(angle) * clampedDistance) / maxRadius;

    setPos({ x, y });
    onValueChange({ x, y });
  };

  const onTouchStart = (e: React.TouchEvent) => {
    setActive(true);
    const touch = e.touches[0];
    handleTouch(touch.clientX, touch.clientY);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    handleTouch(touch.clientX, touch.clientY);
  };

  const onTouchEnd = () => {
    setActive(false);
    setPos({ x: 0, y: 0 });
    onValueChange({ x: 0, y: 0 });
  };

  return (
    <div
      className="mobile-joystick-base"
      ref={baseRef}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {label && <div className="mobile-joystick-label">{label}</div>}
      <div
        className="mobile-joystick-handle"
        style={{
          transform: `translate(${pos.x * 40}px, ${pos.y * 40}px)`,
          opacity: active ? 1 : 0.6
        }}
      />
    </div>
  );
}

export function MobileControls({ inputManager }: { inputManager: InputManager }) {
  return (
    <div className="mobile-controls">
      <div className="mobile-stick-left">
        <Joystick
          label="DRIVE"
          onValueChange={({ x, y }) => {
            inputManager.setVirtualInput({ driveX: x, driveY: -y }); // y is flipped in screen coords
          }}
        />
      </div>
      <div className="mobile-stick-right">
        <Joystick
          label="TURN"
          onValueChange={({ x }) => {
            inputManager.setVirtualInput({ rotate: -x }); // Rotate CCW is positive, right stick right = rotate CW (negative)
          }}
        />
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import {
  PAD_GLYPHS,
  PAD_SLIDER_REPEAT,
  padBackButton,
  padConfirmButton,
  padFamily,
  repeatDueMs,
  resumePadNav,
  suspendPadNav,
  type PadGlyphs,
} from '../../input/padNav';

/**
 * GRAB MODE: how a controller moves a drag handle (lane 4 spec §5).
 *
 * The menu layer (`PadNavLayer`) moves FOCUS by geometry and nudges a focused range input with
 * ◄►; it has no way to move a thing in two dimensions, and it must not learn one, because a second
 * model of "what is selected" is the thing that layer exists not to have. So a handle is a plain
 * button: A on it GRABS it, and while it is held the layer is SUSPENDED (the registry the match and
 * the rebind capture already use) and this hook polls the pad itself:
 *
 *  · D-pad: one step per press, repeating on the SLIDER profile, so a held direction accelerates
 *    the way a held ◄► does on a range input;
 *  · left stick: continuous, up to `STICK_IN_S` past a 0.2 deadzone;
 *  · X held: fine (1/16 in steps, a quarter of the stick speed);
 *  · A drops (commits), B cancels (the caller restores the pre-grab position).
 *
 * The A that grabbed is still down when the loop starts, so A only counts after it has been let
 * go once. When the grab ends the layer resumes; it updated its own button memory every frame of
 * the suspension, so the A still under the thumb is not a fresh press to it either.
 */

const STEP_IN = 0.25;
const FINE_IN = 1 / 16;
const STICK_IN_S = 8;

export interface GrabCallbacks {
  /** move by (dx, dy) in SCREEN directions: +dx right, +dy up, inches */
  nudge(dx: number, dy: number): void;
  drop(): void;
  cancel(): void;
}

export function useHandleGrab(): {
  grabbed: string | null;
  glyphs: PadGlyphs;
  start(key: string, cb: GrabCallbacks): void;
  stop(): void;
} {
  const [grabbed, setGrabbed] = useState<string | null>(null);
  const [glyphs, setGlyphs] = useState<PadGlyphs>(PAD_GLYPHS.generic);
  const cbRef = useRef<GrabCallbacks | null>(null);

  useEffect(() => {
    if (!grabbed) return;
    suspendPadNav('handle');
    let raf = 0;
    let last = performance.now();
    let armed = false;
    const held = new Map<string, { since: number; fires: number }>();
    const edge = (k: string, down: boolean, now: number): boolean => {
      if (!down) {
        held.delete(k);
        return false;
      }
      const h = held.get(k);
      if (!h) {
        held.set(k, { since: now, fires: 1 });
        return true;
      }
      if (now - h.since >= repeatDueMs(h.fires, PAD_SLIDER_REPEAT)) {
        h.fires++;
        return true;
      }
      return false;
    };
    let prevBack = true;
    const poll = (): void => {
      raf = requestAnimationFrame(poll);
      const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
      const pad = pads.find((p) => p && p.connected) ?? null;
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!pad) return;
      const fam = padFamily(pad.id);
      const btn = (i: number): boolean => !!pad.buttons[i] && (pad.buttons[i].pressed || pad.buttons[i].value > 0.5);
      const cb = cbRef.current;
      if (!cb) return;
      const confirm = btn(padConfirmButton(fam));
      const back = btn(padBackButton(fam));
      if (!confirm) armed = true;
      if (armed && confirm) {
        cb.drop();
        return;
      }
      if (back && !prevBack) {
        cb.cancel();
        return;
      }
      prevBack = back;
      const fine = btn(2);
      const step = fine ? FINE_IN : STEP_IN;
      const std = pad.mapping === 'standard';
      if (std) {
        if (edge('u', btn(12), now)) cb.nudge(0, step);
        if (edge('d', btn(13), now)) cb.nudge(0, -step);
        if (edge('l', btn(14), now)) cb.nudge(-step, 0);
        if (edge('r', btn(15), now)) cb.nudge(step, 0);
      }
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      const dz = (v: number): number => (Math.abs(v) < 0.2 ? 0 : (v - Math.sign(v) * 0.2) / 0.8);
      const sx = dz(ax);
      const sy = dz(ay);
      if (sx || sy) {
        const speed = (fine ? STICK_IN_S / 4 : STICK_IN_S) * dt;
        cb.nudge(sx * speed, -sy * speed);
      }
    };
    raf = requestAnimationFrame(poll);
    return () => {
      cancelAnimationFrame(raf);
      resumePadNav('handle');
    };
  }, [grabbed]);

  return {
    grabbed,
    glyphs,
    start(key, cb) {
      cbRef.current = cb;
      const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
      const pad = pads.find((p) => p && p.connected) ?? null;
      setGlyphs(PAD_GLYPHS[padFamily(pad?.id)]);
      setGrabbed(key);
    },
    stop() {
      cbRef.current = null;
      setGrabbed(null);
    },
  };
}

/** is a controller the active input right now? (`PadNavLayer` stamps `data-padnav="on"`) */
export function padIsActive(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.padnav === 'on';
}

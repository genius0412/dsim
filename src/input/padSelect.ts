/**
 * WHICH CONTROLLER IS THE PLAYER HOLDING?
 *
 * Every reader took the FIRST connected entry of `navigator.getGamepads()`. A browser lists
 * every device the OS calls a game controller (a virtual joystick driver, a wheel or its pedals,
 * a flight throttle, a keyboard or tablet with a controller interface), and Chrome shows a page
 * ALL of them from the first button press on any one. With such a device in a lower slot the
 * player's pad was never read: a gamepad tester page lists every slot, so the pad "worked" there
 * and did nothing here (player reports, 2026-11-25).
 *
 * The pad that is read is the one that last gave an INPUT EVENT: a button going down or coming up
 * between two samples, or an axis moving `PAD_WAKE_AXIS` from where it last counted. Both are
 * changes, never levels, so a device that sits with a button stuck on or an axis resting at an end
 * stop gives none and can only ever be the fallback. Rules, in order:
 *   1. the current pad stays while it is in the list;
 *   2. another pad takes over on an event of its own, unless the current one is BUSY (a button it
 *      was seen to press is still down, an axis of it is held `PAD_WAKE_AXIS` or more from the value
 *      it RESTED at when first seen, or it gave an event inside `PAD_BUSY_MS`). A held button
 *      or a held stick does not protect a pad that has been silent for `PAD_INSIST_MS` from a pad that INSISTS
 *      (its last `PAD_INSIST_EVENTS` events all inside `PAD_INSIST_MS`): a latched switch on a
 *      throttle would otherwise keep the player's real pad out for ever;
 *   3. a current pad that leaves the list reads as no pad for `PAD_DROPOUT_GRACE_MS` (a Bluetooth
 *      pad can vanish for a frame, and `GamepadInput` holds its last sample through that), unless
 *      another pad gives an event first;
 *   4. with no current pad: the most recent event, then a pad that had a button down when first
 *      seen (the press that made the browser show it), then the standard mapping, then the lowest
 *      slot. With one pad connected that is the pad, as before.
 *
 * DOM-free and clock-free (`pick` takes the list and the time), so `npm test` drives it.
 */

export interface PadButtonLike {
  readonly pressed: boolean;
  readonly value: number;
}

/** the part of a `Gamepad` the picker reads; a test stub may leave out `index`, `id`, `mapping` */
export interface PadLike {
  readonly connected: boolean;
  readonly index?: number;
  readonly id?: string;
  readonly mapping?: string;
  readonly buttons: ArrayLike<PadButtonLike | null | undefined>;
  readonly axes: ArrayLike<number>;
}

/** how far an axis moves from where it last counted before that is an input event */
export const PAD_WAKE_AXIS = 0.5;
/** how long after its last input event a pad still counts as in use (ms) */
export const PAD_BUSY_MS = 400;
/** a challenger insists when its last `PAD_INSIST_EVENTS` input events all fall inside `PAD_INSIST_MS` */
export const PAD_INSIST_EVENTS = 3;
export const PAD_INSIST_MS = 1500;
/**
 * HOW LONG A PAD MAY VANISH BEFORE IT COUNTS AS UNPLUGGED (ms). `getGamepads()` can report no
 * connected pad for a single frame (seen on Bluetooth pads); see `GamepadInput.sample`.
 */
export const PAD_DROPOUT_GRACE_MS = 100;

const isDown = (b: PadButtonLike | null | undefined): boolean => !!b && (b.pressed || b.value > 0.5);

interface Slot {
  id: string;
  /** each button at the previous sample */
  down: boolean[];
  /** buttons this picker SAW go down and that are still down */
  watched: Set<number>;
  /** each axis where it last counted */
  anchor: number[];
  /** each axis where it was when the pad was first seen: its rest value (a throttle rests at -1) */
  rest: number[];
  /** an axis is `PAD_WAKE_AXIS` or more from its rest value right now: a stick HELD out */
  deflected: boolean;
  lastEvent: number;
  /** the times of the last `PAD_INSIST_EVENTS` input events, oldest first */
  recent: number[];
  /** a button was down when the pad was first seen */
  wokeDown: boolean;
  standard: boolean;
}

export class PadPicker {
  private slots = new Map<number, Slot>();
  private current = -1;
  private lostAt = -1;

  /** the slot being read, -1 for none */
  get slot(): number {
    return this.current;
  }

  reset(): void {
    this.slots.clear();
    this.current = -1;
    this.lostAt = -1;
  }

  pick<T extends PadLike>(pads: ArrayLike<T | null | undefined>, now: number): T | null {
    const live = new Map<number, T>();
    const fresh: number[] = [];
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p || !p.connected) continue;
      const key = p.index ?? i;
      live.set(key, p);
      if (this.observe(key, p, now)) fresh.push(key);
    }
    // a pad that left is a first sight again when it returns; the current one is kept through its grace
    for (const key of [...this.slots.keys()]) if (!live.has(key) && key !== this.current) this.slots.delete(key);

    const cur = live.get(this.current);
    if (cur) {
      this.lostAt = -1;
      if (fresh.length > 0 && !fresh.includes(this.current)) {
        if (!this.busy(this.current, now)) {
          this.current = this.best(fresh);
          return live.get(this.current) ?? null;
        }
        const cs = this.slots.get(this.current);
        if (cs && now - cs.lastEvent >= PAD_INSIST_MS) {
          const pushy = fresh.filter((k) => this.insists(k, now));
          if (pushy.length > 0) {
            this.current = this.best(pushy);
            return live.get(this.current) ?? null;
          }
        }
      }
      return cur;
    }
    if (this.current >= 0 && fresh.length === 0) {
      if (this.lostAt < 0) this.lostAt = now;
      if (now - this.lostAt < PAD_DROPOUT_GRACE_MS) return null;
    }
    if (this.current >= 0) this.slots.delete(this.current);
    this.lostAt = -1;
    this.current = live.size === 0 ? -1 : this.best(fresh.length > 0 ? fresh : [...live.keys()]);
    return live.get(this.current) ?? null;
  }

  /** note this sample of one pad; true when it holds an input event */
  private observe(key: number, p: PadLike, now: number): boolean {
    const id = p.id ?? '';
    let s = this.slots.get(key);
    if (!s || s.id !== id) {
      s = { id, down: [], watched: new Set(), anchor: [], rest: [], deflected: false, lastEvent: -Infinity, recent: [], wokeDown: false, standard: p.mapping === 'standard' };
      for (let i = 0; i < p.buttons.length; i++) {
        s.down[i] = isDown(p.buttons[i]);
        if (s.down[i]) s.wokeDown = true;
      }
      for (let i = 0; i < p.axes.length; i++) {
        s.anchor[i] = p.axes[i] ?? 0;
        s.rest[i] = s.anchor[i];
      }
      this.slots.set(key, s);
      return false;
    }
    let event = false;
    for (let i = 0; i < p.buttons.length; i++) {
      const d = isDown(p.buttons[i]);
      if (d === !!s.down[i]) continue;
      event = true;
      if (d) s.watched.add(i);
      else s.watched.delete(i);
      s.down[i] = d;
    }
    let deflected = false;
    for (let i = 0; i < p.axes.length; i++) {
      const v = p.axes[i] ?? 0;
      if (Math.abs(v - (s.anchor[i] ?? 0)) >= PAD_WAKE_AXIS) {
        event = true;
        s.anchor[i] = v;
      }
      // a held deflection is a level, not an event, so it needs its own mark: measured from where THIS
      // pad's axis rested, never from zero (a throttle resting at -1 is not a stick held out)
      if (Math.abs(v - (s.rest[i] ?? v)) >= PAD_WAKE_AXIS) deflected = true;
    }
    s.deflected = deflected;
    if (event) {
      s.lastEvent = now;
      s.recent.push(now);
      if (s.recent.length > PAD_INSIST_EVENTS) s.recent.shift();
    }
    return event;
  }

  /** did this pad give its last `PAD_INSIST_EVENTS` events all inside `PAD_INSIST_MS` of now? */
  private insists(key: number, now: number): boolean {
    const s = this.slots.get(key);
    return !!s && s.recent.length >= PAD_INSIST_EVENTS && now - s.recent[0] <= PAD_INSIST_MS;
  }

  private busy(key: number, now: number): boolean {
    const s = this.slots.get(key);
    return !!s && (s.watched.size > 0 || s.deflected || now - s.lastEvent < PAD_BUSY_MS);
  }

  /** rule 4's order over the given slots */
  private best(keys: number[]): number {
    let win = -1;
    let ws: Slot | undefined;
    for (const key of keys) {
      const s = this.slots.get(key);
      if (!s) continue;
      const better =
        !ws ||
        s.lastEvent > ws.lastEvent ||
        (s.lastEvent === ws.lastEvent &&
          (Number(s.wokeDown) > Number(ws.wokeDown) ||
            (s.wokeDown === ws.wokeDown &&
              (Number(s.standard) > Number(ws.standard) || (s.standard === ws.standard && key < win)))));
      if (better) {
        win = key;
        ws = s;
      }
    }
    return win;
  }
}

/** ONE picker for the page: driving, menu navigation, the bind capture and the importer's grab
 *  mode all ask it, so they read the same pad. The always-mounted `PadNavLayer` keeps it fed. */
const picker = new PadPicker();

const listed = (): ArrayLike<Gamepad | null> => {
  try {
    return typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
  } catch {
    // a cross-origin embed whose host withholds the gamepad feature throws a SecurityError here, and
    // this runs every frame from the game loop, where an exception stops the loop: read as no pads
    return [];
  }
};

/** the pad the player is using, or null */
export function activePad(now: number = typeof performance !== 'undefined' ? performance.now() : Date.now()): Gamepad | null {
  return picker.pick(listed(), now);
}

/** is any pad connected at all? (the active one may be inside its dropout grace) */
export function anyPadConnected(): boolean {
  const pads = listed();
  for (let i = 0; i < pads.length; i++) if (pads[i]?.connected) return true;
  return false;
}

/**
 * THE PAD A STICK CAPTURE SHOULD READ (`padAxes.ts`): the active pad when the browser gives it no
 * standard mapping, else the first connected pad that has none, else null. Not simply the active
 * pad: the capture is usually started with a mouse, before the pad in question has given the
 * event that would make it the active one.
 */
export function nonStandardPad(now?: number): Gamepad | null {
  const active = activePad(now);
  if (active && active.mapping !== 'standard') return active;
  const pads = listed();
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (p && p.connected && p.mapping !== 'standard') return p;
  }
  return null;
}

/** the pad in one slot, or null. For a capture that must stay on the pad it started with. */
export function padInSlot(slot: number): Gamepad | null {
  const pads = listed();
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (p && p.connected && p.index === slot) return p;
  }
  return null;
}

/** for the smoke run, which shares one process between scenes */
export function resetPadPicker(): void {
  picker.reset();
}

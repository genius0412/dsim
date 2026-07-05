/** tracks held keys and edge-triggered presses */
export class Keyboard {
  private down = new Set<string>();
  private pressed = new Set<string>();
  /** keys whose browser default (scroll etc.) is suppressed — kept in sync
   * with the active bindings so any bound key works cleanly */
  private preventKeys = new Set<string>([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

  setPreventKeys(keys: Iterable<string>): void {
    this.preventKeys = new Set([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
    for (const k of keys) this.preventKeys.add(k);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const k = e.key.toLowerCase();
    if (!e.repeat) this.pressed.add(k);
    this.down.add(k);
    if (this.preventKeys.has(k)) {
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.key.toLowerCase());
  };

  private onBlur = (): void => {
    this.down.clear();
  };

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  held(key: string): boolean {
    return this.down.has(key);
  }

  /** true once per physical key press; consumed on read */
  justPressed(key: string): boolean {
    if (this.pressed.has(key)) {
      this.pressed.delete(key);
      return true;
    }
    return false;
  }

  /** drop un-consumed presses at the end of the frame */
  endFrame(): void {
    this.pressed.clear();
  }
}

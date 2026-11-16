// Typed access to the Electron preload bridge (electron/preload.cjs). Present only
// when running inside the desktop app; `null` in a normal browser, so callers can
// hide desktop-only UI (version readout, update controls) on the web.
/** one network interface the host could be reached on (electron/lanHost.cjs) */
export interface LanAddress {
  /** the adapter's name, e.g. 'Wi-Fi' — a host with several has to tell them apart */
  name: string;
  address: string;
  /** an RFC1918 range, i.e. plausibly the network the guests are on. Listed first. */
  private: boolean;
}

/** what the Host panel renders. Valid whether or not a server is running. */
export interface LanHostStatus {
  running: boolean;
  port: number;
  startedAt: number;
  addresses: LanAddress[];
  /** the server's last few stdout lines, so a failure can say something specific */
  log: string[];
}

/**
 * The frame-rate switches, as the main process sees them. TWO booleans, because they
 * legitimately disagree: `unlimitedFps` is what the NEXT launch will do, `active` is what
 * THIS one did. Chromium reads `disable-frame-rate-limit`/`disable-gpu-vsync` when it spawns
 * the GPU process, so the setting cannot take effect until the app restarts, and the gap
 * between these two is the only honest basis for saying so.
 */
export interface DesktopPerfState {
  unlimitedFps: boolean;
  active: boolean;
}

/**
 * What `check()` answers. `mode` and `ready` arrived with the self-updating shell (0.2); an older
 * shell leaves them out, which reads as `'manual'` and not ready.
 *  - `mode: 'auto'`: the app downloads updates itself and installs them when it closes.
 *  - `mode: 'manual'`: it can only point at the download page (macOS, the portable exe).
 *  - `ready`: an update is downloaded and waiting; `installUpdate()` applies it now.
 */
export interface DesktopUpdateCheck {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  mode?: 'auto' | 'manual';
  ready?: boolean;
}

export interface DesktopBridge {
  isDesktop: true;
  version(): Promise<string>;
  check(): Promise<DesktopUpdateCheck>;
  getAutoCheck(): Promise<boolean>;
  setAutoCheck(v: boolean): Promise<boolean>;
  openDownload(): Promise<void>;
  /**
   * QUIT, INSTALL THE DOWNLOADED UPDATE AND RELAUNCH (`dsim:installUpdate`). Resolves false when
   * nothing is downloaded. OPTIONAL for the reason `lan` is: shells before 0.2 cannot update
   * themselves at all.
   */
  installUpdate?(): Promise<boolean>;
  /**
   * HOST A LAN GAME. OPTIONAL, because a desktop build older than this feature has a
   * preload that never defined it — and the desktop app loads the LIVE site whenever it is
   * reachable, so a brand-new client running inside last month's shell is the ORDINARY
   * case here, not an edge one. Every caller must check `bridge.lan` before using it.
   */
  lan?: {
    start(opts: { port?: number }): Promise<LanHostStatus | { error: string }>;
    stop(): Promise<LanHostStatus>;
    status(): Promise<LanHostStatus>;
  };
  /**
   * UNLIMITED FRAME RATE. OPTIONAL for the reason `lan` is: this build's client runs inside
   * whatever shell the player downloaded, and one older than this feature has a preload that
   * never defined it. Every caller checks `bridge.perf` first and says so rather than throwing.
   */
  /**
   * GOOGLE SIGN-IN IN A POP-UP WINDOW (`dsim:oauth`, electron/main.cjs). Opens `url`, closes the
   * moment the flow redirects to `callback`, and hands back Neon Auth's session verifier.
   * OPTIONAL for the reason `lan` is; without it the button keeps the in-window redirect.
   */
  oauth?(url: string, callback: string): Promise<{ verifier?: string; error?: string; cancelled?: boolean }>;
  perf?: {
    get(): Promise<DesktopPerfState>;
    setUnlimitedFps(v: boolean): Promise<DesktopPerfState>;
    /** quit and start again, so the switches are on the new process's command line. */
    relaunch(): Promise<void>;
  };
}

declare global {
  interface Window {
    dsim?: DesktopBridge;
  }
}

export const desktop = (): DesktopBridge | null =>
  typeof window !== 'undefined' && window.dsim?.isDesktop ? window.dsim : null;

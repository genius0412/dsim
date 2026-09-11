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

export interface DesktopBridge {
  isDesktop: true;
  version(): Promise<string>;
  check(): Promise<{ current: string; latest: string | null; updateAvailable: boolean }>;
  getAutoCheck(): Promise<boolean>;
  setAutoCheck(v: boolean): Promise<boolean>;
  openDownload(): Promise<void>;
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
}

declare global {
  interface Window {
    dsim?: DesktopBridge;
  }
}

export const desktop = (): DesktopBridge | null =>
  typeof window !== 'undefined' && window.dsim?.isDesktop ? window.dsim : null;

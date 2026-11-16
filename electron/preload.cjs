// Bridges a SMALL, safe update API to the renderer (contextIsolation stays on,
// nodeIntegration off). The web UI shows the desktop version + update controls
// only when window.dsim exists (i.e. running inside the Electron app).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dsim', {
  isDesktop: true,
  version: () => ipcRenderer.invoke('dsim:version'),
  // check now (no native dialog) → { current, latest, updateAvailable, mode, ready }
  check: () => ipcRenderer.invoke('dsim:check'),
  getAutoCheck: () => ipcRenderer.invoke('dsim:getAuto'),
  setAutoCheck: (v) => ipcRenderer.invoke('dsim:setAuto', !!v),
  openDownload: () => ipcRenderer.invoke('dsim:openDownload'),
  // quit, install the downloaded update and relaunch → false when none is downloaded
  installUpdate: () => ipcRenderer.invoke('dsim:installUpdate'),
  /**
   * GOOGLE SIGN-IN IN A POP-UP WINDOW (see `dsim:oauth` in main.cjs). Resolves `{ verifier }`,
   * `{ error }` or `{ cancelled: true }`. Absent on an older desktop build, which keeps the
   * in-window redirect.
   */
  oauth: (url, callback) => ipcRenderer.invoke('dsim:oauth', { url, callback }),
  /**
   * HOST A LAN GAME (desktop only — the web app has no way to start a server, which is why
   * the Host panel is gated on `window.dsim` existing at all).
   *
   * `start` resolves to either a status object or `{ error }`; the caller shows the error
   * rather than retrying, because every failure here is a thing a person has to fix (a port
   * in use, a firewall prompt they dismissed).
   */
  lan: {
    start: (opts) => ipcRenderer.invoke('dsim:lanStart', opts || {}),
    stop: () => ipcRenderer.invoke('dsim:lanStop'),
    status: () => ipcRenderer.invoke('dsim:lanStatus'),
  },
  /**
   * THE UNLIMITED FRAME RATE (desktop only — a browser tab cannot ask its own compositor to
   * stop honouring the display's refresh, which is why the Max frame rate row says so).
   *
   * `get` returns BOTH the stored preference and what the running process launched with: the
   * switches are appended before `app.whenReady()`, so the two disagree from the moment the
   * setting is changed until the app is restarted, and the UI has to be able to say that.
   * `relaunch` is wired to a button the player presses and to nothing else.
   */
  perf: {
    get: () => ipcRenderer.invoke('dsim:getPerf'),
    setUnlimitedFps: (v) => ipcRenderer.invoke('dsim:setPerf', !!v),
    relaunch: () => ipcRenderer.invoke('dsim:relaunch'),
  },
});

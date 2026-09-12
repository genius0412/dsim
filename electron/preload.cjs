// Bridges a SMALL, safe update API to the renderer (contextIsolation stays on,
// nodeIntegration off). The web UI shows the desktop version + update controls
// only when window.dsim exists (i.e. running inside the Electron app).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dsim', {
  isDesktop: true,
  version: () => ipcRenderer.invoke('dsim:version'),
  // check now (no native dialog) → { current, latest, updateAvailable }
  check: () => ipcRenderer.invoke('dsim:check'),
  getAutoCheck: () => ipcRenderer.invoke('dsim:getAuto'),
  setAutoCheck: (v) => ipcRenderer.invoke('dsim:setAuto', !!v),
  openDownload: () => ipcRenderer.invoke('dsim:openDownload'),
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
});

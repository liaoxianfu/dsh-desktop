"use strict";

// Preload for the settings & onboarding windows: expose a minimal, safe API
// over IPC.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dshSettings", {
  load: () => ipcRenderer.invoke("settings:load"),
  save: (settings) => ipcRenderer.invoke("settings:save", settings),
  status: () => ipcRenderer.invoke("settings:status"),
});

// First-run onboarding: send the chosen download-source config to the main
// process, which saves it and kicks off the bootstrap (download → start).
contextBridge.exposeInMainWorld("dshOnboarding", {
  start: (settings) => ipcRenderer.send("onboarding:start", settings),
});

// dsh runtime update check / update.
contextBridge.exposeInMainWorld("dshUpdate", {
  check: () => ipcRenderer.invoke("dsh:check-update"),
  update: () => ipcRenderer.invoke("dsh:update"),
});

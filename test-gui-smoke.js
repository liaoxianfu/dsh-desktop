// test-gui-smoke.js — minimal Electron smoke test: open a window, print OK, quit.
const { app, BrowserWindow } = require("electron");

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 400, height: 300, show: true });
  win.loadURL("data:text/html,<h1>gui-smoke</h1>");
  win.on("ready-to-show", () => {
    console.log("GUI-SMOKE-OK");
    setTimeout(() => app.quit(), 800);
  });
  win.webContents.on("did-fail-load", (_e, code, desc) => {
    console.log("GUI-SMOKE-FAIL:", code, desc);
    app.exit(1);
  });
});

setTimeout(() => { console.log("GUI-SMOKE-TIMEOUT"); app.exit(2); }, 15000);

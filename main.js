"use strict";

/**
 * dsh-desktop — DeepSeek Harness desktop shell.
 *
 * Lifecycle contract:
 *   - If nothing listens on the target port, spawn `dsh web --port <port>`,
 *     wait until the HTTP endpoint is ready, then load it in a BrowserWindow.
 *   - When the window is closed (or the app quits), the spawned dsh process
 *     is stopped with SIGTERM (graceful shutdown, then SIGKILL after a grace
 *     period). Closing the window therefore stops the harness — the
 *     "click to launch, close to stop" experience.
 *   - If the port is already in use (e.g. another dsh web instance is
 *     running), we attach to the existing server and never kill it.
 */

const { app, BrowserWindow, dialog, ipcMain, Menu } = require("electron");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

// NOTE: do not call app.setName() — it re-points Chromium's internal dirs
// (cache, SingletonLock) at a fresh ~/.config path, and in read-only HOME
// environments the resulting mkdir failure hard-crashes with SIGTRAP before
// the app is ready. Launch via `electron main.js` (the `electron .` directory
// form SIGTRAPs inside some sandboxes as well).

const DEFAULT_PORT = 3080;
const READY_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 5_000;

let userDataDir;
try {
  userDataDir = app.getPath("userData");
} catch {
  // getPath can fail in restricted environments (e.g. missing XDG dirs);
  // fall back to a conventional location so the app still boots.
  userDataDir = path.join(os.homedir(), ".config", "dsh-desktop");
}
const logDir = path.join(userDataDir, "logs");
try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* logs fall back to console */ }
const appLogFile = path.join(logDir, "dsh-desktop.log");

// ── persistent settings ─────────────────────────────────────────────────────
// GUI-editable configuration (Settings window), stored in userData/settings.json.
// Precedence: environment variable > settings file > default.
const SETTINGS_FILE = path.join(userDataDir, "settings.json");
let settings = {};

function loadSettings() {
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) || {};
  } catch { settings = {}; }
  return settings;
}

function saveSettings(next) {
  settings = { ...next };
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (err) {
    log(`settings save failed: ${err.message}`);
    throw err;
  }
}

function setting(name, envVar, fallback) {
  if (process.env[envVar] !== undefined && process.env[envVar] !== "") return process.env[envVar];
  const v = settings[name];
  if (v !== undefined && v !== "") return String(v);
  return fallback;
}

// Runtime paths depend on settings; resolved once at boot via initRuntimePaths().
let RUNTIME_DIR = path.join(userDataDir, "dsh-runtime");
let RUNTIME_BIN = path.join(RUNTIME_DIR, "node_modules", ".bin", "dsh");
let DSH_NPM_SPEC = "@deepseek-ai/dsh@latest";
let NODE_MAJOR = "22";
let NODE_INSTALL_DIR = path.join(RUNTIME_DIR, "node");
let NODE_BIN = path.join(NODE_INSTALL_DIR, "bin", "node");
let NODE_NPM_CLI = path.join(NODE_INSTALL_DIR, "lib", "node_modules", "npm", "bin", "npm-cli.js");
let settingsPort = "3080";
let settingsWorkspace = "";

function initRuntimePaths() {
  RUNTIME_DIR = setting("runtimeDir", "DSH_APP_RUNTIME_DIR", path.join(userDataDir, "dsh-runtime"));
  DSH_NPM_SPEC = setting("dshSpec", "DSH_APP_DSH_SPEC", "@deepseek-ai/dsh@latest");
  NODE_MAJOR = setting("nodeMajor", "DSH_APP_NODE_MAJOR", "22");
  NODE_INSTALL_DIR = path.join(RUNTIME_DIR, "node");
  if (process.platform === "win32") {
    RUNTIME_BIN = path.join(RUNTIME_DIR, "node_modules", ".bin", "dsh.cmd");
    NODE_BIN = path.join(NODE_INSTALL_DIR, "node.exe");
    NODE_NPM_CLI = path.join(NODE_INSTALL_DIR, "node_modules", "npm", "bin", "npm-cli.js");
  } else {
    RUNTIME_BIN = path.join(RUNTIME_DIR, "node_modules", ".bin", "dsh");
    NODE_BIN = path.join(NODE_INSTALL_DIR, "bin", "node");
    NODE_NPM_CLI = path.join(NODE_INSTALL_DIR, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  }
  settingsPort = setting("port", "DSH_APP_PORT", "3080");
  settingsWorkspace = setting("workspace", "DSH_APP_WORKSPACE", "");
  log(`settings: port=${settingsPort} workspace=${settingsWorkspace || "(default)"} runtimeDir=${RUNTIME_DIR} npmRegistry=${resolveRegistry()}`);
}

// ── portable Node.js ─────────────────────────────────────────────────────────
// If the machine has no Node at all, we ship a portable Node runtime alongside
// dsh (Electron's main process already runs Node, so the download/extract
// logic below works without any system Node). npm and dsh are then executed
// with that bundled node, making the whole harness self-contained.
// DSH_APP_NODE_MIRROR: full base URL, or "cn"/"npmmirror" for the mirror.
const NODE_OFFICIAL_BASE = "https://nodejs.org/dist/";
const NODE_CN_BASE = "https://npmmirror.com/mirrors/node/";

// npm registry for the auto-download. DSH_APP_NPM_REGISTRY accepts a full URL
// or an alias: "cn"/"npmmirror" → the npmmirror mirror, "npmjs"/"default" →
// the official registry. When unset, the first-run dialog offers the choice.
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
const CN_REGISTRY = "https://registry.npmmirror.com/";
let selectedRegistry = null; // set by the first-run dialog (null = env/default)

// Execution mode: "system" uses the machine's node/npm/dsh; "portable" uses
// the bundled Node runtime for npm and for running dsh.
let nodeMode = "system";
let nodeBinPath = null; // resolved executable (system `node` or bundled node)

let mainWindow = null;
let dshProcess = null;
let owned = false; // true => we spawned the server and own its lifecycle
let quitting = false;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(appLogFile, line); } catch { /* ignore */ }
  console.log(line.trimEnd());
}

// execFile's promise form resolves stdout as a Buffer regardless of the
// encoding option (observed on Node ≥26); the callback form returns a string.
// This wrapper always yields strings.
function execFileUtf8(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

async function findExecutableOnPath(executable) {
  const command = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileUtf8(command, [executable], { timeout: 3000 });
    const candidates = stdout.split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
    return candidates.find((p) => fs.existsSync(p)) || null;
  } catch {
    return null;
  }
}

// ── port helpers ────────────────────────────────────────────────────────────

function isPortOpen(port, host = "127.0.0.1", timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

function waitForHttp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/", timeout: 1000 },
        (res) => { res.resume(); resolve(true); },
      );
      req.on("error", () => {
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 250);
      });
      req.on("timeout", () => req.destroy());
    };
    tick();
  });
}

// ── dsh binary discovery ────────────────────────────────────────────────────

function npxCacheProbe() {
  const npxRoot = path.join(os.homedir(), ".npm", "_npx");
  if (!fs.existsSync(npxRoot)) return null;
  let best = null;
  for (const dir of fs.readdirSync(npxRoot)) {
    const candidate = path.join(
      npxRoot,
      dir,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "dsh.cmd" : "dsh",
    );
    if (fs.existsSync(candidate)) {
      const m = fs.statSync(candidate).mtimeMs;
      if (!best || m > best.m) best = { p: candidate, m };
    }
  }
  return best ? best.p : null;
}

async function findDshBin() {
  // DSH_APP_NO_PROBE=1 skips every discovery path (test hook to simulate a
  // machine with no dsh installed at all).
  if (process.env.DSH_APP_NO_PROBE === "1") return null;
  if (process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN)) return process.env.DSH_BIN;
  const pinned = path.join(__dirname, "dsh-path.txt");
  try {
    const p = fs.readFileSync(pinned, "utf8").trim();
    if (p && fs.existsSync(p)) return p;
  } catch { /* no pin file */ }
  const found = await findExecutableOnPath(process.platform === "win32" ? "dsh.cmd" : "dsh");
  if (found) return found;
  return npxCacheProbe();
}

// ── auto-download (no preinstalled dsh on this machine) ─────────────────────

// Packages whose install scripts must run: npm ≥12 blocks them by default
// (allowScripts), but dsh's native addons (node-pty terminal, koffi FFI, the
// sandbox spawn helper) need their post-install work done.
const NATIVE_SCRIPTS_PKGS = [
  "node-pty",
  "koffi",
  "@deepseek-ai/dsh-subprocess-local",
  "@google/genai",
  "protobufjs",
];

let currentProgress = 0;
let currentStep = "初始化中";
let currentMessage = "正在准备运行环境…";

function updateLoading(msg, progress, step) {
  if (msg !== undefined) currentMessage = msg;
  if (progress !== undefined) currentProgress = Math.max(0, Math.min(100, Math.round(progress)));
  if (step !== undefined) currentStep = step;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(`
      (() => {
        const msgEl = document.getElementById('msg');
        const barEl = document.getElementById('progressBar');
        const textEl = document.getElementById('progressText');
        const stepEl = document.getElementById('stepLabel');
        if (msgEl) msgEl.textContent = ${JSON.stringify(currentMessage)};
        if (barEl) barEl.style.width = ${currentProgress} + '%';
        if (textEl) textEl.textContent = ${currentProgress} + '%';
        if (stepEl) stepEl.textContent = ${JSON.stringify(currentStep)};
      })();
    `).catch(() => { /* page may still be loading */ });
  }
}

function resolveRegistry() {
  const fromSettings = setting("npmRegistry", "DSH_APP_NPM_REGISTRY", "");
  if (fromSettings) {
    if (fromSettings === "cn" || fromSettings === "npmmirror") return CN_REGISTRY;
    if (fromSettings === "npmjs" || fromSettings === "default") return DEFAULT_REGISTRY;
    return fromSettings; // assume a full URL (e.g. a corporate mirror)
  }
  return selectedRegistry || DEFAULT_REGISTRY;
}

// ── settings window / menu / IPC ────────────────────────────────────────────

let settingsWindow = null;

function openSettings() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 560,
    height: 700,
    title: "DeepSeek Harness 设置",
    parent: mainWindow,
    backgroundColor: "#0d1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, "settings.html"));
  settingsWindow.on("closed", () => { settingsWindow = null; });
}

function installMenu() {
  const template = [
    {
      label: "DeepSeek Harness",
      submenu: [
        { label: "设置…", accelerator: "CmdOrCtrl+,", click: openSettings },
        { type: "separator" },
        { label: "退出", role: "quit" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  ipcMain.handle("settings:load", () => loadSettings());
  ipcMain.handle("settings:save", (_e, next) => {
    saveSettings(next);
    return true;
  });
  ipcMain.handle("settings:status", () => ({
    nodeMode,
    nodeBin: nodeBinPath || "-",
    dshBin: (() => {
      try { return fs.realpathSync(RUNTIME_BIN); } catch { return "-"; }
    })(),
    runtimeDir: RUNTIME_DIR,
    port: settingsPort,
    workspace: settingsWorkspace || os.homedir(),
  }));
  ipcMain.on("onboarding:start", (_e, s) => handleOnboardingStart(s));
}

// ── portable Node.js runtime ────────────────────────────────────────────────

function resolveNodeBase() {
  const fromSettings = setting("nodeMirror", "DSH_APP_NODE_MIRROR", "");
  if (fromSettings) {
    if (fromSettings === "cn" || fromSettings === "npmmirror") return NODE_CN_BASE;
    if (fromSettings === "official" || fromSettings === "nodejs") return NODE_OFFICIAL_BASE;
    return fromSettings.endsWith("/") ? fromSettings : fromSettings + "/";
  }
  return NODE_OFFICIAL_BASE;
}

function fetchNodeVersion() {
  return new Promise((resolve, reject) => {
    const url = `${NODE_OFFICIAL_BASE}latest-v${NODE_MAJOR}.x/`;
    const req = https.get(url, { headers: { "user-agent": "dsh-desktop" } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`版本页 HTTP ${res.statusCode}`)); }
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => {
        const arch = process.arch === "arm64" ? "arm64" : "x64";
        let suffix;
        if (process.platform === "win32") suffix = `-win-${arch}\\.zip`;
        else if (process.platform === "darwin") suffix = `-darwin-${arch}\\.tar\\.gz`;
        else suffix = `-linux-${arch}\\.tar\\.xz`;
        const m = body.match(new RegExp(`node-v(\\d+\\.\\d+\\.\\d+)${suffix}`));
        if (!m) return reject(new Error("无法解析 Node.js 最新版本"));
        resolve(m[1]);
      });
    });
    req.on("error", reject);
    req.setTimeout(20000, () => req.destroy(new Error("版本页请求超时")));
  });
}

function downloadFileWithNode(url, dest, label, progressStart, progressEnd, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const tmp = dest + ".part";
    const start = progressStart ?? currentProgress;
    const end = progressEnd ?? Math.min(100, start + 20);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore cleanup errors */ }
      reject(err);
    };
    const request = (downloadUrl, remaining) => {
      if (remaining < 0) return fail(new Error(`重定向次数过多: ${url}`));
      const lib = downloadUrl.startsWith("https:") ? https : http;
      const req = lib.get(downloadUrl, { headers: { "user-agent": "dsh-desktop" } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const location = res.headers.location;
          res.resume();
          if (!location) return fail(new Error(`重定向缺少 Location: ${downloadUrl}`));
          return request(new URL(location, downloadUrl).href, remaining - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return fail(new Error(`下载 ${label} 失败: HTTP ${res.statusCode}`));
        }
        const totalBytes = Number(res.headers["content-length"]) || 0;
        let downloadedBytes = 0;
        let lastUpdate = 0;
        const out = fs.createWriteStream(tmp);
        out.on("error", fail);
        res.on("error", fail);
        out.on("finish", () => {
          out.close(() => {
            if (settled) return;
            try {
              if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
                throw new Error(`下载 ${label} 失败: 文件为空`);
              }
              fs.renameSync(tmp, dest);
              settled = true;
              resolve(dest);
            } catch (err) {
              fail(err);
            }
          });
        });
        res.on("data", (chunk) => {
          downloadedBytes += chunk.length;
          const now = Date.now();
          if (now - lastUpdate < 200) return;
          lastUpdate = now;
          const downloadedMb = (downloadedBytes / 1024 / 1024).toFixed(1);
          if (totalBytes > 0) {
            const ratio = downloadedBytes / totalBytes;
            const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
            updateLoading(
              `正在下载 ${label}… ${downloadedMb}MB / ${totalMb}MB (${Math.round(ratio * 100)}%)`,
              start + (end - start) * ratio,
              `下载 ${label}`,
            );
          } else {
            updateLoading(`正在下载 ${label}… ${downloadedMb}MB`, undefined, `下载 ${label}`);
          }
        });
        res.pipe(out);
      });
      req.on("error", fail);
      req.setTimeout(60_000, () => req.destroy(new Error(`下载 ${label} 超时`)));
    };
    request(url, redirectsLeft);
  });
}

function downloadFile(url, dest, label, progressStart, progressEnd) {
  const start = progressStart ?? currentProgress;
  const end = progressEnd ?? Math.min(100, start + 20);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  updateLoading(`正在下载 ${label}…`, start, `下载 ${label}`);
  // Packaged Windows apps cannot rely on curl being present or discoverable.
  // Electron already provides a TLS-capable Node runtime, so use it there.
  if (process.platform === "win32") {
    return downloadFileWithNode(url, dest, label, start, end);
  }
  // Use curl (present on Linux/macOS/Windows 10+) rather than Electron main
  // process https.get: curl handles redirects, proxies, TLS and retries
  // reliably, and is already proven to work in restricted environments.
  return new Promise((resolve, reject) => {
    const tmp = dest + ".part";
    const child = spawn("curl", ["-L", "--fail", "--retry", "3", "--retry-delay", "1", "-sS", "-o", tmp, url], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      let ok = false;
      try { ok = code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 0; } catch { /* ignore */ }
      if (ok) {
        fs.renameSync(tmp, dest);
        updateLoading(`${label} 下载完成`, end, `下载 ${label}`);
        resolve(dest);
      } else {
        fs.rmSync(tmp, { force: true });
        reject(new Error(`下载失败 (curl exit ${code}): ${url}`));
      }
    });
  });
}

async function downloadNode() {
  log("downloading portable Node.js…");
  updateLoading("正在下载 Node.js 运行时（约 30MB）…", 5, "下载 Node.js");
  const version = await fetchNodeVersion();
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  let fname;
  if (process.platform === "win32") fname = `node-v${version}-win-${arch}.zip`;
  else if (process.platform === "darwin") fname = `node-v${version}-darwin-${arch}.tar.gz`;
  else fname = `node-v${version}-linux-${arch}.tar.xz`;
  const archivePath = path.join(RUNTIME_DIR, fname);
  await downloadFile(`${resolveNodeBase()}v${version}/${fname}`, archivePath, "Node.js", 5, 20);
  updateLoading("正在解压 Node.js 运行时…", 20, "解压 Node.js");
  await new Promise((resolve, reject) => {
    fs.mkdirSync(NODE_INSTALL_DIR, { recursive: true });
    if (process.platform === "win32") {
      const psArchive = archivePath.replace(/'/g, "''");
      const psDestination = RUNTIME_DIR.replace(/'/g, "''");
      const command = `Expand-Archive -LiteralPath '${psArchive}' -DestinationPath '${psDestination}' -Force`;
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { stdio: "ignore" },
      );
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code !== 0) return reject(new Error(`PowerShell 解压失败 (${code})`));
        try {
          const extractedDir = path.join(RUNTIME_DIR, `node-v${version}-win-${arch}`);
          if (!fs.existsSync(extractedDir)) throw new Error(`Node.js 解压目录不存在: ${extractedDir}`);
          for (const item of fs.readdirSync(extractedDir)) {
            const src = path.join(extractedDir, item);
            const dest = path.join(NODE_INSTALL_DIR, item);
            fs.rmSync(dest, { recursive: true, force: true });
            fs.renameSync(src, dest);
          }
          fs.rmSync(extractedDir, { recursive: true, force: true });
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      return;
    }
    const tarMode = process.platform === "darwin" ? "-xzf" : "-xJf";
    const child = spawn("tar", [tarMode, archivePath, "-C", NODE_INSTALL_DIR, "--strip-components=1"], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar 解压失败 (${code})`))));
  });
  fs.rmSync(archivePath, { force: true });
  if (!fs.existsSync(NODE_BIN)) throw new Error(`Node.js 解压后缺少可执行文件: ${NODE_BIN}`);
  const { stdout } = await execFileUtf8(NODE_BIN, ["--version"], { timeout: 5000 });
  log(`bundled node ready: ${stdout.trim()} @ ${NODE_BIN}`);
  updateLoading("Node.js 运行时就绪", 25, "Node.js 就绪");
}

async function ensureNode() {
  const downloadWithErrorHandling = async () => {
    try {
      await downloadNode();
    } catch (err) {
      log(`node download failed: ${err.message}`);
      dialog.showErrorBox("下载 Node.js 失败", `${err.message}\n\n请检查网络后重试。`);
      app.exit(1);
      return null;
    }
    nodeMode = "portable";
    nodeBinPath = NODE_BIN;
    return NODE_BIN;
  };
  // Test hook: force the bundled-runtime path even when a system node exists.
  if (process.env.DSH_APP_FORCE_NODE_DOWNLOAD === "1") {
    if (!fs.existsSync(NODE_BIN)) return downloadWithErrorHandling();
    nodeMode = "portable";
    nodeBinPath = NODE_BIN;
    return NODE_BIN;
  }
  // Explicit override.
  if (process.env.DSH_APP_NODE_BIN && fs.existsSync(process.env.DSH_APP_NODE_BIN)) {
    nodeMode = "system";
    nodeBinPath = process.env.DSH_APP_NODE_BIN;
    return nodeBinPath;
  }
  // Previously bundled runtime.
  if (fs.existsSync(NODE_BIN)) {
    nodeMode = "portable";
    nodeBinPath = NODE_BIN;
    return NODE_BIN;
  }
  // System node.
  const systemNode = await findExecutableOnPath(process.platform === "win32" ? "node.exe" : "node");
  if (systemNode) {
    nodeMode = "system";
    nodeBinPath = systemNode;
    return nodeBinPath;
  }
  // No Node at all → offer to bundle one (skipped after onboarding approval).
  const force = process.env.DSH_APP_FORCE_DOWNLOAD === "1";
  if (!force && !onboardingApproved) {
    const choice = await dialog.showMessageBox(mainWindow, {
      type: "question",
      buttons: ["一并下载 Node.js 运行时", "退出"],
      defaultId: 0,
      cancelId: 1,
      title: "DeepSeek Harness",
      message: "未检测到 Node.js 环境",
      detail:
        "本机没有 Node.js/npm。是否一并下载便携版 Node.js 运行时（约 30MB）？\n" +
        "之后 dsh 及其全部依赖（npm 安装、原生模块编译、运行）都将使用该运行时，无需在系统安装 Node。",
    });
    if (choice.response !== 0) {
      app.exit(1);
      return null;
    }
  }
  return downloadWithErrorHandling();
}

function runNpm(args, progressStart, progressEnd, stepLabel) {
  return new Promise((resolve, reject) => {
    const start = progressStart ?? currentProgress;
    const end = progressEnd ?? Math.min(100, start + 40);
    const label = stepLabel || "npm 操作";
    // Gentle network resilience: retry flaky registry fetches a few times.
    // Aggressive values (60s timeout × 5 retries) backfire badly on slow
    // mirrors by turning one hung request into many minutes of waiting.
    const netArgs = ["--fetch-retries", "3", "--fetch-timeout", "20000", "--fetch-retry-mintimeout", "1000"];
    const fullArgs = [...args, "--registry", resolveRegistry(), ...netArgs];
    let cmd;
    let cmdArgs;
    if (nodeMode === "portable") {
      // Bundled node runs its own npm-cli.js (no system npm needed).
      cmd = nodeBinPath;
      cmdArgs = [NODE_NPM_CLI, ...fullArgs];
      log(`npm ${fullArgs.join(" ")} (bundled node)`);
    } else {
      cmd = process.platform === "win32" ? "npm.cmd" : "npm";
      cmdArgs = fullArgs;
      log(`npm ${fullArgs.join(" ")} (system npm)`);
    }
    const spawnOptions = { stdio: ["ignore", "pipe", "pipe"] };
    if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(cmd)) {
      spawnOptions.shell = true;
    }
    updateLoading(`正在执行 npm ${args[0]}…`, start, label);
    const child = spawn(cmd, cmdArgs, spawnOptions);
    const outLog = path.join(logDir, "dsh-download.log");
    const outStream = fs.createWriteStream(outLog, { flags: "a" });
    outStream.on("error", () => { /* the UI still shows process output */ });
    let buf = "";
    const startedAt = Date.now();
    let lastProgress = start;
    const progressTimer = setInterval(() => {
      const elapsedRatio = Math.min(0.9, (Date.now() - startedAt) / 180_000);
      const nextProgress = Math.round(start + (end - start) * elapsedRatio);
      if (nextProgress > lastProgress) {
        lastProgress = nextProgress;
        updateLoading(undefined, nextProgress, label);
      }
    }, 1000);
    const onData = (d) => {
      const s = d.toString();
      try { outStream.write(s); } catch { /* log dir may be read-only */ }
      buf += s;
      const lines = buf.split("\n");
      buf = lines.pop();
      const tail = lines.filter((l) => l.trim()).slice(-3).join("\n");
      if (tail) updateLoading(`${label}中…\n${tail}`, undefined, label);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => {
      clearInterval(progressTimer);
      try { outStream.end(); } catch { /* ignore */ }
      reject(err);
    });
    child.on("exit", (code) => {
      clearInterval(progressTimer);
      try { outStream.end(); } catch { /* ignore */ }
      if (code === 0) {
        updateLoading(undefined, end, label);
        resolve();
      }
      else reject(new Error(`npm ${args[0]} 退出码 ${code}，详见 ${outLog}`));
    });
  });
}

async function downloadDsh() {
  const cacheFlag = process.env.DSH_APP_NPM_CACHE ? ["--cache", process.env.DSH_APP_NPM_CACHE] : [];
  const baseProgress = currentProgress;
  updateLoading("开始下载并安装 dsh…", baseProgress, "安装 dsh");
  // 1) plain install (on npm ≥12 the native install scripts are blocked, but
  //    every package still lands on disk)
  await runNpm(
    ["install", "--prefix", RUNTIME_DIR, "--no-audit", "--no-fund", DSH_NPM_SPEC, ...cacheFlag],
    baseProgress,
    baseProgress + 50,
    "下载 dsh 包",
  );

  // 2) approve the exact installed versions so their install scripts may run
  const allow = {};
  for (const name of NATIVE_SCRIPTS_PKGS) {
    try {
      const version = require(path.join(RUNTIME_DIR, "node_modules", name, "package.json")).version;
      allow[`${name}@${version}`] = true;
    } catch { /* not installed; nothing to approve */ }
  }
  fs.writeFileSync(
    path.join(RUNTIME_DIR, "package.json"),
    JSON.stringify({ private: true, allowScripts: allow }, null, 2),
  );

  // 3) rebuild the native addons (compiles node-pty's pty.node, etc.)
  await runNpm(
    ["rebuild", "--prefix", RUNTIME_DIR, "--no-audit", "--no-fund", ...NATIVE_SCRIPTS_PKGS, ...cacheFlag],
    baseProgress + 50,
    baseProgress + 70,
    "编译原生模块",
  );
}

async function ensureDshBin() {
  // 1) already installed somewhere on this machine
  const found = await findDshBin();
  if (found) {
    updateLoading(undefined, 75, "dsh 已就绪");
    return found;
  }
  // 2) a previously auto-downloaded runtime
  if (fs.existsSync(RUNTIME_BIN)) {
    log(`using previously downloaded runtime: ${RUNTIME_BIN}`);
    updateLoading(undefined, 75, "dsh 已就绪");
    return RUNTIME_BIN;
  }
  // 3) ask to download (skipped when forced by env or after onboarding approval)
  const force = process.env.DSH_APP_FORCE_DOWNLOAD === "1";
  if (!force && !onboardingApproved) {
    const choice = await dialog.showMessageBox(mainWindow, {
      type: "question",
      buttons: ["自动下载（默认源）", "自动下载（国内镜像源）", "退出"],
      defaultId: 0,
      cancelId: 2,
      title: "DeepSeek Harness",
      message: "未找到 dsh 运行时",
      detail:
        "本机尚未安装 dsh。是否自动下载 DeepSeek Harness？\n" +
        "· 需要网络连接，npm 随 Node.js 自带\n" +
        "· 首次下载约 100~200 MB（含全部插件），安装到应用数据目录\n" +
        "· 国内网络建议选择「国内镜像源」以获得更快速度\n" +
        "· 也可通过环境变量 DSH_APP_NPM_REGISTRY 指定任意镜像",
    });
    if (choice.response === 2) {
      app.exit(1);
      return null;
    }
    if (choice.response === 1) selectedRegistry = CN_REGISTRY;
  }
  updateLoading("正在下载 dsh（首次需要几分钟）…", currentProgress, "下载 dsh");
  try {
    await downloadDsh();
  } catch (err) {
    log(`download failed: ${err.message}`);
    dialog.showErrorBox(
      "下载 dsh 失败",
      `${err.message}\n\n请检查网络后重试，或手动安装：npm install -g @deepseek-ai/dsh`,
    );
    app.exit(1);
    return null;
  }
  if (!fs.existsSync(RUNTIME_BIN)) {
    dialog.showErrorBox("下载异常", "dsh 已下载但可执行文件缺失，请查看日志后重试。");
    app.exit(1);
    return null;
  }
  updateLoading("dsh 下载完成", 90, "dsh 就绪");
  return RUNTIME_BIN;
}

// ── server lifecycle ────────────────────────────────────────────────────────

function resolveDshJs(dshBin) {
  try {
    if (process.platform === "win32" && /\.cmd$/i.test(dshBin)) {
      const packageDir = path.resolve(path.dirname(dshBin), "..", "@deepseek-ai", "dsh");
      const packageJson = path.join(packageDir, "package.json");
      if (fs.existsSync(packageJson)) {
        const pkg = JSON.parse(fs.readFileSync(packageJson, "utf8"));
        const relativeBin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin && pkg.bin.dsh;
        if (relativeBin) return path.join(packageDir, relativeBin);
      }
    }
    return fs.realpathSync(dshBin);
  } catch {
    return dshBin;
  }
}

function startServer(dshBin, port, workspace) {
  const outLog = path.join(logDir, "web.out.log");
  let cmd;
  let args;
  if (nodeMode === "portable") {
    // Run dsh's bin.js with the bundled node (system node may not exist).
    const dshJs = resolveDshJs(dshBin);
    cmd = nodeBinPath;
    args = [dshJs, "web", "--port", String(port)];
    log(`spawning: ${nodeBinPath} ${dshJs} web --port ${port}  (cwd=${workspace})`);
  } else {
    cmd = dshBin;
    args = ["web", "--port", String(port)];
    log(`spawning: ${dshBin} web --port ${port}  (cwd=${workspace})`);
  }
  updateLoading("正在启动 dsh 服务…", 93, "启动服务");
  const spawnOptions = {
    cwd: workspace,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  };
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(cmd)) {
    spawnOptions.shell = true;
  }
  dshProcess = spawn(cmd, args, spawnOptions);
  const outStream = fs.createWriteStream(outLog, { flags: "a" });
  dshProcess.stdout.pipe(outStream);
  dshProcess.stderr.pipe(outStream);
  dshProcess.on("error", (err) => {
    log(`failed to start dsh: ${err.message}`);
  });
  dshProcess.on("exit", (code, signal) => {
    log(`dsh exited code=${code} signal=${signal}`);
    dshProcess = null;
    if (!quitting && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox(
        "DeepSeek Harness 服务已退出",
        `dsh web 进程意外退出 (code=${code}, signal=${signal})。\n详细日志: ${outLog}`,
      );
      app.quit();
    }
  });
  return outLog;
}

function stopServer(done) {
  if (!owned || !dshProcess) return done();
  const child = dshProcess;
  dshProcess = null;
  let settled = false;
  const finish = () => { if (!settled) { settled = true; done(); } };
  child.once("exit", finish);
  if (process.platform === "win32") {
    log("stopping dsh process tree with taskkill…");
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      killer.on("error", () => {
        try { child.kill(); } catch { finish(); }
      });
    } catch {
      try { child.kill(); } catch { return finish(); }
    }
  } else {
    log("sending SIGTERM to dsh…");
    try { child.kill("SIGTERM"); } catch { return finish(); }
  }
  setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }, STOP_GRACE_MS);
}

// ── window ──────────────────────────────────────────────────────────────────

const LOADING_HTML =
  "<!doctype html><html><head><meta charset=\"utf-8\"><style>" +
  "body{display:flex;align-items:center;justify-content:center;height:100vh;margin:0;" +
  "background:#0d1117;color:#c9d1d9;font:16px system-ui,sans-serif;padding:20px}" +
  ".container{width:100%;max-width:520px}" +
  ".title{font-size:18px;font-weight:600;margin-bottom:20px;text-align:center;color:#e6edf3}" +
  ".step-label{font-size:13px;color:#8b949e;margin-bottom:8px}" +
  ".progress-wrap{width:100%;height:8px;background:#30363d;border-radius:4px;overflow:hidden;margin-bottom:10px}" +
  ".progress-bar{height:100%;background:linear-gradient(90deg,#2f81f7,#58a6ff);width:0;transition:width .3s ease;border-radius:4px}" +
  ".progress-text{font-size:12px;color:#8b949e;text-align:right;margin-bottom:16px}" +
  ".msg-box{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:12px;min-height:72px}" +
  ".msg{white-space:pre-wrap;font-size:12px;color:#8b949e;line-height:1.6;margin:0;word-break:break-all}" +
  ".spinner{display:inline-block;width:14px;height:14px;border:2px solid #30363d;border-top-color:#2f81f7;" +
  "border-radius:50%;animation:spin .8s linear infinite;margin-right:8px;vertical-align:middle}" +
  "@keyframes spin{to{transform:rotate(360deg)}}" +
  "</style></head>" +
  "<body><div class=\"container\">" +
  "<div class=\"title\"><span class=\"spinner\"></span>DeepSeek Harness 正在准备…</div>" +
  "<div class=\"step-label\" id=\"stepLabel\">初始化中</div>" +
  "<div class=\"progress-wrap\"><div class=\"progress-bar\" id=\"progressBar\"></div></div>" +
  "<div class=\"progress-text\" id=\"progressText\">0%</div>" +
  "<div class=\"msg-box\"><p class=\"msg\" id=\"msg\">正在准备运行环境…</p></div>" +
  "</div></body></html>";

function loadLoadingPage() {
  return mainWindow
    .loadURL("data:text/html;charset=utf-8," + encodeURIComponent(LOADING_HTML))
    .then(() => updateLoading())
    .catch(() => { /* window may be closing */ });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "DeepSeek Harness",
    autoHideMenuBar: true,
    backgroundColor: "#0d1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  loadLoadingPage();
  return mainWindow;
}

async function boot() {
  loadSettings();
  initRuntimePaths();
  registerIpc();
  installMenu();
  const port = Number(settingsPort);
  const workspace = settingsWorkspace || os.homedir();

  createWindow();

  // Test hooks for the settings UI (see test-settings-e2e.sh).
  if (process.env.DSH_APP_AUTO_SETTINGS_WINDOW === "1") {
    openSettings();
  }
  if (process.env.DSH_APP_TEST_SAVE_SETTINGS) {
    try {
      saveSettings(JSON.parse(process.env.DSH_APP_TEST_SAVE_SETTINGS));
      log("test: settings saved via saveSettings()");
    } catch (err) {
      log(`test: settings save hook failed: ${err.message}`);
    }
  }

  if (await isPortOpen(port)) {
    log(`port ${port} already in use — attaching to existing dsh server (won't stop it on exit)`);
    owned = false;
    mainWindow.loadURL(`http://127.0.0.1:${port}`);
    scheduleAutoClose();
    return;
  }

  // Do we need to download anything? (No node, or no dsh.)
  const needNode = !(await nodeReady());
  const needDsh = !(await dshReady());
  if (!needNode && !needDsh) {
    await bootstrap(port, workspace);
    return;
  }
  log(`first run: needNode=${needNode} needDsh=${needDsh}`);

  // Download sources already configured (settings/env)? Then skip the
  // onboarding page and download straight away. DSH_APP_FORCE_DOWNLOAD also
  // bypasses it (test hook / scripted installs).
  const force = process.env.DSH_APP_FORCE_DOWNLOAD === "1";
  const hasSourceConfig = !!(
    setting("npmRegistry", "DSH_APP_NPM_REGISTRY", "") ||
    setting("nodeMirror", "DSH_APP_NODE_MIRROR", "")
  );
  if (force || hasSourceConfig) {
    onboardingApproved = true;
    await bootstrap(port, workspace);
    return;
  }

  // First run with no configuration yet: show the onboarding page, which
  // lets the user pick download sources before anything is fetched.
  showOnboarding();
}

// Do we have a usable Node runtime already?
async function nodeReady() {
  if (process.env.DSH_APP_NODE_BIN && fs.existsSync(process.env.DSH_APP_NODE_BIN)) return true;
  if (fs.existsSync(NODE_BIN)) return true;
  return !!(await findExecutableOnPath(process.platform === "win32" ? "node.exe" : "node"));
}

// Do we have a usable dsh already?
async function dshReady() {
  return !!(await findDshBin()) || fs.existsSync(RUNTIME_BIN);
}

let onboardingApproved = false; // user clicked "start" on the onboarding page

function showOnboarding() {
  log("showing first-run onboarding…");
  mainWindow.loadFile(path.join(__dirname, "onboarding.html"));
  // Test hook: auto-submit the form (simulates the user clicking start).
  if (process.env.DSH_APP_AUTO_ONBOARDING) {
    setTimeout(() => {
      try {
        handleOnboardingStart(JSON.parse(process.env.DSH_APP_AUTO_ONBOARDING));
      } catch (err) {
        log(`test: auto onboarding failed: ${err.message}`);
      }
    }, 1500);
  }
}

function handleOnboardingStart(s) {
  log("onboarding submitted");
  try {
    saveSettings(s);
  } catch (err) {
    dialog.showErrorBox("保存配置失败", err.message);
    return;
  }
  onboardingApproved = true;
  initRuntimePaths(); // port / workspace may have been changed by the user
  const port = Number(settingsPort);
  const workspace = settingsWorkspace || os.homedir();
  loadLoadingPage();
  bootstrap(port, workspace).catch((err) => {
    log(`bootstrap failed: ${err.stack || err.message}`);
    dialog.showErrorBox("启动失败", `初始化过程出错: ${err.message}\n\n请查看日志了解详情。`);
  });
}

// Download what's missing, then start the server and show the UI.
async function bootstrap(port, workspace) {
  currentProgress = 0;
  currentStep = "初始化";
  currentMessage = "正在准备运行环境…";
  updateLoading("正在准备运行环境…", 0, "初始化");
  const node = await ensureNode();
  if (!node) return; // user chose to exit, or download failed (already handled)
  log(`node mode: ${nodeMode} (${node})`);

  const dshBin = await ensureDshBin();
  if (!dshBin) return; // user chose to exit, or download failed (already handled)
  log(`dsh binary: ${dshBin}`);

  owned = true;
  const outLog = startServer(dshBin, port, workspace);

  updateLoading("等待 dsh web 服务就绪…", 96, "启动服务");
  const ready = await waitForHttp(port, READY_TIMEOUT_MS);
  if (!ready) {
    dialog.showErrorBox(
      "启动超时",
      `dsh web 在 ${READY_TIMEOUT_MS / 1000}s 内未就绪。\n详细日志: ${outLog}`,
    );
    stopServer(() => app.exit(1));
    return;
  }
  updateLoading("启动完成！", 100, "完成");
  log("server ready");
  mainWindow.loadURL(`http://127.0.0.1:${port}`);
  scheduleAutoClose();
}

// Test hook: auto-close the window after N ms to verify close-to-stop end-to-end.
function scheduleAutoClose() {
  if (process.env.DSH_APP_AUTOCLOSE_MS) {
    setTimeout(() => {
      log("test: auto-closing window");
      if (mainWindow) mainWindow.close();
    }, Number(process.env.DSH_APP_AUTOCLOSE_MS));
  }
}

// ── app lifecycle ───────────────────────────────────────────────────────────

// DSH_APP_SKIP_LOCK=1 bypasses the single-instance lock (test hook for
// environments where the lock file can't be created, e.g. read-only HOME).
const gotLock = process.env.DSH_APP_SKIP_LOCK ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(boot).catch((err) => {
    log(`boot failed: ${err.stack || err.message}`);
    dialog.showErrorBox("启动失败", `应用初始化失败: ${err.message}\n\n请查看日志了解详情。`);
    app.exit(1);
  });

  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    stopServer(() => app.exit(0));
  });
}

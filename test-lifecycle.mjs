#!/usr/bin/env node
/**
 * test-lifecycle.mjs — validates the core lifecycle without a GUI:
 *   1. discover dsh (same strategy as main.js)
 *   2. spawn `dsh web --port <random>` on a scratch workspace
 *   3. wait for the HTTP endpoint
 *   4. send SIGTERM and assert the process actually exits (close-to-stop)
 * Cleanup is guaranteed via a try/finally that SIGKILLs leftovers.
 */
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const PORT = 4399 + Math.floor(Math.random() * 500);

function isPortOpen(port, host = "127.0.0.1", timeoutMs = 1200) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host });
    s.setTimeout(timeoutMs);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("timeout", () => { s.destroy(); resolve(false); });
    s.once("error", () => resolve(false));
  });
}

function waitForHttp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1000 }, (res) => {
        res.resume(); resolve(true);
      });
      req.on("error", () => {
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 250);
      });
      req.on("timeout", () => req.destroy());
    };
    tick();
  });
}

async function findDshBin() {
  const pinned = path.join(process.cwd(), "dsh-path.txt");
  try {
    const p = fs.readFileSync(pinned, "utf8").trim();
    if (p && fs.existsSync(p)) return p;
  } catch { /* none */ }
  try {
    const { stdout } = await execFile("which", ["dsh"], { timeout: 3000 });
    const p = stdout.trim();
    if (p && fs.existsSync(p)) return p;
  } catch { /* not on PATH */ }
  const npxRoot = path.join(os.homedir(), ".npm", "_npx");
  if (fs.existsSync(npxRoot)) {
    let best = null;
    for (const dir of fs.readdirSync(npxRoot)) {
      const c = path.join(npxRoot, dir, "node_modules", ".bin", "dsh");
      if (fs.existsSync(c)) {
        const m = fs.statSync(c).mtimeMs;
        if (!best || m > best.m) best = { p: c, m };
      }
    }
    if (best) return best.p;
  }
  return null;
}

const dshBin = await findDshBin();
if (!dshBin) {
  console.error("FAIL: dsh binary not found");
  process.exit(1);
}
console.log(`[1/4] dsh binary: ${dshBin}`);

if (await isPortOpen(PORT)) {
  console.error(`FAIL: port ${PORT} already in use — pick another`);
  process.exit(1);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-lc-"));
// dsh rewrites $DSH_HOME/profiles/<name>/cordis.yml at every boot; point
// DSH_HOME inside the scratch dir so the sandbox lets it write.
const testHome = path.join(scratch, "dsh-home");
fs.mkdirSync(testHome, { recursive: true });
console.log(`[2/4] spawning dsh web --port ${PORT} (cwd=${scratch}, DSH_HOME=${testHome})`);

const child = spawn(dshBin, ["web", "--port", String(PORT)], {
  cwd: scratch,
  env: { ...process.env, DSH_HOME: testHome },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (d) => { output += d; });
child.stderr.on("data", (d) => { output += d; });

let exited = null;
child.on("exit", (code, signal) => { exited = { code, signal }; });

try {
  const ready = await waitForHttp(PORT, 90_000);
  if (!ready) {
    console.error("FAIL: server never became ready\n--- dsh output ---\n" + output.slice(-4000));
    process.exit(1);
  }
  console.log("[3/4] server ready on", `http://127.0.0.1:${PORT}`);

  child.kill("SIGTERM");
  const deadline = Date.now() + 10_000;
  while (!exited && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!exited) {
    console.error("FAIL: dsh did not exit after SIGTERM (still alive)");
    child.kill("SIGKILL");
    process.exit(1);
  }
  console.log(`[4/4] PASS: dsh exited on SIGTERM (code=${exited.code}, signal=${exited.signal})`);
  console.log("关闭窗口 ⇒ 停服务 的链路验证通过 ✅");
} finally {
  if (!exited) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  fs.rmSync(scratch, { recursive: true, force: true });
}

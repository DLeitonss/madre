// SPDX-License-Identifier: BUSL-1.1
// Windows/WSL stdio bridge. No downloads, TCP listener or browser ownership.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, win32 } from 'node:path';
import { createInterface } from 'node:readline';

export const WINDOWS_MCP_VERSION = '0.0.83';
export const WINDOWS_BRIDGE = fileURLToPath(import.meta.url);
const execute = promisify(execFile);
const HEARTBEAT = 'madre/windows-heartbeat';

export function windowsEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith('PLAYWRIGHT_MCP_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())));
}

export function windowsEndpoint({ browser = 'msedge', cdpEndpoint = '' } = {}) {
  if (!['chrome', 'msedge'].includes(browser)) throw new Error('Windows CDP requires BROWSER = chrome or msedge.');
  const text = cdpEndpoint || `http://127.0.0.1:${browser === 'msedge' ? 9222 : 9223}`;
  const url = new URL(text);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('CDP must be http://127.0.0.1:<port> without a path, credentials or query.');
  return url.origin;
}

export function windowsCommand(action, options = {}) {
  windowsEndpoint(options);
  return { command: process.execPath, args: [WINDOWS_BRIDGE, action, JSON.stringify(options)] };
}

// wslpath receives each path as a literal argv entry; spaces, quotes and $ are data.
export async function windowsPath(path, { run = execute, env = process.env } = {}) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) throw new Error('An absolute WSL path is required.');
  const { stdout } = await run('wslpath', ['-w', path], { env, timeout: 10000, maxBuffer: 16384 });
  const converted = stdout.trim();
  if (!win32.isAbsolute(converted)) throw new Error('wslpath did not return an absolute Windows path.');
  return converted;
}

export async function windowsCheck(action, options = {}, { env = process.env, cwd = process.cwd(), run = execute } = {}) {
  try {
    const { command, args } = windowsCommand(action, { ...options, projectRoot: cwd });
    const { stdout } = await run(command, args, { env, cwd, timeout: 25000, maxBuffer: 65536 });
    return JSON.parse(stdout.trim());
  } catch (error) { return { ok: false, problem: String(error.stderr || error.message).trim().slice(-600) }; }
}

export async function windowsRuntime(env, { run = execute } = {}) {
  if (process.platform !== 'linux' || !env.WSL_DISTRO_NAME) throw new Error('The Windows connection requires MADRE in WSL with Windows interop enabled.');
  // This script is fixed. No setting, path or website is interpolated as PowerShell code.
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @{node=(Get-Command node.exe -ErrorAction Stop).Source; appdata=$env:LOCALAPPDATA} | ConvertTo-Json -Compress";
  const { stdout } = await run('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { env, timeout: 10000, maxBuffer: 16384, windowsHide: true });
  const runtime = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  if (typeof runtime.appdata !== 'string' || !win32.isAbsolute(runtime.appdata) || typeof runtime.node !== 'string' || !win32.isAbsolute(runtime.node)) throw new Error('Windows Node.js and LOCALAPPDATA are required.');
  const node = await run('wslpath', ['-u', runtime.node], { env, timeout: 10000, maxBuffer: 16384 });
  const command = node.stdout.trim();
  if (!command.startsWith('/')) throw new Error('wslpath did not return an absolute path for Windows Node.js.');
  const found = await run(command, ['-p', 'process.versions.node'], { env, timeout: 10000, maxBuffer: 16384, windowsHide: true });
  const version = found.stdout.trim();
  const major = Number(/^v?(\d+)/.exec(version)?.[1]);
  if (!Number.isInteger(major) || major < 20) throw new Error(`The Windows browser requires Windows Node.js >=20 (found ${version || 'an unknown version'}).`);
  return { command, appdata: runtime.appdata, nodeVersion: version };
}

export function windowsMcpArgs(options) {
  const endpoint = windowsEndpoint(options);
  if (!win32.isAbsolute(options.outputDir)) throw new Error('An absolute Windows output directory is required.');
  if (!['local', 'youtube', 'all'].includes(options.access)) throw new Error('Unknown website access setting.');
  if (!Array.isArray(options.origins) || options.origins.some(one => typeof one !== 'string')) throw new Error('An origin list is required.');
  return ['--cdp-endpoint', endpoint, ...(options.access === 'all' ? [] : ['--allowed-origins', options.origins.join(';')]), '--output-dir', options.outputDir];
}

// Read /json/version only. Never initialize MCP, select, create or navigate a tab.
export async function checkEndpoint(options = {}, { fetcher = fetch } = {}) {
  const endpoint = windowsEndpoint(options);
  const response = await fetcher(`${endpoint}/json/version`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Windows CDP answered HTTP ${response.status}.`);
  const info = await response.json();
  const expected = (options.browser ?? 'msedge') === 'msedge' ? /^Edg\// : /^Chrome\//;
  if (!expected.test(info.Browser ?? '') || (options.browser === 'chrome' && /Edg\//.test(info.Browser))) throw new Error('The CDP browser does not match BROWSER. Check the dedicated profile and port.');
  const ws = new URL(info.webSocketDebuggerUrl);
  if (ws.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(ws.hostname) || ws.port !== new URL(endpoint).port || ws.username || ws.password)
    throw new Error('The browser advertised a non-loopback CDP endpoint.');
  return { ok: true, checked: true, browserVersion: info.Browser };
}

async function worker(action, options) {
  const packageDir = join(options.appdata, 'MADRE', 'browser-server', 'node_modules', '@playwright', 'mcp');
  const installed = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  if (installed.version !== WINDOWS_MCP_VERSION) throw new Error(`Install @playwright/mcp@${WINDOWS_MCP_VERSION} in Windows LOCALAPPDATA/MADRE/browser-server (found ${installed.version}).`);
  if (action === 'version') { console.log(JSON.stringify({ ok: true, version: installed.version })); return; }
  const check = await checkEndpoint(options);
  if (action === 'probe') { console.log(JSON.stringify({ ...check, version: installed.version })); return; }
  if (action !== 'server') throw new Error('Unknown bridge action.');
  const args = windowsMcpArgs(options);
  await mkdir(options.outputDir, { recursive: true });
  // Spawn node directly: no npm.cmd, shell, global package lookup or automatic installation.
  const childEnv = windowsEnvironment();
  const child = spawn(process.execPath, [join(packageDir, 'cli.js'), ...args], { cwd: options.projectRoot, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
  forwardWindowsMcp(child);
}

export function forwardWindowsMcp(child, { input = process.stdin, output = process.stdout, errorOutput = process.stderr, onExit = code => process.exit(code), heartbeatTimeoutMs = 12000, graceMs = 2000, watchIntervalMs = 1000 } = {}) {
  child.stdout.pipe(output);
  child.stderr.pipe(errorOutput);
  child.stdin.on('error', () => {});
  let lastBeat = Date.now();
  let stopping = false;
  let deadline;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(watch);
    child.stdin.end();
    // Only this node process belongs to us. Never taskkill a browser or its process tree.
    deadline = setTimeout(() => child.kill(), graceMs);
  };
  const watch = setInterval(() => { if (Date.now() - lastBeat > heartbeatTimeoutMs) stop(); }, watchIntervalMs);
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { stop(); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { stop(); return; }
    if (message.method === HEARTBEAT) { lastBeat = Date.now(); return; }
    // Linux file:// roots are not Windows workspace paths. Let MCP use its converted cwd
    // instead of advertising a roots capability whose replies refer to another OS.
    if (message.method === 'initialize' && message.params?.capabilities?.roots) {
      delete message.params.capabilities.roots;
      line = JSON.stringify(message);
    }
    if (!stopping) child.stdin.write(`${line}\n`);
  });
  lines.on('close', stop);
  const finish = code => { clearInterval(watch); clearTimeout(deadline); stopping = true; lines.close(); onExit(code); };
  child.on('error', error => { errorOutput.write(`${error.message}\n`); finish(1); });
  child.on('close', code => finish(stopping ? 0 : (code ?? 1)));
}

export async function windowsOutputPath(outputDir, { makeDirectory = mkdir, convert = windowsPath } = {}) {
  await makeDirectory(outputDir, { recursive: true });
  return convert(outputDir);
}

async function relay(action, options) {
  windowsEndpoint(options);
  const env = windowsEnvironment();
  const runtime = await windowsRuntime(env);
  const workerPath = await windowsPath(WINDOWS_BRIDGE);
  const data = { ...options, appdata: runtime.appdata };
  if (action === 'server') {
    data.outputDir = await windowsOutputPath(options.outputDir);
    data.projectRoot = await windowsPath(options.projectRoot);
  }
  const child = spawn(runtime.command, [workerPath, 'worker', action, JSON.stringify(data)], { env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdin.on('error', () => {});
  let beat;
  if (action === 'server') {
    // Line framing keeps heartbeats from splitting a JSON-RPC message across writes.
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on('line', line => { if (!child.stdin.writableEnded) child.stdin.write(`${line}\n`); });
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      clearInterval(beat); lines.close(); child.stdin.end(); process.stdin.pause();
    };
    lines.on('close', stop);
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    process.on('SIGHUP', stop);
    beat = setInterval(() => { if (!child.stdin.writableEnded) child.stdin.write(`${JSON.stringify({ method: HEARTBEAT })}\n`); }, 2000);
  } else child.stdin.end();
  child.on('error', error => { console.error(error.message); process.exit(1); });
  child.on('close', code => { clearInterval(beat); process.exit(code ?? 1); });
}

if (process.argv[1] && resolve(process.argv[1]) === WINDOWS_BRIDGE) {
  try {
    if (process.argv[2] === 'worker') {
      if (process.platform !== 'win32') throw new Error('The bridge worker must run in Windows.');
      await worker(process.argv[3], JSON.parse(process.argv[4]));
    } else await relay(process.argv[2], JSON.parse(process.argv[3]));
  } catch (error) { console.error(`Windows browser: ${error.message}`); process.exitCode = 1; }
}

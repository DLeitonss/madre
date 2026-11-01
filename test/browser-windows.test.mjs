import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import browserModule, { playwrightServerFor, preparePlaywright, playwrightHealth, forgetPlaywrightHealth, windowsTurnReady, windowsRelayEnvironment, PLAYWRIGHT_TOOLS } from '../src/modules/playwright.mjs';
import { windowsEndpoint, windowsPath, windowsOutputPath, windowsCommand, windowsMcpArgs, windowsCheck, checkEndpoint, forwardWindowsMcp, windowsEnvironment, windowsRuntime, WINDOWS_MCP_VERSION } from '../src/modules/playwright-windows.mjs';
import { codexMcpOverrides } from '../src/adapters/codex.mjs';

const config = extra => ({ modules: { playwright: { enabled: true, connection: 'windows', browser: 'chrome', ...extra } } });
const options = extra => ({ port: 4319, outputDir: '/tmp/a b/$shots', projectRoot: '/home/project', connection: 'windows', browser: 'chrome', ...extra });
const payload = server => JSON.parse(server.args[2]);

test('Windows recovers on the next turn after the browser opens or reopens', async () => {
  forgetPlaywrightHealth();
  const settings = { browser: 'chrome', connection: 'windows', cwd: '/test-recovery', env: {} };
  let open = false;
  let probes = 0;
  const check = async () => { probes++; return { ok: open, problem: open ? undefined : 'closed' }; };
  try {
    for (const state of [false, true, false, true]) {
      open = state;
      assert.equal(await windowsTurnReady(settings, { check }), state);
    }
    assert.equal(probes, 4);
    assert.equal(playwrightHealth({ ...settings, env: { PULSE_PLAYWRIGHT_CHECK: '0' } }).ok, true);
  } finally { forgetPlaywrightHealth(); }
});

test('failed Windows health retries immediately while local failures stay cached', async () => {
  forgetPlaywrightHealth();
  const check = async () => ({ ok: true });
  try {
    for (const connection of ['windows', 'local']) {
      const settings = { browser: 'chrome', connection, cwd: '/test-retry', env: {} };
      forgetPlaywrightHealth({ ok: false, problem: 'closed' }, 'chrome', settings);
      assert.equal(playwrightHealth({ ...settings, check }).ok, false);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(playwrightHealth({ ...settings, check }).ok, connection === 'windows');
    }
  } finally { forgetPlaywrightHealth(); }
});

test('Windows output directory exists before conversion and mkdir failures stop conversion', async () => {
  const calls = [];
  const outputDir = '/tmp/not-created-yet/screenshots';
  const converted = await windowsOutputPath(outputDir, {
    makeDirectory: async (path, flags) => { calls.push('mkdir'); assert.equal(path, outputDir); assert.deepEqual(flags, { recursive: true }); },
    convert: async path => { assert.deepEqual(calls, ['mkdir']); assert.equal(path, outputDir); calls.push('convert'); return 'C:\\screenshots'; },
  });
  assert.equal(converted, 'C:\\screenshots');
  assert.deepEqual(calls, ['mkdir', 'convert']);
  await assert.rejects(windowsOutputPath(outputDir, {
    makeDirectory: async () => { throw new Error('denied'); },
    convert: () => assert.fail('must not convert after mkdir fails'),
  }), /denied/);
});

test('Windows card reports unsupported BROWSER before suggesting server installation', async () => {
  const result = await browserModule.describe({ config: config({ browser: 'chromium' }), stateRoot: '/tmp', env: {}, projectRoot: '/missing' });
  assert.equal(result.preflight.ok, false);
  assert.match(result.preflight.problems.join(' '), /BROWSER = chrome (?:or|o) msedge/);
  assert.doesNotMatch(result.status.detail, /Install the pinned|Instala/);
});

test('only Windows omits browser_close and preserves all other tools', () => {
  const local = playwrightServerFor(options({ connection: 'local' }));
  const windows = playwrightServerFor(options());
  assert.deepEqual(local.tools, PLAYWRIGHT_TOOLS);
  assert.ok(local.tools.includes('browser_close'));
  assert.deepEqual(windows.tools, local.tools.filter(tool => tool !== 'browser_close'));
});

test('the connection is opt-in and each Windows browser has its own port', () => {
  assert.equal(browserModule.settingsFrom({}).connection, 'local');
  assert.equal(windowsEndpoint({ browser: 'chrome' }), 'http://127.0.0.1:9223');
  assert.equal(windowsEndpoint({ browser: 'msedge' }), 'http://127.0.0.1:9222');
  assert.equal(windowsEndpoint({ browser: 'chrome', cdpEndpoint: 'http://127.0.0.1:9323/' }), 'http://127.0.0.1:9323');
});

test('remote CDP, credentials, paths and unsupported browsers are rejected', () => {
  for (const cdpEndpoint of ['https://127.0.0.1:9222', 'http://0.0.0.0:9222', 'http://192.168.1.1:9222', 'http://localhost:9222', 'http://u:p@127.0.0.1:9222', 'http://127.0.0.1:9222/path', 'http://127.0.0.1:9222/?token=x', 'http://127.0.0.1:9222/#x', 'http://127.0.0.1'])
    assert.throws(() => windowsEndpoint({ browser: 'chrome', cdpEndpoint }), undefined, cdpEndpoint);
  for (const browser of ['chromium', 'firefox', 'webkit']) assert.throws(() => windowsEndpoint({ browser }));
});

test('Windows server receives restrictions and output paths as JSON data', () => {
  for (const browser of ['chrome', 'msedge']) for (const access of ['local', 'youtube', 'all']) {
    const server = playwrightServerFor(options({ browser, access, servers: [8080], session: 'isolated', headless: true }));
    assert.equal(server.command, process.execPath);
    assert.equal(server.required, true);
    assert.equal(server.args[1], 'server');
    const data = payload(server);
    assert.equal(data.outputDir, '/tmp/a b/$shots');
    assert.equal(data.access, access);
    assert.ok(data.origins.includes('http://127.0.0.1:8080'));
    if (access === 'youtube') assert.ok(data.origins.includes('https://accounts.google.com'));
    const args = windowsMcpArgs({ ...data, outputDir: 'C:\\a b\\$shots' });
    assert.equal(args.includes('--allowed-origins'), access !== 'all');
    assert.equal(args[args.indexOf('--output-dir') + 1], 'C:\\a b\\$shots');
    for (const flag of ['--isolated', '--user-data-dir', '--headless', '--browser', '--no-sandbox']) assert.ok(!args.includes(flag));
    assert.match(server.brief, /no project isolation/);
    assert.match(server.brief, /persist after the turn/);
    assert.match(server.brief, /Never ask for passwords/);
    assert.match(server.brief, /Always open a new tab/);
    assert.match(server.brief, /not a security boundary/);
    assert.doesNotMatch(server.brief, /discarded after this turn|no window/);
  }
});

test('Windows relay forwards only WSL coordinates and Codex waits for it', () => {
  const env = { WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/WSL/123_interop', PATH: '/bin', TOKEN: 'secret' };
  assert.deepEqual(windowsRelayEnvironment(env), { WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/WSL/123_interop' });
  const server = playwrightServerFor(options({ env }));
  assert.deepEqual(server.env, { WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/WSL/123_interop' });
  const overrides = codexMcpOverrides(server);
  assert.ok(overrides.includes(`mcp_servers.${server.name}.required=true`));
  assert.ok(overrides.includes(`mcp_servers.${server.name}.env={ WSL_DISTRO_NAME = "Ubuntu", WSL_INTEROP = "/run/WSL/123_interop" }`));
});

test('path conversion uses literal argv for spaces, quotes and shell metacharacters', async () => {
  const path = '/home/a b/"quoted"/$(literal);x';
  let called;
  const converted = await windowsPath(path, { run: async (...args) => { called = args; return { stdout: '\\\\wsl.localhost\\Ubuntu\\home\\a b\\"quoted"\\$(literal);x\n' }; } });
  assert.equal(called[0], 'wslpath');
  assert.deepEqual(called[1], ['-w', path]);
  assert.match(converted, /^\\\\wsl.localhost/);
  await assert.rejects(windowsPath('relative'));
  await assert.rejects(windowsPath('/tmp/path', { run: async () => ({ stdout: 'relative' }) }));
});

test('preparation never installs a Linux package for the Windows connection', async () => {
  const result = await preparePlaywright({ connection: 'windows', browser: 'msedge',
    run: () => assert.fail('must not install'), version: () => assert.fail('must not resolve Linux version'),
    starts: async data => { assert.equal(data.connection, 'windows'); return { ok: false, problem: 'Open Edge in Windows' }; },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.steps, []);
});

test('Windows update explains the pin without offering a Linux install command', async () => {
  const plan = await browserModule.updatePlan({ config: config(), stateRoot: '/tmp' }, { latest: '999.0.0' });
  assert.equal(plan.command, null);
  assert.ok(plan.note.includes(WINDOWS_MCP_VERSION));
});

test('Windows failures use their own remedy and never recommend a Linux install', () => {
  const windowsError = 'TEST BROWSER stays off: Windows connection failed (Windows Node.js is missing). Install the pinned Windows browser server.';
  const windowsCondition = browserModule.conditions.find(condition => condition.code === 'MU-075');
  const localCondition = browserModule.conditions.find(condition => condition.code === 'MU-054');
  assert.ok(windowsCondition.match.test(windowsError));
  assert.equal(localCondition.match.test(windowsError), false);
  assert.match(windowsCondition.remedy, /Windows browser guide/);
  assert.doesNotMatch(JSON.stringify(windowsCondition.fixes), /npm install -g|npx @playwright/);
});

test('Windows runtime rejects Node below 20 before starting the pinned server', async () => {
  const env = { WSL_DISTRO_NAME: 'Ubuntu' };
  const run = async (command, args) => {
    if (command.endsWith('powershell.exe')) return { stdout: JSON.stringify({ node: 'C:\\Program Files\\nodejs\\node.exe', appdata: 'C:\\Users\\human\\AppData\\Local' }) };
    if (command === 'wslpath') return { stdout: '/mnt/c/Program Files/nodejs/node.exe\n' };
    assert.deepEqual(args, ['-p', 'process.versions.node']);
    return { stdout: '18.17.0\n' };
  };
  await assert.rejects(windowsRuntime(env, { run }), /requires Windows Node\.js >=20 \(found 18\.17\.0\)/);
});

test('a probe only reads CDP metadata and refuses redirects or a mismatched browser', async () => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ Browser: 'Edg/156.0', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/id' }) }; };
  const result = await checkEndpoint({ browser: 'msedge' }, { fetcher });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(c => c.url), ['http://127.0.0.1:9222/json/version']);
  assert.equal(calls[0].init.redirect, 'error');
  await assert.rejects(checkEndpoint({ browser: 'chrome', cdpEndpoint: 'http://127.0.0.1:9222' }, { fetcher }), /does not match/);
  await assert.rejects(checkEndpoint({ browser: 'msedge' }, { fetcher: async () => ({ ok: true, json: async () => ({ Browser: 'Edg/1', webSocketDebuggerUrl: 'ws://example.com:9222/id' }) }) }), /non-loopback/);
});

test('Windows diagnostics report bridge failures without falling back to npm', async () => {
  const result = await windowsCheck('probe', { browser: 'chrome' }, { run: async (command, args) => {
    assert.equal(command, process.execPath);
    assert.equal(args[1], 'probe');
    throw Object.assign(new Error('failed'), { stderr: 'Windows Node.js is missing' });
  } });
  assert.equal(result.ok, false);
  assert.match(result.problem, /Windows Node.js/);
  assert.throws(() => windowsCommand('server', { browser: 'webkit' }));
});

test('Windows processes cannot inherit MCP overrides or Node preload paths', () => {
  const env = { PATH: '/bin', WSL_DISTRO_NAME: 'Ubuntu', NODE_OPTIONS: '--require /linux/preload.cjs', Node_Path: '/linux/modules', PLAYWRIGHT_MCP_CDP_ENDPOINT: 'http://remote:9222', playwright_mcp_allow_unrestricted_file_access: '1' };
  assert.deepEqual(windowsEnvironment(env), { PATH: '/bin', WSL_DISTRO_NAME: 'Ubuntu' });
  assert.equal(env.NODE_OPTIONS, '--require /linux/preload.cjs');
});

test('health cache separates local, Windows, browsers, endpoints and project roots', async () => {
  forgetPlaywrightHealth();
  const variants = [
    { browser: 'chrome', connection: 'local' },
    { browser: 'chrome', connection: 'windows' },
    { browser: 'msedge', connection: 'windows' },
    { browser: 'chrome', connection: 'windows', cdpEndpoint: 'http://127.0.0.1:9333' },
    { browser: 'chrome', connection: 'windows', cwd: '/another-project' },
  ];
  const checks = [];
  for (const variant of variants) {
    assert.equal(playwrightHealth({ ...variant, env: {}, check: async data => { checks.push(data); return { ok: true, marker: checks.length }; } }), null);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks.length, variants.length);
  assert.deepEqual(variants.map(variant => playwrightHealth({ ...variant, env: {} }).marker), [1, 2, 3, 4, 5]);
  assert.equal(playwrightHealth({ browser: 'firefox', connection: 'windows', env: {} }).ok, false);
  forgetPlaywrightHealth();
});

test('ghost and unrelated code turns do not start the Windows bridge', async () => {
  const ctx = { config: config(), stateRoot: '/tmp', env: {}, projectRoot: '/missing' };
  assert.deepEqual(await browserModule.toolsForTurn(ctx, { mode: 0, text: 'browser' }), []);
  assert.deepEqual(await browserModule.toolsForTurn(ctx, { mode: 3, text: 'cambia el título' }), []);
});

test('Windows worker forwards RPC but keeps heartbeats private and stops its child on EOF', async () => {
  const input = new PassThrough();
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let received = '';
  child.stdin.on('data', chunk => { received += chunk; });
  let kills = 0;
  child.kill = () => { kills++; child.emit('close', null); };
  const exited = new Promise(resolve => forwardWindowsMcp(child, { input, output: new PassThrough(), errorOutput: new PassThrough(), graceMs: 5, onExit: resolve }));
  input.write('{"method":"madre/windows-heartbeat"}\n');
  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  input.end();
  assert.equal(await exited, 0);
  assert.equal(kills, 1);
  assert.equal(received, '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
});

test('Windows worker also stops an orphan when WSL heartbeats disappear', async () => {
  const input = new PassThrough();
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit('close', null);
  const exited = new Promise(resolve => forwardWindowsMcp(child, { input, output: new PassThrough(), errorOutput: new PassThrough(), graceMs: 5, heartbeatTimeoutMs: 15, watchIntervalMs: 5, onExit: resolve }));
  assert.equal(await exited, 0);
  assert.equal(child.stdin.writableEnded, true);
  input.destroy();
});

test('Windows MCP uses its converted cwd instead of requesting Linux workspace roots', async () => {
  const input = new PassThrough();
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const received = [];
  child.stdin.on('data', chunk => received.push(JSON.parse(chunk.toString())));
  child.kill = () => child.emit('close', null);
  const exited = new Promise(resolve => forwardWindowsMcp(child, { input, output: new PassThrough(), errorOutput: new PassThrough(), graceMs: 5, onExit: resolve }));
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: { roots: { listChanged: true }, sampling: {} }, clientInfo: { name: 'test', version: '1' } } }) + '\n');
  input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_snapshot"}}\n');
  input.end();
  assert.equal(await exited, 0);
  assert.deepEqual(received[0].params.capabilities, { sampling: {} });
  assert.deepEqual(received[0].params.clientInfo, { name: 'test', version: '1' });
  assert.equal(received[1].method, 'tools/call');
});

test('invalid JSON-RPC input stops only the owned MCP process', async () => {
  const input = new PassThrough();
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let killed = false;
  child.kill = () => { killed = true; child.emit('close', null); };
  const exited = new Promise(resolve => forwardWindowsMcp(child, { input, output: new PassThrough(), errorOutput: new PassThrough(), graceMs: 5, onExit: resolve }));
  input.write('null\n');
  assert.equal(await exited, 0);
  assert.equal(killed, true);
  assert.equal(child.stdin.writableEnded, true);
  input.destroy();
});

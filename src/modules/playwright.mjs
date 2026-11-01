// SPDX-License-Identifier: BUSL-1.1
// MADRE · © 2026 Jossue Alcalá · Business Source License 1.1: LICENSE
// PLAYWRIGHT: a browser for every agent, local and isolated by default.
// Module controls can opt into general web access and persistent sessions.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { t } from '../i18n.mjs';
import { defineModule } from './sdk.mjs';
import { switchIn } from '../module-scope.mjs';
import { packageVersion } from './helpers.mjs';
import { terminateProcessTree, lastWords } from '../adapters/process.mjs';
import { WINDOWS_MCP_VERSION, windowsCheck, windowsCommand, windowsEndpoint } from './playwright-windows.mjs';

export const PLAYWRIGHT_PACKAGE = '@playwright/mcp';
export const PLAYWRIGHT_BROWSERS = ['chromium', 'firefox', 'webkit'];
// Channels drive the Chrome or Edge already installed on this computer. MADRE does not download
// them (`install-browser chrome` wants system packages), so they are offered but never fetched.
export const PLAYWRIGHT_CHANNELS = ['chrome', 'msedge'];
export const PLAYWRIGHT_BROWSER_CHOICES = [...PLAYWRIGHT_BROWSERS, ...PLAYWRIGHT_CHANNELS];
export const isChannel = (browser) => PLAYWRIGHT_CHANNELS.includes(browser);
// The browser the server downloads for each engine: `install-browser` is `playwright install <name>`
// underneath, so the name is the engine's own. The remedy used to say chrome-for-testing whatever
// was chosen, and a person on webkit installed a browser that could never fix it (2026-10-14).
export const installBrowserLine = (browser = 'chromium') => `npx ${PLAYWRIGHT_PACKAGE} install-browser ${PLAYWRIGHT_BROWSERS.includes(browser) ? browser : 'chromium'}`;
export const PLAYWRIGHT_SERVER_NAME = 'pulse-playwright';
// The tools @playwright/mcp exposes that a room turn may use. Screenshots and files land in scratch.
export const PLAYWRIGHT_TOOLS = ['browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_fill_form', 'browser_hover', 'browser_press_key', 'browser_select_option', 'browser_wait_for', 'browser_console_messages', 'browser_network_requests', 'browser_take_screenshot', 'browser_resize', 'browser_tabs', 'browser_close'];

let probe = { at: 0, version: null };
const windowsVersions = new Map();
// Is @playwright/mcp installed where npx can find it without downloading? Read from the package
// itself, never asked of it: `npx --no <package> --version` answers with npm's own version and
// exits cleanly when the package is not there, so it said 11.16.0 for a server never installed.
export async function playwrightVersion({ env = process.env, projectRoot = process.cwd(), now = Date.now(), fresh = false, connection = 'local', browser = 'chromium', cdpEndpoint = '' } = {}) {
  if (connection === 'windows') {
    let key;
    try { key = healthKey({ browser, connection, cdpEndpoint, cwd: projectRoot }); } catch { return null; }
    let entry = windowsVersions.get(key);
    if (!fresh && entry && now - entry.at < 60000) return entry.version;
    if (!entry?.asking) {
      entry = { at: 0, version: null, asking: null };
      windowsVersions.set(key, entry);
      entry.asking = windowsCheck('version', { browser, cdpEndpoint }, { env, cwd: projectRoot }).then(found => {
        entry.version = found.ok ? found.version : null;
        entry.at = Date.now();
        entry.asking = null;
        return entry.version;
      });
    }
    return entry.asking;
  }
  if (!fresh && now - probe.at < 60000) return probe.version;
  const version = await packageVersion(PLAYWRIGHT_PACKAGE, { env, projectRoot });
  probe = { at: now, version };
  return version;
}

// Why npm stopped, in its own words: the line that says it, not the last one, which only points at
// a log file («npm error A complete log of this run can be found in …», 2026-10-18).
export function npmReason(output) {
  const lines = String(output ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const said = lines.filter((line) => /^npm (error|ERR!)/i.test(line)).map((line) => line.replace(/^npm (error|ERR!)\s*/i, '')).filter((line) => line && !/complete log of this run|^(code|errno|syscall)\b/i.test(line));
  return said.find((line) => !/^path\b/i.test(line)) ?? said[0] ?? lastWords(output);
}

// One command of the module's own, run to its end with no terminal: getting the server or its
// browser onto this computer. What it printed last is kept for the case it fails.
function runToEnd(command, args, { cwd, env, timeoutMs = 900000 } = {}) {
  return new Promise((resolve) => {
    let err = '';
    let child;
    try { child = spawn(command, args, { cwd, env: { ...env, CI: '1', NO_COLOR: '1' }, stdio: ['ignore', 'ignore', 'pipe'], shell: false, detached: true, windowsHide: true }); }
    catch (error) { resolve({ code: 1, said: error.message }); return; }
    const timer = setTimeout(() => terminateProcessTree(child, { graceMs: 1000 }), timeoutMs);
    timer.unref?.();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-4000); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: 1, said: error.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, said: npmReason(err) }); });
  });
}

// What the switch puts in place by itself before it gives up (2026-10-18): the person turned it
// on, and a browser to download is MADRE's to fetch, not a line to copy into a terminal. The
// server, globally (where `npx --no` finds it at turn time), when it is missing; then the browser
// the server itself downloads for the engine chosen. Asked again after.
export async function preparePlaywright({ browser = 'chromium', env = process.env, cwd = process.cwd(), run = runToEnd, starts = playwrightStarts, version = playwrightVersion, connection = 'local', cdpEndpoint = '' } = {}) {
  // Windows installation is explicit. Never install Linux packages to repair a Windows server.
  if (connection === 'windows') return { ...await starts({ browser, connection, cdpEndpoint, env, cwd }), steps: [] };
  const engine = PLAYWRIGHT_BROWSERS.includes(browser) ? browser : 'chromium';
  let installed = await version({ env, projectRoot: cwd, fresh: true });
  const steps = [];
  if (!installed) {
    const server = await run('npm', ['install', '-g', PLAYWRIGHT_PACKAGE], { cwd, env });
    steps.push({ display: `npm install -g ${PLAYWRIGHT_PACKAGE}`, code: server.code });
    installed = await version({ env, projectRoot: cwd, fresh: true });
    if (!installed) return { ok: false, steps, problem: server.said ?? t('the browser server could not be installed') };
  }
  // A channel is the Chrome or Edge the person already has: nothing for MADRE to download.
  if (isChannel(browser)) {
    const check = await starts({ browser, env, cwd });
    return { ...check, steps, ...(check.ok ? {} : { problem: check.problem ?? t('{browser} is not installed on this computer', { browser }) }) };
  }
  const fetched = await run('npx', ['--no', PLAYWRIGHT_PACKAGE, 'install-browser', engine], { cwd, env });
  steps.push({ display: installBrowserLine(engine), code: fetched.code });
  const check = await starts({ browser, env, cwd });
  return { ...check, steps, ...(check.ok ? {} : { problem: check.problem ?? fetched.said }) };
}

// Does the browser server start, with its browser? Asked when the switch is turned on, with the
// same server a turn gets: the card said «on · chromium» while every turn's server closed before it
// spoke, and the agents saw only CONNECTION_CLOSED. It is asked to open about:blank, because a
// server without its browser starts fine and fails only at the first page.
// What the server says when another browser already holds the profile directory: the server's own
// «Browser is already in use for <dir>», or Chromium's ProcessSingleton / exit code 21.
export const PROFILE_BUSY = /already in use|ProcessSingleton|exitCode=21|existing browser session/i;

// The arguments of the start check. Isolated and headless unless asked otherwise; given a profile
// it opens that saved session instead, which is the only way to find out the directory can be used.
export function startCheckArgs({ browser = 'chromium', outputDir, profile = null, headless = true }) {
  return ['--no', PLAYWRIGHT_PACKAGE, '--', ...(headless ? ['--headless'] : []), ...(profile ? ['--user-data-dir', profile] : ['--isolated']), '--browser', browser, '--output-dir', outputDir, '--no-sandbox'];
}

export async function playwrightStarts({ browser = 'chromium', env = process.env, cwd = process.cwd(), timeoutMs = 60000, command = 'npx', args = null, profile = null, headless = true, connection = 'local', cdpEndpoint = '' } = {}) {
  if (connection === 'windows') return windowsCheck('probe', { browser, cdpEndpoint }, { env, cwd });
  // npx is a .cmd shim on Windows and there is no shell to run it (WIN-027): not asked there.
  if (process.platform === 'win32' && command === 'npx') return { ok: true, checked: false };
  const outputDir = await mkdtemp(join(tmpdir(), 'madre-playwright-'));
  const argv = args ?? startCheckArgs({ browser, outputDir, profile, headless });
  return new Promise((resolve) => {
    let child = null;
    let out = '';
    let err = '';
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child) terminateProcessTree(child, { graceMs: 1000 });
      rm(outputDir, { recursive: true, force: true }).catch(() => {});
      // A saved session held by another browser is not a browser that fails to start: it works the
      // moment that window closes. Said as busy, so it never reads as «does not start» and never
      // takes the tools away from the turns that follow.
      resolve(profile && result.ok === false && PROFILE_BUSY.test(String(result.problem ?? '')) ? { ok: true, checked: true, busy: true } : result);
    };
    try {
      child = spawn(command, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: true, windowsHide: true });
    } catch (error) {
      finish({ ok: false, problem: error.message });
      return;
    }
    timer = setTimeout(() => finish({ ok: false, problem: t('it did not answer within {seconds}s', { seconds: Math.round(timeoutMs / 1000) }) }), timeoutMs);
    timer.unref?.();
    const send = (message) => { if (!settled) child.stdin.write(`${JSON.stringify(message)}\n`); };
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      for (let newline = out.indexOf('\n'); newline >= 0; newline = out.indexOf('\n')) {
        const line = out.slice(0, newline).trim();
        out = out.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) { finish({ ok: false, problem: String(message.error.message ?? 'initialize failed') }); return; }
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'about:blank' } } });
        } else if (message.id === 2) {
          // The reason, without the path of the executable it looked for or the command it suggests:
          // the card and the refusal say what to run, in the room's words.
          const said = (message.result?.content ?? []).map((part) => part?.text ?? '').join(' ').replace(/^#+\s*Error\s*/i, '').replace(/^Error:\s*/i, '').replace(/;\s*expected executable at[\s\S]*$/i, '').replace(/\s+/g, ' ').trim();
          if (message.error || message.result?.isError) { finish({ ok: false, problem: String(message.error?.message ?? said).slice(0, 300) }); return; }
          finish({ ok: true, checked: true });
          return;
        }
      }
    });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => finish({ ok: false, problem: error.message }));
    child.on('close', (code) => finish({ ok: false, problem: npmReason(err) ?? t('it exited with code {code} before it spoke', { code }) }));
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'madre', version: '1' } } });
  });
}

// A turn that asks to look at a page, click through it, test it, read its console or take a picture
// of it, in the two languages the crew is spoken to here. A page merely named is not one: «cambia el
// lema de la página» needs no browser.
export const BROWSER_INTENT = /navegador|browser|playwright|captura|screenshot|pantallazo|\bclic|\bclick|consola|console|responsive|m[oó]vil|mobile|viewport|ancho de|se ve\b|c[oó]mo (se )?ve|visual|vista previa|preview|ripley|interfaz|\bui\b|\bux\b|e2e|end.to.end|pru[eé]ba(lo|la|las|los)? en|test (it|the page|in the browser)|abre (la|el) (p[aá]gina|app|sitio)|open the (page|app|site)|smoke test/i;
// YouTube and sign-in words count only when the person gave the browser YouTube access: with
// WEBSITES = local «arregla el formulario de login» is a code change, and carrying the sixteen
// browser tools into it is the cost the paragraph above describes. Word boundaries, or «design in»
// and «catalog in» read as «sign in» and «log in».
export const YOUTUBE_INTENT = /\byoutube\b|studio\.youtube\.com|\binici(?:a|ar|e|o) (?:de )?sesi[oó]n|\blog[ -]?in\b|\bsign[ -]?in\b/i;
export const WEB_INTENT = /https?:\/\/[^\s]+|\b(?:abre|abrir|visita|visitar|navega|navegar|open|visit|browse)\b.*\b(?:sitio|web|p[aá]gina|site|website|https?)\b|\binici(?:a|ar|e|o) (?:de )?sesi[oó]n|\blog[ -]?in\b|\bsign[ -]?in\b/i;
// A site named by its domain: «busquemos youtube.com» has no URL scheme and no «sitio/página» noun,
// so WEB_INTENT misses it. It counts only as a navigation verb plus a domain with a well-known
// ending, or a `www.` address: file names such as package.json or app.js never match, and a domain
// merely quoted in a code change («cambia el dominio a example.com») carries no verb of navigation.
export const WEB_VERB = /\b(?:busc\w+|busqu\w+|ve a|ir a|vamos a|entra\w* (?:a|en)|accede\w*|visita\w*|abre\w*|navega\w*|go to|search|look up|open|visit|browse)\b/i;
export const WEB_DOMAIN = /(?<![\w@/\\.-])\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:(?:(?:com|co|go|gob|org|net|edu)\.)?(?:io|tv|co|ai|me|be|es|mx|ar|cl|uk|cr|de|fr|it|br|pe|ve|uy|ec|ca)|com|org|net|app|dev|edu|gov|info|xyz)(?![\w-]|\.\w)/i;
export const WWW_ADDRESS = /\bwww\.[a-z0-9-]+\.[a-z]{2,}/i;
export const wantsWebsite = (text) => { const said = String(text ?? ''); return WEB_INTENT.test(said) || WWW_ADDRESS.test(said) || (WEB_VERB.test(said) && WEB_DOMAIN.test(said)); };
export const wantsBrowser = (text, { access = 'local' } = {}) => BROWSER_INTENT.test(String(text ?? '')) || (access === 'youtube' && YOUTUBE_INTENT.test(String(text ?? ''))) || (access === 'all' && wantsWebsite(text));

// The last answer to «does it start?», for a switch that was already on: asked again in the
// background at most every ten minutes, so the card can say the browser is missing and no turn
// carries a server that would only fail.
// The answer belongs to the browser it was asked about: chosen another, it is asked again, or a
// browser that does not start would ride on the answer of one that does.
const healthChecks = new Map();
const healthKey = ({ browser = 'chromium', connection = 'local', cdpEndpoint = '', cwd = process.cwd() }) => JSON.stringify([browser, connection, connection === 'windows' ? windowsEndpoint({ browser, cdpEndpoint }) : '', cwd]);
export function playwrightHealth({ browser = 'chromium', env = process.env, cwd = process.cwd(), now = Date.now(), check = playwrightStarts, connection = 'local', cdpEndpoint = '' } = {}) {
  const options = { browser, connection, cdpEndpoint, cwd };
  let key;
  try { key = healthKey(options); } catch (error) { return { ok: false, problem: error.message }; }
  let entry = healthChecks.get(key);
  if (!entry) { entry = { at: 0, result: null, asking: null }; healthChecks.set(key, entry); }
  if (env.PULSE_PLAYWRIGHT_CHECK === '0') return entry.result;
  if (!entry.asking && (!entry.at || now - entry.at > 10 * 60 * 1000 || (connection === 'windows' && entry.result?.ok === false))) {
    entry.asking = Promise.resolve().then(() => check({ ...options, env })).then(result => {
      entry.at = Date.now(); entry.result = result; entry.asking = null; return result;
    }, () => { entry.asking = null; return null; });
  }
  return entry.result;
}
export function forgetPlaywrightHealth(result = null, browser = 'chromium', options = {}) {
  if (!result) { healthChecks.clear(); return; }
  healthChecks.set(healthKey({ ...options, browser }), { at: Date.now(), result, asking: null });
}

const connectionOptions = (settings = {}) => ({ browser: settings.browser ?? 'chromium', connection: settings.connection ?? 'local', cdpEndpoint: settings.cdpEndpoint ?? '' });

export async function windowsTurnReady(options, { check = playwrightStarts } = {}) {
  const health = await check(options);
  forgetPlaywrightHealth(health, options.browser, options);
  return health.ok;
}

// External access and shared accounts are explicit choices in the module controls.
export const YOUTUBE_ORIGINS = [
  'https://studio.youtube.com', 'https://www.youtube.com',
  'https://accounts.google.com', 'https://accounts.youtube.com',
  'https://myaccount.google.com', 'https://www.google.com',
  'https://*.google.com', 'https://*.youtube.com', 'https://*.gstatic.com',
  'https://*.googleapis.com', 'https://*.googleusercontent.com',
  'https://*.ytimg.com', 'https://*.ggpht.com',
];
const YOUTUBE_HOSTS = [...new Set(YOUTUBE_ORIGINS.map(origin => origin.replace(/^https:\/\/(?:\*\.)?/, '')))];

export function browserProfile({ session = 'isolated', projectRoot, browser = 'chromium' }) {
  if (session === 'shared') return join(homedir(), '.local', 'share', 'madre', 'browser', browser);
  if (session === 'project') {
    if (!projectRoot) throw new Error('A project browser session needs projectRoot.');
    const id = createHash('sha256').update(projectRoot).digest('hex');
    return join(homedir(), '.local', 'share', 'madre', 'browser', 'projects', id, browser);
  }
  return null;
}

// Always include the room and its local servers. External origins are opt-in.
export function windowsRelayEnvironment(env = process.env) {
  // Codex starts configured MCP servers with the explicit env table. Forward only the two WSL
  // interop coordinates the relay needs; never copy credentials or the rest of MADRE's process.
  return Object.fromEntries(['WSL_DISTRO_NAME', 'WSL_INTEROP'].flatMap((key) => typeof env?.[key] === 'string' && env[key] ? [[key, env[key]]] : []));
}

export function playwrightServerFor({ port, outputDir, browser = 'chromium', headless = true, servers = [], access = 'local', session = 'isolated', projectRoot, connection = 'local', cdpEndpoint = '', env = process.env }) {
  const origins = [port, ...servers.filter((one) => Number.isInteger(one) && one !== port)].flatMap((one) => [`http://127.0.0.1:${one}`, `http://localhost:${one}`]);
  if (access === 'youtube') origins.push(...YOUTUBE_ORIGINS);
  if (connection === 'windows') {
    const endpoint = windowsEndpoint({ browser, cdpEndpoint });
    return {
      name: PLAYWRIGHT_SERVER_NAME,
      ...windowsCommand('server', { browser, cdpEndpoint: endpoint, outputDir, access, origins, projectRoot }),
      env: windowsRelayEnvironment(env), required: true, tools: PLAYWRIGHT_TOOLS.filter(tool => tool !== 'browser_close'),
      brief: `Use the dedicated Windows ${browser} browser connected at ${endpoint}. ${access === 'all' ? 'All website origins are allowed.' : `Allowed website origins: ${origins.join(';')}.`} Open MADRE at http://127.0.0.1:${port} and project previews at http://127.0.0.1:${port}/preview/project/<path>. Windows must be able to reach the WSL servers through localhost. Take screenshots without a filename so they land in ${outputDir}; explicit filenames resolve against the Windows workspace instead. Windows paths in tool responses refer to the same folders via wslpath. The converted project directory is the Windows workspace; Linux MCP roots are not forwarded. This external browser and its login persist after the turn. SESSION and SHOW THE WINDOW do not control it. All agents and projects using this endpoint share its tabs and account; there is no project isolation or concurrency queue. Use one agent at a time. Always open a new tab for the task before navigating. Never close, select, read or navigate unrelated tabs, browser-internal pages, account settings or extensions. Origin filtering is not a security boundary: redirects, pre-existing tabs and cross-tab console output may escape it. Disconnecting the server leaves the browser running. Never read, copy or commit its profile. ${signInLine({ headless: false, profile: 'external' })} Work only on the human's requested task.`,
    };
  }
  const profile = browserProfile({ session, projectRoot, browser });
  const served = servers.filter((one) => Number.isInteger(one) && one !== port);
  return {
    name: PLAYWRIGHT_SERVER_NAME,
    command: 'npx',
    // `--` or npm eats them: without the separator npm takes --headless, --isolated and the
    // rest as its own config, hands the server only their bare values, and the server exits with
    // "too many arguments" before it speaks a word of MCP. The agent sees CONNECTION_CLOSED.
    // No --blocked-origins: it would override the allowed routes. The server routes `**` to
    // abort and then routes each allowed origin to continue, and Playwright matches the most
    // recently added route first — so a blocked `*`, registered after both, wins over the
    // allowlist and aborts even this room with ERR_BLOCKED_BY_CLIENT.
    args: ['--no', '@playwright/mcp', '--', ...(headless ? ['--headless'] : []), ...(profile ? ['--user-data-dir', profile] : ['--isolated']), '--browser', browser, ...(access === 'all' ? [] : ['--allowed-origins', origins.join(';')]), '--output-dir', outputDir, '--no-sandbox'],
    env: {},
    tools: PLAYWRIGHT_TOOLS,
    brief: `${access === 'all' ? 'A general-purpose browser with access to websites and' : access === 'youtube' ? 'A browser with access to YouTube Studio and Google sign-in, plus' : 'A browser that reaches only'} this MADRE at http://127.0.0.1:${port}${served.length ? ` and the project's servers the human started (${served.map((one) => `http://127.0.0.1:${one}`).join(', ')})` : ''}. Open a project file rendered by RIPLEY at http://127.0.0.1:${port}/preview/project/<path>, click, read the console and network, take screenshots (they land in ${outputDir}). RIPLEY's preview keeps no data (no localStorage, no cookies)${served.length ? '; to try an app with its data, open it on its server' : ''}. ${access === 'all' ? `All website origins are allowed, including redirects and sign-in providers. Work only on the human's requested task. ${signInLine({ headless, profile })}` : access === 'youtube' ? `YouTube Studio and the configured Google/YouTube origins are also allowed. ${signInLine({ headless, profile })}` : 'External origins are blocked.'} ${profile ? `The ${session} session persists between turns and is available to every agent using this module. Only one browser can use this profile at a time: close the other window before retrying. Never read, copy, or commit the profile.` : 'The session is isolated and discarded after this turn.'}`,
  };
}

// What the agent is told about signing in, which depends on whether anyone can see the window and
// on whether the login would survive the turn. It used to say «sign in in the visible browser
// window» to a browser that had none, and to a session thrown away at the end of the turn.
export function signInLine({ headless = true, profile = null } = {}) {
  const never = 'Never ask for passwords or authentication codes, and never type them yourself.';
  if (!profile) return `The session is isolated, so a sign-in is lost when this turn ends: if a website asks to sign in, tell the human to set SESSION to project or shared in the TEST BROWSER settings${headless ? ' and turn SHOW THE WINDOW on' : ''}, then ask again. ${never}`;
  if (headless) return `This browser has no window, so nobody can sign in to it. If a website asks to sign in, do not try: tell the human to turn SHOW THE WINDOW on in the TEST BROWSER settings, sign in once in the window that opens, and ask again. A sign-in already saved in this session needs none of that. ${never}`;
  return `The browser window is visible on the human's screen. If a website asks to sign in, ask the human to sign in there and wait for them to say it is done. ${never}`;
}

async function playwrightReady(ctx) {
  const browser = ctx.settings.browser ?? 'chromium';
  if (ctx.settings.connection === 'windows') {
    const options = { ...connectionOptions(ctx.settings), env: ctx.env, cwd: ctx.projectRoot };
    const check = await playwrightStarts(options);
    if (check.ok) { forgetPlaywrightHealth(check, browser, options); return null; }
    return { status: 412, body: { error: t('TEST BROWSER stays off: Windows connection failed ({problem}). Install the pinned Windows server and open the selected browser with its dedicated profile and loopback CDP port; see the Windows browser guide.', { problem: check.problem }), code: 'MU-075' } };
  }
  let check = await playwrightStarts({ browser, env: ctx.env, cwd: ctx.projectRoot });
  // Something missing: MADRE fetches it, then asks again, before saying anything to the person.
  if (!check.ok && process.platform !== 'win32') {
    await ctx.record('extension.preparing', { id: 'playwright', name: 'PLAYWRIGHT', browser });
    check = await preparePlaywright({ browser, env: ctx.env, cwd: ctx.projectRoot });
  }
  forgetPlaywrightHealth(check, browser, { cwd: ctx.projectRoot });
  if (check.ok) {
    // The engine starts. With a saved session, the session's own directory has to open too: a
    // directory that cannot be written is found here, not by the first agent. A profile another
    // window holds is not a failure (playwrightStarts answers `busy`).
    const session = ctx.settings.session ?? 'isolated';
    const profile = session === 'project' && !ctx.projectRoot ? null : browserProfile({ session, projectRoot: ctx.projectRoot, browser });
    if (!profile) return null;
    const kept = await playwrightStarts({ browser, env: ctx.env, cwd: ctx.projectRoot, profile });
    if (kept.ok) return null;
    return { status: 412, body: { error: t('TEST BROWSER stays off: the saved {session} session does not open ({problem}). Close any other window using it and turn it on again, or choose another session in its settings.', { session, problem: String(kept.problem).replace(/[.\s]+$/, '') }), code: 'MU-054' } };
  }
  // The server is there and only the browser is missing: say which one, and the one line that
  // installs it. Without the server, both lines.
  const version = await playwrightVersion({ env: ctx.env, projectRoot: ctx.projectRoot });
  if (version && isChannel(browser)) return { status: 412, body: { error: t('TEST BROWSER stays off: {browser} does not start ({problem}). Install it on this computer, or choose another browser in its settings.', { problem: String(check.problem).replace(/[.\s]+$/, ''), browser }), code: 'MU-054' } };
  return { status: 412, body: { error: version
    ? t('TEST BROWSER stays off: MADRE downloaded the {browser} browser and it still does not start ({problem}). Check your internet connection and turn it on again, or choose another browser in its settings.', { problem: String(check.problem).replace(/[.\s]+$/, ''), browser })
    : t('TEST BROWSER stays off: MADRE could not install its browser server ({problem}). Check your internet connection and turn it on again.', { problem: String(check.problem).replace(/[.\s]+$/, '') }), code: 'MU-054' } };
}

export default defineModule({
  id: 'playwright',
  name: 'Test browser',
  vendor: 'MADRE · Playwright MCP',
  tracks: { name: PLAYWRIGHT_PACKAGE, npm: PLAYWRIGHT_PACKAGE },
  summary: 'Gives every agent a browser for local pages, with optional general web access and persistent project or shared sessions.',
  creates: ['nothing in the project \u00b7 screenshots land in .pulse/out/<turn>/', 'a switch in ~/.pulse/config.json', 'Local: a browser per turn. Windows: a connection to the browser you opened.', 'optional persistent browser profile when enabled'],
  requires: ['Local: @playwright/mcp and a browser here. Windows: WSL interop, Windows Node.js, the pinned server and dedicated Chrome or Edge.', 'PREVIEW on, to have pages to open'],
  reaches: YOUTUBE_HOSTS.map(host => ({
    id: `browser-${host}`,
    host,
    to: `the website open in TEST BROWSER (${host})`,
    what: 'Browser requests, page content and the cookies of the dedicated browser profile used for the turn.',
    when: 'only while TEST BROWSER is on and WEBSITES allows this destination',
    where: 'Modules › Test browser › WEBSITES',
  })),
  settings: { enabled: false, browser: 'chromium', headless: true, access: 'local', session: 'isolated', connection: 'local', cdpEndpoint: '' },
  card: 'switch',
  controls: [
    { key: 'connection', label: 'CONNECTION', type: 'select', options: ['local', 'windows'], note: 'local: start a browser here. windows: connect from WSL to a dedicated Windows Chrome or Edge. Its session and window are managed in Windows; use one agent at a time.' },
    { key: 'cdpEndpoint', label: 'WINDOWS CDP', type: 'text', note: 'Leave empty for Edge port 9222 or Chrome port 9223. Otherwise use http://127.0.0.1:<port>. Requires a dedicated Windows browser profile and the pinned Windows server.' },
    { key: 'access', label: 'WEBSITES', type: 'select', options: ['local', 'youtube', 'all'], note: 'local: project pages. all: any website and its sign-in providers. youtube: legacy limited access. Persistent accounts are available to agents using the same profile.' },
    { key: 'session', label: 'SESSION', type: 'select', options: ['isolated', 'project', 'shared'], note: 'Local connection only. isolated: discarded after the turn. project: agents in this project reuse the login. shared: projects reuse the account. Windows always uses the external browser session.' },
    { key: 'browser', label: 'BROWSER', type: 'select', options: PLAYWRIGHT_BROWSER_CHOICES, note: 'Local: chromium, firefox and webkit are downloaded; chrome and msedge use a local installation. Windows connection: choose chrome or msedge and open its dedicated profile first.' },
    // Nothing opens the moment it is switched on: the window comes with the next agent that opens
    // the page, and the person is told so, and how to try it (2026-10-20).
    {
      key: 'headless', label: 'SHOW THE WINDOW', type: 'switch', invert: true,
      note: 'Local connection only: show the window when an agent opens a page. Windows connection uses the window you opened in Windows.',
      said: {
        on: 'Local connection: the next browser opens with a window. Windows connection: use the window already opened in Windows.',
        off: 'Local connection: the next browser runs without a window. Windows connection: its existing window is unchanged.',
      },
    },
  ],
  async status(ctx) {
    if (ctx.settings.connection === 'windows') {
      const options = { ...connectionOptions(ctx.settings), env: ctx.env, cwd: ctx.projectRoot };
      let endpointProblem = null;
      try { windowsEndpoint(options); } catch (error) { endpointProblem = t(error.message); }
      const version = await playwrightVersion({ ...options, projectRoot: ctx.projectRoot });
      const health = ctx.settings.enabled && version ? playwrightHealth(options) : null;
      const problem = endpointProblem ?? (health?.ok === false ? health.problem : !version ? t('Install the pinned browser server in Windows and check Windows Node.js and WSL interop.') : null);
      return {
        runs: [{ name: PLAYWRIGHT_PACKAGE, version, target: WINDOWS_MCP_VERSION }],
        settings: { ...ctx.settings },
        status: { installed: Boolean(ctx.settings.enabled), detail: problem ? t('Windows connection: {problem}', { problem }) : t('{state} · Windows {browser}', { state: t(ctx.settings.enabled ? 'on' : 'off'), browser: options.browser }) },
        preflight: problem ? { ok: false, problems: [problem] } : { ok: true, problems: [] },
        install: { display: ctx.settings.enabled ? 'disable PLAYWRIGHT' : 'enable PLAYWRIGHT (config.json)', platforms: ['codex', 'claude', 'gemini', 'opencode'] },
      };
    }
    const version = await playwrightVersion({ env: ctx.env, projectRoot: ctx.projectRoot });
    const health = ctx.settings.enabled && version ? playwrightHealth({ browser: ctx.settings.browser ?? 'chromium', env: ctx.env, cwd: ctx.projectRoot }) : null;
    return {
      runs: [{ name: PLAYWRIGHT_PACKAGE, version }],
      settings: { browser: ctx.settings.browser ?? 'chromium', headless: ctx.settings.headless !== false, access: ctx.settings.access ?? 'local', session: ctx.settings.session ?? 'isolated' },
      status: { installed: Boolean(ctx.settings.enabled), detail: ctx.settings.enabled ? (!version ? t('on · the browser server is not installed') : health?.ok === false ? t(isChannel(ctx.settings.browser) ? 'on · the browser does not start: {problem}. Install the selected browser on this computer, or choose another browser in settings.' : 'on · the browser does not start: {problem}. Turn it off and on again: MADRE downloads what is missing.', { problem: String(health.problem).replace(/[.\s]+$/, '').slice(0, 160) }) : `${t('on')} · ${ctx.settings.browser}`) : version ? t('off') : process.platform === 'win32' ? t('off · the browser server is not installed') : isChannel(ctx.settings.browser) ? t('off · install the selected browser on this computer; MADRE does not download it') : t('off · turn it on and MADRE installs its browser; it takes a few minutes') },
      // Missing is not a reason to refuse the switch: turning it on installs what is missing
      // (playwrightReady) everywhere but Windows (2026-10-20). Only there does the person install it.
      preflight: version || process.platform !== 'win32' ? { ok: true, problems: [] } : { ok: false, problems: [t('Install the browser server first: {server}, then its browser: {browser}', { server: 'npm install -g @playwright/mcp', browser: installBrowserLine(ctx.settings.browser) })] },
      install: { display: ctx.settings.enabled ? 'disable PLAYWRIGHT' : 'enable PLAYWRIGHT (config.json)', platforms: ['codex', 'claude', 'gemini', 'opencode'] },
    };
  },
  // Getting the browser server onto this computer, or a newer one. Installed globally, which is
  // where `npx --no` looks for it at turn time without downloading anything.
  async updatePlan(ctx, { latest = null } = {}) {
    if (ctx.settings.connection === 'windows') return {
      command: null,
      note: t('The Windows connection uses @playwright/mcp@{version} installed explicitly in Windows LOCALAPPDATA/MADRE/browser-server. Follow the Windows browser guide; no Linux package is installed or updated.', { version: WINDOWS_MCP_VERSION }),
    };
    const target = latest ? `${PLAYWRIGHT_PACKAGE}@${latest}` : PLAYWRIGHT_PACKAGE;
    return {
      command: 'npm',
      args: ['install', '-g', target],
      display: `npm install -g ${target}`,
      note: 'Installs the browser server for every project on this computer. A browser itself may still be missing; the card says so if it is.',
      after: async () => { await playwrightVersion({ env: ctx.env, projectRoot: ctx.projectRoot, fresh: true }); },
    };
  },
  async toolsForTurn(ctx, turn) {
    if (turn.mode === 0) return [];   // a ghost turn leaves no screenshots and opens no browser
    // Only for a turn that asks for what a browser does. Its tool list goes into every call the CLI
    // makes inside the turn: a one-line change cost Codex 576 thousand tokens of reading, and the
    // browser it carried was never opened.
    if (turn.text !== undefined && !wantsBrowser(turn.text, { access: ctx.settings.access ?? 'local' })) return [];
    const options = connectionOptions(ctx.settings);
    if (!(await playwrightVersion({ ...options, env: ctx.env, projectRoot: ctx.projectRoot }))) return [];
    // A browser known not to start is not handed to anyone: every call to it would fail.
    if (options.connection === 'windows') {
      // The human can open or reopen the external browser between turns. Await a fresh
      // metadata probe instead of refusing this turn using a cached failure.
      if (!(await windowsTurnReady({ ...options, env: ctx.env, cwd: ctx.projectRoot }))) return [];
    } else if (playwrightHealth({ ...options, env: ctx.env, cwd: ctx.projectRoot })?.ok === false) return [];
    const outputDir = turn.scratchDir ?? join(turn.roomDir ?? ctx.stateRoot, 'playwright');
    return [playwrightServerFor({ ...options, port: turn.port, outputDir, headless: ctx.settings.headless !== false, servers: turn.servers ?? [], access: ctx.settings.access ?? 'local', session: ctx.settings.session ?? 'isolated', projectRoot: ctx.projectRoot, env: ctx.env })];
  },
  // Before it turns on, in one project or in all: the server starts and has its browser, or MADRE
  // fetches what is missing and asks again. `null` is ready; anything else is the refusal.
  ready: playwrightReady,
  // The switch, guarded: on only if it is ready. Off is always allowed. A project's switch is that
  // project's (module-scope.mjs).
  async toggle(ctx) {
    const enabled = !ctx.settings.enabled;
    if (enabled) { const refused = await playwrightReady(ctx); if (refused) return refused; }
    await ctx.updateConfig({ modules: { playwright: switchIn(ctx.config.modules?.playwright ?? {}, ctx.roomId ?? null, enabled) } });
    await ctx.record('extension.toggled', { id: 'playwright', name: 'PLAYWRIGHT', enabled });
    return { status: 200, body: { enabled } };
  },
  conditions: [{
    id: 'playwright-windows-missing',
    code: 'MU-075',
    severity: 'informational',
    title: 'TEST BROWSER: the Windows connection is not ready',
    match: /TEST BROWSER stays off: Windows connection failed/i,
    diagnosis: 'The Windows connection uses the pinned @playwright/mcp server inside Windows and an already-open dedicated Chrome or Edge profile. Installing Playwright in Linux cannot repair this connection.',
    remedy: 'Follow the Windows browser guide: verify Windows Node.js >=20 and WSL interop, install the pinned server in Windows LOCALAPPDATA/MADRE/browser-server, open the selected dedicated browser profile with loopback CDP, and RECHECK in MODULES.',
    fixes: { darwin: ['# this connection is for MADRE running in WSL'], linux: ['# follow docs/WINDOWS-BROWSER.md; do not install the Windows server in Linux'] },
  }, {
    id: 'playwright-missing',
    code: 'MU-054',
    severity: 'informational',
    title: 'TEST BROWSER: the browser server is not installed',
    match: /^(?![\s\S]*TEST BROWSER stays off: Windows connection failed)[\s\S]*(?:@playwright\/mcp|playwright.*not (?:found|installed)|browser server)/i,
    diagnosis: 'The TEST BROWSER module runs @playwright/mcp per turn. Two different things have to be on this computer and only one of them is the package: the server, and the browser build that this version of it expects. A server that starts without its browser answers every tool call with "Browser … is not installed", and one that cannot start at all reaches the agent as CONNECTION_CLOSED.',
    remedy: 'Install the server once, globally, then its browser — the browser is downloaded by the server itself, not by the playwright CLI — and RECHECK in MODULES.',
    fixes: { darwin: ['npm install -g @playwright/mcp', 'npx @playwright/mcp install-browser chromium'], linux: ['npm install -g @playwright/mcp', 'npx @playwright/mcp install-browser chromium'] },
  }],
});

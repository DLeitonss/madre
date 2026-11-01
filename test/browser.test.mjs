import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import browserModule, { playwrightServerFor, wantsBrowser, startCheckArgs, playwrightStarts, preparePlaywright, PLAYWRIGHT_BROWSER_CHOICES } from '../src/modules/playwright.mjs';

const server = (extra = {}) => playwrightServerFor({ port: 4319, outputDir: '/tmp/screenshots', projectRoot: '/projects/one', ...extra });
const arg = (s, flag) => s.args[s.args.indexOf(flag) + 1];

test('defaults retain local destinations and an isolated session', () => {
  const s = server();
  assert.ok(s.args.includes('--isolated'));
  assert.ok(!s.args.includes('--user-data-dir'));
  assert.equal(arg(s, '--allowed-origins'), 'http://127.0.0.1:4319;http://localhost:4319');
});

test('YouTube access keeps project servers and adds sign-in origins', () => {
  const s = server({ access: 'youtube', servers: [8080] });
  const origins = arg(s, '--allowed-origins').split(';');
  for (const origin of ['http://127.0.0.1:8080', 'https://studio.youtube.com', 'https://accounts.google.com']) assert.ok(origins.includes(origin));
  assert.match(s.brief, /sign in/);
  assert.doesNotMatch(s.brief, /Nothing else on the network/);
});

test('all agents in one project receive the same persistent profile', () => {
  const one = server({ session: 'project' });
  const two = server({ session: 'project' });
  assert.equal(arg(one, '--user-data-dir'), arg(two, '--user-data-dir'));
  assert.ok(!one.args.includes('--isolated'));
  assert.notEqual(arg(one, '--user-data-dir'), arg(server({ session: 'project', projectRoot: '/projects/two' }), '--user-data-dir'));
});

test('shared profile is independent of the project and separated by engine', () => {
  const one = server({ session: 'shared' });
  assert.equal(arg(one, '--user-data-dir'), arg(server({ session: 'shared', projectRoot: '/projects/two' }), '--user-data-dir'));
  assert.notEqual(arg(one, '--user-data-dir'), arg(server({ session: 'shared', browser: 'firefox' }), '--user-data-dir'));
});

test('visible login and subsequent headless access reuse the profile', () => {
  const login = server({ session: 'shared', headless: false });
  const later = server({ session: 'shared' });
  assert.ok(!login.args.includes('--headless'));
  assert.ok(later.args.includes('--headless'));
  assert.equal(arg(login, '--user-data-dir'), arg(later, '--user-data-dir'));
});

test('YouTube and sign-in words load the browser only when WEBSITES is youtube', () => {
  for (const text of ['Abre YouTube Studio', 'Iniciar sesión en Google', 'inicia sesión', 'login', 'sign in', 'Please log in']) {
    assert.ok(wantsBrowser(text, { access: 'youtube' }), text);
    assert.equal(wantsBrowser(text, { access: 'local' }), false, text);
    assert.equal(wantsBrowser(text), false, text);
  }
  assert.equal(wantsBrowser('Cambia el título del documento', { access: 'youtube' }), false);
});

test('a code change that merely mentions login or design does not load the browser', () => {
  for (const text of ['arregla el formulario de login', 'fix the sign in form', 'update the design in the header', 'remove the catalog in the sidebar']) {
    assert.equal(wantsBrowser(text, { access: 'local' }), false, text);
  }
  // Word boundaries: «design in» and «catalog in» are not «sign in» and «log in» even with access.
  assert.equal(wantsBrowser('update the design in the header', { access: 'youtube' }), false);
  assert.equal(wantsBrowser('remove the catalog in the sidebar', { access: 'youtube' }), false);
});

test('the browser words still work with local access', () => {
  for (const text of ['abre el navegador', 'take a screenshot', 'revisa la consola']) assert.ok(wantsBrowser(text, { access: 'local' }), text);
});

test('the brief of a headless browser says nobody can sign in and how to fix it', () => {
  const s = server({ access: 'youtube', session: 'shared', headless: true });
  assert.match(s.brief, /no window/);
  assert.match(s.brief, /SHOW THE WINDOW/);
  assert.doesNotMatch(s.brief, /visible on the human's screen/);
  assert.doesNotMatch(s.brief, /sign in in the visible browser window/);
});

test('the brief of a visible browser asks the human to sign in in the window', () => {
  const s = server({ access: 'youtube', session: 'shared', headless: false });
  assert.match(s.brief, /visible on the human's screen/);
  assert.match(s.brief, /sign in there/);
  assert.doesNotMatch(s.brief, /no window/);
});

test('the brief of an isolated YouTube session says the login would be lost', () => {
  const s = server({ access: 'youtube', session: 'isolated', headless: false });
  assert.match(s.brief, /lost when this turn ends/);
  assert.match(s.brief, /project or shared/);
  assert.doesNotMatch(s.brief, /SHOW THE WINDOW/);
  assert.match(server({ access: 'youtube', session: 'isolated', headless: true }).brief, /SHOW THE WINDOW/);
});

test('no brief asks for passwords or codes', () => {
  for (const headless of [true, false]) for (const session of ['isolated', 'shared']) {
    assert.match(server({ access: 'youtube', session, headless }).brief, /Never ask for passwords or authentication codes/);
  }
});

test('a local browser does not mention signing in', () => {
  assert.doesNotMatch(server({ session: 'shared' }).brief, /sign in|SHOW THE WINDOW/i);
});

test('chrome and msedge are offered and passed to the server as the browser', () => {
  assert.deepEqual(PLAYWRIGHT_BROWSER_CHOICES, ['chromium', 'firefox', 'webkit', 'chrome', 'msedge']);
  assert.deepEqual(browserModule.controls.find(c => c.key === 'browser').options, PLAYWRIGHT_BROWSER_CHOICES);
  for (const browser of ['chrome', 'msedge']) {
    assert.equal(arg(server({ browser }), '--browser'), browser);
    assert.notEqual(arg(server({ session: 'shared', browser }), '--user-data-dir'), arg(server({ session: 'shared' }), '--user-data-dir'));
  }
});

test('a channel is never downloaded by MADRE', async () => {
  const ran = [];
  const run = async (command, args) => { ran.push([command, ...args].join(' ')); return { code: 0 }; };
  const starts = async ({ browser }) => ({ ok: true, checked: true, browser });
  const version = async () => '0.0.84';
  const chrome = await preparePlaywright({ browser: 'chrome', run, starts, version });
  assert.equal(chrome.ok, true);
  assert.deepEqual(ran, []);
  await preparePlaywright({ browser: 'chromium', run, starts, version });
  assert.deepEqual(ran, ['npx --no @playwright/mcp install-browser chromium']);
  const missing = await preparePlaywright({ browser: 'msedge', run, version, starts: async () => ({ ok: false, problem: 'Chromium distribution \'msedge\' is not found' }) });
  assert.equal(missing.ok, false);
  assert.match(missing.problem, /msedge/);
});

test('the start check is isolated and headless by default and can open a saved profile', () => {
  const plain = startCheckArgs({ outputDir: '/tmp/out' });
  assert.ok(plain.includes('--isolated') && plain.includes('--headless') && !plain.includes('--user-data-dir'));
  const kept = startCheckArgs({ outputDir: '/tmp/out', browser: 'chrome', profile: '/profiles/one' });
  assert.equal(arg({ args: kept }, '--user-data-dir'), '/profiles/one');
  assert.equal(arg({ args: kept }, '--browser'), 'chrome');
  assert.ok(kept.includes('--headless') && !kept.includes('--isolated'));
  assert.ok(!startCheckArgs({ outputDir: '/tmp/out', profile: '/profiles/one', headless: false }).includes('--headless'));
});

// A stand-in for the browser server that speaks just enough MCP: answers initialize, then answers
// the navigation with the given text as an error or as a success.
async function fakeServer(text, { isError }) {
  const dir = await mkdtemp(join(tmpdir(), 'madre-fake-mcp-'));
  const file = join(dir, 'server.mjs');
  await writeFile(file, `import readline from 'node:readline';
const out = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === 1) out({ jsonrpc: '2.0', id: 1, result: {} });
  if (m.id === 2) out({ jsonrpc: '2.0', id: 2, result: { isError: ${isError}, content: [{ type: 'text', text: ${JSON.stringify(text)} }] } });
});
`);
  return { file, done: () => rm(dir, { recursive: true, force: true }) };
}

test('a saved profile held by another browser is busy, not a browser that does not start', async () => {
  const fake = await fakeServer('### Error\nBrowser is already in use for /profiles/one, use --isolated to run multiple instances of the same browser', { isError: true });
  try {
    const busy = await playwrightStarts({ command: process.execPath, args: [fake.file], profile: '/profiles/one', timeoutMs: 15000 });
    assert.deepEqual(busy, { ok: true, checked: true, busy: true });
    // Without a profile the same words are a failure: busy only means something for a saved session.
    const isolated = await playwrightStarts({ command: process.execPath, args: [fake.file], timeoutMs: 15000 });
    assert.equal(isolated.ok, false);
  } finally { await fake.done(); }
});

test('any other failure with a saved profile still fails', async () => {
  const fake = await fakeServer("### Error\nBrowser \"chromium\" is not installed", { isError: true });
  try {
    const result = await playwrightStarts({ command: process.execPath, args: [fake.file], profile: '/profiles/one', timeoutMs: 15000 });
    assert.equal(result.ok, false);
    assert.match(result.problem, /not installed/);
  } finally { await fake.done(); }
});

test('a start check that works answers ok', async () => {
  const fake = await fakeServer('ok', { isError: false });
  try {
    assert.deepEqual(await playwrightStarts({ command: process.execPath, args: [fake.file], profile: '/profiles/one', timeoutMs: 15000 }), { ok: true, checked: true });
  } finally { await fake.done(); }
});

test('module offers access and session controls', () => {
  assert.deepEqual(browserModule.controls.find(c => c.key === 'access').options, ['local', 'youtube', 'all']);
  assert.deepEqual(browserModule.controls.find(c => c.key === 'session').options, ['isolated', 'project', 'shared']);
});

test('the browser control accepts chrome and msedge and rejects others', async () => {
  let config = { modules: { playwright: { enabled: true } } };
  const ctx = { config, roomId: 'one', updateConfig: async patch => { config = { modules: { ...config.modules, ...patch.modules } }; } };
  for (const value of ['chrome', 'msedge']) assert.equal((await browserModule.setControl({ ...ctx, config }, { key: 'browser', value })).status, 200);
  assert.equal((await browserModule.setControl({ ...ctx, config }, { key: 'browser', value: 'opera' })).status, 400);
});

test('settings are available across rooms and invalid choices are rejected', async () => {
  let config = { modules: { playwright: { enabled: true } } };
  const ctx = { config, roomId: 'one', updateConfig: async patch => { config = { modules: { ...config.modules, ...patch.modules } }; } };
  assert.equal((await browserModule.setControl(ctx, { key: 'session', value: 'shared' })).status, 200);
  assert.equal(browserModule.settingsFrom(config, 'two').session, 'shared');
  assert.equal((await browserModule.setControl({ ...ctx, config }, { key: 'access', value: '*' })).status, 400);
});


test('general web access omits origin restrictions and retains persistent login instructions', () => {
  const s = server({ access: 'all', session: 'project', headless: false });
  assert.ok(!s.args.includes('--allowed-origins'));
  assert.ok(!s.args.includes('--blocked-origins'));
  assert.ok(s.args.includes('--user-data-dir'));
  assert.match(s.brief, /All website origins are allowed/);
  assert.match(s.brief, /sign in there/);
  assert.doesNotMatch(s.brief, /External origins are blocked|If Studio/);
});

test('general web requests load tools without changing local intent detection', () => {
  for (const text of ['Abre https://example.test', 'Visita el sitio de mi banco', 'open the website', 'inicia sesión']) {
    assert.ok(wantsBrowser(text, { access: 'all' }), text);
  }
  assert.equal(wantsBrowser('Cambia el título del documento', { access: 'all' }), false);
  assert.equal(wantsBrowser('Abre https://example.test', { access: 'local' }), false);
});

test('a site named by its domain loads the browser with WEBSITES = all (regression: «busquemos youtube.com»)', () => {
  for (const text of ['busquemos youtube.com', 'Busca youtube.com', 'vamos a youtube.com', 'entra a studio.youtube.com', 'search youtube.com', 'go to www.example.org', 'open example.dev', 'visita www.wikipedia.org', 'abre docs.google.com/document']) {
    assert.ok(wantsBrowser(text, { access: 'all' }), text);
    assert.equal(wantsBrowser(text, { access: 'local' }), false, text);
    assert.equal(wantsBrowser(text), false, text);
  }
});

test('file names, bare domains and unrelated verbs do not load the browser with WEBSITES = all', () => {
  for (const text of ['youtube.com', 'example.org', 'busca el error en package.json', 'abre app.js y cambia el título', 'open index.html', 'cambia el dominio a example.com', 'update the README.md', 'search the handler in server.mjs', 'abre src/modules/ahp.mjs']) {
    assert.equal(wantsBrowser(text, { access: 'all' }), false, text);
  }
});

test('general web access can be selected and persists across rooms', async () => {
  let config = { modules: { playwright: { enabled: true } } };
  const ctx = { config, roomId: 'one', updateConfig: async patch => { config = { modules: { ...config.modules, ...patch.modules } }; } };
  assert.equal((await browserModule.setControl(ctx, { key: 'access', value: 'all' })).status, 200);
  assert.equal(browserModule.settingsFrom(config, 'two').access, 'all');
});

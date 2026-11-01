// Domain detection for WEBSITES = all: domains without a verb, endings, and things that only look
// like a domain (paths, e-mail addresses, file names). Written as a specification of the wanted
// behaviour: a failing case here is a gap in madre/src/modules/playwright.mjs, not a broken test.
// Run: node tests/browser.domains.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { wantsBrowser } from '../src/modules/playwright.mjs';

const loads = (text, access = 'all') => wantsBrowser(text, { access });

// 1. A domain with no verb of navigation is a mention, not a request: a code change, a question.
const VERBLESS = [
  'youtube.com',
  'example.org',
  'el dominio es example.com',
  'cambia el dominio a example.com',
  'the staging domain is staging.example.com',
  'update the link to example.com in the footer',
  'cambia el correo de contacto a soporte@example.com',
  'docs.google.com/document',
];
for (const text of VERBLESS) {
  test(`no verb: «${text}» does not load the browser`, () => assert.equal(loads(text), false, text));
}

// 2. Endings already in WEB_DOMAIN, with a verb: they load with WEBSITES = all and with nothing else.
const LISTED = ['com', 'org', 'net', 'io', 'tv', 'co', 'app', 'dev', 'edu', 'gov', 'ai', 'me', 'be', 'es', 'mx', 'ar', 'cl', 'uk'];
for (const ending of LISTED) {
  test(`ending .${ending} with a verb loads the browser only with WEBSITES = all`, () => {
    const text = `abre example.${ending}`;
    assert.equal(loads(text), true, text);
    assert.equal(loads(text, 'local'), false, `${text} (local)`);
    assert.equal(loads(text, 'youtube'), false, `${text} (youtube)`);
  });
}
test('multi-label endings already covered keep working', () => {
  for (const text of ['abre example.co.uk', 'busca example.com.ar', 'visita example.gob.mx', 'open example.com.mx', 'abre example.gob.cl', 'go to news.ycombinator.com']) assert.equal(loads(text), true, text);
});
test('punctuation, case, port and path around a domain do not hide it', () => {
  for (const text of ['Busca en youtube.com.', 'ABRE EXAMPLE.COM', 'abre example.com:8080/x', 'search example.com, then report', 'visita (example.com)']) assert.equal(loads(text), true, text);
});

// 3. Endings outside the list, with a verb. A domain is a domain whatever its ending: these are the
// gaps (.cr, .de, .com.br ...). Wanted: they load with WEBSITES = all.
const OUTSIDE = [
  'abre example.cr',
  'abre example.co.cr',
  'abre example.go.cr',
  'abre example.de',
  'abre example.fr',
  'abre example.it',
  'abre example.com.br',
  'visita example.com.pe',
  'busca example.com.ve',
  'busca example.com.uy',
  'abre example.com.ec',
  'open example.info',
  'open example.xyz',
  'go to example.ca',
];
for (const text of OUTSIDE) {
  test(`ending outside the list: «${text}» loads the browser`, () => assert.equal(loads(text), true, text));
}
test('endings outside the list still do not load it with local or youtube access', () => {
  for (const text of OUTSIDE) { assert.equal(loads(text, 'local'), false, `${text} (local)`); assert.equal(loads(text, 'youtube'), false, `${text} (youtube)`); }
});

// 4. Looks like a domain, is not one. Must never load the browser, whatever the verb.
const NOT_DOMAINS_TODAY_OK = [
  'busca el error en package.json',
  'abre app.js y cambia el título',
  'open index.html',
  'abre src/modules/ahp.mjs',
  'abre README.es.md',
  'abre messages.es.json',
  'open environment.dev.ts',
  'open docker-compose.dev.yml',
  'open archive.tar.gz',
  'busca user.name en el handler',
  'search the handler in server.mjs',
];
for (const text of NOT_DOMAINS_TODAY_OK) {
  test(`file name: «${text}» does not load the browser`, () => assert.equal(loads(text), false, text));
}
// A domain ending that is also a file ending, inside a path, or an e-mail address.
const NOT_DOMAINS_GAPS = [
  'open dist/main.app',
  'abre ./build/MyApp.app',
  'open src/config.dev',
  'busca soporte@example.com en los logs',
  'search admin@example.org in the users table',
];
for (const text of NOT_DOMAINS_GAPS) {
  test(`path or e-mail: «${text}» does not load the browser`, () => assert.equal(loads(text), false, text));
}

// 5. Known limits of a lexical rule. Wanted, not promised: kept as TODO so the gap stays visible
// without failing the run. A noun that looks like the verb, and a library named like a domain.
const LIMITS = [
  ['el buscador de example.com falla', 'noun «buscador» matches busc\\w+'],
  ['the search box on example.com is broken', 'noun «search»'],
  ['search for socket.io usage in the code', 'library named like a domain'],
];
for (const [text, why] of LIMITS) {
  test(`known limit: «${text}» does not load the browser`, { todo: why }, () => assert.equal(loads(text), false, text));
}

test('empty or missing text never loads the browser', () => {
  for (const text of [undefined, null, '']) assert.equal(wantsBrowser(text, { access: 'all' }), false);
});

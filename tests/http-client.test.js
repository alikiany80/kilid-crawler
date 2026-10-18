const test = require('node:test');
const assert = require('node:assert/strict');
const { HttpClient, HttpError, CookieJar } = require('../src/http-client');

test('HttpClient retries 429 with backoff then succeeds', async () => {
  const statuses = [429, 429, 200];
  const sleeps = [];
  const client = new HttpClient({
    delayMs: 0,
    maxRetries: 4,
    rateLimitBackoffMs: 5000,
    sleep: async ms => { sleeps.push(ms); },
    fetch: async () => {
      const status = statuses.shift();
      return new Response(status === 200 ? '{"ok":true}' : 'rate limited', { status });
    }
  });
  assert.deepEqual(await client.getJson('https://example.test/x'), { ok: true });
  assert.deepEqual(sleeps, [5000, 10000]);
});

test('HttpClient does not retry 404', async () => {
  let calls = 0;
  const client = new HttpClient({
    delayMs: 0,
    sleep: async () => {},
    fetch: async () => { calls++; return new Response('nope', { status: 404 }); }
  });
  await assert.rejects(client.getJson('https://example.test/x'), err => err instanceof HttpError && err.status === 404);
  assert.equal(calls, 1);
});

test('HttpClient follows a 307 challenge, keeps its cookies and sends RSC header', async () => {
  const seen = [];
  const client = new HttpClient({
    delayMs: 0,
    sleep: async () => {},
    fetch: async (url, init) => {
      seen.push({ url, cookie: init.headers.Cookie, rsc: init.headers.RSC });
      if (seen.length === 1) {
        return new Response(null, { status: 307, headers: { location: '/detail/1', 'set-cookie': '__arcsjs=abc; Path=/' } });
      }
      return new Response('1:{"listing":{}}', { status: 200 });
    }
  });
  assert.equal(await client.getRsc('https://example.test/detail/1'), '1:{"listing":{}}');
  assert.equal(seen.length, 2);
  assert.equal(seen[1].cookie, '__arcsjs=abc');
  assert.equal(seen[1].rsc, '1');
});

test('HttpClient throttles requests by delayMs', async () => {
  const sleeps = [];
  const client = new HttpClient({ delayMs: 1000, sleep: async ms => sleeps.push(ms), fetch: async () => new Response('ok') });
  await client.getText('https://example.test/a');
  await client.getText('https://example.test/b');
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 900 && sleeps[0] <= 1000);
});

test('CookieJar parses set-cookie headers', () => {
  const jar = new CookieJar();
  const headers = new Headers();
  headers.append('set-cookie', 'a=1; Path=/');
  headers.append('set-cookie', 'b=x=y; HttpOnly');
  jar.setCookiesFromHeaders(headers);
  assert.equal(jar.getCookieHeader(), 'a=1; b=x=y');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');
const { fixture, tempDir, memoryLogger } = require('./helpers');
const { normalizeKilidSummary, normalizeKilidDetails } = require('../src/kilid/normalize');
const { toContractListing } = require('../src/listing');
const { SqliteSink } = require('../src/sinks/sqlite');
const { JsonlSink } = require('../src/sinks/jsonl');
const { HttpSink } = require('../src/sinks/http');
const { createSinks } = require('../src/sinks');
const { loadConfig } = require('../src/config');

const crawledAt = '2026-10-18T09:00:00.000Z';
const fullListing = () => toContractListing(normalizeKilidDetails(fixture('kilid/detail.json')), { crawledAt });
const summaryListing = () => toContractListing(normalizeKilidSummary(fixture('kilid/list-buy-page2.json').items[0]), { crawledAt });

test('SqliteSink: summary after details never nulls known values (COALESCE)', async t => {
  const sink = new SqliteSink(path.join(tempDir(t), 'db.sqlite'));
  t.after(() => sink.close());
  await sink.write([fullListing()]);
  await sink.write([{ ...summaryListing(), priceToman: 61_000_000_000 }]);

  const row = sink.getListing('9000001');
  assert.equal(sink.count(), 1);
  assert.equal(row.price_toman, 61_000_000_000, 'new non-null values win');
  assert.equal(row.floor, 2, 'detail-only values survive a summary');
  assert.equal(row.region_name, 'منطقه 7');
  assert.equal(row.has_full_details, 1);
  assert.equal(row.has_elevator, 1);
  assert.equal(row.images.length, 19, 'images: null means keep existing');
  assert.ok(row.attributes.length > 0);
  assert.ok(row.raw_json.includes('APARTMENT_TOWER'));
  assert.ok(!JSON.parse(row.details_json).raw_json, 'raw payload stored separately');
  assert.ok(row.details_fetched_at);
});

test('SqliteSink: explicit empty images array clears images', async t => {
  const sink = new SqliteSink(path.join(tempDir(t), 'db.sqlite'));
  t.after(() => sink.close());
  await sink.write([fullListing()]);
  await sink.write([{ ...fullListing(), images: [] }]);
  assert.equal(sink.getListing('9000001').images.length, 0);
});

test('SqliteSink: migrations are idempotent and regions are saved', async t => {
  const file = path.join(tempDir(t), 'db.sqlite');
  await new SqliteSink(file).close();
  const sink = new SqliteSink(file);
  t.after(() => sink.close());
  const saved = sink.saveRegions([{ id: 1, name: 'منطقه ۱', slug: 'tehran-region1', municipalArea: 1, tags: ['a'] }, { name: 'bad' }], 272905);
  assert.equal(saved, 1);
  const rows = sink.db.prepare('SELECT * FROM kilid_regions').all();
  assert.equal(rows[0].slug, 'tehran-region1');
  const versions = sink.db.prepare("SELECT version FROM schema_migrations WHERE scope = 'sqlite_sink'").all().map(r => r.version);
  assert.deepEqual(versions, [1, 2]);
});

test('JsonlSink writes one JSON object per line to a file and to a stream', async t => {
  const file = path.join(tempDir(t), 'out', 'x.jsonl');
  const sink = new JsonlSink(file);
  await sink.write([fullListing(), summaryListing()]);
  await sink.close();
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).sourceId, '9000001');

  let out = '';
  const stdout = new Writable({ write(chunk, _enc, cb) { out += chunk; cb(); } });
  const s2 = new JsonlSink('-', { stdout });
  await s2.write([summaryListing()]);
  await s2.close();
  assert.equal(JSON.parse(out.trim()).hasFullDetails, false);
});

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}
const ok = (body = { received: 1, created: 1, updated: 0, rejected: [] }) => new Response(JSON.stringify(body), { status: 200 });

test('HttpSink batches, authenticates and flushes the remainder', async () => {
  const fetch = fakeFetch([ok(), ok(), ok()]);
  const sink = new HttpSink({ url: 'https://sink.example/ingest', token: 'tkn', batchSize: 2, fetch, logger: memoryLogger() });
  await sink.write([summaryListing(), summaryListing(), summaryListing()]);
  assert.equal(fetch.calls.length, 1);
  await sink.flush();
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(fetch.calls.map(c => c.body.listings.length), [2, 1]);
  assert.equal(fetch.calls[0].body.schemaVersion, 1);
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer tkn');
  assert.equal(fetch.calls[0].init.method, 'POST');
});

test('HttpSink retries 5xx/429/network errors with backoff', async () => {
  const sleeps = [];
  const fetch = fakeFetch([
    new Response('x', { status: 503 }),
    new TypeError('fetch failed'),
    new Response('x', { status: 429, headers: { 'retry-after': '2' } }),
    ok()
  ]);
  const sink = new HttpSink({ url: 'https://sink.example/', token: 't', batchSize: 1, maxRetries: 4, backoffMs: 100, fetch, sleep: async ms => sleeps.push(ms), logger: memoryLogger() });
  await sink.write([summaryListing()]);
  assert.equal(fetch.calls.length, 4);
  assert.deepEqual(sleeps, [100, 200, 2000]);
});

test('HttpSink does not retry 4xx and logs rejected counts', async () => {
  const fetch = fakeFetch([new Response('bad token', { status: 401 })]);
  const sink = new HttpSink({ url: 'https://sink.example/', token: 't', batchSize: 1, fetch, sleep: async () => {}, logger: memoryLogger() });
  await assert.rejects(sink.write([summaryListing()]), err => err.status === 401);
  assert.equal(fetch.calls.length, 1);

  const logger = memoryLogger();
  const s2 = new HttpSink({
    url: 'https://sink.example/', token: 't', batchSize: 1, logger,
    fetch: fakeFetch([ok({ received: 1, created: 0, updated: 0, rejected: [{ index: 0, error: 'x' }] })])
  });
  await s2.write([summaryListing()]);
  assert.ok(logger.entries.some(e => e.msg === 'sink rejected listings' && e.rejected === 1));
});

test('HttpSink validates batch size bounds', () => {
  assert.throws(() => new HttpSink({ url: 'https://x/', token: 't', batchSize: 101 }), /batchSize/);
});

test('createSinks builds every selected sink', async t => {
  const dir = tempDir(t);
  const config = loadConfig({
    argv: ['--output=sqlite,jsonl,http', `--db=${path.join(dir, 'a.sqlite')}`, `--jsonl=${path.join(dir, 'a.jsonl')}`],
    env: { SINK_URL: 'https://sink.example/ingest', SINK_TOKEN: 't' }
  });
  const sinks = createSinks(config);
  assert.deepEqual(sinks.map(s => s.name), ['sqlite', 'jsonl', 'http']);
  for (const s of sinks) await s.close();
});

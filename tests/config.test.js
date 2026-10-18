const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Writable } = require('node:stream');
const { loadConfig, ConfigError } = require('../src/config');
const { main } = require('../src/cli');

const cwd = '/tmp/kc';

test('defaults', () => {
  const c = loadConfig({ env: {}, argv: [], cwd });
  assert.deepEqual(c.categories, ['buy', 'rent']);
  assert.equal(c.mode, 'recent');
  assert.equal(c.maxPages, 3);
  assert.equal(c.stopAfterExisting, 30);
  assert.equal(c.fetchDetails, true);
  assert.deepEqual(c.outputs, ['sqlite']);
  assert.equal(c.dbPath, path.join(cwd, 'data/kilid.sqlite'));
  assert.equal(c.jsonlPath, '-');
  assert.equal(c.delayMs, 350);
});

test('flags and env override defaults', () => {
  const c = loadConfig({
    cwd,
    env: { KILID_DB_PATH: 'x/k.sqlite', KILID_DELAY_MS: '1000', HTTP_TIMEOUT_MS: '5000', HTTP_MAX_RETRIES: '2' },
    argv: ['--category=rent', '--mode=full', '--pages=7', '--stop-after=5', '--no-details', '--output=jsonl,sqlite', '--jsonl=out.jsonl', '--sync-regions']
  });
  assert.deepEqual(c.categories, ['rent']);
  assert.equal(c.mode, 'full');
  assert.equal(c.maxPages, 7);
  assert.equal(c.stopAfterExisting, 5);
  assert.equal(c.fetchDetails, false);
  assert.equal(c.syncRegions, true);
  assert.deepEqual(c.outputs, ['jsonl', 'sqlite']);
  assert.equal(c.dbPath, path.join(cwd, 'x/k.sqlite'));
  assert.equal(c.jsonlPath, path.join(cwd, 'out.jsonl'));
  assert.equal(c.delayMs, 1000);
  assert.deepEqual(c.http, { timeoutMs: 5000, maxRetries: 2, rateLimitBackoffMs: 15000 });
  assert.equal(loadConfig({ cwd, env: { KILID_DB_PATH: 'x.sqlite' }, argv: ['--db=y.sqlite'] }).dbPath, path.join(cwd, 'y.sqlite'));
});

test('invalid input fails fast with a clear message', () => {
  const bad = [
    [['--category=land'], {}, /--category/],
    [['--mode=fast'], {}, /--mode/],
    [['--pages=-1'], {}, /--pages/],
    [['--pages=abc'], {}, /--pages/],
    [['--stop-after=0'], {}, /--stop-after/],
    [['--output=ftp'], {}, /--output/],
    [['--bogus'], {}, /Unknown argument/],
    [['--db'], {}, /requires a value/],
    [['--no-details=1'], {}, /does not take a value/],
    [[], { HTTP_TIMEOUT_MS: 'soon' }, /HTTP_TIMEOUT_MS/],
    [[], { LOG_LEVEL: 'loud' }, /LOG_LEVEL/],
    [['--output=http'], {}, /SINK_URL is required/],
    [['--output=http'], { SINK_URL: 'https://x.example/' }, /SINK_TOKEN is required/],
    [['--output=http'], { SINK_URL: 'not a url', SINK_TOKEN: 't' }, /SINK_URL/],
    [['--output=http'], { SINK_URL: 'https://x/', SINK_TOKEN: 't', SINK_BATCH_SIZE: '500' }, /SINK_BATCH_SIZE/]
  ];
  for (const [argv, env, msg] of bad) {
    assert.throws(() => loadConfig({ argv, env, cwd }), err => err instanceof ConfigError && msg.test(err.message), `${argv} ${JSON.stringify(env)}`);
  }
});

test('http output config', () => {
  const c = loadConfig({ cwd, argv: ['--output=http'], env: { SINK_URL: 'https://core.example/api/ingest/listings/', SINK_TOKEN: 's3cret', SINK_BATCH_SIZE: '50' } });
  assert.deepEqual(c.sink, { url: 'https://core.example/api/ingest/listings/', token: 's3cret', batchSize: 50 });
});

function capture() {
  let text = '';
  const stream = new Writable({ write(chunk, _enc, cb) { text += chunk; cb(); } });
  return { stream, get text() { return text; } };
}

test('cli: --help prints usage to stdout and exits 0; bad flag exits 2', async () => {
  const out = capture();
  assert.equal(await main({ argv: ['--help'], env: {}, stdout: out.stream, stderr: capture().stream }), 0);
  assert.match(out.text, /Usage: kilid-crawler/);
  const err = capture();
  assert.equal(await main({ argv: ['--mode=x'], env: {}, stdout: capture().stream, stderr: err.stream }), 2);
  assert.match(err.text, /Invalid --mode/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tempDir, memoryLogger } = require('./helpers');
const { CrawlRunner } = require('../src/runner');
const { StateStore } = require('../src/state');
const { SqliteSink } = require('../src/sinks/sqlite');
const { HttpError } = require('../src/http-client');

function fakeAdapter(pages, { failDetailsFor = [] } = {}) {
  const detailCalls = [];
  return {
    name: 'kilid',
    categories: ['buy'],
    detailCalls,
    async fetchPage(category, cursor) {
      const index = cursor ?? 0;
      const ids = pages[index] || [];
      return {
        items: ids.map(id => ({
          source: 'kilid', sourceId: id, url: `https://kilid.com/detail/${id}`, listingType: 'BUY',
          title: `t${id}`, hasFullDetails: false
        })),
        nextCursor: index + 1 < pages.length ? index + 1 : null,
        page: index + 1
      };
    },
    async fetchDetails(summary) {
      detailCalls.push(summary.sourceId);
      if (failDetailsFor.includes(summary.sourceId)) throw new HttpError(404, 'x');
      return { ...summary, description: 'full', hasFullDetails: true, images: [], attributes: [], details: { is_archived: false } };
    }
  };
}

class MemorySink {
  constructor() { this.name = 'memory'; this.items = []; this.flushes = 0; }
  async write(listings) { this.items.push(...listings); }
  async flush() { this.flushes++; }
  async close() {}
}

function setup(t) {
  const dbPath = path.join(tempDir(t), 'kilid.sqlite');
  const state = new StateStore(dbPath);
  t.after(() => state.close());
  return { dbPath, state, logger: memoryLogger() };
}

test('recent crawl emits contract listings with details, dedupes, isolates detail failures', async t => {
  const { state, logger } = setup(t);
  const sink = new MemorySink();
  const adapter = fakeAdapter([['a', 'b'], ['c', 'a']], { failDetailsFor: ['c'] });
  const res = await new CrawlRunner(adapter, state, [sink], { logger }).crawl({ category: 'buy', maxPages: 5 });

  assert.deepEqual(res, {
    pagesCrawled: 2, listingsCrawled: 3, newListings: 3, updatedListings: 0, detailsFailed: 1, stopReason: 'last_page'
  });
  assert.deepEqual(sink.items.map(l => [l.sourceId, l.hasFullDetails]), [['a', true], ['b', true], ['c', false]]);
  assert.ok(sink.items.every(l => l.schemaVersion === 1 && typeof l.crawledAt === 'string'));
  assert.equal(state.needsDetails('a'), false);
  assert.equal(state.needsDetails('c'), true, 'failed details are retried next run');
  assert.ok(logger.entries.some(e => e.msg === 'details fetch failed' && e.level === 'info'), '404 is logged at info');
});

test('second recent crawl stops when caught up and skips details for complete listings', async t => {
  const { state, logger } = setup(t);
  const pages = [['a', 'b'], ['c', 'd'], ['e']];
  await new CrawlRunner(fakeAdapter(pages), state, [new MemorySink()], { logger }).crawl({ category: 'buy', maxPages: 5 });

  const adapter = fakeAdapter(pages);
  const sink = new MemorySink();
  const res = await new CrawlRunner(adapter, state, [sink], { logger })
    .crawl({ category: 'buy', maxPages: 5, stopAfterExisting: 2 });
  assert.equal(res.stopReason, 'caught_up');
  assert.equal(res.pagesCrawled, 1);
  assert.equal(res.updatedListings, 2);
  assert.deepEqual(adapter.detailCalls, []);
  assert.deepEqual(sink.items.map(l => l.hasFullDetails), [false, false], 'known listings are re-emitted as summaries');
});

test('full mode ignores stopAfterExisting; --no-details never fetches details', async t => {
  const { state, logger } = setup(t);
  const pages = [['a'], ['b'], ['c']];
  await new CrawlRunner(fakeAdapter(pages), state, [new MemorySink()], { logger }).crawl({ category: 'buy', maxPages: 5 });
  const adapter = fakeAdapter(pages);
  const res = await new CrawlRunner(adapter, state, [new MemorySink()], { fetchDetails: false, logger })
    .crawl({ category: 'buy', mode: 'full', maxPages: 2, stopAfterExisting: 1 });
  assert.equal(res.stopReason, 'max_pages');
  assert.equal(res.pagesCrawled, 2);
  assert.deepEqual(adapter.detailCalls, []);
});

test('a failing sink aborts the crawl and leaves listings unseen', async t => {
  const { state, logger } = setup(t);
  const broken = { name: 'broken', write: async () => { throw new Error('disk full'); }, flush: async () => {}, close: async () => {} };
  await assert.rejects(
    new CrawlRunner(fakeAdapter([['a']]), state, [broken], { logger }).crawl({ category: 'buy' }),
    /disk full/
  );
  assert.equal(state.isKnown('a'), false);
  assert.ok(logger.entries.some(e => e.msg === 'crawl failed'));
});

test('empty page stops the crawl; unknown category and empty sinks are rejected', async t => {
  const { state, logger } = setup(t);
  const res = await new CrawlRunner(fakeAdapter([[]]), state, [new MemorySink()], { logger }).crawl({ category: 'buy' });
  assert.equal(res.stopReason, 'empty_page');
  await assert.rejects(new CrawlRunner(fakeAdapter([]), state, [new MemorySink()], { logger }).crawl({ category: 'land' }), /no category/);
  assert.throws(() => new CrawlRunner(fakeAdapter([]), state, []), /at least one sink/);
});

test('runner + SqliteSink share one DB file (state and listings tables)', async t => {
  const { dbPath, state, logger } = setup(t);
  const sink = new SqliteSink(dbPath);
  t.after(() => sink.close());
  await new CrawlRunner(fakeAdapter([['a', 'b']]), state, [sink], { logger }).crawl({ category: 'buy' });
  assert.equal(sink.count(), 2);
  assert.equal(sink.getListing('a').description, 'full');
  assert.equal(sink.getListing('a').has_full_details, 1);
});

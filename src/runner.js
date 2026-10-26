const { createLogger } = require('./logger');
const { HttpError } = require('./http-client');
const { toContractListing } = require('./listing');

/**
 * Source-agnostic crawl loop.
 *
 * Adapter contract:
 *   name: string, categories: string[]
 *   fetchPage(category, cursor|null) -> { items: normalized summaries, nextCursor|null, page }
 *   fetchDetails(summary) -> normalized listing | null
 *
 * Modes:
 *   recent: walk newest-first until `maxPages` or `stopAfterExisting` consecutive already-known listings.
 *   full:   walk up to `maxPages` regardless of known listings.
 * Details are fetched for new listings and for known ones whose full details were never emitted.
 * Each page is written (and flushed) to every sink, then recorded in the state store (so a failed sink write does not
 * mark listings as seen). A failing detail fetch keeps the summary; a failing page/sink aborts the crawl.
 */
class CrawlRunner {
  constructor(adapter, state, sinks, { fetchDetails = true, now = () => new Date().toISOString(), logger } = {}) {
    if (!Array.isArray(sinks) || sinks.length === 0) throw new Error('CrawlRunner needs at least one sink');
    this.adapter = adapter;
    this.state = state;
    this.sinks = sinks;
    this.fetchDetails = fetchDetails;
    this.now = now;
    this.log = logger || createLogger('crawler');
  }

  async loadDetails(summary, log) {
    try {
      return await this.adapter.fetchDetails(summary);
    } catch (err) {
      // A removed/expired post is not a crawl failure; keep the summary.
      const gone = err instanceof HttpError && (err.status === 404 || err.status === 410);
      log[gone ? 'info' : 'warn']('details fetch failed', { sourceId: summary.sourceId, error: err.message });
      return null;
    }
  }

  /** Deliver one page to every sink (flushed, so nothing is buffered) before marking it seen. */
  async writeAll(listings) {
    if (!listings.length) return;
    for (const sink of this.sinks) {
      await sink.write(listings);
      await sink.flush();
    }
    this.state.markSeen(listings, { now: this.now() });
  }

  async crawl({ category, mode = 'recent', maxPages = 3, stopAfterExisting = 30 } = {}) {
    const source = this.adapter.name;
    if (!this.adapter.categories.includes(category)) {
      throw new Error(`Source '${source}' has no category '${category}' (available: ${this.adapter.categories.join(', ')})`);
    }
    if (mode !== 'recent' && mode !== 'full') throw new Error(`Unknown mode '${mode}'`);

    const log = this.log.child({ source, category, mode });
    const stats = { pagesCrawled: 0, listingsCrawled: 0, newListings: 0, updatedListings: 0, detailsFailed: 0 };
    const seen = new Set();
    let consecutiveExisting = 0;
    let cursor = null;
    let stopReason = 'max_pages';

    log.info('crawl started', { maxPages, stopAfterExisting });
    try {
      for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
        const { items, nextCursor, page } = await this.adapter.fetchPage(category, cursor);
        stats.pagesCrawled++;
        if (!items.length) { stopReason = 'empty_page'; break; }

        const batch = [];
        for (const summary of items) {
          if (summary.cityName && !['تهران', 'Tehran', 'tehran'].includes(summary.cityName.trim())) {
            continue; // skip out-of-scope cities (Homba is Tehran-focused)
          }
          if (seen.has(summary.sourceId)) continue; // pinned/bumped posts repeat across pages
          seen.add(summary.sourceId);
          stats.listingsCrawled++;

          const known = this.state.get(summary.sourceId);
          let record = summary;
          if (this.fetchDetails && !known?.hasFullDetails) {
            const details = await this.loadDetails(summary, log);
            if (details) record = details;
            else stats.detailsFailed++;
          }
          batch.push(toContractListing(record, { crawledAt: this.now() }));

          if (known) {
            stats.updatedListings++;
            consecutiveExisting++;
          } else {
            stats.newListings++;
            consecutiveExisting = 0;
          }
        }

        await this.writeAll(batch);
        log.info('page processed', { page: page ?? pageIndex, items: items.length, written: batch.length, ...stats });

        if (mode === 'recent' && consecutiveExisting >= stopAfterExisting) { stopReason = 'caught_up'; break; }
        if (!nextCursor) { stopReason = 'last_page'; break; }
        cursor = nextCursor;
      }
    } catch (err) {
      log.error('crawl failed', { ...stats, error: err.message });
      throw err;
    }

    log.info('crawl finished', { ...stats, stopReason });
    return { ...stats, stopReason };
  }
}

module.exports = { CrawlRunner };

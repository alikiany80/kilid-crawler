const { createLogger } = require('./logger');
const { HttpError } = require('./http-client');
const { toContractListing } = require('./listing');
const { changeHash } = require('./state');

/**
 * Source-agnostic crawl loop.
 *
 * Adapter contract:
 *   name: string, categories: string[]
 *   fetchPage(category, cursor|null) -> { items: normalized summaries, nextCursor|null, page }
 *   fetchDetails(summary) -> normalized listing | null
 *
 * Modes:
 *   recent: walk newest-first until `maxPages` or `stopAfterExisting` consecutive known, UNCHANGED listings.
 *   full:   walk up to `maxPages` regardless of known listings.
 * Details are fetched for new listings and for known ones whose full details were never emitted.
 * Each page is written (and flushed) to every sink, then recorded in the state store (so a failed sink write does not
 * mark listings as seen). A failing detail fetch keeps the summary; a failing page/sink aborts the crawl.
 *
 * Change-only emission: change-only sinks (http) receive a listing only when it is new, its summary changeHash
 * changed, or its full details were fetched for the first time. Unchanged known listings are not POSTed.
 * Local sinks (sqlite, jsonl) still receive every walked listing, and the state store records all of them.
 */
const CHANGE_ONLY_SINKS = new Set(['http']);

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

  /**
   * Deliver one page to every sink (flushed, so nothing is buffered) before marking it seen.
   * Change-only sinks get only the listings whose sourceId is in `changedIds`.
   */
  async writeAll(listings, { changedIds = null, changeHashes = null } = {}) {
    if (!listings.length) return;
    const changed = changedIds ? listings.filter(l => changedIds.has(l.sourceId)) : listings;
    for (const sink of this.sinks) {
      const out = CHANGE_ONLY_SINKS.has(sink.name) ? changed : listings;
      if (out.length) await sink.write(out);
      await sink.flush();
    }
    this.state.markSeen(listings, { now: this.now(), changeHashes });
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
    let consecutiveExisting = 0; // consecutive known listings whose content did not change
    let unchanged = 0;
    let cursor = null;
    let stopReason = 'max_pages';

    log.info('crawl started', { maxPages, stopAfterExisting });
    try {
      for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
        const { items, nextCursor, page } = await this.adapter.fetchPage(category, cursor);
        stats.pagesCrawled++;
        if (!items.length) { stopReason = 'empty_page'; break; }

        const batch = [];
        const changedIds = new Set();
        const changeHashes = new Map();
        for (const summary of items) {
          if (summary.cityName && !['تهران', 'Tehran', 'tehran'].includes(summary.cityName.trim())) {
            continue; // skip out-of-scope cities (Homba is Tehran-focused)
          }
          if (seen.has(summary.sourceId)) continue; // pinned/bumped posts repeat across pages
          seen.add(summary.sourceId);
          stats.listingsCrawled++;

          const known = this.state.get(summary.sourceId);
          const summaryHash = changeHash(toContractListing(summary, { crawledAt: '' }));
          let record = summary;
          let gotDetails = false;
          if (this.fetchDetails && !known?.hasFullDetails) {
            const details = await this.loadDetails(summary, log);
            if (details) { record = details; gotDetails = true; }
            else stats.detailsFailed++;
          }
          const listing = toContractListing(record, { crawledAt: this.now() });
          batch.push(listing);
          changeHashes.set(listing.sourceId, summaryHash);

          // Legacy rows (before change_hash existed) count as unchanged once; their hash is backfilled on markSeen.
          const contentChanged = known ? (known.changeHash != null && known.changeHash !== summaryHash) : true;
          const changed = !known || contentChanged || gotDetails;
          if (changed) changedIds.add(listing.sourceId);

          if (known) {
            stats.updatedListings++;
            if (changed) {
              consecutiveExisting = 0;
            } else {
              unchanged++;
              consecutiveExisting++;
            }
          } else {
            stats.newListings++;
            consecutiveExisting = 0;
          }
        }

        await this.writeAll(batch, { changedIds, changeHashes });
        log.info('page processed', {
          page: page ?? pageIndex, items: items.length, written: batch.length, changed: changedIds.size, unchanged,
          consecutiveUnchanged: consecutiveExisting, ...stats
        });

        if (mode === 'recent' && consecutiveExisting >= stopAfterExisting) { stopReason = 'caught_up'; break; }
        if (!nextCursor) { stopReason = 'last_page'; break; }
        cursor = nextCursor;
      }
    } catch (err) {
      log.error('crawl failed', { ...stats, error: err.message });
      throw err;
    }

    log.info('crawl finished', { ...stats, unchanged, stopReason });
    return { ...stats, stopReason };
  }
}

module.exports = { CrawlRunner };

const crypto = require('node:crypto');
const { openDatabase, runMigrations, transaction } = require('./sqlite');

const MIGRATIONS = [
  {
    version: 1,
    name: 'seen',
    sql: `
      CREATE TABLE seen (
        source_id TEXT PRIMARY KEY,
        has_full_details INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        content_hash TEXT
      );
      CREATE INDEX idx_seen_last_seen_at ON seen(last_seen_at);
    `
  },
  {
    version: 2,
    name: 'seen_change_hash',
    sql: 'ALTER TABLE seen ADD COLUMN change_hash TEXT;'
  }
];

/** Stable hash of a contract listing, ignoring the per-run crawledAt timestamp. */
function contentHash(listing) {
  const { crawledAt, ...rest } = listing;
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

/** Fields that change between runs without the listing itself changing (raw payload, run metadata). */
const VOLATILE_FIELDS = ['crawledAt', 'details', 'publishedAt', 'sourceUpdatedAt', 'hasFullDetails', 'buildingAge'];

/**
 * Stable hash of the list-page summary (as a contract listing) used for change detection. Always computed from
 * the summary, never from details, so a known listing hashes the same on every run unless its visible content changed.
 */
function changeHash(summaryListing) {
  const rest = { ...summaryListing };
  for (const f of VOLATILE_FIELDS) delete rest[f];
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

/**
 * Crawl state independent of the chosen sinks: which listings were already seen and whether their full
 * details were already emitted. Lets recent mode stop early and skip detail fetches with any sink.
 */
class StateStore {
  constructor(dbPath) {
    this.db = openDatabase(dbPath);
    runMigrations(this.db, 'state', MIGRATIONS);
    this.stmts = {
      get: this.db.prepare('SELECT source_id, has_full_details, content_hash, change_hash FROM seen WHERE source_id = ?'),
      upsert: this.db.prepare(`
        INSERT INTO seen (source_id, has_full_details, first_seen_at, last_seen_at, content_hash, change_hash)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (source_id) DO UPDATE SET
          has_full_details = MAX(seen.has_full_details, excluded.has_full_details),
          last_seen_at = excluded.last_seen_at,
          content_hash = excluded.content_hash,
          change_hash = COALESCE(excluded.change_hash, seen.change_hash)
      `)
    };
  }

  /** null when unknown, else { sourceId, hasFullDetails, contentHash, changeHash }. */
  get(sourceId) {
    const row = this.stmts.get.get(String(sourceId));
    return row ? { sourceId: row.source_id, hasFullDetails: row.has_full_details === 1, contentHash: row.content_hash, changeHash: row.change_hash }
      : null;
  }

  isKnown(sourceId) {
    return this.get(sourceId) !== null;
  }

  needsDetails(sourceId) {
    const row = this.get(sourceId);
    return !row || !row.hasFullDetails;
  }

  /**
   * Record emitted contract listings atomically (call only after all sinks accepted them).
   * `changeHashes` (optional Map sourceId -> summary changeHash) stores the change-detection hash.
   */
  markSeen(listings, { now = new Date().toISOString(), changeHashes = null } = {}) {
    transaction(this.db, () => {
      for (const l of listings) {
        const ch = changeHashes ? changeHashes.get(String(l.sourceId)) ?? null : null;
        this.stmts.upsert.run(String(l.sourceId), l.hasFullDetails ? 1 : 0, now, now, contentHash(l), ch);
      }
    });
  }

  close() {
    this.db.close();
  }
}

module.exports = { StateStore, contentHash, changeHash };

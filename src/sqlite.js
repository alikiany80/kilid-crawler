const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/**
 * Open a SQLite file with the pragmas every component relies on.
 * temp_store=MEMORY: SQLite otherwise spills temp files to /var/tmp, which is not writable in many
 * sandboxed/containerized deployments ("unable to open database file").
 */
function openDatabase(dbPath) {
  if (!dbPath) throw new Error('openDatabase requires a path');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
  `);
  return db;
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Apply pending forward-only migrations of one component (`scope`), each in its own transaction.
 * Several components (state, sqlite sink, regions) share one file, so versions are tracked per scope.
 * Returns the applied versions.
 */
function runMigrations(db, scope, migrations) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      scope TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (scope, version)
    );
  `);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations WHERE scope = ?').all(scope).map(r => r.version)
  );
  const done = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    try {
      transaction(db, () => {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migrations (scope, version, name, applied_at) VALUES (?, ?, ?, ?)')
          .run(scope, m.version, m.name, new Date().toISOString());
      });
    } catch (err) {
      throw new Error(`Migration ${scope}/${m.version}_${m.name} failed: ${err.message}`, { cause: err });
    }
    done.push(m.version);
  }
  return done;
}

/** SQLite bindings accept null/number/string/bigint/buffer only. */
function toSql(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

module.exports = { openDatabase, runMigrations, transaction, toSql };

/**
 * Minimal structured logger: JSON lines to STDERR only (stdout is reserved for `--output=jsonl --jsonl=-`).
 * Level from LOG_LEVEL=debug|info|warn|error (default info). Never pass secrets or contact data in fields.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel() {
  return LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
}

function createLogger(component, baseFields = {}, { write = line => process.stderr.write(line) } = {}) {
  const emit = (level, msg, fields = {}) => {
    if (LEVELS[level] < currentLevel()) return;
    write(JSON.stringify({ ts: new Date().toISOString(), level, component, msg, ...baseFields, ...fields }) + '\n');
  };
  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: fields => createLogger(component, { ...baseFields, ...fields }, { write })
  };
}

module.exports = { createLogger, LEVELS };

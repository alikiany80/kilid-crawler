const path = require('node:path');
const { LEVELS } = require('./logger');

const CATEGORIES = ['buy', 'rent'];
const MODES = ['recent', 'full'];
const OUTPUTS = ['sqlite', 'jsonl', 'http'];
const DEFAULT_DB_PATH = 'data/kilid.sqlite';

const USAGE = `Usage: kilid-crawler [options]

Crawl kilid.com listings (Tehran) and emit listing contract v1 records.

Options:
  --category=buy|rent|all   Section(s) to crawl (default: all)
  --mode=recent|full        recent: stop after --stop-after consecutive known listings;
                            full: walk all --pages regardless (default: recent)
  --pages=N                 Max list pages per category, 0 = no crawl (default: 3)
  --stop-after=N            Consecutive known listings that end a recent crawl (default: 30)
  --no-details              Do not fetch detail pages (summaries only)
  --output=LIST             Comma list of sinks: sqlite,jsonl,http (default: sqlite)
  --db=PATH                 SQLite file for state and the sqlite sink (default: $KILID_DB_PATH or ${DEFAULT_DB_PATH})
  --jsonl=-|PATH            JSONL target, '-' = stdout (default: -)
  --sync-regions            Also download Tehran regions into the kilid_regions table of --db
  -h, --help                Show this help

Environment: KILID_DB_PATH, KILID_DELAY_MS, HTTP_TIMEOUT_MS, HTTP_MAX_RETRIES,
HTTP_RATE_LIMIT_BACKOFF_MS, SINK_URL, SINK_TOKEN, SINK_BATCH_SIZE, LOG_LEVEL (see .env.example).
Logs are JSON lines on stderr; stdout is used only for --jsonl=-.`;

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function parseIntStrict(raw, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(raw);
  if (raw === '' || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`Invalid ${label}=${raw}: expected an integer in [${min}, ${max}]`);
  }
  return value;
}

function readInt(env, name, fallback, range) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return parseIntStrict(raw, name, range);
}

/** Parse CLI flags (`--key=value`, `--flag`). Pure; throws ConfigError on unknown/invalid input. */
function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') { args.help = true; continue; }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new ConfigError(`Unknown argument: ${arg}`);
    const [, key, value] = match;
    const needsValue = ['category', 'mode', 'pages', 'stop-after', 'output', 'db', 'jsonl'];
    const isFlag = ['no-details', 'sync-regions'];
    if (needsValue.includes(key)) {
      if (value === undefined || value === '') throw new ConfigError(`--${key} requires a value (--${key}=...)`);
      args[key] = value;
    } else if (isFlag.includes(key)) {
      if (value !== undefined) throw new ConfigError(`--${key} does not take a value`);
      args[key] = true;
    } else {
      throw new ConfigError(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function parseOutputs(raw) {
  const outputs = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))];
  if (!outputs.length) throw new ConfigError('--output must list at least one sink');
  for (const o of outputs) {
    if (!OUTPUTS.includes(o)) throw new ConfigError(`Invalid --output '${o}' (allowed: ${OUTPUTS.join(', ')})`);
  }
  return outputs;
}

function parseSinkUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('Invalid SINK_URL: not a URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ConfigError('Invalid SINK_URL: must be http(s)');
  return url.toString();
}

/**
 * Build the validated runtime config from environment + CLI flags (fail fast with a clear message).
 * Relative paths resolve against `cwd`.
 */
function loadConfig({ env = process.env, argv = [], cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  if (args.help) return { help: true, usage: USAGE };

  if (env.LOG_LEVEL && !(env.LOG_LEVEL in LEVELS)) {
    throw new ConfigError(`Invalid LOG_LEVEL=${env.LOG_LEVEL} (allowed: ${Object.keys(LEVELS).join(', ')})`);
  }

  const category = args.category ?? 'all';
  if (category !== 'all' && !CATEGORIES.includes(category)) {
    throw new ConfigError(`Invalid --category=${category} (allowed: ${CATEGORIES.join(', ')}, all)`);
  }
  const mode = args.mode ?? 'recent';
  if (!MODES.includes(mode)) throw new ConfigError(`Invalid --mode=${mode} (allowed: ${MODES.join(', ')})`);

  const outputs = parseOutputs(args.output ?? 'sqlite');
  const sink = { url: null, token: null, batchSize: readInt(env, 'SINK_BATCH_SIZE', 25, { min: 1, max: 100 }) };
  if (outputs.includes('http')) {
    if (!env.SINK_URL) throw new ConfigError('SINK_URL is required with --output=http');
    if (!env.SINK_TOKEN) throw new ConfigError('SINK_TOKEN is required with --output=http');
    sink.url = parseSinkUrl(env.SINK_URL);
    sink.token = env.SINK_TOKEN;
  }

  const jsonlRaw = args.jsonl ?? '-';
  return {
    help: false,
    categories: category === 'all' ? [...CATEGORIES] : [category],
    mode,
    maxPages: args.pages === undefined ? 3 : parseIntStrict(args.pages, '--pages', { min: 0, max: 10000 }),
    stopAfterExisting: args['stop-after'] === undefined
      ? 30
      : parseIntStrict(args['stop-after'], '--stop-after', { min: 1, max: 100000 }),
    fetchDetails: !args['no-details'],
    syncRegions: Boolean(args['sync-regions']),
    outputs,
    dbPath: path.resolve(cwd, args.db ?? (env.KILID_DB_PATH || DEFAULT_DB_PATH)),
    jsonlPath: jsonlRaw === '-' ? '-' : path.resolve(cwd, jsonlRaw),
    delayMs: readInt(env, 'KILID_DELAY_MS', 350, { min: 0, max: 60000 }),
    http: {
      timeoutMs: readInt(env, 'HTTP_TIMEOUT_MS', 20000, { min: 1000, max: 300000 }),
      maxRetries: readInt(env, 'HTTP_MAX_RETRIES', 4, { min: 1, max: 10 }),
      rateLimitBackoffMs: readInt(env, 'HTTP_RATE_LIMIT_BACKOFF_MS', 15000, { min: 100, max: 600000 })
    },
    sink
  };
}

module.exports = { loadConfig, parseArgs, ConfigError, USAGE, CATEGORIES };

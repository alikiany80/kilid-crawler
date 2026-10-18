const { loadConfig, ConfigError } = require('./config');
const { createLogger } = require('./logger');
const { KilidAdapter } = require('./kilid/adapter');
const { StateStore } = require('./state');
const { createSinks, SqliteSink } = require('./sinks');
const { CrawlRunner } = require('./runner');

async function closeAll(resources, log) {
  for (const r of resources) {
    try {
      await r.close();
    } catch (err) {
      log.error('close failed', { error: err.message });
    }
  }
}

/** Download Tehran regions into kilid_regions of the sqlite DB (reuses the sqlite sink when selected). */
async function syncRegions(adapter, sinks, config, log) {
  const existing = sinks.find(s => s instanceof SqliteSink);
  const sink = existing || new SqliteSink(config.dbPath);
  try {
    const { cityId, regions } = await adapter.fetchRegions();
    const saved = sink.saveRegions(regions, cityId);
    log.info('kilid regions synced', { cityId, received: regions.length, saved });
  } finally {
    if (!existing) await sink.close();
  }
}

/** Run the CLI. Returns the process exit code (0 ok, 1 crawl failure, 2 usage/config error). */
async function main({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const log = createLogger('cli');
  let config;
  try {
    config = loadConfig({ env, argv });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    stderr.write(`kilid-crawler: ${err.message}\nRun with --help for usage.\n`);
    return 2;
  }
  if (config.help) {
    stdout.write(config.usage + '\n');
    return 0;
  }

  const { sink, ...safeConfig } = config;
  log.info('starting', { ...safeConfig, sinkUrl: sink.url ? new URL(sink.url).origin : null });

  const state = new StateStore(config.dbPath);
  const sinks = createSinks(config, { stdout });
  const adapter = new KilidAdapter({ http: config.http, delayMs: config.delayMs });
  const results = {};
  let failed = false;
  try {
    if (config.syncRegions) await syncRegions(adapter, sinks, config, log);
    if (config.maxPages > 0) {
      const runner = new CrawlRunner(adapter, state, sinks, { fetchDetails: config.fetchDetails });
      for (const category of config.categories) {
        results[category] = await runner.crawl({
          category,
          mode: config.mode,
          maxPages: config.maxPages,
          stopAfterExisting: config.stopAfterExisting
        });
      }
    }
    log.info('done', { results });
  } catch (err) {
    failed = true;
    log.error('fatal', { error: err.message, results });
  } finally {
    await closeAll([...sinks, state], log);
  }
  return failed ? 1 : 0;
}

module.exports = { main };

const { SqliteSink } = require('./sqlite');
const { JsonlSink } = require('./jsonl');
const { HttpSink } = require('./http');

/** Build every sink selected with --output (config from src/config.js). */
function createSinks(config, { stdout } = {}) {
  return config.outputs.map(output => {
    switch (output) {
      case 'sqlite': return new SqliteSink(config.dbPath);
      case 'jsonl': return new JsonlSink(config.jsonlPath, { stdout });
      case 'http': return new HttpSink({
        url: config.sink.url,
        token: config.sink.token,
        batchSize: config.sink.batchSize,
        timeoutMs: config.http.timeoutMs,
        maxRetries: config.http.maxRetries
      });
      default: throw new Error(`Unknown output '${output}'`);
    }
  });
}

module.exports = { createSinks, SqliteSink, JsonlSink, HttpSink };

const { createLogger } = require('../logger');

const MAX_BATCH = 100;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class SinkHttpError extends Error {
  constructor(status, body) {
    super(`sink responded HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'SinkHttpError';
    this.status = status;
  }
}

/**
 * POSTs {schemaVersion: 1, listings: [...]} batches to SINK_URL with a bearer token.
 * Full batches are sent from write(); the remainder on flush(). Retries 429/5xx/network errors with
 * exponential backoff (Retry-After honoured); other 4xx fail immediately. A batch that still fails throws,
 * so the runner does not mark those listings as seen.
 */
class HttpSink {
  constructor({
    url, token, batchSize = 25, timeoutMs = 20000, maxRetries = 4, backoffMs = 1000,
    fetch: fetchImpl = fetch, sleep: sleepImpl = sleep, logger = createLogger('http-sink')
  }) {
    if (!url) throw new Error('HttpSink requires url');
    if (!token) throw new Error('HttpSink requires token');
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH) {
      throw new Error(`HttpSink batchSize must be an integer in [1, ${MAX_BATCH}]`);
    }
    this.name = 'http';
    this.url = url;
    this.token = token;
    this.batchSize = batchSize;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.backoffMs = backoffMs;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
    this.log = logger;
    this.buffer = [];
    this.totals = { sent: 0, created: 0, updated: 0, rejected: 0 };
  }

  async write(listings) {
    this.buffer.push(...listings);
    while (this.buffer.length >= this.batchSize) {
      await this.sendBatch(this.buffer.slice(0, this.batchSize));
      this.buffer.splice(0, this.batchSize);
    }
  }

  async flush() {
    while (this.buffer.length) {
      const batch = this.buffer.slice(0, this.batchSize);
      await this.sendBatch(batch);
      this.buffer.splice(0, batch.length);
    }
  }

  retryWait(res, attempt) {
    const retryAfter = Number(res?.headers?.get('retry-after'));
    if (res?.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
    return this.backoffMs * 2 ** (attempt - 1);
  }

  async postOnce(body) {
    return this.fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${this.token}`
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs)
    });
  }

  async sendBatch(listings) {
    const body = JSON.stringify({ schemaVersion: 1, listings });
    let lastError = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      let res = null;
      try {
        res = await this.postOnce(body);
      } catch (err) {
        lastError = err;
      }
      if (res) {
        if (res.ok) return this.recordResponse(res, listings.length);
        const text = await res.text().catch(() => '');
        lastError = new SinkHttpError(res.status, text);
        if (res.status !== 429 && res.status < 500) throw lastError;
      }
      if (attempt < this.maxRetries) {
        const waitMs = this.retryWait(res, attempt);
        this.log.warn('retrying sink batch', { attempt, status: res?.status, error: res ? undefined : lastError?.message, waitMs });
        await this.sleep(waitMs);
      }
    }
    throw lastError;
  }

  async recordResponse(res, size) {
    const data = await res.json().catch(() => ({}));
    const rejected = Array.isArray(data.rejected) ? data.rejected : [];
    const counts = {
      size,
      received: data.received ?? null,
      created: data.created ?? null,
      updated: data.updated ?? null,
      rejected: rejected.length
    };
    this.totals.sent += size;
    this.totals.created += Number(data.created) || 0;
    this.totals.updated += Number(data.updated) || 0;
    this.totals.rejected += rejected.length;
    if (rejected.length) {
      this.log.warn('sink rejected listings', { ...counts, sample: rejected.slice(0, 5) });
    } else {
      this.log.info('sink batch accepted', counts);
    }
    return counts;
  }

  async close() {
    this.log.info('sink totals', this.totals);
  }
}

module.exports = { HttpSink, SinkHttpError, MAX_BATCH };

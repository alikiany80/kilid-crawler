const fs = require('node:fs');
const path = require('node:path');

/** One contract object per line, appended to a file, or to stdout when target is '-'. */
class JsonlSink {
  constructor(target, { stdout = process.stdout } = {}) {
    this.name = 'jsonl';
    this.target = target;
    if (target === '-') {
      this.stream = stdout;
      this.ownsStream = false;
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      this.stream = fs.createWriteStream(target, { flags: 'a', encoding: 'utf8' });
      this.ownsStream = true;
    }
  }

  async write(listings) {
    if (!listings.length) return;
    const chunk = listings.map(l => JSON.stringify(l)).join('\n') + '\n';
    await new Promise((resolve, reject) => {
      this.stream.write(chunk, err => (err ? reject(err) : resolve()));
    });
  }

  async flush() {}

  async close() {
    if (!this.ownsStream) return;
    await new Promise((resolve, reject) => {
      this.stream.once('error', reject);
      this.stream.end(resolve);
    });
  }
}

module.exports = { JsonlSink };

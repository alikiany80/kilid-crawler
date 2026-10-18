const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');

function fixture(relPath) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, relPath), 'utf8'));
}

function contractSchema() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'contract/listing.v1.schema.json'), 'utf8'));
}

/** Fresh temp dir removed after the test. */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kilid-crawler-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Logger that records entries instead of writing to stderr. */
function memoryLogger(entries = []) {
  const make = base => {
    const emit = level => (msg, fields = {}) => entries.push({ level, msg, ...base, ...fields });
    return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error'), child: f => make({ ...base, ...f }) };
  };
  const logger = make({});
  logger.entries = entries;
  return logger;
}

/** Build a minimal Next.js RSC flight payload embedding the given list items (as kilid.com/buy does). */
function page1Rsc(items) {
  return [
    '0:["$","html",null,{}]',
    `5:["$","$L6",null,{"initialListings":${JSON.stringify(items)},"total":1234}]`,
    '7:["$","footer",null,{}]'
  ].join('\n');
}

/** RSC payload of /detail/:id where images is a flight reference resolved by URLs elsewhere in the stream. */
function detailRsc(listing, imageUrls = []) {
  const withRef = { ...listing, images: '$8', updatedAt: '$undefined' };
  return [
    '0:["$","html",null,{}]',
    `4:["$","$L5",null,{"listing":${JSON.stringify(withRef)},"related":[]}]`,
    `8:${JSON.stringify(imageUrls)}`
  ].join('\n');
}

module.exports = { ROOT, FIXTURES, fixture, contractSchema, tempDir, memoryLogger, page1Rsc, detailRsc };

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, fixture, contractSchema } = require('./helpers');
const { validate } = require('./schema-validator');
const { normalizeKilidSummary, normalizeKilidDetails } = require('../src/kilid/normalize');
const { toContractListing, CONTRACT_KEYS } = require('../src/listing');

const schema = contractSchema();
const crawledAt = '2026-10-18T09:00:00.000Z';

const cases = [
  ...fixture('kilid/list-buy-page2.json').items.map((item, i) => [`buy summary #${i}`, normalizeKilidSummary(item)]),
  ['rent summary', normalizeKilidSummary(fixture('kilid/list-rent-item.json'))],
  ['detail', normalizeKilidDetails(fixture('kilid/detail.json'))]
];

for (const [name, normalized] of cases) {
  test(`contract v1: ${name} validates`, () => {
    const listing = toContractListing(normalized, { crawledAt });
    assert.deepEqual(validate(schema, listing), []);
    assert.equal(listing.schemaVersion, 1);
    assert.equal(listing.crawledAt, crawledAt);
  });
}

test('contract v1: summaries mark images/attributes unknown (null), details carry arrays', () => {
  const summary = toContractListing(cases[0][1], { crawledAt });
  assert.equal(summary.hasFullDetails, false);
  assert.equal(summary.images, null);
  assert.equal(summary.attributes, null);
  const full = toContractListing(cases.at(-1)[1], { crawledAt });
  assert.ok(Array.isArray(full.images) && full.images.every(i => i.thumbnailUrl === null));
  assert.ok(Array.isArray(full.attributes) && full.attributes.every(a => typeof a.value === 'string'));
});

test('toContractListing keeps only schema keys', () => {
  const listing = toContractListing({ ...cases[0][1], internalFlag: 1, rooms: undefined }, { crawledAt });
  assert.ok(Object.keys(listing).every(k => CONTRACT_KEYS.includes(k)));
  assert.equal('rooms' in listing, false, 'undefined values are dropped');
  assert.deepEqual(Object.keys(schema.properties).sort(), [...CONTRACT_KEYS].sort(), 'CONTRACT_KEYS mirrors the schema');
});

test('vendored contract matches the expected id', () => {
  assert.equal(schema.$id, 'urn:real-estate-listing:v1');
  assert.ok(fs.existsSync(path.join(ROOT, 'contract/README.md')));
});

test('schema validator catches violations', () => {
  const bad = { ...toContractListing(cases[0][1], { crawledAt }), listingType: 'SELL', rooms: 1.5, extra: true, latitude: 100 };
  delete bad.url;
  const errors = validate(schema, bad);
  for (const pattern of [/listingType/, /rooms/, /extra/, /latitude/, /url/]) {
    assert.ok(errors.some(e => pattern.test(e)), `expected an error matching ${pattern}: ${errors.join('; ')}`);
  }
  assert.ok(validate(schema, { ...bad, schemaVersion: 2 }).some(e => /const/.test(e)));
  assert.ok(validate(schema, { ...bad, source: 'X' }).some(e => /pattern|match/.test(e)));
  assert.ok(validate(schema, { ...bad, crawledAt: 'yesterday' }).some(e => /date-time/.test(e)));
});

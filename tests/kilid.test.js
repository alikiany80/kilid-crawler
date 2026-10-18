const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, page1Rsc, detailRsc } = require('./helpers');
const { normalizeKilidSummary, normalizeKilidDetails, locationFromBreadcrumbs, withoutContactData } = require('../src/kilid/normalize');
const { findObjectEnd, parsePage1Rsc, parseListingDetailRsc } = require('../src/kilid/parser');
const { KilidAdapter } = require('../src/kilid/adapter');

test('summary normalization (buy)', () => {
  const n = normalizeKilidSummary(fixture('kilid/list-buy-page2.json').items[0]);
  assert.equal(n.source, 'kilid');
  assert.equal(n.sourceId, '9000001');
  assert.equal(n.listingType, 'BUY');
  assert.equal(n.title, 'آپارتمان نمونه ۱۰۷ متری در نیلوفر');
  assert.equal(n.priceToman, 62_000_000_000);
  assert.equal(n.pricePerMeter, Math.round(62_000_000_000 / 107));
  assert.equal(n.cityName, 'تهران');
  assert.equal(n.neighborhoodName, 'نیلوفر');
  assert.equal(n.isPriceNegotiable, false);
  assert.equal(n.publisherName, 'آژانس نمونه ۱');
  assert.equal(n.coverImageUrl, 'https://example.com/img/2.jpg');
  assert.equal(n.details.agency_id, '1000001');
  assert.equal(n.hasFullDetails, false);
  assert.equal(n.url, 'https://kilid.com/detail/9000001');
});

test('summary normalization (rent) has no price per meter', () => {
  const n = normalizeKilidSummary(fixture('kilid/list-rent-item.json'));
  assert.equal(n.listingType, 'RENT');
  assert.equal(n.priceToman, 1_000_000_000);
  assert.equal(n.rentToman, 55_000_000);
  assert.equal(n.pricePerMeter, null);
});

test('detail normalization uses breadcrumbs and specs', () => {
  const n = normalizeKilidDetails(fixture('kilid/detail.json'));
  assert.equal(n.hasFullDetails, true);
  assert.equal(n.regionName, 'منطقه 7');
  assert.equal(n.neighborhoodName, 'نیلوفر');
  assert.equal(n.floor, 2);
  assert.equal(n.parkingCount, 1);
  assert.equal(n.hasParking, true);
  assert.equal(n.hasElevator, true);
  assert.equal(n.hasStorage, true);
  assert.equal(n.latitude, 35.73815008413058);
  assert.equal(n.locationIsExact, true);
  assert.equal(n.propertyType, 'APARTMENT_TOWER');
  assert.equal(n.sourceUpdatedAt, null, '1970 placeholder dates are dropped');
  assert.equal(n.images.length, 19);
  assert.equal(n.imageCount, 19);
  assert.ok(n.attributes.some(a => a.group === 'specs' && a.name === 'floor'));
  assert.equal(n.details.agency_id, '1000001');
  assert.equal('phone' in n.details.raw_json.agency, false, 'contact keys removed from raw payload');
});

test('phone numbers are redacted from title, description and raw payload', () => {
  const d = {
    ...fixture('kilid/detail.json'),
    title: 'آپارتمان نمونه تماس ۰۹۱۲ ۰۰۰ ۰۰۰۰',
    description: 'توضیحات نمونه. تماس: 09120000000 یا +98 912 000 0000. قیمت 62000000000 تومان'
  };
  const n = normalizeKilidDetails(d);
  assert.doesNotMatch(n.title, /۰۹۱۲/);
  assert.doesNotMatch(n.description, /0912|\+98/);
  assert.match(n.description, /62000000000/, 'long digit runs (prices) are kept');
  assert.doesNotMatch(JSON.stringify(n.details.raw_json), /0912/);
});

test('withoutContactData drops nested contact keys', () => {
  assert.deepEqual(
    withoutContactData({ a: 1, agency: { name: 'x', phone: '1', contactInfo: {} }, list: [{ mobile: '2', b: 3 }] }),
    { a: 1, agency: { name: 'x' }, list: [{ b: 3 }] }
  );
});

test('locationFromBreadcrumbs', () => {
  const loc = locationFromBreadcrumbs([
    { title: 'خرید', url: '/buy' },
    { title: 'تهران', url: '/buy/tehran' },
    { title: 'منطقه 3', url: '/buy/tehran-region3' },
    { title: 'اختیاریه', url: '/buy/tehran-region3-ekhtiarieh' }
  ]);
  assert.deepEqual(loc, { cityName: 'تهران', regionName: 'منطقه 3', neighborhoodName: 'اختیاریه' });
});

test('findObjectEnd ignores braces inside strings', () => {
  const text = 'x{"a":"} {","b":{"c":1}}tail';
  assert.equal(text.slice(1, findObjectEnd(text, 1)), '{"a":"} {","b":{"c":1}}');
  assert.equal(findObjectEnd('{"a":1', 0), -1);
});

test('parseListingDetailRsc handles braces in description', () => {
  const rsc = '1:["$","div",{"listing":{"id":"9","description":"قیمت {ویژه} }","images":"$5"}}]\n"https://cdn.kilid.com/listing/a.webp"';
  const listing = parseListingDetailRsc(rsc);
  assert.equal(listing.description, 'قیمت {ویژه} }');
  assert.deepEqual(listing.images, ['https://cdn.kilid.com/listing/a.webp']);
});

test('parseListingDetailRsc returns null without a listing object', () => {
  assert.equal(parseListingDetailRsc('0:["$","html",null,{}]'), null);
});

test('parsePage1Rsc extracts unique listing objects from the flight payload', () => {
  const items = fixture('kilid/list-buy-page2.json').items;
  const parsed = parsePage1Rsc(page1Rsc([...items, items[0]]));
  assert.deepEqual(parsed.map(i => i.id), ['9000001', '9000002']);
});

function fakeClient(routes) {
  const calls = [];
  const lookup = url => {
    calls.push(url);
    if (!(url in routes)) throw new Error(`unexpected url ${url}`);
    return routes[url];
  };
  return { calls, getRsc: async url => lookup(url), getJson: async url => lookup(url) };
}

test('adapter: page 1 from RSC, page 2 from the listings API, details from detail RSC', async () => {
  const page2 = fixture('kilid/list-buy-page2.json');
  const detail = fixture('kilid/detail.json');
  const client = fakeClient({
    'https://kilid.com/buy': page1Rsc([page2.items[1]]),
    'https://kilid.com/api/listings?url=%2Fbuy&page=2': { items: page2.items, hasNextPage: false },
    'https://kilid.com/detail/9000001': detailRsc(detail, ['https://cdn.kilid.com/listing/2026/a.webp', 'https://cdn.kilid.com/listing/2026/a.webp?q=small'])
  });
  const adapter = new KilidAdapter({ client });

  const p1 = await adapter.fetchPage('buy', null);
  assert.deepEqual(p1.items.map(i => i.sourceId), ['9000002']);
  assert.equal(p1.nextCursor, 2);

  const p2 = await adapter.fetchPage('buy', 2);
  assert.equal(p2.items.length, 2);
  assert.equal(p2.nextCursor, null);

  const full = await adapter.fetchDetails(p2.items[0]);
  assert.equal(full.hasFullDetails, true);
  assert.deepEqual(full.images, [{ url: 'https://cdn.kilid.com/listing/2026/a.webp' }]);
  assert.equal(full.sourceUpdatedAt, null);

  await assert.rejects(adapter.fetchPage('land', null), /Unknown kilid category/);
});

test('adapter: regions API', async () => {
  const client = fakeClient({ 'https://kilid.com/api/regions?cityId=272905': [{ id: 1, name: 'منطقه ۱', slug: 'tehran-region1' }] });
  const { cityId, regions } = await new KilidAdapter({ client }).fetchRegions();
  assert.equal(cityId, 272905);
  assert.equal(regions.length, 1);
});

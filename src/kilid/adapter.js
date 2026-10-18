const { HttpClient } = require('../http-client');
const { parsePage1Rsc, parseListingDetailRsc } = require('./parser');
const { normalizeKilidSummary, normalizeKilidDetails } = require('./normalize');

const BASE_URL = 'https://kilid.com';
const TEHRAN_CITY_ID = 272905;
const SECTIONS = { buy: '/buy', rent: '/rent' };

/**
 * Kilid source adapter. Implements the contract used by src/runner.js:
 *   name, categories, fetchPage(category, cursor) -> { items, nextCursor, page }, fetchDetails(summary)
 *
 * Page 1 is only present in the RSC payload of https://kilid.com/buy|/rent (header RSC: 1);
 * pages 2+ come from /api/listings?url=%2Fbuy&page=N -> { items, hasNextPage }.
 * Detail pages are RSC too; ArvanCloud answers the first hit with a 307 + cookies, which HttpClient follows.
 */
class KilidAdapter {
  constructor({ http = {}, delayMs = 350, client } = {}) {
    this.name = 'kilid';
    this.categories = Object.keys(SECTIONS);
    this.client = client || new HttpClient({ ...http, delayMs });
  }

  async fetchPage(category, cursor) {
    const section = SECTIONS[category];
    if (!section) throw new Error(`Unknown kilid category '${category}'`);
    const page = cursor ?? 1;

    let rawItems;
    let hasNext;
    if (page === 1) {
      rawItems = parsePage1Rsc(await this.client.getRsc(`${BASE_URL}${section}`));
      hasNext = rawItems.length > 0;
    } else {
      const data = await this.client.getJson(`${BASE_URL}/api/listings?url=${encodeURIComponent(section)}&page=${page}`);
      rawItems = Array.isArray(data?.items) ? data.items : [];
      hasNext = Boolean(data?.hasNextPage);
    }

    const items = rawItems.filter(i => i && i.id && /^\d+$/.test(String(i.id))).map(normalizeKilidSummary);
    return { items, nextCursor: hasNext && items.length > 0 ? page + 1 : null, page };
  }

  async fetchDetails(summary) {
    const parsed = parseListingDetailRsc(await this.client.getRsc(`${BASE_URL}/detail/${summary.sourceId}`));
    return parsed ? normalizeKilidDetails(parsed) : null;
  }

  /** Tehran regions (id, name, slug, municipalArea, tags) from the public regions API. */
  async fetchRegions(cityId = TEHRAN_CITY_ID) {
    const regions = await this.client.getJson(`${BASE_URL}/api/regions?cityId=${cityId}`);
    return { cityId, regions: Array.isArray(regions) ? regions : [] };
  }
}

module.exports = { KilidAdapter, BASE_URL, TEHRAN_CITY_ID };

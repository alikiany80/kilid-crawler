/** Contract v1 keys (contract/listing.v1.schema.json), in schema order. */
const CONTRACT_KEYS = [
  'schemaVersion', 'source', 'sourceId', 'url', 'crawledAt', 'hasFullDetails',
  'title', 'description', 'listingType', 'propertyType',
  'cityName', 'regionName', 'neighborhoodName', 'locationLabel', 'latitude', 'longitude', 'locationIsExact',
  'priceToman', 'rentToman', 'pricePerMeter', 'isPriceNegotiable',
  'areaM2', 'landAreaM2', 'rooms', 'yearBuilt', 'buildingAge', 'floor', 'totalFloors', 'unitsPerFloor',
  'parkingCount', 'hasParking', 'hasElevator', 'hasStorage', 'hasBalcony',
  'publisherKind', 'publisherName', 'coverImageUrl', 'imageCount', 'publishedAt', 'sourceUpdatedAt',
  'images', 'attributes', 'details'
];

const finiteOrNull = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function toImages(images) {
  if (!Array.isArray(images)) return null;
  return images
    .filter(img => img && typeof img.url === 'string' && img.url)
    .map(img => ({ url: img.url, thumbnailUrl: typeof img.thumbnailUrl === 'string' ? img.thumbnailUrl : null }));
}

function toAttributes(attributes) {
  if (!Array.isArray(attributes)) return null;
  return attributes
    .filter(a => a && a.name !== undefined && a.name !== null && a.name !== '')
    .map(a => ({
      group: a.group === undefined || a.group === null ? '' : String(a.group),
      name: String(a.name),
      value: a.value === undefined || a.value === null ? '' : String(a.value)
    }));
}

/**
 * Map a normalized listing (src/kilid/normalize.js) to a contract v1 object.
 * Keeps only schema keys and drops undefined ones; images/attributes are null when unknown (summary rows).
 */
function toContractListing(normalized, { crawledAt = new Date().toISOString() } = {}) {
  if (!normalized || typeof normalized !== 'object') throw new TypeError('toContractListing expects a listing object');
  const out = {
    ...normalized,
    schemaVersion: 1,
    sourceId: String(normalized.sourceId),
    crawledAt,
    hasFullDetails: Boolean(normalized.hasFullDetails),
    images: toImages(normalized.images),
    attributes: toAttributes(normalized.attributes),
    details: normalized.details && typeof normalized.details === 'object' ? normalized.details : null
  };
  for (const key of ['latitude', 'longitude', 'priceToman', 'rentToman', 'pricePerMeter', 'areaM2', 'landAreaM2']) {
    if (key in out) out[key] = finiteOrNull(out[key]);
  }

  const listing = {};
  for (const key of CONTRACT_KEYS) {
    if (out[key] !== undefined) listing[key] = out[key];
  }
  return listing;
}

module.exports = { toContractListing, CONTRACT_KEYS };

const { currentJalaliYear, redactPhoneNumbers } = require('../text');

const SOURCE = 'kilid';

function splitLocationLabel(label) {
  if (!label) return { cityName: null, neighborhoodName: null };
  const parts = label.split('-').map(s => s.trim());
  return { cityName: parts[0] || null, neighborhoodName: parts[1] || null };
}

/** Extract city/region/neighborhood from Kilid breadcrumbs (e.g. /buy/tehran-region7). */
function locationFromBreadcrumbs(breadcrumbs) {
  const out = { cityName: null, regionName: null, neighborhoodName: null };
  if (!Array.isArray(breadcrumbs)) return out;
  for (const b of breadcrumbs) {
    if (!b?.url || !/^\/(buy|rent)\//.test(b.url)) continue;
    const seg = b.url.split('/').filter(Boolean)[1];
    if (!seg) continue;
    if (!seg.includes('-')) out.cityName ??= b.title;
    else if (/-region\d+$/.test(seg)) out.regionName ??= b.title;
    else out.neighborhoodName ??= b.title;
  }
  return out;
}

const CONTACT_KEY = /phone|mobile|telephone|email|contact|whatsapp/i;

/** Deep copy of a raw payload without contact fields or phone numbers in strings (the contract never carries contact data). */
function withoutContactData(value) {
  if (Array.isArray(value)) return value.map(withoutContactData);
  if (typeof value === 'string') return redactPhoneNumbers(value);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (!CONTACT_KEY.test(k)) out[k] = withoutContactData(v);
  }
  return out;
}

const positiveOrNull = v => (typeof v === 'number' && v > 0 ? Math.round(v) : null);
const cleanRent = v => (typeof v === 'number' && v >= 500_000 ? Math.round(v) : null);
const cleanRooms = r => (Number.isInteger(r) && r >= 0 && r <= 10 ? r : null);

function pricePerMeter(price, area, listingType) {
  return listingType === 'BUY' && price > 0 && area > 0 ? Math.round(price / area) : null;
}

/** Normalize a Kilid list-page item (summary). */
function normalizeKilidSummary(item) {
  const listingType = item.listingType === 'RENT' ? 'RENT' : 'BUY';
  const { cityName, neighborhoodName } = splitLocationLabel(item.location?.label);
  const priceToman = positiveOrNull(item.priceToman);
  const areaM2 = positiveOrNull(item.areaM2);
  const yearBuilt = positiveOrNull(item.yearBuilt);

  return {
    source: SOURCE,
    sourceId: String(item.id),
    url: `https://kilid.com/detail/${item.id}`,
    title: redactPhoneNumbers(item.title) || null,
    listingType,
    cityName,
    neighborhoodName,
    locationLabel: item.location?.label || null,
    priceToman,
    rentToman: cleanRent(item.rentToman),
    pricePerMeter: pricePerMeter(priceToman, areaM2, listingType),
    isPriceNegotiable: item.agreedPrice === undefined ? null : Boolean(item.agreedPrice),
    areaM2,
    rooms: cleanRooms(item.rooms),
    yearBuilt,
    buildingAge: yearBuilt ? currentJalaliYear() - yearBuilt : null,
    publisherKind: item.publisherKind || item.agency?.kind || null,
    publisherName: item.agency?.name || null,
    coverImageUrl: item.coverImage?.url || null,
    publishedAt: item.publishedAt || null,
    hasFullDetails: false,
    details: {
      location_id: item.location?.id ?? null,
      agency_id: item.agency?.id ? String(item.agency.id) : null,
      agency_name: item.agency?.name || null,
      agency_logo_url: item.agency?.logoUrl || null,
      agency_kind: item.agency?.kind || null,
      is_featured: item.featured === undefined ? null : Boolean(item.featured)
    }
  };
}

function specAttributes(specs) {
  if (!specs) return [];
  const attrs = [];
  for (const [name, value] of Object.entries(specs)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) value.forEach(v => attrs.push({ group: 'specs', name, value: v }));
    else attrs.push({ group: 'specs', name, value });
  }
  return attrs;
}

/** Normalize a Kilid detail payload (parsed from the /detail/:id RSC stream). */
function normalizeKilidDetails(details) {
  const base = normalizeKilidSummary(details);
  const specs = details.specs || {};
  const crumbs = locationFromBreadcrumbs(details.breadcrumbs);
  const yearBuilt = positiveOrNull(specs.yearBuilt) ?? base.yearBuilt;
  const images = Array.isArray(details.images) ? details.images.filter(u => typeof u === 'string') : [];
  const features = Array.isArray(details.features) ? details.features : [];
  const updatedAt = details.updatedAt && !details.updatedAt.startsWith('1970') ? details.updatedAt : null;
  const parkingCount = Number.isInteger(specs.parkingCount) ? specs.parkingCount : null;

  return {
    ...base,
    description: redactPhoneNumbers(details.description) || null,
    propertyType: details.propertyType || null,
    cityName: crumbs.cityName || base.cityName,
    regionName: crumbs.regionName,
    neighborhoodName: crumbs.neighborhoodName || base.neighborhoodName,
    latitude: details.point?.lat ?? null,
    longitude: details.point?.lon ?? null,
    locationIsExact: details.point ? true : null,
    yearBuilt,
    buildingAge: yearBuilt ? currentJalaliYear() - yearBuilt : null,
    floor: Number.isInteger(specs.floor) ? specs.floor : null,
    totalFloors: Number.isInteger(specs.totalFloors) ? specs.totalFloors : null,
    unitsPerFloor: Number.isInteger(specs.unitsPerFloor) ? specs.unitsPerFloor : null,
    parkingCount,
    hasParking: parkingCount === null ? null : parkingCount > 0,
    hasElevator: typeof specs.elevator === 'boolean' ? specs.elevator : null,
    hasStorage: typeof specs.storage === 'boolean' ? specs.storage : null,
    hasBalcony: features.includes('BALCONY') ? true : null,
    imageCount: images.length,
    sourceUpdatedAt: updatedAt,
    hasFullDetails: true,
    images: images.map(url => ({ url })),
    attributes: [
      ...specAttributes(specs),
      ...features.map(f => ({ group: 'features', name: f, value: '' }))
    ],
    details: {
      ...base.details,
      property_type_raw: details.propertyType || null,
      is_archived: details.archived === undefined ? null : Boolean(details.archived),
      video_url: details.videoUrl || null,
      breadcrumbs_json: details.breadcrumbs || null,
      specs_json: details.specs || null,
      features_json: features,
      raw_json: withoutContactData(details)
    }
  };
}

module.exports = { normalizeKilidSummary, normalizeKilidDetails, locationFromBreadcrumbs, withoutContactData };

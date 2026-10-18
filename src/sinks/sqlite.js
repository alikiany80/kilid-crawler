const { openDatabase, runMigrations, transaction, toSql } = require('../sqlite');

/** Contract field -> listings column (all scalar contract fields except identity/bookkeeping). */
const LISTING_FIELDS = [
  ['url', 'url'],
  ['title', 'title'],
  ['description', 'description'],
  ['listingType', 'listing_type'],
  ['propertyType', 'property_type'],
  ['cityName', 'city_name'],
  ['regionName', 'region_name'],
  ['neighborhoodName', 'neighborhood_name'],
  ['locationLabel', 'location_label'],
  ['latitude', 'latitude'],
  ['longitude', 'longitude'],
  ['locationIsExact', 'location_is_exact'],
  ['priceToman', 'price_toman'],
  ['rentToman', 'rent_toman'],
  ['pricePerMeter', 'price_per_meter'],
  ['isPriceNegotiable', 'is_price_negotiable'],
  ['areaM2', 'area_m2'],
  ['landAreaM2', 'land_area_m2'],
  ['rooms', 'rooms'],
  ['yearBuilt', 'year_built'],
  ['buildingAge', 'building_age'],
  ['floor', 'floor'],
  ['totalFloors', 'total_floors'],
  ['unitsPerFloor', 'units_per_floor'],
  ['parkingCount', 'parking_count'],
  ['hasParking', 'has_parking'],
  ['hasElevator', 'has_elevator'],
  ['hasStorage', 'has_storage'],
  ['hasBalcony', 'has_balcony'],
  ['publisherKind', 'publisher_kind'],
  ['publisherName', 'publisher_name'],
  ['coverImageUrl', 'cover_image_url'],
  ['imageCount', 'image_count'],
  ['publishedAt', 'published_at'],
  ['sourceUpdatedAt', 'source_updated_at']
];

const MIGRATIONS = [
  {
    version: 1,
    name: 'listings',
    sql: `
      CREATE TABLE listings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL UNIQUE,
        url TEXT,
        title TEXT,
        description TEXT,
        listing_type TEXT NOT NULL CHECK (listing_type IN ('BUY', 'RENT')),
        property_type TEXT,
        city_name TEXT,
        region_name TEXT,
        neighborhood_name TEXT,
        location_label TEXT,
        latitude REAL,
        longitude REAL,
        location_is_exact INTEGER,
        price_toman INTEGER,
        rent_toman INTEGER,
        price_per_meter INTEGER,
        is_price_negotiable INTEGER,
        area_m2 REAL,
        land_area_m2 REAL,
        rooms INTEGER,
        year_built INTEGER,
        building_age INTEGER,
        floor INTEGER,
        total_floors INTEGER,
        units_per_floor INTEGER,
        parking_count INTEGER,
        has_parking INTEGER,
        has_elevator INTEGER,
        has_storage INTEGER,
        has_balcony INTEGER,
        publisher_kind TEXT,
        publisher_name TEXT,
        cover_image_url TEXT,
        image_count INTEGER,
        published_at TEXT,
        source_updated_at TEXT,
        details_json TEXT,
        raw_json TEXT,
        has_full_details INTEGER NOT NULL DEFAULT 0,
        crawled_at TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        details_fetched_at TEXT
      );
      CREATE INDEX idx_listings_type_price ON listings(listing_type, price_toman);
      CREATE INDEX idx_listings_area ON listings(area_m2);
      CREATE INDEX idx_listings_neighborhood ON listings(neighborhood_name);
      CREATE INDEX idx_listings_published_at ON listings(published_at);
      CREATE INDEX idx_listings_last_seen_at ON listings(last_seen_at);

      CREATE TABLE listing_images (
        listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        url TEXT NOT NULL,
        thumbnail_url TEXT,
        PRIMARY KEY (listing_id, position)
      );

      CREATE TABLE listing_attributes (
        listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        group_name TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        value TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (listing_id, group_name, name, value)
      );
      CREATE INDEX idx_listing_attributes_name ON listing_attributes(name, value);
    `
  },
  {
    version: 2,
    name: 'kilid_regions',
    sql: `
      CREATE TABLE kilid_regions (
        id INTEGER PRIMARY KEY,
        city_id INTEGER NOT NULL,
        name TEXT,
        slug TEXT,
        municipal_area INTEGER,
        tags_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_kilid_regions_city ON kilid_regions(city_id);
    `
  }
];

/** Split contract `details` into (details without raw payload, raw payload). */
function splitDetails(details) {
  if (!details || typeof details !== 'object') return { detailsJson: null, rawJson: null };
  const { raw_json: raw, ...rest } = details;
  return { detailsJson: rest, rawJson: raw ?? null };
}

/**
 * Full local database of contract listings. Upserts on source_id with COALESCE semantics:
 * a summary (hasFullDetails=false) never nulls values a previous detail crawl stored;
 * images/attributes are replaced only when the listing carries an array (null = unknown, keep existing).
 */
class SqliteSink {
  constructor(dbPath) {
    this.name = 'sqlite';
    this.db = openDatabase(dbPath);
    runMigrations(this.db, 'sqlite_sink', MIGRATIONS);
    const cols = LISTING_FIELDS.map(([, c]) => c);
    const allCols = [...cols, 'details_json', 'raw_json'];
    const updates = allCols.map(c => `${c} = COALESCE(excluded.${c}, listings.${c})`).join(',\n        ');
    this.stmts = {
      upsert: this.db.prepare(`
        INSERT INTO listings (source, source_id, ${allCols.join(', ')},
          has_full_details, crawled_at, first_seen_at, last_seen_at, details_fetched_at)
        VALUES (?, ?, ${allCols.map(() => '?').join(', ')}, ?, ?, ?, ?, ?)
        ON CONFLICT (source_id) DO UPDATE SET
        ${updates},
        has_full_details = MAX(listings.has_full_details, excluded.has_full_details),
        crawled_at = excluded.crawled_at,
        last_seen_at = excluded.last_seen_at,
        details_fetched_at = COALESCE(excluded.details_fetched_at, listings.details_fetched_at)
        RETURNING id
      `),
      deleteImages: this.db.prepare('DELETE FROM listing_images WHERE listing_id = ?'),
      insertImage: this.db.prepare(
        'INSERT OR IGNORE INTO listing_images (listing_id, position, url, thumbnail_url) VALUES (?, ?, ?, ?)'
      ),
      deleteAttributes: this.db.prepare('DELETE FROM listing_attributes WHERE listing_id = ?'),
      insertAttribute: this.db.prepare(
        'INSERT OR IGNORE INTO listing_attributes (listing_id, group_name, name, value) VALUES (?, ?, ?, ?)'
      )
    };
  }

  upsertOne(listing, now) {
    const { detailsJson, rawJson } = splitDetails(listing.details);
    const full = listing.hasFullDetails ? 1 : 0;
    const crawledAt = listing.crawledAt || now;
    const { id } = this.stmts.upsert.get(
      listing.source,
      String(listing.sourceId),
      ...LISTING_FIELDS.map(([field]) => toSql(listing[field])),
      toSql(detailsJson),
      toSql(rawJson),
      full,
      crawledAt,
      now,
      now,
      full ? crawledAt : null
    );
    if (Array.isArray(listing.images)) {
      this.stmts.deleteImages.run(id);
      listing.images.forEach((img, i) => this.stmts.insertImage.run(id, i, img.url, img.thumbnailUrl ?? null));
    }
    if (Array.isArray(listing.attributes)) {
      this.stmts.deleteAttributes.run(id);
      for (const a of listing.attributes) this.stmts.insertAttribute.run(id, a.group, a.name, a.value);
    }
    return Number(id);
  }

  async write(listings, { now = new Date().toISOString() } = {}) {
    if (!listings.length) return;
    transaction(this.db, () => {
      for (const l of listings) this.upsertOne(l, now);
    });
  }

  async flush() {}

  /** Replace-by-id upsert of Kilid regions (from /api/regions). */
  saveRegions(regions, cityId, { now = new Date().toISOString() } = {}) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO kilid_regions (id, city_id, name, slug, municipal_area, tags_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let saved = 0;
    transaction(this.db, () => {
      for (const r of regions) {
        if (!r || !Number.isInteger(Number(r.id))) continue;
        stmt.run(
          Number(r.id), cityId, r.name ?? null, r.slug ?? null,
          Number.isInteger(r.municipalArea) ? r.municipalArea : null,
          r.tags ? JSON.stringify(r.tags) : null, now
        );
        saved++;
      }
    });
    return saved;
  }

  getListing(sourceId) {
    const row = this.db.prepare('SELECT * FROM listings WHERE source_id = ?').get(String(sourceId));
    if (!row) return null;
    return {
      ...row,
      images: this.db.prepare('SELECT position, url, thumbnail_url FROM listing_images WHERE listing_id = ? ORDER BY position').all(row.id),
      attributes: this.db.prepare('SELECT group_name, name, value FROM listing_attributes WHERE listing_id = ?').all(row.id)
    };
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM listings').get().n;
  }

  async close() {
    this.db.close();
  }
}

module.exports = { SqliteSink, LISTING_FIELDS };

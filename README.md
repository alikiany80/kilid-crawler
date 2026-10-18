# kilid-crawler

A polite, zero-dependency crawler for real-estate listings on [kilid.com](https://kilid.com) (Tehran, buy and rent).
Every listing is normalized into the [listing contract v1](contract/README.md)
([JSON Schema](contract/listing.v1.schema.json)) and written to one or more outputs: a local SQLite database,
JSON Lines, or an HTTP endpoint.

- Node.js ≥ 22.13 (uses the built-in `node:sqlite`, `fetch` and `node:test`). No npm dependencies.
- Incremental: a small state table remembers which listings were already seen, so `recent` runs stop early
  and do not fetch details again.
- No contact data is collected. Phone fields are removed and phone numbers in free text are redacted.

## Install

```bash
git clone https://github.com/alikiany80/kilid-crawler.git
cd kilid-crawler
node bin/kilid-crawler.js --help        # nothing to install
```

## Usage

```bash
# newest buy + rent listings into data/kilid.sqlite (default)
node bin/kilid-crawler.js

# one page of buy listings, both to SQLite and to a JSONL file
node bin/kilid-crawler.js --category=buy --pages=1 --output=sqlite,jsonl --jsonl=data/buy.jsonl

# stream summaries (no detail requests) to stdout, e.g. into jq
node bin/kilid-crawler.js --no-details --output=jsonl --jsonl=- | jq .title

# deep crawl, sent in batches to your own ingest API
SINK_URL=https://ingest.example/api/listings/ SINK_TOKEN=... \
  node bin/kilid-crawler.js --mode=full --pages=50 --output=http

# download the list of Tehran regions into the kilid_regions table, without crawling
node bin/kilid-crawler.js --sync-regions --pages=0
```

`npm run crawl -- <flags>` works too.

| Flag | Default | Meaning |
|---|---|---|
| `--category=buy\|rent\|all` | `all` | Which section(s) to crawl |
| `--mode=recent\|full` | `recent` | `recent` stops after `--stop-after` known listings in a row. `full` walks all `--pages` |
| `--pages=N` | `3` | Maximum list pages per category (about 20 listings each). `0` means no crawl |
| `--stop-after=N` | `30` | Known listings in a row that end a `recent` crawl |
| `--no-details` | off | Skip detail pages and emit list summaries only |
| `--output=LIST` | `sqlite` | Comma list of `sqlite`, `jsonl`, `http` |
| `--db=PATH` | `$KILID_DB_PATH` or `data/kilid.sqlite` | SQLite file for the crawl state and the sqlite output |
| `--jsonl=-\|PATH` | `-` | JSONL target. `-` means stdout. Files are appended to |
| `--sync-regions` | off | Also save Tehran regions (`/api/regions`) into `kilid_regions` in `--db` |

Exit codes: `0` ok, `1` crawl failed, `2` invalid flags or environment.

### How it works

1. Page 1 of `https://kilid.com/buy` or `/rent` comes from the Next.js RSC payload (request header `RSC: 1`).
   Pages 2 and later come from `https://kilid.com/api/listings?url=%2Fbuy&page=N`, which returns `{items, hasNextPage}`.
2. For new listings, and for known listings whose full details were never stored, the crawler fetches the detail
   RSC payload at `https://kilid.com/detail/:id`. The ArvanCloud `307` + cookie challenge is followed automatically.
3. Each page is written to every output. Only after all outputs accept it is the page recorded in the
   `seen` state table. If a detail request fails, the crawler keeps the summary and retries the details on the next run.

## Outputs

- **sqlite** (default) has these tables: `listings` (every contract column, plus `details_json`, `raw_json`,
  `first_seen_at`, `last_seen_at`), `listing_images`, `listing_attributes` and, optionally, `kilid_regions`.
  Rows are upserted on `source_id` with COALESCE semantics, so a later summary never erases values that an
  earlier detail crawl stored. The DB uses WAL mode, a busy timeout and versioned migrations.
- **jsonl** writes one contract v1 object per line.
- **http** sends `POST {SINK_URL}` with `Authorization: Bearer {SINK_TOKEN}` and the body
  `{"schemaVersion":1,"listings":[...]}`, in batches of `SINK_BATCH_SIZE` (default 25, max 100). The request
  is retried with backoff on 429, 5xx or network errors. Other 4xx errors are not retried. The response
  counts are logged. See [contract/README.md](contract/README.md).

The crawl state (`seen` table) always lives in the `--db` file, whichever outputs you choose.

Source-specific `details` keys: `location_id`, `agency_id`, `agency_name`, `agency_logo_url`, `agency_kind`,
`is_featured`, `property_type_raw`, `is_archived`, `video_url`, `breadcrumbs_json`, `specs_json`, `features_json`,
and `raw_json` (the original detail payload without contact fields).

## Environment

All variables are optional. See [.env.example](.env.example). Values are checked at startup, and invalid
ones stop the crawler with a clear message.

| Variable | Default | |
|---|---|---|
| `KILID_DB_PATH` | `data/kilid.sqlite` | Same as `--db` (the flag wins) |
| `KILID_DELAY_MS` | `350` | Minimum gap between requests to kilid.com |
| `HTTP_TIMEOUT_MS` | `20000` | Per-request timeout |
| `HTTP_MAX_RETRIES` | `4` | Attempts per request (network errors, 5xx, 429) |
| `HTTP_RATE_LIMIT_BACKOFF_MS` | `15000` | Base backoff after a 429 without `Retry-After` |
| `SINK_URL`, `SINK_TOKEN` | – | Required only with `--output=http` |
| `SINK_BATCH_SIZE` | `25` | Listings per HTTP batch (1–100) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

Logs are JSON lines on **stderr**. Stdout is used only for `--jsonl=-`.

## Etiquette and legal

- This tool is for personal and educational use. Respect kilid.com's terms of service and robots rules.
- Requests are throttled (`KILID_DELAY_MS`), back off on rate limits, and are read-only. Keep page counts modest
  and do not run many instances in parallel.
- No contact data is collected or emitted: phone and contact fields are dropped, and phone numbers in titles
  and descriptions are replaced with a placeholder.

## Library use

```js
const { KilidAdapter, CrawlRunner, StateStore, SqliteSink } = require('kilid-crawler');
const state = new StateStore('data/kilid.sqlite');
const runner = new CrawlRunner(new KilidAdapter(), state, [new SqliteSink('data/kilid.sqlite')]);
await runner.crawl({ category: 'buy', maxPages: 1 });
```

## Tests

```bash
npm test          # = node --test "tests/**/*.test.js"
```

The tests are fully offline. Fixtures have the real payload structure but synthetic text and example.com images.
A contract test checks every normalized fixture against `contract/listing.v1.schema.json`, using a small validator
included in the repo (`tests/schema-validator.js`).

## فارسی

**kilid-crawler** آگهی‌های خرید و اجارهٔ ملک تهران را از kilid.com جمع‌آوری می‌کند و هر آگهی را به قالب
استاندارد «قرارداد آگهی نسخهٔ ۱» تبدیل می‌کند. خروجی می‌تواند پایگاه دادهٔ SQLite، فایل JSONL یا یک API باشد.
به هیچ وابستگی‌ای نیاز ندارد و فقط Node.js نسخهٔ ۲۲.۱۳ یا بالاتر لازم است.

```bash
node bin/kilid-crawler.js --category=buy --pages=1 --output=sqlite,jsonl --jsonl=data/buy.jsonl
```

- این ابزار فقط برای استفادهٔ شخصی و آموزشی است. قوانین و شرایط استفادهٔ سایت را رعایت کنید.
- درخواست‌ها با فاصلهٔ زمانی ارسال می‌شوند. تعداد صفحات را کم نگه دارید.
- هیچ اطلاعات تماسی، مثل شمارهٔ تلفن، ذخیره یا منتشر نمی‌شود.

## License

[MIT](LICENSE) © 2026 alikiany80

const { createLogger } = require('../logger');

const log = createLogger('kilid-parser');

function parsePage1Rsc(rscText) {
  const items = [];
  // Match listing objects: {"id":"...","title":...,"featured":(true|false)}
  // Next.js RSC flight chunks serialize listings as JSON fragments
  const regex = /\{"id":"(\d+)","title":.+?"featured":(?:true|false)\}/g;
  let match;
  const seenIds = new Set();

  while ((match = regex.exec(rscText)) !== null) {
    try {
      const obj = JSON.parse(match[0]);
      if (obj.id && !seenIds.has(obj.id)) {
        seenIds.add(obj.id);
        items.push(obj);
      }
    } catch {
      // ignore partial chunk match
    }
  }

  return items;
}

function parseListingDetailRsc(rscText) {
  const startMarker = '"listing":{';
  const idx = rscText.indexOf(startMarker);
  if (idx === -1) {
    return null;
  }

  const start = idx + startMarker.length - 1;
  const end = findObjectEnd(rscText, start);
  if (end === -1) {
    log.warn('unterminated listing object in RSC payload');
    return null;
  }

  // Replace React flight markers like "$undefined" with null
  const cleaned = rscText.slice(start, end).replace(/"\$undefined"/g, 'null');

  let listing = null;
  try {
    listing = JSON.parse(cleaned);
  } catch (err) {
    log.warn('error parsing listing JSON', { error: err.message });
    return null;
  }

  // Extract all high-res image URLs from the RSC stream if images was a react reference
  if (typeof listing.images === 'string' && listing.images.startsWith('$')) {
    const imgMatches = rscText.match(/https:\/\/cdn\.kilid\.com\/listing\/[^"'\\]+\.webp/g) || [];
    const uniqueImages = Array.from(new Set(imgMatches.filter(url => !url.includes('?q=small'))));
    listing.images = uniqueImages;
  }

  return listing;
}

/** Index just past the JSON object starting at `start` ('{'), skipping braces inside strings; -1 if unterminated. */
function findObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}' && --depth === 0) {
      return i + 1;
    }
  }
  return -1;
}

module.exports = {
  findObjectEnd,
  parsePage1Rsc,
  parseListingDetailRsc
};

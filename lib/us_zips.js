// US zip-code → centroid lookup, plus a reverse "nearest zip to a
// lat/lng" used by the trade location endpoint.
//
// Data source: U.S. Census Bureau 2024 ZCTA Gazetteer (public domain).
// See ./us_zips.NOTICE.md.
//
// To regenerate us_zips.json:
//   curl -L -o /tmp/zcta.zip \
//     https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_zcta_national.zip
//   unzip /tmp/zcta.zip -d /tmp
//   node -e '
//     const fs = require("fs");
//     const out = {};
//     fs.readFileSync("/tmp/2024_Gaz_zcta_national.txt","utf8")
//       .trim().split("\n").slice(1).forEach(l => {
//         const p = l.split("\t").map(s => s.trim());
//         if (p.length >= 7) out[p[0]] = [+(+p[5]).toFixed(4), +(+p[6]).toFixed(4)];
//       });
//     fs.writeFileSync("lib/us_zips.json", JSON.stringify(out));
//   '

const path = require('path');
const zips = require('./us_zips.json');

// Build an array view once for the nearest-zip scan. ~34k entries.
// At a few hundred ns per haversine call this is ~10ms — acceptable for
// a one-time write on /api/trade/location. If it ever becomes hot, swap
// to a k-d tree or PostGIS-side ST_ClosestPoint.
const entries = Object.entries(zips).map(([z, [lat, lng]]) => ({ z, lat, lng }));

function lookupZip(zip) {
  if (typeof zip !== 'string') return null;
  const z = zip.trim().slice(0, 5);
  if (!/^\d{5}$/.test(z)) return null;
  const hit = zips[z];
  if (!hit) return null;
  return { zip: z, lat: hit[0], lng: hit[1] };
}

// Haversine — good to ~0.5% over short distances, which is plenty for
// "which zip is closest" decisions.
function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8; // mean Earth radius, miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Find the closest known US zip to a raw lat/lng. Returns null if the
// input is outside any zip centroid's plausible neighborhood (>50 mi).
function nearestZip(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!isFinite(lat) || !isFinite(lng)) return null;
  // Coarse US bounding box — reject obvious non-US coordinates fast.
  // Includes Alaska (lat up to ~71), Hawaii (lng to ~-178), Puerto
  // Rico (lng to ~-65). Excludes anything clearly off-continent.
  if (lat < 17 || lat > 72) return null;
  if (lng < -180 || lng > -65) return null;

  let best = null;
  let bestDist = Infinity;
  for (const e of entries) {
    // Cheap bounding-box prefilter — skip anything more than ~1° away
    // (≈ 69 miles) in either axis. Halves the haversine cost.
    if (Math.abs(e.lat - lat) > 1 || Math.abs(e.lng - lng) > 1) continue;
    const d = haversineMiles(lat, lng, e.lat, e.lng);
    if (d < bestDist) {
      bestDist = d;
      best = e;
    }
  }
  if (!best || bestDist > 50) return null;
  return { zip: best.z, lat: best.lat, lng: best.lng, distance_miles: bestDist };
}

module.exports = { lookupZip, nearestZip, haversineMiles };

// Location helpers: distances, town lookup from typed text, and the SQL distance expression.
// Kept free of DB/network code so it can be unit-tested on its own. Town data lives in towns.js.

const TOWNS = require('./towns');

const EARTH_RADIUS_KM = 6371;

// Search rings for donor matching: nearest donors first, out to the last ring.
const RADIUS_STEPS_KM = [15, 30, 50];
const MAX_RADIUS_KM = RADIUS_STEPS_KM[RADIUS_STEPS_KM.length - 1];

const toRad = deg => (deg * Math.PI) / 180;

function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Same haversine formula as SQL, for "distance from point ($lat, $lng)" to table columns.
function distanceSql(latParam, lngParam, latCol = 'lat', lngCol = 'lng') {
  return `(2 * ${EARTH_RADIUS_KM} * asin(least(1, sqrt(
    power(sin(radians(${latCol} - ${latParam}) / 2), 2) +
    cos(radians(${latParam})) * cos(radians(${latCol})) * power(sin(radians(${lngCol} - ${lngParam}) / 2), 2)
  ))))`;
}

// "Mvog-Mbi, Yaoundé!" -> ['mvog', 'mbi', 'yaounde']
function words(text) {
  return (text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

// Lookup key: words joined without spaces, so "Up Station", "Upstation" and "up-station" agree
const keyOf = text => words(text).join('');

// Everyday words in addresses that must never be "corrected" into a town name
const STOPWORDS = new Set(['hospital', 'hopital', 'regional', 'general', 'district', 'clinic', 'clinique', 'centre',
  'center', 'health', 'medical', 'road', 'street', 'rue', 'town', 'city', 'ville', 'quarter', 'quartier', 'area',
  'near', 'the', 'and', 'of', 'de', 'du', 'des', 'la', 'le', 'les', 'in', 'at', 'junction', 'carrefour', 'market',
  'marche', 'main', 'new', 'old', 'big', 'small', 'petit', 'grand', 'mile', 'pk', 'opposite', 'behind', 'after', 'before']);

// key -> [{ town, kind: 'name' | 'area', label }]
const INDEX = new Map();
const ENTRIES = [];
for (const town of TOWNS) {
  const add = (label, kind) => {
    const key = keyOf(label);
    if (!key) return;
    const entry = { key, town, kind, label };
    if (!INDEX.has(key)) INDEX.set(key, []);
    INDEX.get(key).push(entry);
    ENTRIES.push(entry);
  };
  add(town.name, 'name');
  (town.aliases || []).forEach(a => add(a, 'name'));
  (town.areas || []).forEach(a => add(a, 'area'));
}

// Edit distance counting a swap of two neighbouring letters as one edit ("Bamedna" -> "Bamenda" = 1)
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// Typos allowed for a known key. Town names: 1 for 4-6 letters, 2 for longer.
// Areas are often short everyday-looking words, so they need 6+ letters before any typo is allowed.
function typoLimit(entry) {
  const len = entry.key.length;
  if (entry.kind === 'name') return len >= 7 ? 2 : len >= 4 ? 1 : 0;
  return len >= 8 ? 2 : len >= 6 ? 1 : 0;
}

const uniqueTowns = list => [...new Map(list.map(e => [e.town.name, e.town])).values()];

// Typed place -> town. Returns { town, how, area, suggestions }:
// - town set: confident match. how = 'name' (name/alias), 'area' (neighbourhood) or 'typo'
// - town null: suggestions holds up to 2 likely town names (may be empty)
function resolveTown(text) {
  const ws = words(text);
  const empty = { town: null, how: null, area: null, suggestions: [] };
  if (ws.length === 0) return empty;

  // Word groups of 3, 2 and 1 words, earliest first
  const grams = [];
  for (let n = Math.min(3, ws.length); n >= 1; n--) {
    for (let i = 0; i + n <= ws.length; i++) {
      const part = ws.slice(i, i + n);
      grams.push({ key: part.join(''), pos: i, n, allStop: part.every(w => STOPWORDS.has(w)) });
    }
  }

  // 1. Exact town name or alias (earliest in the text wins: "Molyko, Buea" -> Buea)
  const nameHits = grams.flatMap(g => (INDEX.get(g.key) || []).filter(e => e.kind === 'name').map(e => ({ ...e, pos: g.pos })));
  if (nameHits.length > 0) {
    const first = nameHits.reduce((a, b) => (b.pos < a.pos ? b : a));
    return { town: first.town, how: 'name', area: null, suggestions: [] };
  }

  // 2. Exact neighbourhood; one listed under several towns is ambiguous
  const areaHits = grams.flatMap(g => (INDEX.get(g.key) || []).filter(e => e.kind === 'area'));
  if (areaHits.length > 0) {
    const towns = uniqueTowns(areaHits);
    if (towns.length === 1) return { town: towns[0], how: 'area', area: areaHits[0].label, suggestions: [] };
    return { ...empty, suggestions: towns.slice(0, 2).map(t => t.name) };
  }

  // 3. Typos: same first letter, small edit distance
  const close = [];
  for (const g of grams) {
    if (g.allStop || g.key.length < 4) continue;
    for (const entry of ENTRIES) {
      if (entry.key[0] !== g.key[0] || Math.abs(entry.key.length - g.key.length) > 3) continue;
      const dist = editDistance(g.key, entry.key);
      const limit = typoLimit(entry);
      if (dist <= limit + 1) close.push({ ...entry, dist, ok: dist <= limit && limit > 0 });
    }
  }
  const ok = close.filter(c => c.ok);
  if (ok.length > 0) {
    const best = Math.min(...ok.map(c => c.dist));
    const bestTowns = uniqueTowns(ok.filter(c => c.dist === best));
    if (bestTowns.length === 1) {
      const hit = ok.find(c => c.dist === best);
      return { town: hit.town, how: 'typo', area: hit.kind === 'area' ? hit.label : null, suggestions: [] };
    }
    return { ...empty, suggestions: bestTowns.slice(0, 2).map(t => t.name) };
  }
  const near = close.sort((a, b) => a.dist - b.dist);
  return { ...empty, suggestions: uniqueTowns(near).slice(0, 2).map(t => t.name) };
}

// Known town for typed text when we are confident, else null
function findTown(text) {
  return resolveTown(text).town;
}

// How to show a resolved place: "Molyko, Buea" for a neighbourhood, else the town name
function placeLabel(resolved) {
  if (!resolved?.town) return null;
  return resolved.area ? `${resolved.area}, ${resolved.town.name}` : resolved.town.name;
}

function townByName(name) {
  return TOWNS.find(t => t.name === name) || null;
}

// Closest known town to a point, if it is within maxKm.
function nearestTown(lat, lng, maxKm = 25) {
  let best = null;
  for (const town of TOWNS) {
    const km = haversineKm(lat, lng, town.lat, town.lng);
    if (km <= maxKm && (!best || km < best.km)) best = { ...town, km };
  }
  return best;
}

// Known towns whose centre is within radiusKm of a point (for donors who typed a town, no pin).
function townsWithin(lat, lng, radiusKm) {
  return TOWNS.filter(town => haversineKm(lat, lng, town.lat, town.lng) <= radiusKm).map(town => town.name);
}

// Smallest search ring that contains a distance (for "found within 15 km" style messages).
function ringFor(km) {
  return RADIUS_STEPS_KM.find(r => km <= r) || null;
}

// WhatsApp location message -> { lat, lng, name, address }, or null if malformed.
function parseLocationMessage(message) {
  const loc = message?.location;
  const lat = Number(loc?.latitude);
  const lng = Number(loc?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng, name: loc.name || null, address: loc.address || null };
}

module.exports = {
  RADIUS_STEPS_KM, MAX_RADIUS_KM, TOWNS,
  haversineKm, distanceSql, resolveTown, findTown, placeLabel, townByName, nearestTown, townsWithin, ringFor,
  parseLocationMessage, editDistance
};

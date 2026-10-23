// Location helpers: distances, known town centres, and the SQL distance expression.
// Kept free of DB/network code so it can be unit-tested on its own.

const EARTH_RADIUS_KM = 6371;

// Search rings for donor matching: nearest donors first, out to the last ring.
const RADIUS_STEPS_KM = [15, 30, 50];
const MAX_RADIUS_KM = RADIUS_STEPS_KM[RADIUS_STEPS_KM.length - 1];

// Approximate town centres (public map coordinates, rounded). Used to label a pin
// with a town name and to place requests/donors that typed a town instead of a pin.
const TOWNS = [
  { name: 'Buea', lat: 4.1527, lng: 9.2410 },
  { name: 'Limbe', lat: 4.0167, lng: 9.2000, aliases: ['victoria'] },
  { name: 'Tiko', lat: 4.0750, lng: 9.3600 },
  { name: 'Mutengene', lat: 4.0910, lng: 9.3140 },
  { name: 'Muyuka', lat: 4.2897, lng: 9.4103 },
  { name: 'Idenau', lat: 4.2167, lng: 8.9833 },
  { name: 'Kumba', lat: 4.6363, lng: 9.4469 },
  { name: 'Mamfe', lat: 5.7667, lng: 9.2833 },
  { name: 'Douala', lat: 4.0511, lng: 9.7679 },
  { name: 'Edea', lat: 3.8000, lng: 10.1333 },
  { name: 'Nkongsamba', lat: 4.9547, lng: 9.9404 },
  { name: 'Kribi', lat: 2.9400, lng: 9.9100 },
  { name: 'Yaounde', lat: 3.8480, lng: 11.5021 },
  { name: 'Ebolowa', lat: 2.9000, lng: 11.1500 },
  { name: 'Bertoua', lat: 4.5770, lng: 13.6840 },
  { name: 'Bamenda', lat: 5.9631, lng: 10.1591 },
  { name: 'Kumbo', lat: 6.2000, lng: 10.6667 },
  { name: 'Bafoussam', lat: 5.4778, lng: 10.4176 },
  { name: 'Dschang', lat: 5.4500, lng: 10.0667 },
  { name: 'Ngaoundere', lat: 7.3270, lng: 13.5840 },
  { name: 'Garoua', lat: 9.3010, lng: 13.3980 },
  { name: 'Maroua', lat: 10.5910, lng: 14.3159 }
];

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

// "Yaoundé " -> "yaounde"
function normalize(text) {
  return (text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// Known town mentioned in free text ("Buea town", "Regional hospital Limbe"), or null.
function findTown(text) {
  const t = normalize(text);
  if (!t) return null;
  return TOWNS.find(town => [town.name, ...(town.aliases || [])].some(n => t.includes(normalize(n)))) || null;
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
  haversineKm, distanceSql, findTown, nearestTown, townsWithin, ringFor, parseLocationMessage
};

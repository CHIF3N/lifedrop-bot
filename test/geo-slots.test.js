const test = require('node:test');
const assert = require('node:assert');
const geo = require('../geo');
const { upcomingSlots, formatSlot, slotId, parseSlotId } = require('../slots');

test('haversine: Buea to Limbe is roughly 15 km, Buea to Douala roughly 58 km', () => {
  const buea = geo.TOWNS.find(t => t.name === 'Buea');
  const limbe = geo.TOWNS.find(t => t.name === 'Limbe');
  const douala = geo.TOWNS.find(t => t.name === 'Douala');
  const bl = geo.haversineKm(buea.lat, buea.lng, limbe.lat, limbe.lng);
  const bd = geo.haversineKm(buea.lat, buea.lng, douala.lat, douala.lng);
  assert.ok(bl > 13 && bl < 18, `Buea-Limbe ${bl}`);
  assert.ok(bd > 50 && bd < 65, `Buea-Douala ${bd}`);
});

test('neighbouring Fako towns are inside the widest ring of each other', () => {
  const buea = geo.TOWNS.find(t => t.name === 'Buea');
  const near = geo.townsWithin(buea.lat, buea.lng, geo.MAX_RADIUS_KM);
  for (const name of ['Buea', 'Limbe', 'Tiko', 'Mutengene']) assert.ok(near.includes(name), name);
  assert.ok(!near.includes('Yaounde'));
});

test('findTown handles accents, case and extra words', () => {
  assert.strictEqual(geo.findTown('  Yaoundé ').name, 'Yaounde');
  assert.strictEqual(geo.findTown('Regional Hospital LIMBE').name, 'Limbe');
  assert.strictEqual(geo.findTown('Victoria').name, 'Limbe');
  assert.strictEqual(geo.findTown('Somewhere else'), null);
  assert.strictEqual(geo.findTown(''), null);
});

test('nearestTown labels a pin and ignores far-away points', () => {
  assert.strictEqual(geo.nearestTown(4.155, 9.245).name, 'Buea');
  assert.strictEqual(geo.nearestTown(0, 0), null);
});

test('ringFor picks the smallest ring', () => {
  assert.strictEqual(geo.ringFor(3), 15);
  assert.strictEqual(geo.ringFor(22), 30);
  assert.strictEqual(geo.ringFor(49.9), 50);
  assert.strictEqual(geo.ringFor(80), null);
});

test('parseLocationMessage validates coordinates', () => {
  assert.deepStrictEqual(
    geo.parseLocationMessage({ location: { latitude: 4.15, longitude: 9.24, name: 'Clinic' } }),
    { lat: 4.15, lng: 9.24, name: 'Clinic', address: null }
  );
  assert.strictEqual(geo.parseLocationMessage({ location: { latitude: 'x', longitude: 9 } }), null);
  assert.strictEqual(geo.parseLocationMessage({}), null);
});

test('distanceSql uses the given params and columns', () => {
  const sql = geo.distanceSql('$5', '$6', 'd.lat', 'd.lng');
  assert.ok(sql.includes('radians(d.lat - $5)') && sql.includes('radians(d.lng - $6)'));
});

test('slots: skips Sunday and past times, in Cameroon time', () => {
  // Saturday 24 Oct 2026, 10:30 WAT (09:30 UTC): 09:00 gone, 11:00 is inside the 2h lead
  const slots = upcomingSlots(new Date(Date.UTC(2026, 9, 24, 9, 30)), { days: 2 });
  assert.deepStrictEqual(slots.map(formatSlot), [
    'Sat 24 Oct, 14:00',
    'Mon 26 Oct, 09:00', 'Mon 26 Oct, 11:00', 'Mon 26 Oct, 14:00'
  ]);
  assert.strictEqual(slots[1].toISOString(), '2026-10-26T08:00:00.000Z');
});

test('slots: late evening rolls to the next working day', () => {
  const slots = upcomingSlots(new Date(Date.UTC(2026, 9, 23, 20, 0)), { days: 1 });
  assert.strictEqual(formatSlot(slots[0]), 'Sat 24 Oct, 09:00');
});

test('slot ids round-trip', () => {
  const at = new Date('2026-10-26T08:00:00Z');
  const parsed = parseSlotId(slotId(7, at));
  assert.strictEqual(parsed.labId, 7);
  assert.strictEqual(parsed.slotAt.toISOString(), at.toISOString());
  assert.strictEqual(parseSlotId('slot_x_1'), null);
});

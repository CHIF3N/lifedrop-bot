const test = require('node:test');
const assert = require('node:assert');
const geo = require('../geo');
const TOWNS = require('../towns');

const townOf = text => geo.resolveTown(text).town?.name || null;

test('misspelled towns resolve', () => {
  for (const [typed, town] of [
    ['Douela', 'Douala'], ['douale', 'Douala'], ['Yaunde', 'Yaounde'], ['Yaoundé', 'Yaounde'], ['yaoundee', 'Yaounde'],
    ['Bamedna', 'Bamenda'], ['Bamenda town', 'Bamenda'], ['Bafousam', 'Bafoussam'], ['Kumba town', 'Kumba'],
    ['Limbé', 'Limbe'], ['Bue', null], ['Beua', 'Buea'], ['Tikko', 'Tiko'], ['Mutengene junction', 'Mutengene'],
    ['Mutengéné', 'Mutengene'], ['ngaoundéré', 'Ngaoundere']
  ]) {
    assert.strictEqual(townOf(typed), town, typed);
  }
});

test('neighbourhoods resolve to their town', () => {
  for (const [typed, town] of [
    ['Molyko', 'Buea'], ['Great Soppo', 'Buea'], ['great-soppo', 'Buea'], ['Mile 17', 'Buea'], ['mile17', 'Buea'],
    ['Bonaberi', 'Douala'], ['Bonabéri', 'Douala'], ['Akwa', 'Douala'], ['Bastos', 'Yaounde'], ['Mvog-Mbi', 'Yaounde'],
    ['mvog mbi', 'Yaounde'], ['Nkwen', 'Bamenda'], ['Up Station', 'Bamenda'], ['upstation', 'Bamenda'],
    ['Down Beach', 'Limbe'], ['Fiango', 'Kumba'], ['Tamdja', 'Bafoussam'], ['Biyem-Assi', 'Yaounde']
  ]) {
    assert.strictEqual(townOf(typed), town, typed);
  }
  const r = geo.resolveTown('Molyko');
  assert.strictEqual(r.how, 'area');
  assert.strictEqual(geo.placeLabel(r), 'Molyko, Buea');
});

test('misspelled neighbourhoods (6+ letters) resolve as typos', () => {
  for (const [typed, town] of [['Moliko', 'Buea'], ['Bonamousadi', 'Douala'], ['Bonaberri', 'Douala'], ['Nkolbison', 'Yaounde']]) {
    const r = geo.resolveTown(typed);
    assert.strictEqual(r.town?.name, town, typed);
    assert.strictEqual(r.how, 'typo', typed);
  }
});

test('town name in a longer address wins over everyday words', () => {
  assert.strictEqual(townOf('Regional Hospital LIMBE'), 'Limbe');
  assert.strictEqual(townOf('General hospital, Akwa, Douala'), 'Douala');
  assert.strictEqual(townOf('Molyko, Buea'), 'Buea');
  assert.strictEqual(townOf('Victoria'), 'Limbe');
});

test('unknown text is not forced into a town', () => {
  for (const typed of ['Somewhere else', 'hospital', 'my house', 'near the market', '', '   ', 'boat', 'mess', 'Bali']) {
    assert.strictEqual(townOf(typed), null, typed);
  }
});

test('ambiguous neighbourhood gives suggestions instead of a guess', () => {
  const r = geo.resolveTown('Mile 4');
  assert.strictEqual(r.town, null);
  assert.deepStrictEqual(r.suggestions.sort(), ['Bamenda', 'Limbe']);
});

test('near misses beyond the typo limit become suggestions', () => {
  const r = geo.resolveTown('Bamndaa'); // 2 edits from a 7-letter name is allowed...
  assert.strictEqual(r.town?.name, 'Bamenda');
  const far = geo.resolveTown('Dwala'); // first letter kept but too far for a 6-letter name
  assert.strictEqual(far.town, null);
  assert.deepStrictEqual(far.suggestions, ['Douala']);
});

test('editDistance counts a swap as one edit', () => {
  assert.strictEqual(geo.editDistance('bamedna', 'bamenda'), 1);
  assert.strictEqual(geo.editDistance('douela', 'douala'), 1);
  assert.strictEqual(geo.editDistance('abc', 'abc'), 0);
});

test('town data is well formed and areas only repeat on purpose', () => {
  const names = new Set();
  for (const t of TOWNS) {
    assert.ok(t.name && Number.isFinite(t.lat) && Number.isFinite(t.lng), t.name);
    assert.ok(!names.has(t.name), `duplicate town ${t.name}`);
    names.add(t.name);
  }
  assert.strictEqual(geo.townByName('Buea').lat, 4.1527);
});

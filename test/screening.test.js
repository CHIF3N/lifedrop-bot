const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { evaluateScreening } = require('../screening');

const TODAY = new Date(2026, 9, 23);
const healthy = { name: 'Test', gender: 'male', age: '30', weight_kg: '70', blood_type: 'O+', on_medication: 'no', chronic_condition: 'no' };

test('healthy donor is eligible with no wait', () => {
  assert.deepStrictEqual(evaluateScreening(healthy, TODAY), { status: 'eligible', deferredUntil: null, reasons: [] });
});

test('permanent conditions rule the donor out', () => {
  const r = evaluateScreening({ ...healthy, ever_conditions: ['hepatitis_bc'] }, TODAY);
  assert.strictEqual(r.status, 'not_eligible');
});

test('age over 60 and weight under 50 kg rule the donor out', () => {
  assert.strictEqual(evaluateScreening({ ...healthy, age: '61' }, TODAY).status, 'not_eligible');
  assert.strictEqual(evaluateScreening({ ...healthy, weight_kg: '48' }, TODAY).status, 'not_eligible');
});

test('under 18 waits until 18', () => {
  const r = evaluateScreening({ ...healthy, age: '17' }, TODAY);
  assert.strictEqual(r.status, 'eligible');
  assert.strictEqual(r.deferredUntil, '2027-10-23');
});

test('recent events defer by the longest wait', () => {
  const r = evaluateScreening({ ...healthy, recent_conditions: ['fever_2w', 'malaria_6m'] }, TODAY);
  assert.strictEqual(r.status, 'eligible');
  assert.strictEqual(r.deferredUntil, '2027-04-23');
});

test('pregnancy pauses a female donor until she updates her info', () => {
  const r = evaluateScreening({ ...healthy, gender: 'female', women_health: ['pregnant'] }, TODAY);
  assert.strictEqual(r.status, 'needs_update');
});

test('women-only answers are ignored for men', () => {
  assert.strictEqual(evaluateScreening({ ...healthy, women_health: ['pregnant'] }, TODAY).status, 'eligible');
});

test('recent birth defers 6 months, heavy periods go to review', () => {
  const r = evaluateScreening({ ...healthy, gender: 'female', women_health: ['birth_6m', 'heavy_periods'] }, TODAY);
  assert.strictEqual(r.status, 'needs_review');
  assert.strictEqual(r.deferredUntil, '2027-04-23');
});

test('cancer, medication and unknown blood type go to team review', () => {
  assert.strictEqual(evaluateScreening({ ...healthy, ever_conditions: ['cancer'] }, TODAY).status, 'needs_review');
  assert.strictEqual(evaluateScreening({ ...healthy, on_medication: 'yes' }, TODAY).status, 'needs_review');
  assert.strictEqual(evaluateScreening({ ...healthy, blood_type: 'UNKNOWN' }, TODAY).status, 'needs_review');
});

test('old Flow answers still work (no gender or checkbox fields)', () => {
  const old = { name: 'Old', age: '30', weight_kg: '70', blood_type: 'A+', on_medication: 'no', chronic_condition: 'no', recent_illness: 'yes', recent_tattoo_piercing: 'no' };
  assert.strictEqual(evaluateScreening(old, TODAY).status, 'needs_review');
});

test('every Flow checkbox id has a rule, and option titles fit WhatsApp limits', () => {
  const flow = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'flows', 'donor_registration.json'), 'utf8'));
  const options = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      if (node['data-source']) options.push(...node['data-source'].map(o => ({ group: node.name, ...o })));
      Object.values(node).forEach(walk);
    }
  };
  walk(flow);
  for (const o of options) {
    assert.ok(o.title.length <= 30, `"${o.title}" is longer than 30 characters`);
  }
  for (const group of ['recent_conditions', 'ever_conditions', 'women_health']) {
    for (const o of options.filter(x => x.group === group)) {
      const r = evaluateScreening({ ...healthy, gender: 'female', [group]: [o.id] }, TODAY);
      assert.ok(r.reasons.includes(o.id), `${group}:${o.id} has no screening rule`);
    }
  }
});

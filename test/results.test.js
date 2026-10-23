const test = require('node:test');
const assert = require('node:assert');
const { parseResultsRequest, normalizeBloodGroup, parseResultButton, neutralResultMessage, parseLabCode, statusAfterBloodGroupConfirmed } = require('../results');

test('lab booking codes are recognised', () => {
  assert.strictEqual(parseLabCode('LT-12345'), 'LT-12345');
  assert.strictEqual(parseLabCode('lt 12345'), 'LT-12345');
  assert.strictEqual(parseLabCode('LD-12345'), null);
  assert.strictEqual(parseLabCode('LT-1234'), null);
});

test('confirmed blood group clears review only when unknown group was the only reason', () => {
  assert.deepStrictEqual(statusAfterBloodGroupConfirmed({ eligibility_status: 'needs_review', screening_reasons: 'blood_type_unknown' }), { status: 'eligible', reasons: '' });
  assert.deepStrictEqual(statusAfterBloodGroupConfirmed({ eligibility_status: 'needs_review', screening_reasons: 'blood_type_unknown,cancer' }), { status: 'needs_review', reasons: 'cancer' });
  assert.strictEqual(statusAfterBloodGroupConfirmed({ eligibility_status: 'not_eligible', screening_reasons: 'hiv' }).status, 'not_eligible');
  // Old registration form: no reasons stored, decide from the old yes/no answers
  assert.strictEqual(statusAfterBloodGroupConfirmed({ eligibility_status: 'needs_review', screening_reasons: null, on_medication: false, chronic_condition: false, recent_illness: false, recent_tattoo_piercing: false }).status, 'eligible');
  assert.strictEqual(statusAfterBloodGroupConfirmed({ eligibility_status: 'needs_review', screening_reasons: null, on_medication: true }).status, 'needs_review');
});

test('staff results request is recognised in common forms', () => {
  assert.strictEqual(parseResultsRequest('results LD-48213'), 'LD-48213');
  assert.strictEqual(parseResultsRequest('Result LD 48213'), 'LD-48213');
  assert.strictEqual(parseResultsRequest('LD48213 results'), 'LD-48213');
  assert.strictEqual(parseResultsRequest('LD-48213'), null);
  assert.strictEqual(parseResultsRequest('results please'), null);
});

test('blood group typing variants are normalised', () => {
  assert.strictEqual(normalizeBloodGroup('o+'), 'O+');
  assert.strictEqual(normalizeBloodGroup('0+'), 'O+');
  assert.strictEqual(normalizeBloodGroup('AB neg'), 'AB-');
  assert.strictEqual(normalizeBloodGroup('b positive'), 'B+');
  assert.strictEqual(normalizeBloodGroup('C+'), null);
  assert.strictEqual(normalizeBloodGroup(''), null);
});

test('result buttons parse, including AB groups', () => {
  assert.deepStrictEqual(parseResultButton('res_clear_12_AB+'), { action: 'clear', matchId: '12', bloodGroup: 'AB+' });
  assert.deepStrictEqual(parseResultButton('res_follow_7_O-'), { action: 'follow', matchId: '7', bloodGroup: 'O-' });
  assert.deepStrictEqual(parseResultButton('res_view_7'), { action: 'view', matchId: '7', bloodGroup: null });
  assert.strictEqual(parseResultButton('res_clear_x_O+'), null);
  assert.strictEqual(parseResultButton('match_yes_7'), null);
});

test('donor message is identical for cleared and follow-up and names no infection', () => {
  const text = neutralResultMessage('Jean', 'LD-48213', 'O+', 'Hôpital Laquintinie');
  assert.match(text, /O\+/);
  assert.doesNotMatch(text, /HIV|hepatitis|syphilis|negative|positive|reactive|clear/i);
});

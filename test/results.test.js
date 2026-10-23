const test = require('node:test');
const assert = require('node:assert');
const { parseResultsRequest, normalizeBloodGroup, parseResultButton, neutralResultMessage } = require('../results');

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

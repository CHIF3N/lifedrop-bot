const test = require('node:test');
const assert = require('node:assert');
const { daysUntilEligible } = require('../deferral');

test('never donated means eligible now', () => {
  assert.strictEqual(daysUntilEligible(null, 90, new Date(2026, 9, 23)), 0);
});

test('donated today means full wait left', () => {
  assert.strictEqual(daysUntilEligible('2026-10-23', 90, new Date(2026, 9, 23, 18, 30)), 90);
});

test('counts down by calendar day', () => {
  assert.strictEqual(daysUntilEligible('2026-10-01', 90, new Date(2026, 9, 23)), 68);
});

test('eligible again exactly when the wait ends', () => {
  // 2026-07-25 + 90 days = 2026-10-23
  assert.strictEqual(daysUntilEligible('2026-07-25', 90, new Date(2026, 9, 22)), 1);
  assert.strictEqual(daysUntilEligible('2026-07-25', 90, new Date(2026, 9, 23)), 0);
  assert.strictEqual(daysUntilEligible('2026-01-01', 90, new Date(2026, 9, 23)), 0);
});

test('accepts Date objects like pg returns for DATE columns', () => {
  assert.strictEqual(daysUntilEligible(new Date(2026, 9, 13), 90, new Date(2026, 9, 23)), 80);
});

test('respects a custom wait period', () => {
  assert.strictEqual(daysUntilEligible('2026-10-13', 56, new Date(2026, 9, 23)), 46);
});

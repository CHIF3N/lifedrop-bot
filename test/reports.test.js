const test = require('node:test');
const assert = require('node:assert');
const { formatTime, toTemplateParam, splitReport, formatStatsReport, dailySummaryParams } = require('../reports');

const stats = {
  donors: { total: '312', new: '5', ready: '241', resting: '12', waiting: '9', needs_review: '20', paused: '3', not_eligible: '27', verified: '40' },
  bloodTypes: [{ blood_type: 'O+', count: '120' }, { blood_type: 'A+', count: '80' }],
  requests: { total: '4', emergency: '1', fulfilled: '3', no_match: '1' },
  topLocations: [{ location: 'buea', count: '2' }],
  matches: { contacted: '12', yes: '6', no: '2', not_needed: '0', no_reply: '4', median_minutes_to_yes: 7.4 },
  donations: { confirmed: '2', by_facility: '1', self_reported: '1', results: '1' },
  facilities: { partners: '3' },
  waitlist: { home_lab: '18' }
};

test('time is shown in Cameroon time', () => {
  assert.strictEqual(formatTime(new Date(Date.UTC(2026, 9, 23, 13, 5))), '23 Oct 2026, 14:05');
});

test('template params have no new lines, stars or long runs of spaces', () => {
  const p = toTemplateParam('*Blood:* O+\n\n📍 Buea     town\n');
  assert.strictEqual(p, 'Blood: O+ | 📍 Buea town');
  assert.ok(toTemplateParam('x'.repeat(2000)).length <= 700);
  assert.strictEqual(toTemplateParam(''), '-');
});

test('report title and details split for the ops template', () => {
  const { title, details } = splitReport('🩸 *New Blood Request Logged*\n\n🆔 *Request:* #42\n📍 *Location:* Buea');
  assert.strictEqual(title, '🩸 New Blood Request Logged');
  assert.strictEqual(details, '🆔 Request: #42 | 📍 Location: Buea');
});

test('stats report includes key numbers, rates and explanations in 3 short messages', () => {
  const full = {
    ...stats,
    donors: { ...stats.donors, unknown_type: '6', with_pin: '100' },
    requests: { ...stats.requests, units: '6', urgent: '2', routine: '1', partner: '1', median_minutes_to_fulfil: 95 },
    donorsByCity: [{ city: 'buea', count: '50', ready: '40' }],
    readyByType: [{ blood_type: 'O+', count: '1' }],
    demandByType: [{ blood_type_needed: 'O+', units: '3' }],
    activity: { tests_booked: '7' }
  };
  const parts = formatStatsReport(full, 7, new Date(Date.UTC(2026, 9, 23, 13, 5)));
  assert.strictEqual(parts.length, 3);
  for (const p of parts) assert.ok(p.length < 4000);
  const text = parts.join('\n');
  assert.match(text, /last 7 days/);
  assert.match(text, /Ready now: \*241\*: can be matched today/);
  assert.match(text, /Fulfilled: 3 \(75%\)/);
  assert.match(text, /Yes rate: 50%/);
  assert.match(text, /time to a yes: 7 min/);
  assert.match(text, /time to fulfil: 1.6 h/);
  assert.match(text, /O\+: 1 ready · 3 unit\(s\) asked ⚠️ short/);
  assert.match(text, /buea: 50 \(40 ready\)/);
});

test('daily summary gives 12 string params in template order', () => {
  const p = dailySummaryParams(stats, new Date(Date.UTC(2026, 9, 23, 13)));
  assert.strictEqual(p.length, 12);
  assert.deepStrictEqual(p, ['23 Oct 2026', '5', '312', '241', '4', '3', '1', '6', '2', '4', '2', '1']);
});

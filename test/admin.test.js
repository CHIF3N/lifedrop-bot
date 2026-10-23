const test = require('node:test');
const assert = require('node:assert');
const { normalizePhone, parseAdminCommand } = require('../admin');
const { REQUEST_REASONS, BLOOD_GROUP_ROWS, requestSummary, parseContact } = require('../request-form');

test('contact person name and phone are split', () => {
  assert.deepStrictEqual(parseContact('Paul 677 12 34 56'), { name: 'Paul', phone: '237677123456' });
  assert.deepStrictEqual(parseContact('Mama Grace: +237677123456'), { name: 'Mama Grace', phone: '237677123456' });
  assert.deepStrictEqual(parseContact('677123456'), { name: 'Contact person', phone: '237677123456' });
  assert.strictEqual(parseContact('Paul'), null);
});

test('phone numbers are cleaned to WhatsApp format', () => {
  assert.strictEqual(normalizePhone('+237 6 77 12 34 56'), '237677123456');
  assert.strictEqual(normalizePhone('677123456'), '237677123456');
  assert.strictEqual(normalizePhone('00237677123456'), '237677123456');
  assert.strictEqual(normalizePhone('12345'), null);
});

test('stats command with and without days', () => {
  assert.deepStrictEqual(parseAdminCommand('stats'), { cmd: 'stats', days: 7 });
  assert.deepStrictEqual(parseAdminCommand('Stats 30'), { cmd: 'stats', days: 30 });
  assert.deepStrictEqual(parseAdminCommand('stats 999'), { cmd: 'stats', days: 365 });
});

test('addhospital parses name, city and phone', () => {
  const r = parseAdminCommand('addhospital Buea Regional Hospital | Buea | 677 12 34 56');
  assert.strictEqual(r.cmd, 'add');
  assert.deepStrictEqual(r.facility, {
    name: 'Buea Regional Hospital', city: 'Buea', staff_phone: '237677123456',
    type: 'hospital', does_blood_collection: true, does_lab_tests: false
  });
  assert.strictEqual(parseAdminCommand('addlab Lab X | Douala | 699000111').facility.type, 'lab');
});

test('bad addhospital input is reported, unknown text is not a command', () => {
  assert.deepStrictEqual(parseAdminCommand('addhospital Buea Regional Hospital'), { cmd: 'add_invalid', kind: 'hospital' });
  assert.deepStrictEqual(parseAdminCommand('addhospital X | Buea | 12'), { cmd: 'add_invalid', kind: 'hospital' });
  assert.strictEqual(parseAdminCommand('hello'), null);
  assert.strictEqual(parseAdminCommand('2'), null);
  assert.deepStrictEqual(parseAdminCommand('removehospital #4'), { cmd: 'remove', id: 4 });
});

test('list rows fit WhatsApp limits (24 chars, max 10 rows)', () => {
  for (const rows of [REQUEST_REASONS, BLOOD_GROUP_ROWS]) {
    assert.ok(rows.length <= 10);
    for (const r of rows) assert.ok(r.title.length <= 24, `${r.title} too long`);
  }
});

test('request summary shows every field and the no-payment notice', () => {
  const text = requestSummary({
    blood_type_needed: 'O+', units_needed: 2, urgency: 'Emergency', location: 'Buea',
    hospital_name: 'Buea Regional Hospital', patient_name: 'M. N.', reason: 'reason_surgery',
    contact_name: 'Paul', contact_phone: '237677123456'
  });
  for (const part of ['O+', 'Units:* 2', 'Emergency', 'Buea Regional Hospital', 'M. N.', 'Surgery / operation', 'Paul (237677123456)', 'does not pay donors']) {
    assert.ok(text.includes(part), `missing ${part}`);
  }
});

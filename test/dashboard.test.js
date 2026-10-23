const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const {
  createDashboard, maskPhone, sessionToken, validSessionToken, parseCookies, broadcastPayload,
  audienceFilter, requiredTemplates, templateStatusRows, isStopText, isStartText, STOP_PAYLOAD
} = require('../dashboard');
const { createTestPool } = require('./helpers/pglite-pool');

const KEY = 'test-admin-key';
const HOUR = 60 * 60 * 1000;

// ---------- Pure helpers ----------

test('phone numbers are masked by default', () => {
  assert.strictEqual(maskPhone('237677123456'), '2376•••••456');
  assert.strictEqual(maskPhone(''), '');
  assert.strictEqual(maskPhone(null), '');
  assert.strictEqual(maskPhone('12345'), '•••');
});

test('session cookie is signed with ADMIN_KEY and expires', () => {
  const now = Date.now();
  const token = sessionToken(KEY, now);
  assert.ok(!token.includes(KEY));
  assert.ok(validSessionToken(KEY, token, now));
  assert.ok(!validSessionToken('other-key', token, now));
  assert.ok(!validSessionToken(KEY, token, now + 13 * HOUR));
  assert.ok(!validSessionToken(KEY, 'garbage', now));
  assert.ok(!validSessionToken(undefined, token, now));
  assert.deepStrictEqual(parseCookies('a=1; ld_admin=x.y'), { a: '1', ld_admin: 'x.y' });
});

test('broadcast is a normal message inside the 24h window, else the donor_broadcast template', () => {
  const now = Date.now();
  const inside = broadcastPayload({ name: 'Jean Paul', last_inbound_at: new Date(now - HOUR) }, 'Drink water.\nEat well.', now);
  assert.strictEqual(inside.channel, 'text');
  assert.match(inside.text, /^Hello Jean, a message from the LifeDrop team:\n\nDrink water.\nEat well./);
  assert.match(inside.text, /Reply STOP/);

  const outside = broadcastPayload({ name: '', last_inbound_at: new Date(now - 25 * HOUR) }, 'Drink water.\nEat well.', now);
  assert.strictEqual(outside.channel, 'template');
  assert.deepStrictEqual(outside.params, ['friend', 'Drink water. | Eat well.']);
  assert.strictEqual(broadcastPayload({ name: 'A', last_inbound_at: null }, 'x', now).channel, 'template');
});

test('audience filters: all, blood type, city, 24h only', () => {
  assert.deepStrictEqual(audienceFilter({ type: 'all' }).params, []);
  assert.match(audienceFilter({}).where, /broadcast_opt_out IS NOT TRUE/);
  assert.deepStrictEqual(audienceFilter({ type: 'blood_type', value: 'O+' }).params, ['O+']);
  assert.ok(audienceFilter({ type: 'blood_type', value: 'Z' }).error);
  assert.ok(audienceFilter({ type: 'city', value: ' ' }).error);
  assert.ok(audienceFilter({ type: 'nope' }).error);
  assert.match(audienceFilter({ type: 'city', value: 'Buea', window_only: true }).where, /24 hours/);
});

test('required templates are read from WHATSAPP_TEMPLATES.md and joined with Meta status', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'templates', 'WHATSAPP_TEMPLATES.md'), 'utf8');
  const required = requiredTemplates(md);
  assert.ok(required.length >= 10);
  assert.deepStrictEqual(required.find(r => r.name === 'donor_broadcast'), { name: 'donor_broadcast', category: 'Marketing' });

  const rows = templateStatusRows(required, [
    { name: 'donor_match_alert', status: 'PENDING', category: 'UTILITY', language: 'en' },
    { name: 'hello_world', status: 'APPROVED', category: 'UTILITY', language: 'en_US' }
  ]);
  assert.strictEqual(rows.find(r => r.name === 'donor_match_alert').status, 'PENDING');
  assert.strictEqual(rows.find(r => r.name === 'donor_broadcast').status, 'MISSING');
  assert.ok(rows.find(r => r.name === 'hello_world').extra);
});

test('STOP and START replies are recognised', () => {
  assert.ok(isStopText(' STOP '));
  assert.ok(isStopText('Stop updates'));
  assert.ok(!isStopText('stop by the hospital'));
  assert.ok(isStartText('start'));
  assert.ok(!isStartText('started'));
});

// ---------- HTTP + database (PGlite, no real WhatsApp) ----------

async function setup({ sendFails = [], allowSend = true } = {}) {
  const pool = await createTestPool();
  const now = Date.now();
  const recent = new Date(now - HOUR).toISOString();
  const old = new Date(now - 3 * 24 * HOUR).toISOString();
  await pool.query(
    `INSERT INTO donors (name, phone, blood_type, city, town, eligibility_status, last_inbound_at, screening_reasons) VALUES
      ('Jean Recent', '237600000001', 'O+', 'buea', 'Buea', 'eligible', $1, NULL),
      ('Marie Old', '237600000002', 'O+', 'limbe', 'Limbe', 'eligible', $2, NULL),
      ('Paul Review', '237600000003', 'A+', 'buea', 'Buea', 'needs_review', $2, 'medication'),
      ('Fail Old', '237600000004', 'B+', 'buea', 'Buea', 'eligible', $2, NULL)`,
    [recent, old]
  );
  const sent = [];
  const sendMessage = async (to, text) => {
    if (sendFails.includes(to)) throw Object.assign(new Error('fail'), { response: { data: { error: { message: 'Invalid number' } } } });
    sent.push({ to, type: 'text', text });
  };
  const sendTemplate = async (to, name, params, buttons) => {
    if (sendFails.includes(to)) throw Object.assign(new Error('fail'), { response: { data: { error: { message: 'Template not approved' } } } });
    sent.push({ to, type: 'template', name, params, buttons });
  };
  const getStats = async (days) => ({
    donors: { total: '4', new: '4', ready: '3', needs_review: '1' }, requests: {}, matches: {},
    donations: {}, facilities: {}, waitlist: {}, activity: {}, days
  });
  const dashboard = createDashboard({ pool, getStats, sendMessage, sendTemplate, adminKey: KEY, wabaId: 'WABA', whatsappToken: 'T', delayMs: 0, allowSend });
  await dashboard.schemaReady;
  const app = express();
  app.use('/admin', dashboard.router);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/admin`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    const json = (res.headers.get('content-type') || '').includes('json');
    return { status: res.status, headers: res.headers, body: json ? JSON.parse(text) : text };
  };
  const login = async () => {
    const res = await call('POST', '/login', { key: KEY });
    cookie = res.headers.get('set-cookie').split(';')[0];
    return res;
  };
  const close = async () => { await new Promise(r => server.close(r)); await pool.end(); };
  return { pool, dashboard, call, login, close, sent };
}

test('everything under /admin/api is 403 until logged in with ADMIN_KEY', async () => {
  const t = await setup();
  try {
    assert.strictEqual((await t.call('GET', '/api/stats')).status, 403);
    assert.strictEqual((await t.call('POST', '/login', { key: 'wrong' })).status, 403);
    const ok = await t.login();
    assert.strictEqual(ok.status, 204);
    const setCookie = ok.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.ok(!setCookie.includes(KEY));
    const stats = await t.call('GET', '/api/stats?days=7');
    assert.strictEqual(stats.status, 200);
    assert.strictEqual(stats.body.totals.requests_total, '0');
    assert.strictEqual(stats.body.report.length, 3);
    assert.strictEqual(stats.body.series.length, 7); // one row per day for the charts
    assert.strictEqual(stats.body.series.reduce((sum, d) => sum + Number(d.donors), 0), 4); // the 4 donors joined today
    assert.strictEqual(stats.body.bloodTypes.find(b => b.blood_type === 'O+').count, '2');
    assert.strictEqual(stats.body.openRequests.length, 0);
    const page = await t.call('GET', '/'); // the page itself loads (it shows the login form)
    assert.strictEqual(page.status, 200);
    assert.match(page.body, /LifeDrop Admin/);
    const chartLib = await t.call('GET', '/vendor/chart.umd.js'); // charts are served from node_modules, no CDN
    assert.strictEqual(chartLib.status, 200);
    assert.match(chartLib.headers.get('content-type'), /javascript/);
  } finally { await t.close(); }
});

test('donor list masks phones unless revealed, and filters by status', async () => {
  const t = await setup();
  try {
    await t.login();
    const masked = await t.call('GET', '/api/donors');
    assert.strictEqual(masked.body.rows.length, 4);
    assert.ok(masked.body.rows.every(r => r.phone.includes('•')));
    const revealed = await t.call('GET', '/api/donors?reveal=1&status=needs_review');
    assert.deepStrictEqual(revealed.body.rows.map(r => r.phone), ['237600000003']);
    assert.strictEqual((await t.call('GET', '/api/donors?q=marie')).body.rows.length, 1);
  } finally { await t.close(); }
});

test('donor review approves or rejects only donors waiting for review', async () => {
  const t = await setup();
  try {
    await t.login();
    const { rows } = (await t.call('GET', '/api/donors?status=needs_review')).body;
    const r = await t.call('POST', `/api/donors/${rows[0].id}/review`, { decision: 'approve' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.donor.eligibility_status, 'eligible');
    assert.strictEqual((await t.call('POST', `/api/donors/${rows[0].id}/review`, { decision: 'reject' })).status, 409);
    assert.strictEqual((await t.call('POST', `/api/donors/${rows[0].id}/review`, { decision: 'maybe' })).status, 400);
  } finally { await t.close(); }
});

test('hospital is registered in the shared facilities table and its flags toggle', async () => {
  const t = await setup();
  try {
    await t.login();
    const created = await t.call('POST', '/api/facilities', { name: 'Test Hospital', city: 'Molyko', staff_phone: '677 12 34 56', type: 'hospital' });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.facility.staff_phone, '237677123456');
    assert.strictEqual(created.body.facility.is_partner, true);
    assert.strictEqual(created.body.facility.does_blood_collection, true);
    assert.strictEqual((await t.call('POST', '/api/facilities', { name: 'Dup', city: 'Buea', staff_phone: '677123456' })).status, 409);
    assert.strictEqual((await t.call('POST', '/api/facilities', { name: 'Bad', city: 'Buea', staff_phone: '12' })).status, 400);

    const id = created.body.facility.id;
    const patched = await t.call('PATCH', `/api/facilities/${id}`, { is_partner: false, does_lab_tests: true, name: 'ignored' });
    assert.deepStrictEqual(
      { p: patched.body.facility.is_partner, l: patched.body.facility.does_lab_tests, n: patched.body.facility.name },
      { p: false, l: true, n: 'Test Hospital' }
    );
    const list = await t.call('GET', '/api/facilities?partner=no');
    assert.strictEqual(list.body.rows.length, 1);
    assert.ok(list.body.rows[0].staff_phone.includes('•'));
  } finally { await t.close(); }
});

test('broadcast: preview, confirm step, per-recipient log, opt-outs skipped', async () => {
  const t = await setup({ sendFails: ['237600000004'] });
  try {
    await t.login();
    await t.pool.query(`UPDATE donors SET broadcast_opt_out = TRUE WHERE phone = '237600000003'`);
    const body = { message: 'Drink water before you donate.', audience: { type: 'all' } };

    const preview = await t.call('POST', '/api/broadcasts/preview', body);
    assert.strictEqual(preview.status, 200);
    assert.deepStrictEqual([preview.body.total, preview.body.inWindow, preview.body.viaTemplate], [3, 1, 2]);

    assert.strictEqual((await t.call('POST', '/api/broadcasts', body)).status, 400); // no confirm
    assert.strictEqual((await t.call('POST', '/api/broadcasts', { ...body, confirm: true, expected_count: 5 })).status, 409);
    assert.strictEqual((await t.call('POST', '/api/broadcasts/preview', { ...body, message: 'x'.repeat(701) })).status, 400);

    const started = await t.call('POST', '/api/broadcasts', { ...body, confirm: true, expected_count: 3 });
    assert.strictEqual(started.status, 202);
    await t.dashboard.running;

    assert.deepStrictEqual(t.sent.map(s => [s.to, s.type]), [['237600000001', 'text'], ['237600000002', 'template']]);
    const tpl = t.sent[1];
    assert.strictEqual(tpl.name, 'donor_broadcast');
    assert.deepStrictEqual(tpl.params, ['Marie', 'Drink water before you donate.']);
    assert.deepStrictEqual(tpl.buttons, [STOP_PAYLOAD]);

    const detail = await t.call('GET', `/api/broadcasts/${started.body.id}`);
    assert.strictEqual(detail.body.broadcast.status, 'done');
    assert.deepStrictEqual([detail.body.broadcast.sent, detail.body.broadcast.failed], [2, 1]);
    const failed = detail.body.recipients.find(r => r.status === 'failed');
    assert.strictEqual(failed.error, 'Template not approved');
    assert.ok(failed.phone.includes('•'));

    const list = await t.call('GET', '/api/broadcasts');
    assert.strictEqual(list.body.rows[0].audience.label, 'all donors');

    const cityOnly = await t.call('POST', '/api/broadcasts/preview', { ...body, audience: { type: 'city', value: 'buea', window_only: true } });
    assert.strictEqual(cityOnly.body.total, 1);
  } finally { await t.close(); }
});

test('template status comes from the Graph API (stubbed)', async () => {
  const t = await setup();
  const realGet = axios.get;
  let calledUrl = '';
  axios.get = async (url) => {
    calledUrl = url;
    return { data: { data: [{ name: 'donor_broadcast', status: 'APPROVED', category: 'MARKETING', language: 'en' }] } };
  };
  try {
    await t.login();
    const r = await t.call('GET', '/api/templates?refresh=1');
    assert.strictEqual(calledUrl, 'https://graph.facebook.com/v22.0/WABA/message_templates');
    assert.strictEqual(r.body.rows.find(x => x.name === 'donor_broadcast').status, 'APPROVED');
    assert.strictEqual(r.body.rows.find(x => x.name === 'donor_match_alert').status, 'MISSING');
  } finally {
    axios.get = realGet;
    await t.close();
  }
});

test('STOP opts a donor out of broadcasts, START opts back in', async () => {
  const t = await setup();
  try {
    await t.dashboard.handleOptOut('237600000001');
    let r = await t.pool.query(`SELECT broadcast_opt_out FROM donors WHERE phone = '237600000001'`);
    assert.strictEqual(r.rows[0].broadcast_opt_out, true);
    assert.strictEqual(await t.dashboard.handleOptIn('237600000002'), false); // not opted out: "start" keeps its normal meaning
    assert.strictEqual(await t.dashboard.handleOptIn('237600000001'), true);
    r = await t.pool.query(`SELECT broadcast_opt_out FROM donors WHERE phone = '237600000001'`);
    assert.strictEqual(r.rows[0].broadcast_opt_out, false);
    assert.strictEqual(t.sent.length, 2);
  } finally { await t.close(); }
});

test('local mode (real database on a laptop) refuses to send broadcasts', async () => {
  const t = await setup({ allowSend: false });
  try {
    await t.login();
    assert.strictEqual((await t.call('GET', '/api/me')).body.allowSend, false);
    const r = await t.call('POST', '/api/broadcasts', { message: 'Hi', audience: { type: 'all' }, confirm: true, expected_count: 4 });
    assert.strictEqual(r.status, 403);
    assert.match(r.body.error, /turned off/);
    assert.strictEqual(t.sent.length, 0);
  } finally { await t.close(); }
});

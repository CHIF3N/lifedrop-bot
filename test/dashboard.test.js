const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const {
  createDashboard, toCsv, failureText, detectImageType, imageMessageBody, imageTemplateBody, describeTemplate, templateComponents, renderTemplate, personalise, maskPhone, sessionToken, validSessionToken, parseCookies, broadcastPayload,
  audienceFilter, requiredTemplates, templateStatusRows, isStopText, isStartText, STOP_PAYLOAD, JOIN_LINK, SITE_LINK
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
  assert.ok(!/STOP/.test(inside.text));
  assert.ok(inside.text.endsWith(`Join the group: ${JOIN_LINK}\n🌐 ${SITE_LINK}`));
  assert.strictEqual(JOIN_LINK, 'https://lifedrop-bot.onrender.com/join');

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

async function setup({ sendFails = [], allowSend = true, stubImageSenders = true } = {}) {
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
    return { data: { messages: [{ id: `wamid.${to}.${sent.length}` }] } };
  };
  const sendTemplate = async (to, name, params, buttons) => {
    if (sendFails.includes(to)) throw Object.assign(new Error('fail'), { response: { data: { error: { message: 'Template not approved' } } } });
    sent.push({ to, type: 'template', name, params, buttons });
    return { data: { messages: [{ id: `wamid.${to}.${sent.length}` }] } };
  };
  const sendImage = async (to, mediaId, caption) => {
    if (sendFails.includes(to)) throw new Error('fail');
    sent.push({ to, type: 'image', mediaId, caption });
  };
  const sendImageTemplate = async (to, name, mediaId, params, buttons) => {
    if (sendFails.includes(to)) throw new Error('fail');
    sent.push({ to, type: 'image_template', name, mediaId, params, buttons });
  };
  const imageSenders = stubImageSenders ? { sendImage, sendImageTemplate } : {};
  const sendTemplateRaw = async (to, name, language, components) => {
    if (sendFails.includes(to)) throw new Error('fail');
    sent.push({ to, type: 'raw_template', name, language, components });
  };
  const created = [];
  const createRequest = async (phone, data) => { created.push({ phone, data }); return { requestId: 77, matchCount: 3 }; };
  const getStats = async (days) => ({
    donors: { total: '4', new: '4', ready: '3', needs_review: '1' }, requests: {}, matches: {},
    donations: {}, facilities: {}, waitlist: {}, activity: {}, days
  });
  const dashboard = createDashboard({ pool, getStats, sendMessage, sendTemplate, adminKey: KEY, wabaId: 'WABA', whatsappToken: 'T', delayMs: 0, allowSend, phoneNumberId: 'PNID', ...imageSenders, sendTemplateRaw, createRequest });
  await dashboard.schemaReady;
  const app = express();
  app.use('/admin', dashboard.router);
  // fetch() refuses some ports ("bad port"), so pick another random port if we land on one
  const BAD_PORTS = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
  let server;
  do {
    if (server) await new Promise(r => server.close(r));
    server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  } while (BAD_PORTS.has(server.address().port));
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
  const upload = async (buf, type, name = 'tip.png') => {
    const res = await fetch(`${base}/api/broadcast-image`, { method: 'POST', headers: { 'Content-Type': type, 'X-File-Name': name, cookie }, body: buf });
    return { status: res.status, body: await res.json() };
  };
  const login = async () => {
    const res = await call('POST', '/login', { key: KEY });
    cookie = res.headers.get('set-cookie').split(';')[0];
    return res;
  };
  const close = async () => { await new Promise(r => server.close(r)); await pool.end(); };
  return { pool, dashboard, call, login, close, sent, upload, created };
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
    assert.strictEqual(tpl.buttons, undefined); // template buttons are static links now

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

test('CSV cells are quoted and formula-safe', () => {
  const csv = toCsv([{ a: 'x,y', b: '=HYPERLINK("bad")', c: null }, { a: 'say "hi"', b: 5, c: '-2' }], ['a', 'b', 'c']);
  assert.strictEqual(csv, 'a,b,c\r\n"x,y","\'=HYPERLINK(""bad"")",\r\n"say ""hi""",5,\'-2\r\n');
});

test('requests can be marked fulfilled, closed and reopened, and every change is logged', async () => {
  const t = await setup();
  try {
    await t.login();
    await t.pool.query(`INSERT INTO requests (requester_phone, blood_type_needed, location, urgency) VALUES ('237600000050', 'O+', 'buea', 'Urgent')`);
    let r = await t.call('POST', '/api/requests/1/status', { status: 'fulfilled' });
    assert.strictEqual(r.body.request.status, 'fulfilled');
    assert.ok(r.body.request.fulfilled_at);
    r = await t.call('POST', '/api/requests/1/status', { status: 'open' });
    assert.strictEqual(r.body.request.fulfilled_at, null);
    r = await t.call('POST', '/api/requests/1/status', { status: 'closed' });
    assert.strictEqual(r.body.request.status, 'closed');
    assert.strictEqual((await t.call('POST', '/api/requests/1/status', { status: 'deleted' })).status, 400);
    assert.strictEqual((await t.call('POST', '/api/requests/99/status', { status: 'closed' })).status, 404);

    const stats = await t.call('GET', '/api/stats?days=7');
    assert.strictEqual(stats.body.totals.requests_open, '0'); // closed is not open
    assert.strictEqual(stats.body.totals.requests_closed, '1');
    assert.strictEqual((await t.call('GET', '/api/requests?status=closed')).body.rows.length, 1);

    const donors = (await t.call('GET', '/api/donors?status=needs_review')).body.rows;
    await t.call('POST', `/api/donors/${donors[0].id}/review`, { decision: 'approve' });
    const log = (await t.call('GET', '/api/log')).body.rows;
    assert.deepStrictEqual(log.map(l => l.action), ['donor_approved', 'request_closed', 'request_open', 'request_fulfilled']);
    assert.strictEqual(log[0].target_name, 'Paul Review');
  } finally { await t.close(); }
});

test('donor profile shows history, and phones stay masked', async () => {
  const t = await setup();
  try {
    await t.login();
    await t.pool.query(`INSERT INTO requests (requester_phone, blood_type_needed, location, urgency) VALUES ('237600000050', 'O+', 'buea', 'Urgent')`);
    await t.pool.query(`INSERT INTO matches (request_id, donor_id, response, donation_confirmed_at, confirm_code) VALUES (1, 1, 'yes', NOW(), 'LD-11111'), (1, 2, NULL, NULL, NULL)`);
    const p = await t.call('GET', '/api/donors/1');
    assert.strictEqual(p.status, 200);
    assert.strictEqual(p.body.donor.name, 'Jean Recent');
    assert.ok(p.body.donor.phone.includes('•'));
    assert.strictEqual(p.body.matches.length, 1);
    assert.strictEqual(p.body.matches[0].confirm_code, 'LD-11111');
    assert.strictEqual((await t.call('GET', '/api/donors/1?reveal=1')).body.donor.phone, '237600000001');
    assert.strictEqual((await t.call('GET', '/api/donors/999')).status, 404);
    assert.strictEqual((await t.call('GET', '/api/matches?donor_id=2')).body.rows.length, 1);
  } finally { await t.close(); }
});

test('CSV export uses the list filters and masks phones unless revealed', async () => {
  const t = await setup();
  try {
    await t.login();
    const masked = await t.call('GET', '/api/export/donors.csv?blood_type=O%2B');
    assert.strictEqual(masked.status, 200);
    assert.match(masked.headers.get('content-disposition'), /attachment; filename="lifedrop-donors-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = masked.body.replace(/^﻿/, '').trim().split('\r\n');
    assert.strictEqual(lines[0].split(',')[0], 'id');
    assert.strictEqual(lines.length, 3); // header + 2 O+ donors
    assert.ok(!masked.body.includes('237600000001'));
    const revealed = await t.call('GET', '/api/export/donors.csv?reveal=1');
    assert.ok(revealed.body.includes('237600000001'));
    assert.strictEqual((await t.call('GET', '/api/export/secrets.csv')).status, 404);
  } finally { await t.close(); }
});

// ---------- Broadcast images ----------
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

test('only real JPEG and PNG files are accepted as broadcast images', () => {
  assert.strictEqual(detectImageType(PNG), 'image/png');
  assert.strictEqual(detectImageType(JPG), 'image/jpeg');
  assert.strictEqual(detectImageType(Buffer.from('GIF89a')), null);
  assert.strictEqual(detectImageType(Buffer.from('<svg')), null);
  assert.strictEqual(detectImageType(null), null);
});

test('image message and image template have the shape WhatsApp expects', () => {
  assert.deepStrictEqual(imageMessageBody('2376', '999', 'Hi'), {
    messaging_product: 'whatsapp', to: '2376', type: 'image', image: { id: '999', caption: 'Hi' }
  });
  const t = imageTemplateBody('2376', 'donor_broadcast_image', '999', ['Jean', 'Tip'], [STOP_PAYLOAD]);
  assert.strictEqual(t.template.name, 'donor_broadcast_image');
  assert.deepStrictEqual(t.template.components[0], { type: 'header', parameters: [{ type: 'image', image: { id: '999' } }] });
  assert.deepStrictEqual(t.template.components[1].parameters.map(p => p.text), ['Jean', 'Tip']);
  assert.deepStrictEqual(t.template.components[2], {
    type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: STOP_PAYLOAD }]
  });
});

test('donor_broadcast_image is a required template', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'templates', 'WHATSAPP_TEMPLATES.md'), 'utf8');
  assert.deepStrictEqual(requiredTemplates(md).find(r => r.name === 'donor_broadcast_image'), { name: 'donor_broadcast_image', category: 'Marketing' });
});

test('image upload goes to the WhatsApp media endpoint (stubbed) and rejects bad files', async () => {
  const t = await setup();
  const realPost = axios.post;
  const calls = [];
  axios.post = async (url, body, opts) => { calls.push({ url, body, opts }); return { data: { id: '1234567890' } }; };
  try {
    await t.login();
    const ok = await t.upload(PNG, 'image/png', 'tip.png');
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.body, { mediaId: '1234567890', type: 'image/png', bytes: PNG.length, name: 'tip.png' });
    assert.strictEqual(calls[0].url, 'https://graph.facebook.com/v22.0/PNID/media');
    assert.strictEqual(calls[0].body.get('messaging_product'), 'whatsapp');
    assert.strictEqual(calls[0].body.get('type'), 'image/png');
    assert.strictEqual(calls[0].body.get('file').size, PNG.length);
    assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer T');

    assert.strictEqual((await t.upload(Buffer.from('GIF89a....'), 'image/png')).status, 400); // lies about its type
    const big = await t.upload(Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]), 'image/png');
    assert.strictEqual(big.status, 413);
    assert.match(big.body.error, /max 5 MB/);
    assert.strictEqual(calls.length, 1);
  } finally {
    axios.post = realPost;
    await t.close();
  }
});

test('image upload is refused in local mode and without login', async () => {
  const t = await setup({ allowSend: false });
  try {
    assert.strictEqual((await t.upload(PNG, 'image/png')).status, 403); // not logged in
    await t.login();
    const r = await t.upload(PNG, 'image/png');
    assert.strictEqual(r.status, 403);
    assert.match(r.body.error, /local mode/);
  } finally { await t.close(); }
});

test('broadcast with an image: image message inside 24h, image template outside, both logged', async () => {
  const t = await setup();
  try {
    await t.login();
    const body = { message: 'Give blood, save lives. Join: https://wa.me/237686001785?text=Hi', audience: { type: 'blood_type', value: 'O+' } };
    const preview = await t.call('POST', '/api/broadcasts/preview', { ...body, with_image: true });
    assert.strictEqual(preview.body.templateName, 'donor_broadcast_image');
    assert.strictEqual(preview.body.total, 2);

    assert.strictEqual((await t.call('POST', '/api/broadcasts', { ...body, confirm: true, expected_count: 2, image: { media_id: '../etc' } })).status, 400);
    const started = await t.call('POST', '/api/broadcasts', { ...body, confirm: true, expected_count: 2, image: { media_id: '1234567890', name: 'tip.png' } });
    assert.strictEqual(started.status, 202);
    await t.dashboard.running;

    const [inWindow, outside] = t.sent;
    assert.deepStrictEqual([inWindow.to, inWindow.type, inWindow.mediaId], ['237600000001', 'image', '1234567890']);
    assert.match(inWindow.caption, /^Hello Jean, a message from the LifeDrop team:\n\nGive blood/);
    assert.deepStrictEqual([outside.to, outside.type, outside.name, outside.mediaId], ['237600000002', 'image_template', 'donor_broadcast_image', '1234567890']);
    assert.deepStrictEqual(outside.params, ['Marie', body.message]);
    assert.strictEqual(outside.buttons, undefined); // template buttons are static links now

    const detail = await t.call('GET', `/api/broadcasts/${started.body.id}`);
    assert.strictEqual(detail.body.broadcast.image_media_id, '1234567890');
    assert.strictEqual(detail.body.broadcast.image_name, 'tip.png');
    assert.deepStrictEqual(detail.body.recipients.map(r => r.channel), ['image', 'image_template']);
    assert.strictEqual((await t.call('GET', '/api/broadcasts')).body.rows[0].image_name, 'tip.png');
  } finally { await t.close(); }
});

test('default image senders call the Graph API messages endpoint (stubbed)', async () => {
  const t = await setup({ stubImageSenders: false });
  const realPost = axios.post;
  const calls = [];
  axios.post = async (url, body) => { calls.push({ url, body }); return { data: {} }; };
  try {
    await t.login();
    const body = { message: 'Tip', audience: { type: 'blood_type', value: 'O+' } };
    await t.call('POST', '/api/broadcasts', { ...body, confirm: true, expected_count: 2, image: { media_id: '555555' } });
    await t.dashboard.running;
    assert.deepStrictEqual(calls.map(c => c.url), Array(2).fill('https://graph.facebook.com/v22.0/PNID/messages'));
    assert.strictEqual(calls[0].body.type, 'image');
    assert.strictEqual(calls[1].body.template.name, 'donor_broadcast_image');
  } finally {
    axios.post = realPost;
    await t.close();
  }
});

// ---------- Send any template, message one donor, new request ----------
const META_TEMPLATES = [
  {
    name: 'blood_sos', status: 'APPROVED', category: 'UTILITY', language: 'en',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'SOS for {{1}}' },
      { type: 'BODY', text: 'Hello {{1}}, {{2}} blood is needed at {{3}}.' },
      { type: 'FOOTER', text: 'LifeDrop' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'I can help' }, { type: 'URL', text: 'Details', url: 'https://lifedropcm.site/r/{{1}}' }] }
    ]
  },
  {
    name: 'donor_broadcast_image', status: 'APPROVED', category: 'MARKETING', language: 'en',
    components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hello {{1}}, a message from the LifeDrop team: {{2}}' }]
  },
  { name: 'hello_world', status: 'APPROVED', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Hello World' }] },
  { name: 'promo_video', status: 'APPROVED', category: 'MARKETING', language: 'en', components: [{ type: 'HEADER', format: 'VIDEO' }, { type: 'BODY', text: 'Watch' }] },
  { name: 'pending_one', status: 'PENDING', category: 'UTILITY', language: 'en', components: [{ type: 'BODY', text: 'x' }] }
];

async function withMetaTemplates(fn) {
  const realGet = axios.get;
  axios.get = async () => ({ data: { data: META_TEMPLATES } });
  try { await fn(); } finally { axios.get = realGet; }
}

test('templates are described from Meta, with unsupported parts flagged', () => {
  const sos = describeTemplate(META_TEMPLATES[0]);
  assert.deepStrictEqual([sos.bodyVars, sos.header.vars, sos.sendable], [3, 1, true]);
  assert.deepStrictEqual(sos.buttons.map(b => [b.type, b.needsParam]), [['QUICK_REPLY', false], ['URL', true]]);
  const video = describeTemplate(META_TEMPLATES[3]);
  assert.strictEqual(video.sendable, false);
  assert.deepStrictEqual(video.problems, ['video header']);
});

test('template components fill header, body and URL button, and {name} is personal', () => {
  const sos = describeTemplate(META_TEMPLATES[0]);
  const comps = templateComponents(sos, { headerText: 'Buea', body: ['Jean', 'O+', 'Line 1\nLine 2'], buttonParams: { 1: '42' } });
  assert.deepStrictEqual(comps, [
    { type: 'header', parameters: [{ type: 'text', text: 'Buea' }] },
    { type: 'body', parameters: [{ type: 'text', text: 'Jean' }, { type: 'text', text: 'O+' }, { type: 'text', text: 'Line 1 | Line 2' }] },
    { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: '42' }] }
  ]);
  const img = templateComponents(describeTemplate(META_TEMPLATES[1]), { headerImageId: '555', body: ['A', 'B'] });
  assert.deepStrictEqual(img[0], { type: 'header', parameters: [{ type: 'image', image: { id: '555' } }] });
  assert.deepStrictEqual(templateComponents(describeTemplate(META_TEMPLATES[2]), {}), []); // no variables, no components
  assert.strictEqual(personalise('Hi {name}!', 'Marie Ngo'), 'Hi Marie!');
  assert.strictEqual(personalise('Hi {NAME}', 'Buea Regional Hospital', true), 'Hi Buea Regional Hospital');
  assert.strictEqual(renderTemplate(sos, { headerText: 'X', body: ['{name}', 'O+', 'Buea'], name: 'Paul Biya' }),
    '*SOS for X*\n\nHello Paul, O+ blood is needed at Buea.\n\n_LifeDrop_\n\n[ I can help ]  [ Details ]');
});

test('only approved templates are offered for sending', async () => {
  const t = await setup();
  await withMetaTemplates(async () => {
    try {
      await t.login();
      const r = await t.call('GET', '/api/templates/sendable?refresh=1');
      assert.deepStrictEqual(r.body.templates.map(x => x.name), ['blood_sos', 'donor_broadcast_image', 'hello_world', 'promo_video']);
      assert.ok(!('meta' in (await t.call('GET', '/api/templates')).body)); // raw Meta data is not sent to the page
    } finally { await t.close(); }
  });
});

test('send any template to one number, one donor, a hospital, partners or donors', async () => {
  const t = await setup();
  await withMetaTemplates(async () => {
    try {
      await t.login();
      await t.pool.query(`INSERT INTO facilities (name, city, staff_phone, is_partner) VALUES ('Buea Regional Hospital', 'Buea', '237699000001', TRUE), ('Old Lab', 'Limbe', '237699000002', FALSE)`);
      const base = { template: 'blood_sos', language: 'en', header_text: 'Buea', body: ['{name}', 'O+', 'Buea Regional Hospital'], button_params: { 1: '42' } };

      const counts = {};
      for (const [key, recipients] of Object.entries({
        phone: { type: 'phone', value: '677 12 34 56' },
        donor: { type: 'donor', value: 2 },
        facility: { type: 'facility', value: 1 },
        partners: { type: 'partners' },
        donors: { type: 'donors', audience: { type: 'blood_type', value: 'O+' } }
      })) {
        counts[key] = (await t.call('POST', '/api/template-send/preview', { ...base, recipients })).body.total;
      }
      assert.deepStrictEqual(counts, { phone: 1, donor: 1, facility: 1, partners: 1, donors: 2 });

      const preview = await t.call('POST', '/api/template-send/preview', { ...base, recipients: { type: 'donor', value: 2 } });
      assert.match(preview.body.sample, /^\*SOS for Buea\*\n\nHello Marie, O\+ blood/);

      assert.strictEqual((await t.call('POST', '/api/template-send', { ...base, recipients: { type: 'partners' }, expected_count: 1 })).status, 400); // no confirm
      assert.strictEqual((await t.call('POST', '/api/template-send', { ...base, body: ['x'], recipients: { type: 'partners' }, confirm: true, expected_count: 1 })).status, 400); // blanks missing
      assert.strictEqual((await t.call('POST', '/api/template-send', { ...base, template: 'pending_one', recipients: { type: 'partners' }, confirm: true, expected_count: 1 })).status, 400);
      assert.strictEqual((await t.call('POST', '/api/template-send', { ...base, template: 'promo_video', body: [], recipients: { type: 'partners' }, confirm: true, expected_count: 1 })).status, 400);
      assert.strictEqual((await t.call('POST', '/api/template-send', { ...base, template: 'donor_broadcast_image', body: ['a', 'b'], recipients: { type: 'partners' }, confirm: true, expected_count: 1 })).status, 400); // needs image

      const started = await t.call('POST', '/api/template-send', { ...base, recipients: { type: 'donors', audience: { type: 'blood_type', value: 'O+' } }, confirm: true, expected_count: 2 });
      assert.strictEqual(started.status, 202);
      await t.dashboard.running;
      assert.deepStrictEqual(t.sent.map(x => [x.to, x.name, x.language]), [['237600000001', 'blood_sos', 'en'], ['237600000002', 'blood_sos', 'en']]);
      assert.strictEqual(t.sent[0].components[1].parameters[0].text, 'Jean');
      assert.strictEqual(t.sent[1].components[1].parameters[0].text, 'Marie');
      const detail = await t.call('GET', `/api/broadcasts/${started.body.id}`);
      assert.strictEqual(detail.body.broadcast.status, 'done');
      assert.deepStrictEqual(detail.body.recipients.map(r => r.channel), ['template:blood_sos', 'template:blood_sos']);

      t.sent.length = 0;
      await t.call('POST', '/api/template-send', { ...base, recipients: { type: 'facility', value: 1 }, confirm: true, expected_count: 1 });
      await t.dashboard.running;
      assert.strictEqual(t.sent[0].to, '237699000001');
      assert.strictEqual(t.sent[0].components[1].parameters[0].text, 'Buea Regional Hospital'); // hospitals keep their full name

      const log = (await t.call('GET', '/api/log')).body.rows;
      assert.strictEqual(log[0].action, 'template_sent');
    } finally { await t.close(); }
  });
});

test('message one donor: allowed inside 24h, refused outside', async () => {
  const t = await setup();
  try {
    await t.login();
    const ok = await t.call('POST', '/api/donors/1/message', { text: 'Thanks for donating!' });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(t.sent.at(-1), { to: '237600000001', type: 'text', text: 'Thanks for donating!' });
    const old = await t.call('POST', '/api/donors/2/message', { text: 'Hi' });
    assert.strictEqual(old.status, 409);
    assert.strictEqual(old.body.outsideWindow, true);
    assert.strictEqual((await t.call('POST', '/api/donors/1/message', { text: '' })).status, 400);
    assert.strictEqual((await t.call('POST', '/api/donors/999/message', { text: 'Hi' })).status, 404);
    assert.strictEqual(t.sent.length, 1);
  } finally { await t.close(); }
});

test('new request from the dashboard goes through the bot matcher', async () => {
  const t = await setup();
  try {
    await t.login();
    await t.pool.query(`INSERT INTO facilities (name, city, staff_phone, is_partner, does_blood_collection) VALUES ('Buea Regional Hospital', 'Buea', '237699000001', TRUE, TRUE)`);
    const opts = await t.call('GET', '/api/request-options');
    assert.strictEqual(opts.body.canCreate, true);
    assert.strictEqual(opts.body.facilities.length, 1);
    assert.ok(opts.body.reasons.some(r => r.id === 'reason_surgery'));

    const body = { requester_phone: '677 12 34 56', blood_type_needed: 'O-', units_needed: '2', urgency: 'Emergency', town: 'Molyko', facility_id: 1, reason: 'reason_surgery', contact_name: 'Paul', contact_phone: '699000111' };
    assert.strictEqual((await t.call('POST', '/api/requests', body)).status, 400); // no confirm
    assert.strictEqual((await t.call('POST', '/api/requests', { ...body, blood_type_needed: 'Z', confirm: true })).status, 400);
    assert.strictEqual((await t.call('POST', '/api/requests', { ...body, requester_phone: '12', confirm: true })).status, 400);
    const r = await t.call('POST', '/api/requests', { ...body, confirm: true });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual([r.body.requestId, r.body.matchCount, r.body.knownTown], [77, 3, true]);
    assert.strictEqual(t.created[0].phone, '237677123456');
    assert.deepStrictEqual(t.created[0].data, {
      blood_type_needed: 'O-', units_needed: 2, urgency: 'Emergency', town: 'Buea', location: 'Buea', facility_id: 1,
      hospital_name: 'Buea Regional Hospital', patient_name: null, reason: 'reason_surgery', contact_name: 'Paul', contact_phone: '237699000111'
    });
    assert.strictEqual((await t.call('GET', '/api/log')).body.rows[0].action, 'request_created');
  } finally { await t.close(); }
});

test('local mode refuses template sends, donor messages and new requests', async () => {
  const t = await setup({ allowSend: false });
  try {
    await t.login();
    assert.strictEqual((await t.call('POST', '/api/template-send', { confirm: true })).status, 403);
    assert.strictEqual((await t.call('POST', '/api/donors/1/message', { text: 'Hi' })).status, 403);
    assert.strictEqual((await t.call('POST', '/api/requests', { confirm: true })).status, 403);
    assert.strictEqual(t.sent.length + t.created.length, 0);
  } finally { await t.close(); }
});

// ---------- Delivery reports ----------
test('Meta failure codes become plain-language reasons', () => {
  assert.match(failureText({ code: 131042, title: 'Business eligibility payment issue' }), /^131042 Meta: no valid payment method/);
  assert.strictEqual(failureText({ code: 999, title: 'Something odd' }), '999 Something odd');
  assert.strictEqual(failureText(undefined), 'Failed');
});

test('delivery reports from the webhook update each broadcast recipient', async () => {
  const t = await setup();
  try {
    await t.login();
    const started = await t.call('POST', '/api/broadcasts', { message: 'Tip', audience: { type: 'blood_type', value: 'O+' }, confirm: true, expected_count: 2 });
    await t.dashboard.running;
    const ids = (await t.pool.query(`SELECT wa_message_id, delivery FROM broadcast_recipients ORDER BY id`)).rows;
    assert.ok(ids.every(r => r.wa_message_id && r.delivery === 'sent'));
    const [a, b] = ids.map(r => r.wa_message_id);

    await t.dashboard.recordStatuses([
      { id: a, status: 'read' },
      { id: a, status: 'delivered' }, // late, must not move it back
      { id: b, status: 'failed', errors: [{ code: 131042, title: 'Business eligibility payment issue' }] },
      { id: 'wamid.unknown', status: 'delivered' } // a normal bot message: ignored
    ]);
    const list = (await t.call('GET', '/api/broadcasts')).body.rows[0];
    assert.deepStrictEqual([list.sent, list.delivered, list.read, list.undelivered, list.tracked], ['2', '1', '1', '1', '2']);
    assert.match(list.sample_error, /^131042/);
    const detail = (await t.call('GET', `/api/broadcasts/${started.body.id}`)).body.recipients;
    assert.deepStrictEqual(detail.map(r => r.delivery), ['read', 'failed']);
    assert.match(detail[1].delivery_error, /payment method/);
  } finally { await t.close(); }
});

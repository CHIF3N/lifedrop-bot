// Admin web dashboard (mounted at /admin by server.js). Monitor stats, browse data, onboard hospitals,
// review donors, check template approval and send broadcasts. Everything under /admin/api needs ADMIN_KEY.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const geo = require('./geo');
const { normalizePhone } = require('./admin');
const { toTemplateParam, formatStatsReport } = require('./reports');

const COOKIE_NAME = 'ld_admin';
const SESSION_HOURS = 12;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_BROADCAST_LENGTH = 700; // donor_broadcast body is capped at 1024 chars including its fixed text
const BROADCAST_TEMPLATE = 'donor_broadcast';
const STOP_PAYLOAD = 'bcast_stop';
const BLOOD_TYPES = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'];
const FACILITY_TYPES = ['hospital', 'lab', 'blood_bank'];
const FACILITY_FLAGS = ['is_partner', 'does_blood_collection', 'does_lab_tests'];

// ---------- Pure helpers (unit-tested) ----------

// "237677123456" -> "2376•••••456"
function maskPhone(phone) {
  const p = String(phone || '');
  if (p.length < 7) return p ? '•••' : '';
  return `${p.slice(0, 4)}${'•'.repeat(p.length - 7)}${p.slice(-3)}`;
}

const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest('hex');

// Cookie value "<expiry ms>.<signature>": proves the holder knew ADMIN_KEY, without storing the key itself
function sessionToken(adminKey, now = Date.now()) {
  const exp = now + SESSION_HOURS * 60 * 60 * 1000;
  return `${exp}.${hmac(adminKey, `lifedrop-admin:${exp}`)}`;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function validSessionToken(adminKey, token, now = Date.now()) {
  if (!adminKey || !token) return false;
  const [exp, sig] = String(token).split('.');
  if (!exp || !sig || !(Number(exp) > now)) return false;
  return safeEqual(sig, hmac(adminKey, `lifedrop-admin:${exp}`));
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const withinWindow = (lastInboundAt, now = Date.now()) =>
  Boolean(lastInboundAt) && now - new Date(lastInboundAt).getTime() < WINDOW_MS;

const firstName = (name) => toTemplateParam(String(name || '').trim().split(/\s+/)[0] || 'friend', 30);

// What one donor gets: a normal message inside the 24h window, else the approved Marketing template
function broadcastPayload(donor, message, now = Date.now()) {
  const name = firstName(donor.name);
  if (withinWindow(donor.last_inbound_at, now)) {
    return {
      channel: 'text',
      text: `Hello ${name}, a message from the LifeDrop team:\n\n${String(message).trim()}\n\nThank you for being a LifeDrop blood donor. Reply STOP to stop these updates.`
    };
  }
  return { channel: 'template', params: [name, toTemplateParam(message, MAX_BROADCAST_LENGTH)] };
}

// Audience -> SQL filter on donors. Opted-out donors and donors without a phone are never included.
function audienceFilter(audience = {}) {
  const where = [`phone IS NOT NULL`, `broadcast_opt_out IS NOT TRUE`];
  const params = [];
  const type = audience.type || 'all';
  if (type === 'blood_type') {
    if (!BLOOD_TYPES.includes(audience.value)) return { error: 'Pick a valid blood type.' };
    params.push(audience.value);
    where.push(`blood_type = $${params.length}`);
  } else if (type === 'city') {
    const city = String(audience.value || '').trim();
    if (!city) return { error: 'Type a city.' };
    params.push(city);
    where.push(`lower(COALESCE(town, trim(city))) = lower($${params.length})`);
  } else if (type !== 'all') {
    return { error: 'Unknown audience.' };
  }
  if (audience.window_only) where.push(`last_inbound_at > NOW() - INTERVAL '24 hours'`);
  return { where: where.join(' AND '), params };
}

function describeAudience(audience = {}) {
  const base = audience.type === 'blood_type' ? `${audience.value} donors`
    : audience.type === 'city' ? `donors in ${audience.value}` : 'all donors';
  return audience.window_only ? `${base} (active in last 24h only)` : base;
}

// Template names from the table in templates/WHATSAPP_TEMPLATES.md: "| 6 | `donor_broadcast` | Marketing | ..."
function requiredTemplates(markdown) {
  const rows = [];
  const re = /^\|\s*\d+\s*\|\s*`([a-z0-9_]+)`\s*\|\s*([A-Za-z]+)\s*\|/gm;
  let m;
  while ((m = re.exec(markdown))) rows.push({ name: m[1], category: m[2] });
  return rows;
}

// Join required templates with what Meta reports. Missing = not submitted (or submitted under another name).
function templateStatusRows(required, metaTemplates) {
  const byName = {};
  for (const t of metaTemplates || []) (byName[t.name] = byName[t.name] || []).push(t);
  const rows = required.map(r => {
    const found = byName[r.name] || [];
    const en = found.find(t => /^en/.test(t.language || '')) || found[0];
    return { name: r.name, category: r.category, status: en ? en.status : 'MISSING', language: en?.language || null };
  });
  const extra = Object.keys(byName).filter(n => !required.some(r => r.name === n))
    .map(n => ({ name: n, category: byName[n][0].category, status: byName[n][0].status, language: byName[n][0].language, extra: true }));
  return [...rows, ...extra];
}

// TIMESTAMP columns hold UTC (Render runs in UTC); charts group by the day in Cameroon
const localDay = (col) => `((${col}) AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Douala')::date`;
const LOCAL_TODAY = `(NOW() AT TIME ZONE 'Africa/Douala')::date`;

const intParam = (v, def, max) => Math.min(Math.max(parseInt(v, 10) || def, 0), max);
const errorText = (err) => String(err.response?.data?.error?.message || err.message || 'error').slice(0, 300);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Router ----------

function createDashboard({
  pool, getStats, sendMessage, sendTemplate,
  adminKey = process.env.ADMIN_KEY,
  wabaId = process.env.WABA_ID,
  whatsappToken = process.env.WHATSAPP_TOKEN,
  delayMs = parseInt(process.env.BROADCAST_DELAY_MS, 10) || 300,
  allowSend = process.env.BROADCASTS_DISABLED !== 'true', // false in local mode: reading real data, never sending
  templatesFile = path.join(__dirname, 'templates', 'WHATSAPP_TEMPLATES.md')
}) {
  const router = express.Router();
  let running = null; // promise of the broadcast being sent right now
  const failedLogins = new Map(); // ip -> { count, since }

  const schemaReady = pool.query(`
    CREATE TABLE IF NOT EXISTS broadcasts (
      id SERIAL PRIMARY KEY,
      message TEXT NOT NULL,
      audience JSONB NOT NULL,
      status TEXT DEFAULT 'sending',
      total INTEGER DEFAULT 0,
      sent INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      via_text INTEGER DEFAULT 0,
      via_template INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      finished_at TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS broadcast_recipients (
      id SERIAL PRIMARY KEY,
      broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id),
      donor_id INTEGER,
      phone TEXT NOT NULL,
      channel TEXT,
      status TEXT NOT NULL,
      error TEXT,
      sent_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS broadcast_recipients_bid_idx ON broadcast_recipients (broadcast_id);
    ALTER TABLE donors ADD COLUMN IF NOT EXISTS broadcast_opt_out BOOLEAN DEFAULT FALSE;
    ALTER TABLE donors ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP;
    UPDATE broadcasts SET status = 'interrupted', finished_at = NOW() WHERE status = 'sending';
  `).catch(err => console.warn('⚠️ Dashboard schema warning:', err.message));

  router.use(express.json({ limit: '50kb' }));
  router.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' https://api.fontshare.com; font-src https://cdn.fontshare.com; script-src 'self'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store'
    });
    next();
  });
  router.use(express.static(path.join(__dirname, 'admin-ui')));
  // chart.js only exports its CommonJS entry, which sits next to the browser build in dist/
  const chartJsFile = path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.js');
  router.get('/vendor/chart.umd.js', (req, res) => res.sendFile(chartJsFile));

  const isLoggedIn = (req) => validSessionToken(adminKey, parseCookies(req.headers.cookie)[COOKIE_NAME]);
  const cookie = (req, value, maxAgeSec) => {
    const secure = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : '';
    return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${maxAgeSec}${secure}`;
  };

  router.post('/login', (req, res) => {
    const ip = req.ip || 'unknown';
    const f = failedLogins.get(ip);
    if (f && f.count >= 10 && Date.now() - f.since < 15 * 60 * 1000) {
      return res.status(429).json({ error: 'Too many wrong keys. Try again in 15 minutes.' });
    }
    if (!adminKey || !safeEqual(req.body?.key || '', adminKey)) {
      const cur = f && Date.now() - f.since < 15 * 60 * 1000 ? f : { count: 0, since: Date.now() };
      failedLogins.set(ip, { ...cur, count: cur.count + 1 });
      return res.status(403).json({ error: adminKey ? 'Wrong key.' : 'ADMIN_KEY is not set on the server.' });
    }
    failedLogins.delete(ip);
    res.set('Set-Cookie', cookie(req, sessionToken(adminKey), SESSION_HOURS * 3600));
    res.sendStatus(204);
  });

  router.post('/logout', (req, res) => {
    res.set('Set-Cookie', cookie(req, '', 0));
    res.sendStatus(204);
  });

  // Everything below needs the login cookie
  router.use('/api', (req, res, next) => (isLoggedIn(req) ? next() : res.status(403).json({ error: 'Not logged in.' })));

  const api = (handler) => async (req, res) => {
    try {
      await schemaReady;
      await handler(req, res);
    } catch (err) {
      console.error('Dashboard error:', err.message);
      res.status(500).json({ error: 'Server error: ' + err.message });
    }
  };
  const reveal = (req) => req.query.reveal === '1';
  const showPhones = (req, rows, fields = ['phone']) => (reveal(req) ? rows : rows.map(r => {
    const out = { ...r };
    for (const f of fields) if (f in out) out[f] = maskPhone(out[f]);
    return out;
  }));

  router.get('/api/me', (req, res) => res.json({ ok: true, wabaConfigured: Boolean(wabaId), allowSend }));

  // ----- Overview -----
  router.get('/api/stats', api(async (req, res) => {
    const days = intParam(req.query.days, 7, 365) || 7;
    const chartDays = Math.max(days, 7);
    const [stats, totals, series, bloodTypes, openRequests] = await Promise.all([
      getStats(days),
      pool.query(`SELECT
          (SELECT COUNT(*) FROM requests WHERE status IS DISTINCT FROM 'fulfilled') AS requests_open,
          (SELECT COUNT(*) FROM requests WHERE status = 'fulfilled') AS requests_fulfilled,
          (SELECT COUNT(*) FROM requests r WHERE NOT EXISTS (SELECT 1 FROM matches m WHERE m.request_id = r.id)) AS requests_no_donor,
          (SELECT COUNT(*) FROM requests) AS requests_total,
          (SELECT COUNT(*) FROM matches) AS matches_total,
          (SELECT COUNT(*) FROM matches WHERE response IS NOT NULL) AS matches_replied,
          (SELECT COUNT(*) FROM matches WHERE donation_confirmed_at IS NOT NULL) AS donations_confirmed,
          (SELECT COUNT(*) FROM donors WHERE broadcast_opt_out IS TRUE) AS donors_opted_out`),
      // One row per day in Cameroon time (timestamps are stored in UTC)
      pool.query(
        `WITH days AS (
           SELECT generate_series(${LOCAL_TODAY} - ($1::int - 1), ${LOCAL_TODAY}, INTERVAL '1 day')::date AS day
         )
         SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
           (SELECT COUNT(*) FROM donors WHERE ${localDay('created_at')} = d.day) AS donors,
           (SELECT COUNT(*) FROM requests WHERE ${localDay('created_at')} = d.day) AS requests,
           (SELECT COUNT(*) FROM matches WHERE ${localDay('contacted_at')} = d.day) AS contacted,
           (SELECT COUNT(*) FROM matches WHERE response = 'yes' AND ${localDay('responded_at')} = d.day) AS yes,
           (SELECT COUNT(*) FROM matches WHERE ${localDay('donation_confirmed_at')} = d.day) AS donations
         FROM days d ORDER BY d.day`,
        [chartDays]
      ),
      pool.query(`SELECT COALESCE(NULLIF(blood_type, ''), 'UNKNOWN') AS blood_type, COUNT(*) AS count FROM donors GROUP BY 1`),
      pool.query(
        `SELECT r.id, r.blood_type_needed, r.units_needed, r.urgency, COALESCE(r.town, r.location) AS location, r.created_at,
           (SELECT COUNT(*) FROM matches m WHERE m.request_id = r.id) AS contacted,
           (SELECT COUNT(*) FROM matches m WHERE m.request_id = r.id AND m.response = 'yes') AS yes
         FROM requests r WHERE r.status IS DISTINCT FROM 'fulfilled'
         ORDER BY r.created_at DESC NULLS LAST, r.id DESC LIMIT 6`
      )
    ]);
    res.json({
      days, stats, totals: totals.rows[0], report: formatStatsReport(stats, days),
      series: series.rows, bloodTypes: bloodTypes.rows, openRequests: openRequests.rows
    });
  }));

  // ----- Lists -----
  function listQuery(req, filters) {
    const where = [];
    const params = [];
    for (const [key, sql] of Object.entries(filters)) {
      const v = String(req.query[key] ?? '').trim();
      if (!v) continue;
      params.push(key === 'q' ? `%${v}%` : v);
      where.push(sql.replace(/\$\?/g, `$${params.length}`));
    }
    const limit = intParam(req.query.limit, 100, 500) || 100;
    const offset = intParam(req.query.offset, 0, 1e6);
    return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params, tail: `LIMIT ${limit} OFFSET ${offset}` };
  }

  router.get('/api/donors', api(async (req, res) => {
    const q = listQuery(req, {
      status: `d.eligibility_status = $?`,
      blood_type: `d.blood_type = $?`,
      city: `lower(COALESCE(d.town, trim(d.city))) = lower($?)`,
      q: `(d.name ILIKE $? OR d.phone LIKE $?)`
    });
    const result = await pool.query(
      `SELECT d.id, d.name, d.phone, d.blood_type, COALESCE(d.town, d.city) AS city, d.gender, d.age, d.eligibility_status,
         d.screening_reasons, d.last_donation_date, d.deferred_until, d.verified_at, d.created_at, d.last_inbound_at,
         d.broadcast_opt_out, d.reviewed_at
       FROM donors d ${q.where} ORDER BY d.created_at DESC NULLS LAST, d.id DESC ${q.tail}`,
      q.params
    );
    res.json({ rows: showPhones(req, result.rows) });
  }));

  router.get('/api/requests', api(async (req, res) => {
    const q = listQuery(req, {
      status: `COALESCE(r.status, 'open') = $?`,
      blood_type: `r.blood_type_needed = $?`,
      urgency: `r.urgency = $?`,
      city: `lower(COALESCE(r.town, trim(r.location))) = lower($?)`
    });
    const result = await pool.query(
      `SELECT r.id, r.requester_phone, r.blood_type_needed, r.units_needed, r.urgency, COALESCE(r.status, 'open') AS status,
         COALESCE(r.town, r.location) AS location, r.hospital_name, f.name AS facility_name, r.contact_name, r.contact_phone,
         r.created_at, r.fulfilled_at,
         (SELECT COUNT(*) FROM matches m WHERE m.request_id = r.id) AS contacted,
         (SELECT COUNT(*) FROM matches m WHERE m.request_id = r.id AND m.response = 'yes') AS yes
       FROM requests r LEFT JOIN facilities f ON f.id = r.facility_id
       ${q.where} ORDER BY r.created_at DESC NULLS LAST, r.id DESC ${q.tail}`,
      q.params
    );
    res.json({ rows: showPhones(req, result.rows, ['requester_phone', 'contact_phone']) });
  }));

  router.get('/api/matches', api(async (req, res) => {
    const q = listQuery(req, {
      response: `COALESCE(m.response, 'no_reply') = $?`,
      request_id: `m.request_id = $?::int`
    });
    const result = await pool.query(
      `SELECT m.id, m.request_id, m.donor_id, d.name AS donor_name, d.phone, r.blood_type_needed, COALESCE(r.town, r.location) AS location,
         COALESCE(m.response, 'no_reply') AS response, m.contacted_at, m.responded_at, m.confirm_code, m.donation_confirmed_at,
         m.confirmed_by_facility_id IS NOT NULL AS confirmed_by_facility
       FROM matches m LEFT JOIN donors d ON d.id = m.donor_id LEFT JOIN requests r ON r.id = m.request_id
       ${q.where} ORDER BY m.contacted_at DESC NULLS LAST, m.id DESC ${q.tail}`,
      q.params
    );
    res.json({ rows: showPhones(req, result.rows) });
  }));

  router.get('/api/facilities', api(async (req, res) => {
    const q = listQuery(req, {
      type: `type = $?`,
      partner: `is_partner = ($? = 'yes')`
    });
    const result = await pool.query(
      `SELECT id, name, type, city, staff_phone, is_partner, does_blood_collection, does_lab_tests, is_demo, created_at
       FROM facilities ${q.where} ORDER BY is_partner DESC, city, name ${q.tail}`,
      q.params
    );
    res.json({ rows: showPhones(req, result.rows, ['staff_phone']) });
  }));

  // ----- Hospitals / labs -----
  router.post('/api/facilities', api(async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const typedCity = String(b.city || '').trim();
    const phone = normalizePhone(b.staff_phone);
    const type = FACILITY_TYPES.includes(b.type) ? b.type : 'hospital';
    if (!name || !typedCity) return res.status(400).json({ error: 'Name and city are required.' });
    if (!phone) return res.status(400).json({ error: 'Staff phone is not a valid number (e.g. 677123456).' });
    const existing = await pool.query(`SELECT id, name FROM facilities WHERE regexp_replace(staff_phone, '\\D', '', 'g') = $1`, [phone]);
    if (existing.rows.length) {
      return res.status(409).json({ error: `This phone is already registered as ${existing.rows[0].name} (ID ${existing.rows[0].id}).` });
    }
    // Same as the WhatsApp "addhospital" command: store the clean town name and its centre
    const town = geo.resolveTown(typedCity).town;
    const inserted = await pool.query(
      `INSERT INTO facilities (name, type, city, staff_phone, is_partner, does_blood_collection, does_lab_tests, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, name, type, city, staff_phone, is_partner, does_blood_collection, does_lab_tests`,
      [name, type, town?.name || typedCity, phone, b.is_partner !== false,
       b.does_blood_collection ?? type !== 'lab', b.does_lab_tests ?? type === 'lab', town?.lat ?? null, town?.lng ?? null]
    );
    res.status(201).json({ facility: inserted.rows[0], knownTown: Boolean(town) });
  }));

  router.patch('/api/facilities/:id', api(async (req, res) => {
    const sets = [];
    const params = [];
    for (const flag of FACILITY_FLAGS) {
      if (typeof req.body?.[flag] === 'boolean') {
        params.push(req.body[flag]);
        sets.push(`${flag} = $${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
    params.push(parseInt(req.params.id, 10));
    const result = await pool.query(
      `UPDATE facilities SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, name, is_partner, does_blood_collection, does_lab_tests`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Facility not found.' });
    res.json({ facility: result.rows[0] });
  }));

  // ----- Donor review -----
  router.post('/api/donors/:id/review', api(async (req, res) => {
    const decision = req.body?.decision;
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision must be approve or reject.' });
    const result = await pool.query(
      `UPDATE donors SET eligibility_status = $1, reviewed_at = NOW()
       WHERE id = $2 AND eligibility_status = 'needs_review' RETURNING id, name, eligibility_status`,
      [decision === 'approve' ? 'eligible' : 'not_eligible', parseInt(req.params.id, 10)]
    );
    if (!result.rows.length) return res.status(409).json({ error: 'Donor not found or no longer waiting for review.' });
    res.json({ donor: result.rows[0] });
  }));

  // ----- WhatsApp templates -----
  let templateCache = null; // { at, rows }
  async function templateStatus(force = false) {
    if (!wabaId || !whatsappToken) return { configured: false, rows: [] };
    if (!force && templateCache && Date.now() - templateCache.at < 5 * 60 * 1000) return templateCache.data;
    const required = requiredTemplates(fs.readFileSync(templatesFile, 'utf8'));
    const meta = [];
    let url = `https://graph.facebook.com/v22.0/${wabaId}/message_templates`;
    let params = { fields: 'name,status,category,language', limit: 200 };
    for (let page = 0; url && page < 10; page++) {
      const r = await axios.get(url, { params, headers: { Authorization: `Bearer ${whatsappToken}` } });
      meta.push(...(r.data?.data || []));
      url = r.data?.paging?.next || null;
      params = undefined; // the "next" link already carries them
    }
    const data = { configured: true, checkedAt: new Date().toISOString(), rows: templateStatusRows(required, meta) };
    templateCache = { at: Date.now(), data };
    return data;
  }

  router.get('/api/templates', api(async (req, res) => {
    try {
      res.json(await templateStatus(req.query.refresh === '1'));
    } catch (err) {
      res.status(502).json({ error: 'Could not reach Meta: ' + errorText(err) });
    }
  }));

  // ----- Broadcasts -----
  router.get('/api/audience-options', api(async (req, res) => {
    const [types, cities] = await Promise.all([
      pool.query(`SELECT blood_type AS value, COUNT(*) AS count FROM donors WHERE ${audienceFilter().where} AND blood_type IS NOT NULL GROUP BY 1 ORDER BY 1`),
      pool.query(`SELECT COALESCE(town, trim(city)) AS value, COUNT(*) AS count FROM donors WHERE ${audienceFilter().where} AND COALESCE(town, city) IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 50`)
    ]);
    res.json({ bloodTypes: types.rows, cities: cities.rows });
  }));

  function checkMessage(message) {
    const text = String(message || '').trim();
    if (!text) return 'Write a message first.';
    if (text.length > MAX_BROADCAST_LENGTH) return `Message is too long (${text.length}/${MAX_BROADCAST_LENGTH} characters).`;
    return null;
  }

  async function audienceCounts(filter) {
    const r = await pool.query(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE last_inbound_at > NOW() - INTERVAL '24 hours') AS in_window
       FROM donors WHERE ${filter.where}`,
      filter.params
    );
    return { total: Number(r.rows[0].total), inWindow: Number(r.rows[0].in_window) };
  }

  router.post('/api/broadcasts/preview', api(async (req, res) => {
    const { message, audience = {} } = req.body || {};
    const messageError = checkMessage(message);
    if (messageError) return res.status(400).json({ error: messageError });
    const filter = audienceFilter(audience);
    if (filter.error) return res.status(400).json({ error: filter.error });
    const counts = await audienceCounts(filter);
    let templateState = 'UNKNOWN';
    try {
      const t = await templateStatus();
      if (t.configured) templateState = t.rows.find(r => r.name === BROADCAST_TEMPLATE)?.status || 'MISSING';
    } catch (err) { /* shown as UNKNOWN */ }
    const sample = { name: 'Jean', last_inbound_at: null };
    res.json({
      audience: describeAudience(audience),
      total: counts.total,
      inWindow: counts.inWindow,
      viaTemplate: counts.total - counts.inWindow,
      templateName: BROADCAST_TEMPLATE,
      templateStatus: templateState,
      sampleText: broadcastPayload({ ...sample, last_inbound_at: new Date() }, message).text,
      sampleTemplate: `Hello Jean, a message from the LifeDrop team: ${broadcastPayload(sample, message).params[1]}\n\nThank you for being a LifeDrop blood donor. Reply STOP to stop these updates.`,
      secondsEstimate: Math.ceil((counts.total * delayMs) / 1000)
    });
  }));

  async function runBroadcast(id, donors, message) {
    let sent = 0, failed = 0, viaText = 0, viaTemplate = 0;
    for (let i = 0; i < donors.length; i++) {
      const d = donors[i];
      const payload = broadcastPayload(d, message);
      let status = 'sent';
      let error = null;
      try {
        if (payload.channel === 'text') await sendMessage(d.phone, payload.text);
        else await sendTemplate(d.phone, BROADCAST_TEMPLATE, payload.params, [STOP_PAYLOAD]);
        sent++;
        if (payload.channel === 'text') viaText++; else viaTemplate++;
      } catch (err) {
        status = 'failed';
        error = errorText(err);
        failed++;
      }
      await pool.query(
        `INSERT INTO broadcast_recipients (broadcast_id, donor_id, phone, channel, status, error) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, d.id, d.phone, payload.channel, status, error]
      ).catch(err => console.error('Broadcast log error:', err.message));
      if ((i + 1) % 20 === 0) {
        await pool.query(`UPDATE broadcasts SET sent = $2, failed = $3 WHERE id = $1`, [id, sent, failed]).catch(() => {});
      }
      if (i < donors.length - 1 && delayMs > 0) await sleep(delayMs); // throttle: stay well under Meta's rate limits
    }
    await pool.query(
      `UPDATE broadcasts SET status = 'done', sent = $2, failed = $3, via_text = $4, via_template = $5, finished_at = NOW() WHERE id = $1`,
      [id, sent, failed, viaText, viaTemplate]
    );
  }

  router.post('/api/broadcasts', api(async (req, res) => {
    const { message, audience = {}, confirm, expected_count: expected } = req.body || {};
    if (!allowSend) return res.status(403).json({ error: 'Sending is turned off here (local mode). Send broadcasts from the live dashboard on Render.' });
    if (confirm !== true) return res.status(400).json({ error: 'Confirm the broadcast first.' });
    const messageError = checkMessage(message);
    if (messageError) return res.status(400).json({ error: messageError });
    const filter = audienceFilter(audience);
    if (filter.error) return res.status(400).json({ error: filter.error });
    if (running) return res.status(409).json({ error: 'Another broadcast is still sending. Wait for it to finish.' });
    const active = await pool.query(`SELECT id FROM broadcasts WHERE status = 'sending' LIMIT 1`);
    if (active.rows.length) return res.status(409).json({ error: `Broadcast #${active.rows[0].id} is still sending.` });

    const donors = (await pool.query(
      `SELECT id, name, phone, last_inbound_at FROM donors WHERE ${filter.where} ORDER BY id`,
      filter.params
    )).rows;
    if (!donors.length) return res.status(400).json({ error: 'No donors match this audience.' });
    if (Number(expected) !== donors.length) {
      return res.status(409).json({ error: `The audience changed (${donors.length} donors now, preview said ${expected}). Preview again.` });
    }
    const text = String(message).trim();
    const inserted = await pool.query(
      `INSERT INTO broadcasts (message, audience, total) VALUES ($1, $2, $3) RETURNING id`,
      [text, JSON.stringify({ ...audience, label: describeAudience(audience) }), donors.length]
    );
    const id = inserted.rows[0].id;
    running = runBroadcast(id, donors, text)
      .catch(async err => {
        console.error('Broadcast error:', err.message);
        await pool.query(`UPDATE broadcasts SET status = 'interrupted', finished_at = NOW() WHERE id = $1`, [id]).catch(() => {});
      })
      .finally(() => { running = null; });
    res.status(202).json({ id, total: donors.length });
  }));

  router.get('/api/broadcasts', api(async (req, res) => {
    const result = await pool.query(
      `SELECT b.id, b.message, b.audience, b.status, b.total, b.created_at, b.finished_at, b.via_text, b.via_template,
         COALESCE(c.sent, 0) AS sent, COALESCE(c.failed, 0) AS failed
       FROM broadcasts b LEFT JOIN (
         SELECT broadcast_id, COUNT(*) FILTER (WHERE status = 'sent') AS sent, COUNT(*) FILTER (WHERE status = 'failed') AS failed
         FROM broadcast_recipients GROUP BY 1
       ) c ON c.broadcast_id = b.id
       ORDER BY b.id DESC LIMIT 50`
    );
    res.json({ rows: result.rows });
  }));

  router.get('/api/broadcasts/:id', api(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const [b, recipients] = await Promise.all([
      pool.query(`SELECT * FROM broadcasts WHERE id = $1`, [id]),
      pool.query(
        `SELECT br.donor_id, d.name, br.phone, br.channel, br.status, br.error, br.sent_at
         FROM broadcast_recipients br LEFT JOIN donors d ON d.id = br.donor_id
         WHERE br.broadcast_id = $1 ORDER BY br.id`,
        [id]
      )
    ]);
    if (!b.rows.length) return res.status(404).json({ error: 'Broadcast not found.' });
    res.json({ broadcast: b.rows[0], recipients: showPhones(req, recipients.rows) });
  }));

  // Donor replied STOP (text or the template's "Stop updates" button)
  async function handleOptOut(phone) {
    await schemaReady;
    await pool.query(`UPDATE donors SET broadcast_opt_out = TRUE WHERE phone = $1`, [phone]);
    return sendMessage(phone, "✅ You won't get LifeDrop news updates any more. You can still be contacted when a patient urgently needs your blood type. Reply START to get updates again.");
  }

  // Donor replied START: only handled for opted-out donors (returns false otherwise, so "start" keeps its normal meaning)
  async function handleOptIn(phone) {
    await schemaReady;
    const r = await pool.query(`UPDATE donors SET broadcast_opt_out = FALSE WHERE phone = $1 AND broadcast_opt_out IS TRUE RETURNING id`, [phone]);
    if (!r.rows.length) return false;
    await sendMessage(phone, '✅ You will get LifeDrop news updates again. Reply STOP any time to stop them.');
    return true;
  }

  return {
    router,
    handleOptOut,
    handleOptIn,
    schemaReady,
    get running() { return running; }
  };
}

const isStopText = (text) => /^(stop|unsubscribe|stop updates)$/i.test(String(text || '').trim());
const isStartText = (text) => /^start$/i.test(String(text || '').trim());

module.exports = {
  createDashboard, maskPhone, sessionToken, validSessionToken, parseCookies, withinWindow, broadcastPayload,
  audienceFilter, describeAudience, requiredTemplates, templateStatusRows, isStopText, isStartText,
  STOP_PAYLOAD, MAX_BROADCAST_LENGTH
};

// Run the real server.js locally with an in-memory database (PGlite) and fake WhatsApp, to try the dashboard.
// Nothing is sent to Meta: every WhatsApp call is printed instead. Usage: npm run dev:admin, then open
// http://localhost:3100/admin and log in with the key printed below.
const Module = require('module');
const axios = require('axios');
const { PglitePool, SCHEMA } = require('../test/helpers/pglite-pool');

process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-key';
process.env.WABA_ID = process.env.WABA_ID || 'DEV_WABA';
process.env.WHATSAPP_TOKEN = 'dev-token-not-real';
process.env.PHONE_NUMBER_ID = 'DEV_PHONE_ID';
process.env.PORT = process.env.PORT || '3100';
process.env.BROADCAST_DELAY_MS = process.env.BROADCAST_DELAY_MS || '500';
delete process.env.DATABASE_URL;
delete process.env.CS_PHONE_NUMBER;
delete process.env.GEMINI_API_KEY;

// Fake WhatsApp: print instead of sending. 237600000013 always fails, to show how failures look.
axios.post = async (url, body) => {
  if (!String(url).includes('graph.facebook.com')) throw new Error(`Blocked outbound call in dev mode: ${url}`);
  if (body?.to === '237600000013') {
    throw Object.assign(new Error('Request failed'), { response: { data: { error: { message: '(dev) Recipient phone number not on WhatsApp' } } } });
  }
  const what = body?.type === 'template' ? `template ${body.template.name}` : body?.type;
  console.log(`📤 [fake WhatsApp] to ${body?.to}: ${what}${body?.text ? ` | ${body.text.body.slice(0, 60)}...` : ''}`);
  return { data: { messages: [{ id: 'wamid.DEV' }] } };
};
axios.get = async (url) => {
  if (!String(url).includes('/message_templates')) throw new Error(`Blocked outbound call in dev mode: ${url}`);
  return {
    data: {
      data: [
        { name: 'hello_world', status: 'APPROVED', category: 'UTILITY', language: 'en_US' },
        { name: 'donor_match_alert', status: 'PENDING', category: 'UTILITY', language: 'en' }
      ]
    }
  };
};

// server.js does `new Pool(...)` from pg: hand it the PGlite pool instead
const pool = new PglitePool();
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'pg') return { Pool: function () { return pool; } };
  return realLoad.call(this, request, ...rest);
};

async function seed() {
  await pool.query(SCHEMA);
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const donors = [
    ['Jean Mbah', 'O+', 'Buea', 'eligible', 2, 'male'],
    ['Marie Ngo', 'O+', 'Buea', 'eligible', 80, 'female'],
    ['Paul Tabi', 'A+', 'Limbe', 'needs_review', 200, 'male', 'Takes regular medication'],
    ['Grace Eyong', 'B+', 'Tiko', 'eligible', 5, 'female'],
    ['Samuel Fon', 'O-', 'Douala', 'eligible', 400, 'male'],
    ['Esther Ndi', 'AB+', 'Buea', 'needs_review', 30, 'female', 'Heavy periods'],
    ['Eric Nkem', 'A-', 'Limbe', 'not_eligible', 500, 'male', 'Chronic condition'],
    ['Linda Ayuk', 'O+', 'Douala', 'eligible', 1, 'female'],
    ['Peter Ewane', 'B-', 'Buea', 'eligible', 90, 'male'],
    ['Rose Bate', 'A+', 'Tiko', 'on_hold', 300, 'female'],
    ['Didier Kum', 'O+', 'Limbe', 'eligible', 12, 'male'],
    ['Fake Failure', 'O+', 'Buea', 'eligible', 100, 'male']
  ];
  for (const [i, d] of donors.entries()) {
    await pool.query(
      `INSERT INTO donors (name, phone, blood_type, city, town, eligibility_status, last_inbound_at, gender, screening_reasons, created_at)
       VALUES ($1, $2, $3, lower($4), $4, $5, $6, $7, $8, $9)`,
      [d[0], `2376000000${String(i + 2).padStart(2, '0')}`, d[1], d[2], d[3], hoursAgo(d[4]), d[5], d[6] || null, hoursAgo(24 * (i + 1))]
    );
  }
  await pool.query(`INSERT INTO facilities (name, type, city, staff_phone, is_partner, does_blood_collection) VALUES
    ('Dev Regional Hospital (fictional)', 'hospital', 'Buea', '237600000090', TRUE, TRUE)`);
  await pool.query(`INSERT INTO requests (requester_phone, blood_type_needed, location, town, urgency, status, units_needed, facility_id, created_at, fulfilled_at) VALUES
    ('237600000080', 'O+', 'buea', 'Buea', 'Emergency', 'fulfilled', 2, 1, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days' + INTERVAL '40 minutes'),
    ('237600000081', 'A+', 'limbe', 'Limbe', 'Urgent', 'open', 1, NULL, NOW() - INTERVAL '1 day', NULL),
    ('237600000082', 'AB-', 'kumba', NULL, 'Routine', 'open', 1, NULL, NOW() - INTERVAL '2 hours', NULL)`);
  await pool.query(`INSERT INTO matches (request_id, donor_id, contacted_at, response, responded_at, confirm_code, donation_confirmed_at, confirmed_by_facility_id) VALUES
    (1, 1, NOW() - INTERVAL '3 days', 'yes', NOW() - INTERVAL '3 days' + INTERVAL '10 minutes', 'LD-12345', NOW() - INTERVAL '2 days', 1),
    (1, 2, NOW() - INTERVAL '3 days', 'yes', NOW() - INTERVAL '3 days' + INTERVAL '30 minutes', 'LD-23456', NULL, NULL),
    (1, 8, NOW() - INTERVAL '3 days', 'no', NOW() - INTERVAL '3 days' + INTERVAL '5 minutes', NULL, NULL, NULL),
    (2, 3, NOW() - INTERVAL '1 day', NULL, NULL, NULL, NULL, NULL)`);
}

seed().then(() => {
  require('../server');
  console.log(`\n🛠️  Dev dashboard: http://localhost:${process.env.PORT}/admin  (key: ${process.env.ADMIN_KEY})`);
  console.log('   In-memory database with fictional donors. WhatsApp is faked: nothing is really sent.\n');
});

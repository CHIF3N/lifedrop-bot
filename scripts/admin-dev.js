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
  if (String(url).endsWith('/media')) {
    console.log('📤 [fake WhatsApp] image uploaded');
    return { data: { id: '1234567890123456' } };
  }
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
        { name: 'hello_world', status: 'APPROVED', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Hello World' }] },
        { name: 'donor_match_alert', status: 'PENDING', category: 'UTILITY', language: 'en', components: [{ type: 'BODY', text: 'x {{1}}' }] },
        {
          name: 'hospital_admin_notice', status: 'APPROVED', category: 'MARKETING', language: 'en',
          components: [{ type: 'BODY', text: 'Hello {{1}} team, this is a message from LifeDrop administration: {{2}}\n\nReply to this message if you have questions.' }]
        },
        {
          name: 'donor_broadcast', status: 'APPROVED', category: 'MARKETING', language: 'en',
          components: [
            { type: 'BODY', text: 'Hello {{1}}, a message from the LifeDrop team: {{2}}\n\nThank you for being a LifeDrop blood donor.' },
            { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Join the group', url: 'https://lifedrop-bot.onrender.com/join' }, { type: 'URL', text: 'Visit website', url: 'https://lifedropcm.site' }] }
          ]
        },
        {
          name: 'donor_broadcast_image', status: 'APPROVED', category: 'MARKETING', language: 'en',
          components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hello {{1}}, a message from the LifeDrop team: {{2}}\n\nThank you for being a LifeDrop blood donor.' }]
        }
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
  // Deterministic fictional data spread over the last 45 days, so the charts have something to show
  let x = 7;
  const rand = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const first = ['Jean', 'Marie', 'Paul', 'Grace', 'Samuel', 'Esther', 'Eric', 'Linda', 'Peter', 'Rose', 'Didier', 'Brenda', 'Kevin', 'Joy', 'Yannick'];
  const last = ['Mbah', 'Ngo', 'Tabi', 'Eyong', 'Fon', 'Ndi', 'Nkem', 'Ayuk', 'Ewane', 'Bate', 'Kum', 'Tanyi'];
  const towns = ['Buea', 'Buea', 'Buea', 'Limbe', 'Limbe', 'Tiko', 'Douala', 'Douala', 'Mutengene', 'Kumba'];
  const types = ['O+', 'O+', 'O+', 'O+', 'A+', 'A+', 'B+', 'B+', 'AB+', 'O-', 'A-', 'B-', 'AB-'];
  const statuses = ['eligible', 'eligible', 'eligible', 'eligible', 'eligible', 'eligible', 'needs_review', 'not_eligible', 'on_hold'];
  for (let i = 0; i < 64; i++) {
    const daysAgo = Math.floor(rand() * rand() * 45); // more sign-ups recently
    const status = i === 63 ? 'eligible' : pick(statuses);
    const donated = rand() < 0.15 ? `NOW() - INTERVAL '${Math.floor(rand() * 60)} days'` : 'NULL';
    await pool.query(
      `INSERT INTO donors (name, phone, blood_type, city, town, eligibility_status, last_inbound_at, gender, screening_reasons, created_at, last_donation_date)
       VALUES ($1, $2, $3, lower($4), $4, $5, NOW() - $6 * INTERVAL '1 hour', $7, $8, NOW() - $9 * INTERVAL '1 day' - $10 * INTERVAL '1 hour', ${donated})`,
      [i === 63 ? 'Fake Failure' : `${pick(first)} ${pick(last)}`, `2376000${String(i + 100).padStart(5, '0')}`, pick(types), pick(towns), status,
       Math.floor(rand() * 300), rand() < 0.5 ? 'male' : 'female', status === 'needs_review' ? pick(['Takes regular medication', 'Heavy periods', 'Recent surgery']) : null,
       daysAgo, Math.floor(rand() * 20)]
    );
  }
  await pool.query(`UPDATE donors SET phone = '237600000013' WHERE name = 'Fake Failure'`);
  await pool.query(`INSERT INTO facilities (name, type, city, staff_phone, is_partner, does_blood_collection, does_lab_tests) VALUES
    ('Dev Regional Hospital (fictional)', 'hospital', 'Buea', '237600000090', TRUE, TRUE, FALSE),
    ('Dev Lab Limbe (fictional)', 'lab', 'Limbe', '237600000091', TRUE, FALSE, TRUE)`);
  for (let r = 1; r <= 26; r++) {
    const daysAgo = Math.floor(rand() * 40);
    const fulfilled = rand() < 0.6 && daysAgo > 0;
    const type = pick(types);
    await pool.query(
      `INSERT INTO requests (requester_phone, blood_type_needed, location, town, urgency, status, units_needed, facility_id, created_at, fulfilled_at)
       VALUES ($1, $2, lower($3), $3, $4, $5, $6, $7, NOW() - $8 * INTERVAL '1 day', ${fulfilled ? `NOW() - $8 * INTERVAL '1 day' + INTERVAL '50 minutes'` : 'NULL'})`,
      [`2376000800${String(r).padStart(2, '0')}`, type, pick(towns), pick(['Emergency', 'Urgent', 'Urgent', 'Routine']), fulfilled ? 'fulfilled' : 'open',
       1 + Math.floor(rand() * 3), rand() < 0.4 ? 1 : null, daysAgo]
    );
    if (rand() < 0.15) continue; // some requests found no donor
    const contacts = 2 + Math.floor(rand() * 4);
    for (let c = 0; c < contacts; c++) {
      const donorId = 1 + Math.floor(rand() * 63);
      const reply = pick(['yes', 'yes', 'no', null, null, 'not_needed']);
      const confirmed = reply === 'yes' && rand() < 0.5;
      await pool.query(
        `INSERT INTO matches (request_id, donor_id, contacted_at, response, responded_at, confirm_code, donation_confirmed_at, confirmed_by_facility_id)
         VALUES ($1, $2, NOW() - $3 * INTERVAL '1 day', $4, ${reply ? `NOW() - $3 * INTERVAL '1 day' + INTERVAL '25 minutes'` : 'NULL'},
           $5, ${confirmed ? `NOW() - $3 * INTERVAL '1 day' + INTERVAL '1 day'` : 'NULL'}, $6)`,
        [r, donorId, daysAgo, reply, reply === 'yes' ? `LD-${10000 + r * 10 + c}` : null, confirmed && rand() < 0.6 ? 1 : null]
      );
    }
  }
}

seed().then(() => {
  require('../server');
  console.log(`\n🛠️  Dev dashboard: http://localhost:${process.env.PORT}/admin  (key: ${process.env.ADMIN_KEY})`);
  console.log('   In-memory database with fictional donors. WhatsApp is faked: nothing is really sent.\n');
});

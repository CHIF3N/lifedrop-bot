const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// In-memory conversation state (resets if server restarts — fine for now)
const sessions = {};

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message) {
      const from = message.from;
      const text = message.text?.body?.trim() || '';
      await handleMessage(from, text);
    }
  } catch (err) {
    console.error('Error:', err.response?.data ? JSON.stringify(err.response.data) : err.message);
  }
  res.sendStatus(200);
});

async function handleMessage(from, text) {
  if (!sessions[from]) {
    sessions[from] = { step: 'start', data: {} };
  }
  const session = sessions[from];

  // Allow restart anytime
  if (text.toLowerCase() === 'restart') {
    sessions[from] = { step: 'start', data: {} };
    return sendMessage(from, "Restarted. Welcome to LifeDrop! Reply:\n1 - Register as a blood donor\n2 - Request blood");
  }

  switch (session.step) {
    case 'start':
      session.step = 'menu';
      return sendMessage(from, "Welcome to LifeDrop 🩸\nReply:\n1 - Register as a blood donor\n2 - Request blood");

    case 'menu':
      if (text === '1') {
        session.step = 'donor_name';
        return sendMessage(from, "Great! Let's get you registered. What's your full name?");
      } else if (text === '2') {
        session.step = 'request_blood_type';
        return sendMessage(from, "What blood type is needed? (e.g. A+, O-, B+)");
      } else {
        return sendMessage(from, "Please reply with 1 (donor) or 2 (request blood).");
      }

    // ---- DONOR REGISTRATION FLOW ----
    case 'donor_name':
      session.data.name = text;
      session.step = 'donor_blood_type';
      return sendMessage(from, "What's your blood type? (e.g. A+, O-, B+)");

    case 'donor_blood_type':
      session.data.blood_type = text.toUpperCase();
      session.step = 'donor_city';
      return sendMessage(from, "Which city/town are you in?");

    case 'donor_city':
      session.data.city = text;
      session.step = 'donor_age';
      return sendMessage(from, "What's your age?");

    case 'donor_age':
      session.data.age = parseInt(text) || null;
      session.step = 'donor_weight';
      return sendMessage(from, "What's your weight in kg?");

    case 'donor_weight':
      session.data.weight_kg = parseInt(text) || null;
      session.step = 'donor_last_donation';
      return sendMessage(from, "When did you last donate blood? Reply 'never' or a rough date (e.g. Jan 2026).");

    case 'donor_last_donation':
      session.data.last_donation_text = text;
      session.step = 'donor_medication';
      return sendMessage(from, "Are you currently on any medication? (yes/no)");

    case 'donor_medication':
      session.data.on_medication = text.toLowerCase().startsWith('y');
      session.step = 'donor_chronic';
      return sendMessage(from, "Do you have any chronic condition (diabetes, hypertension, HIV, hepatitis)? (yes/no)");

    case 'donor_chronic':
      session.data.chronic_condition = text.toLowerCase().startsWith('y');
      session.step = 'donor_illness';
      return sendMessage(from, "Any fever, cold, or illness in the past 2 weeks? (yes/no)");

    case 'donor_illness':
      session.data.recent_illness = text.toLowerCase().startsWith('y');
      session.step = 'donor_tattoo';
      return sendMessage(from, "Any tattoo or piercing in the last 6 months? (yes/no)");

    case 'donor_tattoo':
      session.data.recent_tattoo_piercing = text.toLowerCase().startsWith('y');
      session.step = 'donor_consent';
      return sendMessage(from, "Last step: do you consent to LifeDrop storing your info to match you with blood requests? (yes/no)");

    case 'donor_consent':
      session.data.consent_given = text.toLowerCase().startsWith('y');
      if (!session.data.consent_given) {
        sessions[from] = { step: 'start', data: {} };
        return sendMessage(from, "No problem — we won't save your info. Message us anytime if you change your mind.");
      }
      await saveDonor(from, session.data);
      sessions[from] = { step: 'start', data: {} };
      return sendMessage(from, "Thank you! You're registered as a LifeDrop donor. We'll reach out when there's a matching request nearby. 🩸");

    // ---- BLOOD REQUEST FLOW ----
    case 'request_blood_type':
      session.data.blood_type_needed = text.toUpperCase();
      session.step = 'request_location';
      return sendMessage(from, "What city/location is the patient in?");

    case 'request_location':
      session.data.location = text;
      session.step = 'request_urgency';
      return sendMessage(from, "How urgent is this? (e.g. immediate, today, this week)");

    case 'request_urgency':
      session.data.urgency = text;
      const matchCount = await saveRequestAndMatch(from, session.data);
      sessions[from] = { step: 'start', data: {} };
      return sendMessage(from, `Request logged. Found ${matchCount} potential matching donor(s) in ${session.data.location}. We're reaching out to them now.`);

    default:
      sessions[from] = { step: 'start', data: {} };
      return sendMessage(from, "Let's start over. Welcome to LifeDrop 🩸\nReply:\n1 - Register as a blood donor\n2 - Request blood");
  }
}

async function saveDonor(phone, d) {
  await pool.query(
    `INSERT INTO donors (name, phone, blood_type, city, age, weight_kg, on_medication, chronic_condition, recent_illness, recent_tattoo_piercing, consent_given, eligibility_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (phone) DO UPDATE SET
       name=$1, blood_type=$3, city=$4, age=$5, weight_kg=$6, on_medication=$7, chronic_condition=$8, recent_illness=$9, recent_tattoo_piercing=$10, consent_given=$11, eligibility_status=$12`,
    [
      d.name, phone, d.blood_type, d.city, d.age, d.weight_kg,
      d.on_medication, d.chronic_condition, d.recent_illness, d.recent_tattoo_piercing,
      d.consent_given,
      (d.on_medication || d.chronic_condition || d.recent_illness || d.recent_tattoo_piercing) ? 'needs_review' : 'eligible'
    ]
  );
}

async function saveRequestAndMatch(phone, d) {
  const result = await pool.query(
    `INSERT INTO requests (requester_phone, blood_type_needed, location, urgency) VALUES ($1,$2,$3,$4) RETURNING id`,
    [phone, d.blood_type_needed, d.location, d.urgency]
  );
  const requestId = result.rows[0].id;

  const matches = await pool.query(
    `SELECT id FROM donors WHERE blood_type = $1 AND city ILIKE $2 AND eligibility_status = 'eligible'`,
    [d.blood_type_needed, `%${d.location}%`]
  );

  for (const donor of matches.rows) {
    await pool.query(
      `INSERT INTO matches (request_id, donor_id) VALUES ($1, $2)`,
      [requestId, donor.id]
    );
  }

  return matches.rows.length;
}

async function sendMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

app.get('/', (req, res) => res.send('LifeDrop bot is running.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

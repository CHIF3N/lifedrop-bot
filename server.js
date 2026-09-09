const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const DONOR_FLOW_ID = '2716596505409098'; // your Donor Registration Flow ID
const COMMUNITY_LINK = 'https://chat.whatsapp.com/EPIAr0zFQxVEYXru4PmRwF?s=cl&p=a&mlu=4&ilr=4';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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

      // Handle a completed WhatsApp Flow submission
      if (message.type === 'interactive' && message.interactive?.type === 'nfm_reply') {
        const flowResponse = JSON.parse(message.interactive.nfm_reply.response_json);
        await handleFlowSubmission(from, flowResponse);
      } else {
        const text = message.text?.body?.trim() || '';
        await handleMessage(from, text);
      }
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
        sessions[from] = { step: 'start', data: {} }; // reset, Flow handles the rest
        return sendDonorFlow(from);
      } else if (text === '2') {
        session.step = 'request_blood_type';
        return sendMessage(from, "What blood type is needed? (e.g. A+, O-, B+)");
      } else {
        return sendMessage(from, "Please reply with 1 (donor) or 2 (request blood).");
      }

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

async function handleFlowSubmission(from, flowData) {
  await saveDonor(from, flowData);
  await sendMessage(from, "Thank you! You're registered as a LifeDrop donor. We'll reach out when there's a matching request nearby. 🩸");
  await sendCommunityLinkIfNeeded(from);
}

async function saveDonor(phone, d) {
  const onMed = d.on_medication === 'yes';
  const chronic = d.chronic_condition === 'yes';
  const illness = d.recent_illness === 'yes';
  const tattoo = d.recent_tattoo_piercing === 'yes';
  const consent = d.consent && d.consent.includes('agree');
  const email = d.email && d.email.trim() !== '' ? d.email.trim() : null;

  await pool.query(
    `INSERT INTO donors (name, phone, country, blood_type, city, age, weight_kg, email, on_medication, chronic_condition, recent_illness, recent_tattoo_piercing, consent_given, eligibility_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (phone) DO UPDATE SET
       name=$1, country=$3, blood_type=$4, city=$5, age=$6, weight_kg=$7, email=$8, on_medication=$9, chronic_condition=$10, recent_illness=$11, recent_tattoo_piercing=$12, consent_given=$13, eligibility_status=$14`,
    [
      d.name, phone, d.country, d.blood_type, d.city, d.age, d.weight_kg, email,
      onMed, chronic, illness, tattoo, consent,
      (onMed || chronic || illness || tattoo) ? 'needs_review' : 'eligible'
    ]
  );
}

async function sendCommunityLinkIfNeeded(phone) {
  const result = await pool.query(`SELECT community_link_sent FROM donors WHERE phone = $1`, [phone]);
  const alreadySent = result.rows[0]?.community_link_sent;
  if (alreadySent) return;

  await sendMessage(
    phone,
    `Want to connect with other donors, ask questions, and get updates from real people on our team? Join the LifeDrop community here: ${COMMUNITY_LINK}`
  );
  await pool.query(`UPDATE donors SET community_link_sent = TRUE WHERE phone = $1`, [phone]);
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
    await pool.query(`INSERT INTO matches (request_id, donor_id) VALUES ($1, $2)`, [requestId, donor.id]);
  }

  return matches.rows.length;
}

async function sendDonorFlow(to) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'flow',
        header: { type: 'text', text: 'LifeDrop Donor Registration' },
        body: { text: "Let's get you registered as a blood donor. Tap below to start." },
        footer: { text: 'Takes about 2 minutes' },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_token: `token_${to}_${Date.now()}`,
            flow_id: DONOR_FLOW_ID,
            flow_cta: 'Start Registration',
            flow_action: 'navigate',
            flow_action_payload: { screen: 'PERSONAL_INFO' }
          }
        }
      }
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
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

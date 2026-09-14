const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const CS_PHONE_NUMBER = process.env.CS_PHONE_NUMBER;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// NOTE: Replace with the new published Flow ID from WABA 1095708656227443
const DONOR_FLOW_ID = '1747598403124876';
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
      await pool.query(`UPDATE donors SET last_inbound_at = NOW() WHERE phone = $1`, [from]);

      if (message.type === 'interactive' && message.interactive?.type === 'nfm_reply') {
        const flowResponse = JSON.parse(message.interactive.nfm_reply.response_json);
        await handleFlowSubmission(from, flowResponse);
      } else if (message.type === 'interactive' && message.interactive?.type === 'button_reply') {
        const buttonId = message.interactive.button_reply.id;
        if (buttonId.startsWith('match_')) {
          await handleDonorResponse(from, buttonId);
        } else if (buttonId.startsWith('req_followup_')) {
          await handleRequesterFollowUp(from, buttonId);
        } else {
          await handleMessage(from, buttonId);
        }
      } else if (message.type === 'button' && message.button?.payload) {
        const payload = message.button.payload;
        if (payload.startsWith('match_')) {
          await handleDonorResponse(from, payload);
        } else if (payload.startsWith('req_followup_')) {
          await handleRequesterFollowUp(from, payload);
        }
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

async function notifyCustomerService(text) {
  if (!CS_PHONE_NUMBER) {
    console.log('[CS Notification]:', text);
    return;
  }
  await sendMessage(CS_PHONE_NUMBER, text);
}

async function askGeminiGuidance(userText) {
  if (!GEMINI_API_KEY) return null;
  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: userText }] }],
        systemInstruction: {
          parts: [{
            text: "You are the AI assistant for LifeDrop, a WhatsApp-based blood donor network in Cameroon. The user asked an off-topic or conversational question. In 1 or 2 concise, polite sentences, answer or acknowledge their question, clarify that LifeDrop is a voluntary, non-profit donor matching service (we do not pay donors), and guide them to reply '1' to register as a donor or '2' to request blood. Keep response under 50 words."
          }]
        }
      },
      { timeout: 8000 }
    );
    return res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch (err) {
    console.error('Gemini API error:', err.response?.data || err.message);
    return null;
  }
}

async function handleMessage(from, text) {
  if (!sessions[from]) {
    sessions[from] = { step: 'start', data: {}, aiAttempts: 0 };
  }
  const session = sessions[from];

  if (text.toLowerCase() === 'restart') {
    sessions[from] = { step: 'start', data: {}, aiAttempts: 0 };
    return sendMessage(from, "Restarted. Welcome to LifeDrop! Reply:\n1 - Register as a blood donor\n2 - Request blood");
  }

  // Handle post-signup review / feedback
  if (session.step === 'awaiting_feedback') {
    if (text.toLowerCase() !== 'skip') {
      await notifyCustomerService(
        `⭐ *Donor Review Received!*\n\n👤 *From:* ${session.data.donorName || 'Donor'} (${from})\n💬 *Review:* "${text}"`
      );
      await sendMessage(from, "Thank you for your feedback! It helps us improve our service and save lives. 🙏");
    } else {
      await sendMessage(from, "No problem! You're all set.");
    }
    sessions[from] = { step: 'start', data: {}, aiAttempts: 0 };
    return;
  }

  switch (session.step) {
    case 'start': {
      session.step = 'menu';
      const existing = await pool.query('SELECT name FROM donors WHERE phone = $1', [from]);
      if (existing.rows.length > 0) {
        return sendMessage(from, `Welcome back, ${existing.rows[0].name}! 🩸\nReply:\n1 - Update my donor info\n2 - Request blood`);
      }
      return sendMessage(from, "Welcome to LifeDrop 🩸\nReply:\n1 - Register as a blood donor\n2 - Request blood");
    }

    case 'menu':
      if (text === '1') {
        sessions[from] = { step: 'start', data: {}, aiAttempts: 0 };
        return sendDonorFlow(from);
      } else if (text === '2') {
        session.step = 'request_blood_type';
        return sendMessage(from, "What blood type is needed? (e.g. A+, O-, B+, AB+)");
      } else {
        // AI Fallback for off-context questions (limit to 3 times)
        session.aiAttempts = (session.aiAttempts || 0) + 1;
        if (session.aiAttempts <= 3) {
          const aiResponse = await askGeminiGuidance(text);
          if (aiResponse) return sendMessage(from, aiResponse);
        }
        return sendMessage(from, "Please reply with *1* to register as a donor or *2* to request blood.");
      }

    case 'request_blood_type':
      session.data.blood_type_needed = text.toUpperCase();
      session.step = 'request_location';
      return sendMessage(from, "What city/location is the patient in?");

    case 'request_location':
      session.data.location = text;
      session.step = 'request_hospital';
      return sendMessage(from, "Which hospital or clinic? (name it, or reply 'skip')");

    case 'request_hospital':
      session.data.hospital_name = text.toLowerCase() === 'skip' ? null : text;
      session.step = 'request_units';
      return sendMessage(from, "How many units/pints are needed? (reply with a number, or 'skip' for 1)");

    case 'request_units': {
      const parsed = parseInt(text, 10);
      session.data.units_needed = isNaN(parsed) ? null : parsed;
      session.step = 'request_urgency';
      return sendButtons(from, "How urgent is this?", [
        { id: 'urgency_routine', title: 'Routine' },
        { id: 'urgency_urgent', title: 'Urgent' },
        { id: 'urgency_emergency', title: 'Emergency' }
      ]);
    }

    case 'request_urgency': {
      const urgencyMap = { urgency_routine: 'Routine', urgency_urgent: 'Urgent', urgency_emergency: 'Emergency' };
      session.data.urgency = urgencyMap[text] || text;
      session.step = 'request_consent';
      return sendButtons(
        from,
        "Before we proceed: do you agree to arrange any transport, feeding, or other support directly with the donor? LifeDrop does not pay donors and does not manage or guarantee any compensation — that's strictly between you and the donor.",
        [
          { id: 'consent_agree', title: 'I agree' },
          { id: 'consent_decline', title: 'Cancel' }
        ]
      );
    }

    case 'request_consent': {
      if (text === 'consent_decline') {
        sessions[from] = { step: 'start', data: {}, aiAttempts: 0 };
        return sendMessage(from, "No worries — request cancelled. Message us anytime you're ready.");
      }
      const matchCount = await saveRequestAndMatch(from, session.data);
      sessions[from] = { step: 'start', data: {}, aiAttempts: 0 };
      if (matchCount === 0) {
        return sendMessage(from, `Request logged. We currently do not have matching donors available in ${session.data.location}. Our customer support team has been notified to assist manually.`);
      }
      return sendMessage(from, `Request logged. Reaching out to ${matchCount} potential donor(s) in ${session.data.location} now. We'll message you as soon as someone confirms.`);
    }

    default:
      sessions[from] = { step: 'start', data: {}, aiAttempts: 0 };
      return sendMessage(from, "Let's start over. Welcome to LifeDrop 🩸\nReply:\n1 - Register as a blood donor\n2 - Request blood");
  }
}

async function handleFlowSubmission(from, flowData) {
  await saveDonor(from, flowData);
  
  // Get donor count for CS tracking
  const countResult = await pool.query(`SELECT COUNT(*) FROM donors`);
  const totalDonors = countResult.rows[0].count;

  const bloodTypeDisplay = flowData.blood_type === 'UNKNOWN' ? "Unknown / Not sure (Needs blood typing)" : flowData.blood_type;

  // Send CS notification
  await notifyCustomerService(
    `🆕 *New Donor Registered!*\n\n👤 *Name:* ${flowData.name}\n📞 *Phone:* ${from}\n🩸 *Blood Group:* ${bloodTypeDisplay}\n📍 *City:* ${flowData.city}\n📊 *Total Donors in System:* ${totalDonors}`
  );

  await sendMessage(from, "Thank you! You're registered as a LifeDrop donor. We'll reach out when there's a matching request nearby. Reminder: LifeDrop doesn't pay donors — any support is arranged directly with the requester. 🩸");
  await sendCommunityLinkIfNeeded(from);

  // Set session to collect user review
  sessions[from] = { step: 'awaiting_feedback', data: { donorName: flowData.name }, aiAttempts: 0 };
  await sendMessage(from, "⭐ *Quick Feedback:* How was your registration experience? Reply with a rating (1-5) or a quick comment, or reply 'skip'.");
}

async function saveDonor(phone, d) {
  const onMed = d.on_medication === 'yes';
  const chronic = d.chronic_condition === 'yes';
  const illness = d.recent_illness === 'yes';
  const tattoo = d.recent_tattoo_piercing === 'yes';
  const consent = d.consent && d.consent.includes('agree');
  const noPaymentAck = d.no_payment_ack && d.no_payment_ack.includes('agree');
  const email = d.email && d.email.trim() !== '' ? d.email.trim() : null;

  const parsedAge = parseInt(d.age, 10) || null;
  const parsedWeight = parseInt(d.weight_kg, 10) || null;

  await pool.query(
    `INSERT INTO donors (name, phone, country, blood_type, city, age, weight_kg, email, on_medication, chronic_condition, recent_illness, recent_tattoo_piercing, consent_given, no_payment_ack, eligibility_status, last_inbound_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
     ON CONFLICT (phone) DO UPDATE SET
       name=$1, country=$3, blood_type=$4, city=$5, age=$6, weight_kg=$7, email=$8, on_medication=$9, chronic_condition=$10, recent_illness=$11, recent_tattoo_piercing=$12, consent_given=$13, no_payment_ack=$14, eligibility_status=$15`,
    [
      d.name, phone, d.country, d.blood_type, d.city, parsedAge, parsedWeight, email,
      onMed, chronic, illness, tattoo, consent, noPaymentAck,
      (onMed || chronic || illness || tattoo) ? 'needs_review' : 'eligible'
    ]
  );
}

async function sendCommunityLinkIfNeeded(phone) {
  const result = await pool.query(`SELECT community_link_sent FROM donors WHERE phone = $1`, [phone]);
  if (result.rows[0]?.community_link_sent) return;
  await sendMessage(phone, `Want to connect with other donors, ask questions, and get updates from real people on our team? Join the LifeDrop community here: ${COMMUNITY_LINK}`);
  await pool.query(`UPDATE donors SET community_link_sent = TRUE WHERE phone = $1`, [phone]);
}

async function saveRequestAndMatch(phone, d) {
  const result = await pool.query(
    `INSERT INTO requests (requester_phone, blood_type_needed, location, hospital_name, units_needed, urgency) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [phone, d.blood_type_needed, d.location, d.hospital_name, d.units_needed, d.urgency]
  );
  const requestId = result.rows[0].id;
  const neededUnits = d.units_needed || 1;
  const notifyCount = neededUnits + 1;

  const matchedDonors = await pool.query(
    `SELECT id, name, phone, last_inbound_at FROM donors WHERE blood_type = $1 AND city ILIKE $2 AND eligibility_status = 'eligible' LIMIT $3`,
    [d.blood_type_needed, `%${d.location}%`, notifyCount]
  );

  if (matchedDonors.rows.length === 0) {
    await notifyCustomerService(
      `⚠️ *NO DONOR MATCH FOUND!*\n\n🩸 *Blood Needed:* ${d.blood_type_needed} (${neededUnits} unit(s))\n📍 *Location:* ${d.location}\n🏥 *Hospital:* ${d.hospital_name || 'Not specified'}\n⚡ *Urgency:* ${d.urgency}\n📞 *Requester Phone:* ${phone}\n\n*Action Required:* Check alternate locations or manual outreach.`
    );
  } else {
    await notifyCustomerService(
      `🩸 *New Blood Request Logged*\n\n🩸 *Blood Needed:* ${d.blood_type_needed} (${neededUnits} unit(s))\n📍 *Location:* ${d.location}\n🏥 *Hospital:* ${d.hospital_name || 'N/A'}\n⚡ *Urgency:* ${d.urgency}\n👥 *Donors Contacted:* ${matchedDonors.rows.length}\n📞 *Requester Phone:* ${phone}`
    );

    for (const donor of matchedDonors.rows) {
      const matchResult = await pool.query(
        `INSERT INTO matches (request_id, donor_id, contacted_at) VALUES ($1, $2, NOW()) RETURNING id`,
        [requestId, donor.id]
      );
      await notifyDonor(donor.name, donor.phone, donor.last_inbound_at, matchResult.rows[0].id, d);
    }
  }

  // 10-Minute Follow-Up Check with the Requester
  scheduleRequesterFollowUp(phone, requestId, d);

  return matchedDonors.rows.length;
}

function scheduleRequesterFollowUp(phone, requestId, requestData) {
  setTimeout(async () => {
    try {
      const check = await pool.query(`SELECT status FROM requests WHERE id = $1`, [requestId]);
      if (check.rows.length === 0 || check.rows[0].status === 'fulfilled') return;

      await sendButtons(
        phone,
        "Hi, this is LifeDrop checking in. It has been 10 minutes since your request was logged. Have you connected with a donor?",
        [
          { id: `req_followup_yes_${requestId}`, title: 'Yes, connected' },
          { id: `req_followup_no_${requestId}`, title: 'Still searching' }
        ]
      );
    } catch (err) {
      console.error('Follow-up error:', err.message);
    }
  }, 10 * 60 * 1000); // 10 minutes
}

async function handleRequesterFollowUp(from, buttonId) {
  const isYes = buttonId.startsWith('req_followup_yes_');
  const reqId = buttonId.replace('req_followup_yes_', '').replace('req_followup_no_', '');

  if (isYes) {
    await sendMessage(from, "Glad to hear that! We hope the donation process goes smoothly. Please reach out if you need anything else.");
    await notifyCustomerService(
      `✅ *Requester Update (10-min check)*\n\n📞 *Requester:* ${from}\n🆔 *Request ID:* ${reqId}\n*Status:* Confirmed they have connected with a donor.`
    );
  } else {
    await sendMessage(from, "Understood. Our customer service team has been notified and we will continue monitoring for available donors.");
    await notifyCustomerService(
      `🚨 *URGENT: Requester Needs Help (10-min check)*\n\n📞 *Requester:* ${from}\n🆔 *Request ID:* ${reqId}\n*Status:* Has NOT connected with a donor yet. Manual follow-up required!`
    );
  }
}

async function notifyDonor(donorName, donorPhone, lastInboundAt, matchId, requestData) {
  const withinWindow = lastInboundAt && (Date.now() - new Date(lastInboundAt).getTime()) < 24 * 60 * 60 * 1000;
  if (withinWindow) {
    const hospitalLine = requestData.hospital_name ? ` at ${requestData.hospital_name}` : '';
    const unitsLine = requestData.units_needed ? ` (${requestData.units_needed} unit(s) needed total)` : '';
    const body = `Hello ${donorName}! 🩸 Blood needed: ${requestData.blood_type_needed} in ${requestData.location}${hospitalLine}.\nUrgency: ${requestData.urgency}${unitsLine}\n\nReminder: LifeDrop doesn't pay donors — any support is arranged directly with the requester.\n\nCan you donate?`;
    await sendButtons(donorPhone, body, [
      { id: `match_yes_${matchId}`, title: 'Yes, I can' },
      { id: `match_no_${matchId}`, title: 'Not available' }
    ]);
  } else {
    await sendDonorMatchTemplate(donorName, donorPhone, matchId, requestData);
  }
}

async function sendDonorMatchTemplate(donorName, donorPhone, matchId, requestData) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: donorPhone,
      type: 'template',
      template: {
        name: 'donor_match_alert',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: donorName },
              { type: 'text', text: requestData.blood_type_needed },
              { type: 'text', text: requestData.location },
              { type: 'text', text: requestData.urgency }
            ]
          },
          {
            type: 'button', sub_type: 'quick_reply', index: '0',
            parameters: [{ type: 'payload', payload: `match_yes_${matchId}` }]
          },
          {
            type: 'button', sub_type: 'quick_reply', index: '1',
            parameters: [{ type: 'payload', payload: `match_no_${matchId}` }]
          }
        ]
      }
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

async function handleDonorResponse(from, buttonId) {
  const isYes = buttonId.startsWith('match_yes_');
  const matchId = buttonId.replace('match_yes_', '').replace('match_no_', '');

  const matchRow = await pool.query(
    `SELECT m.request_id, m.response, r.units_needed, r.requester_phone, r.blood_type_needed, r.location, r.hospital_name     FROM matches m JOIN requests r ON r.id = m.request_id WHERE m.id = $1`,
    [matchId]
  );
  if (matchRow.rows.length === 0) return;
  const { request_id, response: existingResponse, units_needed, requester_phone, blood_type_needed, location, hospital_name } = matchRow.rows[0];

  if (existingResponse) return;

  if (!isYes) {
    await pool.query(`UPDATE matches SET response = 'no' WHERE id = $1`, [matchId]);
    return sendMessage(from, "No problem, thanks for letting us know. We'll reach out next time there's a match.");
  }

  const neededUnits = units_needed || 1;
  const acceptedCountResult = await pool.query(
    `SELECT COUNT(*) FROM matches WHERE request_id = $1 AND response = 'yes'`,
    [request_id]
  );
  const acceptedSoFar = parseInt(acceptedCountResult.rows[0].count, 10);

  if (acceptedSoFar >= neededUnits) {
    await pool.query(`UPDATE matches SET response = 'not_needed' WHERE id = $1`, [matchId]);
    return sendMessage(from, "Thanks so much for responding! We've already secured enough donors for this request. We'll reach out next time there's a match. 🙏");
  }

  await pool.query(`UPDATE matches SET response = 'yes' WHERE id = $1`, [matchId]);
  const donorInfo = await pool.query(`SELECT name FROM donors WHERE phone = $1`, [from]);
  const donorName = donorInfo.rows[0]?.name || 'A donor';

  await sendMessage(from, "Thank you! We've noted your response. The requester's contact will follow shortly so you can coordinate. Reminder: any transport/feeding support is arranged directly between you two. 🙏");
  await sendMessage(
    requester_phone,
    `Good news! ${donorName} (${from}) has agreed to donate ${blood_type_needed}${hospital_name ? ' at ' + hospital_name : ''} in ${location}. Please reach out to coordinate directly.`
  );

  const newAcceptedCount = acceptedSoFar + 1;
  if (newAcceptedCount >= neededUnits) {
    const pendingMatches = await pool.query(
      `SELECT m.id, d.phone FROM matches m JOIN donors d ON d.id = m.donor_id WHERE m.request_id = $1 AND m.response IS NULL`,
      [request_id]
    );
    for (const pm of pendingMatches.rows) {
      await pool.query(`UPDATE matches SET response = 'not_needed' WHERE id = $1`, [pm.id]);
      await sendMessage(pm.phone, "Thanks so much for being ready to help! We've found enough donors for this request already. We'll reach out next time there's a match. 🙏");
    }
    await pool.query(`UPDATE requests SET status = 'fulfilled' WHERE id = $1`, [request_id]);
  }
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

async function sendButtons(to, bodyText, buttons) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) }
      }
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

app.get('/', (req, res) => res.send('LifeDrop bot is running.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

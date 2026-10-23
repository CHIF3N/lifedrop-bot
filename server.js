const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');
const { daysUntilEligible } = require('./deferral');
const { evaluateScreening } = require('./screening');
const { parseResultsRequest, normalizeBloodGroup, parseResultButton, neutralResultMessage } = require('./results');

const app = express();
app.use(bodyParser.json());

// Environment configuration
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const CS_PHONE_NUMBER = process.env.CS_PHONE_NUMBER;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DONOR_FLOW_ID = process.env.DONOR_FLOW_ID || '1747598403124876';
// Rest period between confirmed whole-blood donations (WHO minimum: 12 weeks men, 16 weeks women)
const DONATION_WAIT_DAYS_MALE = parseInt(process.env.DONATION_WAIT_DAYS_MALE, 10) || 90;
const DONATION_WAIT_DAYS_FEMALE = parseInt(process.env.DONATION_WAIT_DAYS_FEMALE, 10) || 120;
const donationWaitDays = (gender) => (gender === 'male' ? DONATION_WAIT_DAYS_MALE : DONATION_WAIT_DAYS_FEMALE);
const COMMUNITY_LINK ='https://chat.whatsapp.com/EPIAr0zFQxVEYXru4PmRwF?s=cl&p=a&mlu=4&ilr=4';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Auto-verify schema on startup to prevent column-missing runtime crashes
async function initDb() {
  try {
    await pool.query(`
      ALTER TABLE requests ADD COLUMN IF NOT EXISTS hospital_name TEXT;
      ALTER TABLE requests ADD COLUMN IF NOT EXISTS units_needed INTEGER DEFAULT 1;
      ALTER TABLE donors ADD COLUMN IF NOT EXISTS email TEXT;
      ALTER TABLE donors ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMP;
      ALTER TABLE donors ADD COLUMN IF NOT EXISTS community_link_sent BOOLEAN DEFAULT FALSE;
      ALTER TABLE donors ADD COLUMN IF NOT EXISTS last_donation_date DATE;
      ALTER TABLE donors ADD COLUMN IF NOT EXISTS gender TEXT;
      ALTER TABLE donors ADD COLUMN IF NOT EXISTS deferred_until DATE;
      ALTER TABLE donors ADD COLUMN IF NOT EXISTS screening_reasons TEXT;
      ALTER TABLE donors ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP;
      ALTER TABLE donors ADD COLUMN IF NOT EXISTS verified_by_facility_id INTEGER;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS donation_confirmed BOOLEAN;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS confirm_code TEXT;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS confirmed_by_facility_id INTEGER;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS result_blood_group TEXT;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS result_outcome TEXT;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS results_at TIMESTAMP;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS results_facility_id INTEGER;
      CREATE TABLE IF NOT EXISTS facilities (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'hospital',
        city TEXT,
        region TEXT,
        address TEXT,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        staff_phone TEXT,
        is_partner BOOLEAN DEFAULT FALSE,
        does_blood_collection BOOLEAN DEFAULT FALSE,
        does_lab_tests BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS feature_interest (
        phone TEXT NOT NULL,
        feature TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (phone, feature)
      );
    `);
    console.log('✅ Database schema verified.');
  } catch (err) {
    console.warn('⚠️ Database schema verification warning:', err.message);
  }
}
initDb();

const sessions = {};

// Webhook Verification
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

// Webhook Event Receiver
app.post('/webhook', async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message) {
      const from = message.from;

      // Track last user interaction for 24h messaging window
      pool.query(`UPDATE donors SET last_inbound_at = NOW() WHERE phone = $1`, [from]).catch(() => {});

      if (message.type === 'interactive' && message.interactive?.type === 'nfm_reply') {
        const flowResponse = JSON.parse(message.interactive.nfm_reply.response_json);
        await handleFlowSubmission(from, flowResponse);
      } else if (message.type === 'interactive' && message.interactive?.type === 'button_reply') {
        const buttonId = message.interactive.button_reply.id;
        if (buttonId.startsWith('match_')) {
          await handleDonorResponse(from, buttonId);
        } else if (buttonId.startsWith('req_followup_')) {
          await handleRequesterFollowUp(from, buttonId);
        } else if (buttonId.startsWith('donated_')) {
          await handleDonationConfirmation(from, buttonId);
        } else if (buttonId.startsWith('fac_')) {
          await handleFacilityConfirmation(from, buttonId);
        } else if (buttonId.startsWith('res_')) {
          await handleResultButton(from, buttonId);
        } else {
          await handleMessage(from, buttonId);
        }
      } else if (message.type === 'button' && message.button?.payload) {
        const payload = message.button.payload;
        if (payload.startsWith('match_')) {
          await handleDonorResponse(from, payload);
        } else if (payload.startsWith('req_followup_')) {
          await handleRequesterFollowUp(from, payload);
        } else if (payload.startsWith('donated_')) {
          await handleDonationConfirmation(from, payload);
        } else if (payload.startsWith('res_')) {
          await handleResultButton(from, payload);
        } else {
          await handleMessage(from, payload);
        }
      } else {
        const text = message.text?.body?.trim() || '';
        const resultsCode = parseResultsRequest(text);
        if (resultsCode) {
          await handleResultsRequest(from, resultsCode);
        } else if (/^LD-?\s?\d{5}$/i.test(text)) {
          await handleFacilityCode(from, text);
        } else {
          await handleMessage(from, text);
        }
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.response?.data ? JSON.stringify(err.response.data) : err.message);
  }
  res.sendStatus(200);
});

// Safe Customer Service Notifications (Never crashes requester flows)
async function notifyCustomerService(text) {
  if (!CS_PHONE_NUMBER) {
    console.log('[CS Log (No Phone Configured)]:\n', text);
    return;
  }
  const cleanNumber = CS_PHONE_NUMBER.replace(/\D/g, '');
  try {
    await sendMessage(cleanNumber, text);
  } catch (err) {
    console.warn('⚠️ Could not deliver CS message (check 24h window or phone ID):', err.response?.data?.error?.message || err.message);
    console.log('📌 CS Alert Fallback Output:\n', text);
  }
}

// AI Smart Redirection for Off-Context Questions
async function askGeminiGuidance(userText) {
  if (!GEMINI_API_KEY) return null;
  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: userText }] }],
        systemInstruction: {
          parts: [{
            text: "You are the automated WhatsApp assistant for LifeDrop, a voluntary blood donor network in Cameroon. The user sent an off-topic question. In 1 or 2 polite sentences, answer or acknowledge their question, clarify that LifeDrop is a voluntary service connecting donors and patients (we do not sell blood or pay donors), and guide them to reply '1' to register as a donor or '2' to request blood. Keep response strictly under 45 words."
          }]
        }
      },
      { timeout: 7000 }
    );
    return res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch (err) {
    console.warn('Gemini API error:', err.response?.data?.error?.message || err.message);
    return null;
  }
}

// Main Conversation Router
async function handleMessage(from, text) {
  if (!sessions[from]) {
    sessions[from] = { step: 'start', data: {}, aiAttempts: 0 };
  }
  const session = sessions[from];

  if (text.toLowerCase() === 'restart') {
    sessions[from] = { step: 'start', data: {}, aiAttempts: 0 };
    return sendMessage(from, "Restarted. Welcome to LifeDrop! 🩸\n\nReply:\n1 - Register as a blood donor\n2 - Request blood\n3 - Home lab test (coming soon)");
  }

  // Blood bank staff typing the blood group for a results entry
  if (session.step === 'results_blood_group') {
    return handleResultsBloodGroup(from, text);
  }

  // Home lab test waitlist (feature coming soon)
  if (text === 'homelab_notify' || text === 'homelab_no') {
    sessions[from] = { step: 'start', data: {}, aiAttempts: 0 };
    if (text === 'homelab_no') {
      return sendMessage(from, "No problem! Reply anytime if you need blood or want to register as a donor. 🩸");
    }
    await pool.query(
      `INSERT INTO feature_interest (phone, feature) VALUES ($1, 'home_lab_test') ON CONFLICT DO NOTHING`,
      [from]
    );
    await notifyCustomerService(`🧪 *Home Lab Test Interest*\n\n📞 *Phone:* ${from}`);
    return sendMessage(from, "Great! You're on the list. We'll message you as soon as home lab tests are available. 🧪");
  }

  // Handle post-signup review
  if (session.step === 'awaiting_feedback') {
    if (text.toLowerCase() !== 'skip') {
      await notifyCustomerService(
        `⭐ *Donor Review Received!*\n\n👤 *From:* ${session.data.donorName || 'Donor'} (${from})\n💬 *Review:* "${text}"`
      );
      await sendMessage(from, "Thank you for your feedback! It helps us improve our service and save lives. 🙏");
    } else {
      await sendMessage(from, "You're all set! We will notify you when a patient nearby needs your blood type.");
    }
    sessions[from] = { step: 'start', data: {}, aiAttempts: 0 };
    return;
  }

  switch (session.step) {
    case 'start': {
      session.step = 'menu';
      const existing = await pool.query('SELECT name, last_donation_date, gender, deferred_until, eligibility_status FROM donors WHERE phone = $1', [from]);
      if (existing.rows.length > 0) {
        const donor = existing.rows[0];
        const restDays = daysUntilEligible(donor.last_donation_date, donationWaitDays(donor.gender));
        const daysLeft = Math.max(restDays, daysUntilEligible(donor.deferred_until, 0));
        let restLine = '';
        if (donor.eligibility_status === 'needs_update') {
          restLine = "\n\nYour donor profile is paused. When you are no longer pregnant or breastfeeding, reply 1 to update your info.";
        } else if (donor.eligibility_status === 'eligible' && daysLeft > 0) {
          restLine = restDays > 0
            ? `\n\nThank you for your last donation! ❤️ You're on a rest break. You can donate again in ${daysLeft} day(s). We won't send you requests until then.`
            : `\n\nYou can start donating in ${daysLeft} day(s). We won't send you requests until then.`;
        }
        return sendMessage(from, `Welcome back, ${donor.name}! 🩸${restLine}\n\nReply:\n1 - Update my donor info\n2 - Request blood\n3 - Home lab test (coming soon)`);
      }
      return sendMessage(from, "Welcome to LifeDrop 🩸\n\nReply:\n1 - Register as a blood donor\n2 - Request blood\n3 - Home lab test (coming soon)");
    }

    case 'menu':
      if (text === '1') {
        sessions[from] = { step: 'start', data: {}, aiAttempts: 0 };
        return sendDonorFlow(from);
      } else if (text === '2') {
        session.step = 'request_blood_type';
        return sendMessage(from, "What blood type is needed? (e.g. A+, O-, B+, AB+)");
      } else if (text === '3') {
        return sendButtons(
          from,
          "🧪 *Home Lab Tests: coming soon!*\nA trained lab technician will come to your home to collect samples for tests like blood group, blood count and more.\n\nWant us to tell you when it launches?",
          [
            { id: 'homelab_notify', title: 'Yes, notify me' },
            { id: 'homelab_no', title: 'No thanks' }
          ]
        );
      } else {
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
      return sendMessage(from, "What city or town is the patient in?");

    case 'request_location':
      session.data.location = text;
      session.step = 'request_hospital';
      return sendMessage(from, "Which hospital or clinic? (enter hospital name, or reply 'skip')");

    case 'request_hospital':
      session.data.hospital_name = text.toLowerCase() === 'skip' ? null : text;
      session.step = 'request_units';
      return sendMessage(from, "How many units/pints are needed? (reply with a number, or 'skip' for 1)");

    case 'request_units': {
      const parsed = parseInt(text, 10);
      session.data.units_needed = isNaN(parsed) || parsed < 1 ? 1 : parsed;
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
        "Before we proceed: do you agree to arrange any transport, feeding, or other support directly with the donor? LifeDrop does not pay donors and does not manage compensation.",
        [
          { id: 'consent_agree', title: 'I agree' },
          { id: 'consent_decline', title: 'Cancel' }
        ]
      );
    }

    case 'request_consent': {
      if (text === 'consent_decline') {
        sessions[from] = { step: 'start', data: {}, aiAttempts: 0 };
        return sendMessage(from, "Request cancelled. Message us anytime you need assistance.");
      }

      if (text !== 'consent_agree') {
        return sendButtons(
          from,
          "Please select an option below to proceed:",
          [
            { id: 'consent_agree', title: 'I agree' },
            { id: 'consent_decline', title: 'Cancel' }
          ]
        );
      }

      const requestPayload = { ...session.data };
      sessions[from] = { step: 'start', data: {}, aiAttempts: 0 }; // Clear session state immediately

      try {
        const matchCount = await saveRequestAndMatch(from, requestPayload);
        if (matchCount === 0) {
          return sendMessage(from, `Request logged. We currently do not have eligible donors matching ${requestPayload.blood_type_needed} in ${requestPayload.location}. Our support team has been notified to assist manually.`);
        }
        return sendMessage(from, `Request logged. Reaching out to ${matchCount} eligible donor(s) in ${requestPayload.location} now. We will notify you the moment someone confirms.`);
      } catch (err) {
        console.error('Failed processing blood request:', err);
        return sendMessage(from, "Your request was logged, but we experienced an issue reaching out to donors automatically. Our customer support team has been notified.");
      }
    }

    default:
      sessions[from] = { step: 'start', data: {}, aiAttempts: 0 };
      return sendMessage(from, "Let's start over. Welcome to LifeDrop 🩸\n\nReply:\n1 - Register as a blood donor\n2 - Request blood\n3 - Home lab test (coming soon)");
  }
}

// Flow Submission Handler
async function handleFlowSubmission(from, flowData) {
  try {
    const screening = await saveDonor(from, flowData);

    const countResult = await pool.query(`SELECT COUNT(*) FROM donors`);
    const totalDonors = countResult.rows[0].count;

    const bloodTypeLabel = flowData.blood_type === 'UNKNOWN' ? "Unknown (Needs Typing)" : flowData.blood_type;

    await notifyCustomerService(
      `🆕 *New Donor Registered!*\n\n👤 *Name:* ${flowData.name}\n📞 *Phone:* ${from}\n🩸 *Blood Group:* ${bloodTypeLabel}\n📍 *City:* ${flowData.city}\n🩺 *Screening:* ${screening.status}${screening.deferredUntil ? ' (wait until ' + screening.deferredUntil + ')' : ''}\n📊 *Total Donors:* ${totalDonors}`
    );

    await sendMessage(from, screeningReply(screening));
    await sendCommunityLinkIfNeeded(from);

    sessions[from] = { step: 'awaiting_feedback', data: { donorName: flowData.name }, aiAttempts: 0 };
    await sendMessage(from, "⭐ *Quick Feedback:* How was your registration experience? Reply with a rating (1-5) or a quick comment, or reply 'skip'.");
  } catch (err) {
    console.error('Error handling flow submission:', err);
    await sendMessage(from, "Thank you for submitting! Your details have been received.");
  }
}

// Database Upsert for Donors
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
  const gender = d.gender === 'male' || d.gender === 'female' ? d.gender : null;

  const screening = evaluateScreening(d);

  await pool.query(
    `INSERT INTO donors (name, phone, country, blood_type, city, age, weight_kg, email, on_medication, chronic_condition, recent_illness, recent_tattoo_piercing, consent_given, no_payment_ack, eligibility_status, gender, deferred_until, screening_reasons, last_inbound_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
     ON CONFLICT (phone) DO UPDATE SET
       name=$1, country=$3, blood_type=$4, city=$5, age=$6, weight_kg=$7, email=$8, on_medication=$9, chronic_condition=$10, recent_illness=$11, recent_tattoo_piercing=$12, consent_given=$13, no_payment_ack=$14, eligibility_status=CASE WHEN donors.eligibility_status = 'on_hold' THEN 'on_hold' ELSE $15 END, gender=COALESCE($16, donors.gender), deferred_until=$17, screening_reasons=$18, last_inbound_at=NOW()`,
    [
      d.name, phone, d.country, d.blood_type, d.city, parsedAge, parsedWeight, email,
      onMed, chronic, illness, tattoo, consent, noPaymentAck,
      screening.status, gender, screening.deferredUntil, screening.reasons.join(',')
    ]
  );
  return screening;
}

// Registration reply based on the screening result (no medical reasons are given in chat)
function screeningReply(screening) {
  switch (screening.status) {
    case 'not_eligible':
      return "Thank you for wanting to help. 🙏 Based on your answers, blood donation is not safe for you or for patients right now, so we will not send you donation requests. You can still help by sharing LifeDrop with friends and family. If you think an answer was wrong, reply 1 to update your info.";
    case 'needs_update':
      return "Thank you for registering! 🩸 While you are pregnant or breastfeeding, we will not send you donation requests. When that changes, reply 1 to update your info and you can start donating.";
    case 'needs_review':
      return "Thank you! You are registered as a LifeDrop donor. 🩸 Our team will review a few of your answers before we send you requests. Reminder: LifeDrop does not pay donors.";
    default:
      if (screening.deferredUntil) {
        return `Thank you! You are registered as a LifeDrop donor. 🩸 Based on your answers, you need to wait before donating. We'll start sending you requests from ${screening.deferredUntil}. Reminder: LifeDrop does not pay donors.`;
      }
      return "Thank you! You are officially registered as a LifeDrop donor. We'll reach out when a matching patient nearby needs blood. Reminder: LifeDrop does not pay donors. 🩸";
  }
}

// Community Invite Helper
async function sendCommunityLinkIfNeeded(phone) {
  try {
    const result = await pool.query(`SELECT community_link_sent FROM donors WHERE phone = $1`, [phone]);
    if (result.rows[0]?.community_link_sent) return;

    await sendMessage(phone, `Want to connect with other donors, ask questions, and get updates from our team? Join our WhatsApp community here: ${COMMUNITY_LINK}`);
    await pool.query(`UPDATE donors SET community_link_sent = TRUE WHERE phone = $1`, [phone]);
  } catch (err) {
    console.warn('Could not check or send community link:', err.message);
  }
}

// Request Matching Engine
async function saveRequestAndMatch(phone, d) {
  const result = await pool.query(
    `INSERT INTO requests (requester_phone, blood_type_needed, location, hospital_name, units_needed, urgency) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [phone, d.blood_type_needed, d.location, d.hospital_name, d.units_needed, d.urgency]
  );
  const requestId = result.rows[0].id;
  const neededUnits = d.units_needed || 1;
  const notifyCount = neededUnits + 1;

  const matchedDonors = await pool.query(
    `SELECT id, name, phone, last_inbound_at FROM donors
     WHERE blood_type = $1 AND city ILIKE $2 AND eligibility_status = 'eligible'
       AND (deferred_until IS NULL OR deferred_until <= CURRENT_DATE)
       AND (last_donation_date IS NULL OR last_donation_date <= CURRENT_DATE - (CASE WHEN gender = 'male' THEN $4 ELSE $5 END)::int)
     LIMIT $3`,
    [d.blood_type_needed, `%${d.location}%`, notifyCount, DONATION_WAIT_DAYS_MALE, DONATION_WAIT_DAYS_FEMALE]
  );

  if (matchedDonors.rows.length === 0) {
    await notifyCustomerService(
      `⚠️ *NO DONOR MATCH FOUND!*\n\n🩸 *Blood Needed:* ${d.blood_type_needed} (${neededUnits} unit(s))\n📍 *Location:* ${d.location}\n🏥 *Hospital:* ${d.hospital_name || 'Not specified'}\n⚡ *Urgency:* ${d.urgency}\n📞 *Requester Phone:* ${phone}\n\n*Action Required:* Manual donor outreach needed.`
    );
  } else {
    await notifyCustomerService(
      `🩸 *New Blood Request Logged*\n\n🩸 *Blood Needed:* ${d.blood_type_needed} (${neededUnits} unit(s))\n📍 *Location:* ${d.location}\n🏥 *Hospital:* ${d.hospital_name || 'N/A'}\n⚡ *Urgency:* ${d.urgency}\n👥 *Donors Contacted:* ${matchedDonors.rows.length}\n📞 *Requester Phone:* ${phone}`
    );

    for (const donor of matchedDonors.rows) {
      try {
        const matchResult = await pool.query(
          `INSERT INTO matches (request_id, donor_id, contacted_at) VALUES ($1, $2, NOW()) RETURNING id`,
          [requestId, donor.id]
        );
        await notifyDonor(donor.name, donor.phone, donor.last_inbound_at, matchResult.rows[0].id, d);
      } catch (err) {
        console.error(`Failed to notify donor ${donor.id}:`, err.message);
      }
    }
  }

  scheduleRequesterFollowUp(phone, requestId);
  return matchedDonors.rows.length;
}

// 10-Minute Requester Follow-Up Timer
function scheduleRequesterFollowUp(phone, requestId) {
  setTimeout(async () => {
    try {
      const check = await pool.query(`SELECT status FROM requests WHERE id = $1`, [requestId]);
      if (check.rows.length === 0 || check.rows[0].status === 'fulfilled') return;

      await sendButtons(
        phone,
        "Hi, this is LifeDrop checking in. It has been 10 minutes since your request was logged. Have you connected with a donor yet?",
        [
          { id: `req_followup_yes_${requestId}`, title: 'Yes, connected' },
          { id: `req_followup_no_${requestId}`, title: 'Still searching' }
        ]
      );
    } catch (err) {
      console.warn('Follow-up timer error:', err.message);
    }
  }, 10 * 60 * 1000);
}

// Handler for 10-minute follow-up response
async function handleRequesterFollowUp(from, buttonId) {
  const isYes = buttonId.startsWith('req_followup_yes_');
  const reqId = buttonId.replace('req_followup_yes_', '').replace('req_followup_no_', '');

  if (isYes) {
    await sendMessage(from, "Glad to hear that! We hope the donation process goes smoothly. Reach out anytime if you need more assistance.");
    await notifyCustomerService(
      `✅ *Requester Update (10-min check)*\n\n📞 *Requester:* ${from}\n🆔 *Request ID:* ${reqId}\n*Status:* Confirmed donor connection.`
    );
  } else {
    await sendMessage(from, "Understood. Our team has been notified and will monitor available donors for you.");
    await notifyCustomerService(
      `🚨 *URGENT: Requester Still Searching (10-min check)*\n\n📞 *Requester:* ${from}\n🆔 *Request ID:* ${reqId}\n*Status:* Has NOT connected with a donor yet. Manual support needed!`
    );
  }
}

// Notify donor via 24h interactive buttons or template
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

// Outbound Template Alert for 24h+ Window
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

// Donor Accept/Decline Handler
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

  // Donor already gave blood recently (e.g. tapped an older alert): keep them resting
  const donorRest = await pool.query(`SELECT last_donation_date, gender FROM donors WHERE phone = $1`, [from]);
  const daysLeft = daysUntilEligible(donorRest.rows[0]?.last_donation_date, donationWaitDays(donorRest.rows[0]?.gender));
  if (daysLeft > 0) {
    await pool.query(`UPDATE matches SET response = 'no' WHERE id = $1`, [matchId]);
    return sendMessage(from, `Thank you for wanting to help! 🙏 You donated recently, so your body needs rest. You can donate again in ${daysLeft} day(s). We'll reach out after that.`);
  }

  const neededUnits = units_needed || 1;
  const acceptedCountResult = await pool.query(
    `SELECT COUNT(*) FROM matches WHERE request_id = $1 AND response = 'yes'`,
    [request_id]
  );
  const acceptedSoFar = parseInt(acceptedCountResult.rows[0].count, 10);

  if (acceptedSoFar >= neededUnits) {
    await pool.query(`UPDATE matches SET response = 'not_needed' WHERE id = $1`, [matchId]);
    return sendMessage(from, "Thanks so much for being ready to help! We have already secured enough donors for this request. We will reach out next time there is a match. 🙏");
  }

  const confirmCode = await generateConfirmCode();
  await pool.query(`UPDATE matches SET response = 'yes', confirm_code = $2 WHERE id = $1`, [matchId, confirmCode]);
  const donorInfo = await pool.query(`SELECT name FROM donors WHERE phone = $1`, [from]);
  const donorName = donorInfo.rows[0]?.name || 'A donor';

  await sendMessage(from, `Thank you! We've noted your response. The requester's contact will follow shortly so you can coordinate. Reminder: any transport/feeding support is arranged directly between you two. 🙏\n\n🔑 Your donation code: *${confirmCode}*\nAt the blood bank, show this code and your ID card. The staff will confirm your donation with it.`);
  await sendMessage(
    requester_phone,
    `Good news! ${donorName} (${from}) has agreed to donate ${blood_type_needed}${hospital_name ? ' at ' + hospital_name : ''} in ${location}. Please reach out to coordinate directly.`
  );
  await sendDonationConfirmButtons(from, requester_phone, donorName, matchId);

  const newAcceptedCount = acceptedSoFar + 1;
  if (newAcceptedCount >= neededUnits) {
    const pendingMatches = await pool.query(
      `SELECT m.id, d.phone FROM matches m JOIN donors d ON d.id = m.donor_id WHERE m.request_id = $1 AND m.response IS NULL`,
      [request_id]
    );
    for (const pm of pendingMatches.rows) {
      await pool.query(`UPDATE matches SET response = 'not_needed' WHERE id = $1`, [pm.id]);
      await sendMessage(pm.phone, "Thanks so much for offering to help! We've secured enough donors for this request. We will contact you next time there is a match. 🙏");
    }
    await pool.query(`UPDATE requests SET status = 'fulfilled' WHERE id = $1`, [request_id]);
  }
}

// "Did the donation happen?" buttons, sent right after a donor accepts (both chats are inside the 24h window then).
// The buttons stay in the chat, so either side can tap them later; a tap is an inbound message, so our reply always delivers.
async function sendDonationConfirmButtons(donorPhone, requesterPhone, donorName, matchId) {
  try {
    await sendButtons(donorPhone, "After you have donated, please tap below. This lets us give you a rest period before we ask you again. 🩸", [
      { id: `donated_yes_${matchId}`, title: 'Yes, I donated' },
      { id: `donated_no_${matchId}`, title: "It didn't happen" }
    ]);
  } catch (err) {
    console.warn('Could not send donation confirmation to donor:', err.response?.data?.error?.message || err.message);
  }
  try {
    await sendButtons(requesterPhone, `Once ${donorName} has donated, please tap below to confirm. Did the donation happen?`, [
      { id: `donated_yes_${matchId}`, title: 'Donation done' },
      { id: `donated_no_${matchId}`, title: "It didn't happen" }
    ]);
  } catch (err) {
    console.warn('Could not send donation confirmation to requester:', err.response?.data?.error?.message || err.message);
  }
}

// Donation Confirmation Handler (sets the donor's rest period on "Yes")
async function handleDonationConfirmation(from, buttonId) {
  const isYes = buttonId.startsWith('donated_yes_');
  const matchId = buttonId.replace('donated_yes_', '').replace('donated_no_', '');

  const matchRow = await pool.query(
    `SELECT m.donor_id, m.donation_confirmed, d.name AS donor_name, d.phone AS donor_phone, d.gender, r.requester_phone
     FROM matches m JOIN donors d ON d.id = m.donor_id JOIN requests r ON r.id = m.request_id WHERE m.id = $1`,
    [matchId]
  );
  if (matchRow.rows.length === 0) return;
  const { donor_id, donation_confirmed, donor_name, donor_phone, gender, requester_phone } = matchRow.rows[0];

  if (from !== donor_phone && from !== requester_phone) return;
  if (donation_confirmed === true) {
    return sendMessage(from, "This donation is already recorded. Thank you! 🙏");
  }

  if (!isYes) {
    await pool.query(`UPDATE matches SET donation_confirmed = FALSE WHERE id = $1`, [matchId]);
    await sendMessage(from, "Thanks for letting us know. If you still need help, message us anytime.");
    return notifyCustomerService(
      `❌ *Donation Did Not Happen*\n\n👤 *Donor:* ${donor_name} (${donor_phone})\n📞 *Requester:* ${requester_phone}\n🆔 *Match ID:* ${matchId}\n*Reported by:* ${from === donor_phone ? 'Donor' : 'Requester'}`
    );
  }

  await recordDonation(matchId, donor_id, null);

  const donorThanks = donorThanksText(donor_name, gender);
  if (from === donor_phone) {
    await sendMessage(from, donorThanks);
  } else {
    await sendMessage(from, "Thank you for confirming! We're glad the donation happened. Wishing the patient a quick recovery. 🙏");
    try {
      await sendMessage(donor_phone, donorThanks);
    } catch (err) {
      console.warn('Could not thank donor (likely outside 24h window):', err.response?.data?.error?.message || err.message);
    }
  }
  await notifyCustomerService(
    `✅ *Donation Confirmed (self-reported)*\n\n👤 *Donor:* ${donor_name} (${donor_phone})\n📞 *Requester:* ${requester_phone}\n🆔 *Match ID:* ${matchId}\n⏳ *Next eligible in:* ${donationWaitDays(gender)} days`
  );
}

// Marks a match as donated and starts the donor's rest period.
// With a facilityId the blood bank checked the donor's ID, so the donor also becomes "verified".
async function recordDonation(matchId, donorId, facilityId) {
  await pool.query(`UPDATE matches SET donation_confirmed = TRUE, confirmed_by_facility_id = $2 WHERE id = $1`, [matchId, facilityId]);
  await pool.query(`UPDATE donors SET last_donation_date = CURRENT_DATE WHERE id = $1`, [donorId]);
  if (facilityId) {
    await pool.query(`UPDATE donors SET verified_at = NOW(), verified_by_facility_id = $2 WHERE id = $1`, [donorId, facilityId]);
  }
}

function donorThanksText(donorName, gender) {
  return `Thank you for donating blood, ${donorName}! ❤️ You may have saved a life. Your body needs time to recover, so we won't ask you to donate again for the next ${donationWaitDays(gender)} days. We'll reach out after that.`;
}

// Short code the donor shows at the blood bank, e.g. LD-48213 (unique among open codes)
async function generateConfirmCode() {
  for (let i = 0; i < 5; i++) {
    const code = `LD-${crypto.randomInt(10000, 100000)}`;
    const clash = await pool.query(`SELECT 1 FROM matches WHERE confirm_code = $1 AND donation_confirmed IS NOT TRUE`, [code]);
    if (clash.rows.length === 0) return code;
  }
  return `LD-${Date.now().toString().slice(-7)}`;
}

async function getPartnerFacility(phone) {
  const result = await pool.query(
    `SELECT id, name FROM facilities WHERE is_partner = TRUE AND regexp_replace(staff_phone, '\\D', '', 'g') = $1 LIMIT 1`,
    [phone]
  );
  return result.rows[0] || null;
}

// Blood bank staff send the donor's code: show who it belongs to so they can check the ID card first
async function handleFacilityCode(from, text) {
  const facility = await getPartnerFacility(from);
  if (!facility) {
    return sendMessage(from, "This code is for partner blood bank staff. Please show it to the staff at the blood bank when you donate. 🩸");
  }

  const code = `LD-${text.replace(/\D/g, '')}`;
  const matchRow = await pool.query(
    `SELECT m.id, m.donation_confirmed, d.name, d.blood_type, d.phone
     FROM matches m JOIN donors d ON d.id = m.donor_id
     WHERE m.confirm_code = $1 AND m.response = 'yes' ORDER BY m.id DESC LIMIT 1`,
    [code]
  );
  if (matchRow.rows.length === 0) {
    return sendMessage(from, `❓ Code ${code} was not found. Please check it with the donor and send it again.`);
  }
  const match = matchRow.rows[0];
  if (match.donation_confirmed === true) {
    return sendMessage(from, `Code ${code} is already confirmed. Thank you! 🙏`);
  }

  return sendButtons(
    from,
    `🔎 *${code}*\n👤 ${match.name}\n🩸 ${match.blood_type}\n📞 ...${match.phone.slice(-4)}\n\nPlease check the donor's ID card matches this name. Did this person donate today?`,
    [
      { id: `fac_yes_${match.id}`, title: 'Confirm donation' },
      { id: `fac_no_${match.id}`, title: 'Did not donate' }
    ]
  );
}

async function handleFacilityConfirmation(from, buttonId) {
  const facility = await getPartnerFacility(from);
  if (!facility) return;

  const isYes = buttonId.startsWith('fac_yes_');
  const matchId = buttonId.replace('fac_yes_', '').replace('fac_no_', '');

  const matchRow = await pool.query(
    `SELECT m.donor_id, m.donation_confirmed, m.confirm_code, d.name, d.phone, d.gender, r.requester_phone
     FROM matches m JOIN donors d ON d.id = m.donor_id JOIN requests r ON r.id = m.request_id WHERE m.id = $1`,
    [matchId]
  );
  if (matchRow.rows.length === 0) return;
  const { donor_id, donation_confirmed, confirm_code, name, phone, gender, requester_phone } = matchRow.rows[0];
  if (donation_confirmed === true) {
    return sendMessage(from, `Code ${confirm_code} is already confirmed. Thank you! 🙏`);
  }

  if (!isYes) {
    await sendMessage(from, "Noted. Nothing was recorded for this donor.");
    return notifyCustomerService(
      `⚠️ *Blood Bank: Donation Not Done*\n\n🏥 *Facility:* ${facility.name}\n👤 *Donor:* ${name} (${phone})\n🔑 *Code:* ${confirm_code}`
    );
  }

  await recordDonation(matchId, donor_id, facility.id);
  await sendMessage(from, `✅ Donation by ${name} (${confirm_code}) is recorded. Thank you, ${facility.name}! 🙏`);

  for (const [to, text] of [
    [phone, `${donorThanksText(name, gender)}\n\n✅ ${facility.name} confirmed your donation. You are now a *verified* LifeDrop donor.`],
    [requester_phone, `✅ ${facility.name} has confirmed that ${name} donated blood. Wishing the patient a quick recovery. 🙏`]
  ]) {
    try {
      await sendMessage(to, text);
    } catch (err) {
      console.warn('Could not send facility confirmation notice (likely outside 24h window):', err.response?.data?.error?.message || err.message);
    }
  }
  await notifyCustomerService(
    `✅ *Donation Confirmed by Blood Bank*\n\n🏥 *Facility:* ${facility.name}\n👤 *Donor:* ${name} (${phone})\n🔑 *Code:* ${confirm_code}\n⏳ *Next eligible in:* ${donationWaitDays(gender)} days`
  );
}

// Donation results, step 1: staff send "results LD-48213" for a confirmed donation
async function handleResultsRequest(from, code) {
  const facility = await getPartnerFacility(from);
  if (!facility) {
    return sendMessage(from, "Donation results can only be entered by partner blood bank staff. If you donated, the blood bank will share your results with you. 🩸");
  }

  const matchRow = await pool.query(
    `SELECT m.id, m.results_at, d.name FROM matches m JOIN donors d ON d.id = m.donor_id
     WHERE m.confirm_code = $1 AND m.donation_confirmed = TRUE ORDER BY m.id DESC LIMIT 1`,
    [code]
  );
  if (matchRow.rows.length === 0) {
    return sendMessage(from, `❓ No confirmed donation found for ${code}. If the donor gave blood today, first send the code alone (${code}) to confirm the donation.`);
  }
  const match = matchRow.rows[0];
  if (match.results_at) {
    return sendMessage(from, `Results for ${code} are already recorded. To correct them, please contact the LifeDrop team.`);
  }

  sessions[from] = { step: 'results_blood_group', data: { matchId: match.id, code }, aiAttempts: 0 };
  return sendMessage(from, `🧪 Results for *${code}* (${match.name}).\n\nType the blood group you found, e.g. O+ or AB-.\n\n⚠️ Do NOT type infection test results here. Reply 'cancel' to stop.`);
}

// Step 2: staff type the blood group, then pick the outcome
async function handleResultsBloodGroup(from, text) {
  const { matchId, code } = sessions[from].data;
  if (text.toLowerCase() === 'cancel') {
    sessions[from] = { step: 'start', data: {}, aiAttempts: 0 };
    return sendMessage(from, "Cancelled. Nothing was saved.");
  }

  const bloodGroup = normalizeBloodGroup(text);
  if (!bloodGroup) {
    return sendMessage(from, "Please type a blood group like O+, A-, B+ or AB-, or reply 'cancel'.");
  }

  sessions[from] = { step: 'start', data: {}, aiAttempts: 0 };
  return sendButtons(
    from,
    `🧪 *${code}*\n🩸 Blood group: *${bloodGroup}*\n\nScreening outcome?\n• *Cleared*: nothing needs the donor's attention\n• *Needs follow-up*: your team will contact the donor in person\n\nThe donor gets the same message either way.`,
    [
      { id: `res_clear_${matchId}_${bloodGroup}`, title: 'Cleared' },
      { id: `res_follow_${matchId}_${bloodGroup}`, title: 'Needs follow-up' },
      { id: `res_cancel_${matchId}`, title: 'Cancel' }
    ]
  );
}

// Step 3 (staff outcome buttons) and the donor's "View update" template button
async function handleResultButton(from, buttonId) {
  const parsed = parseResultButton(buttonId);
  if (!parsed) return;
  const { action, matchId, bloodGroup } = parsed;

  if (action === 'view') {
    const view = await pool.query(
      `SELECT m.confirm_code, m.result_blood_group, m.results_at, d.name, d.phone, f.name AS facility_name
       FROM matches m JOIN donors d ON d.id = m.donor_id LEFT JOIN facilities f ON f.id = m.results_facility_id WHERE m.id = $1`,
      [matchId]
    );
    const row = view.rows[0];
    if (!row || row.phone !== from || !row.results_at) return;
    return sendMessage(from, neutralResultMessage(row.name, row.confirm_code, row.result_blood_group, row.facility_name));
  }

  const facility = await getPartnerFacility(from);
  if (!facility) return;
  if (action === 'cancel') {
    return sendMessage(from, "Cancelled. Nothing was saved.");
  }
  if (!bloodGroup) return;

  const matchRow = await pool.query(
    `SELECT m.confirm_code, m.results_at, d.id AS donor_id, d.name, d.phone, d.blood_type, d.eligibility_status, d.screening_reasons, d.last_inbound_at
     FROM matches m JOIN donors d ON d.id = m.donor_id WHERE m.id = $1 AND m.donation_confirmed = TRUE`,
    [matchId]
  );
  if (matchRow.rows.length === 0) return;
  const donor = matchRow.rows[0];
  if (donor.results_at) {
    return sendMessage(from, `Results for ${donor.confirm_code} are already recorded. To correct them, please contact the LifeDrop team.`);
  }

  const followUp = action === 'follow';
  await pool.query(
    `UPDATE matches SET result_blood_group = $2, result_outcome = $3, results_at = NOW(), results_facility_id = $4 WHERE id = $1`,
    [matchId, bloodGroup, followUp ? 'follow_up' : 'cleared', facility.id]
  );

  // Lab-confirmed blood group replaces the self-reported one; "I don't know" donors no longer need review for it
  let status = donor.eligibility_status;
  let reasons = donor.screening_reasons || '';
  if (reasons.split(',').includes('blood_type_unknown')) {
    reasons = reasons.split(',').filter(r => r && r !== 'blood_type_unknown').join(',');
    if (status === 'needs_review' && reasons === '') status = 'eligible';
  }
  if (followUp) status = 'on_hold'; // silent pause: no reason is ever sent to the donor
  await pool.query(
    `UPDATE donors SET blood_type = $2, eligibility_status = $3, screening_reasons = $4 WHERE id = $1`,
    [donor.donor_id, bloodGroup, status, reasons]
  );

  await sendMessage(
    from,
    followUp
      ? `Saved for ${donor.confirm_code}. The donor's LifeDrop profile is now paused and they will get the same neutral message as every donor. Please contact them in person through your usual counselling process.`
      : `✅ Saved for ${donor.confirm_code}. The donor will be told their blood group (${bloodGroup}). Thank you!`
  );

  const groupChanged = donor.blood_type && donor.blood_type !== 'UNKNOWN' && donor.blood_type !== bloodGroup;
  await notifyCustomerService(
    followUp
      ? `⏸️ *Donor Paused After Blood Bank Results*\n\n🏥 *Facility:* ${facility.name}\n👤 *Donor:* ${donor.name} (${donor.phone})\n🔑 *Code:* ${donor.confirm_code}\n\nThe blood bank will contact the donor in person. Do not discuss reasons over WhatsApp.`
      : `🧪 *Donation Results Recorded*\n\n🏥 *Facility:* ${facility.name}\n👤 *Donor:* ${donor.name} (${donor.phone})\n🔑 *Code:* ${donor.confirm_code}\n🩸 *Blood group:* ${bloodGroup}${groupChanged ? ` (was ${donor.blood_type})` : ''}`
  );

  await sendResultUpdate(donor, matchId, bloodGroup, facility.name);
}

// Same neutral text for every donor: direct inside the 24h window, else the donation_update template
async function sendResultUpdate(donor, matchId, bloodGroup, facilityName) {
  const withinWindow = donor.last_inbound_at && (Date.now() - new Date(donor.last_inbound_at).getTime()) < 24 * 60 * 60 * 1000;
  try {
    if (withinWindow) {
      await sendMessage(donor.phone, neutralResultMessage(donor.name, donor.confirm_code, bloodGroup, facilityName));
    } else {
      await sendDonationUpdateTemplate(donor.name, donor.phone, donor.confirm_code, matchId);
    }
  } catch (err) {
    console.warn('Could not send donation update to donor:', err.response?.data?.error?.message || err.message);
    await notifyCustomerService(
      `⚠️ *Could not send donation update*\n\n👤 *Donor:* ${donor.name} (${donor.phone})\n🔑 *Code:* ${donor.confirm_code}\n\nCheck that the 'donation_update' template is approved in WhatsApp Manager.`
    );
  }
}

// Outbound Template for results after the 24h window (tapping "View update" reopens the window)
async function sendDonationUpdateTemplate(donorName, donorPhone, code, matchId) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: donorPhone,
      type: 'template',
      template: {
        name: 'donation_update',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: donorName },
              { type: 'text', text: code }
            ]
          },
          {
            type: 'button', sub_type: 'quick_reply', index: '0',
            parameters: [{ type: 'payload', payload: `res_view_${matchId}` }]
          }
        ]
      }
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

// Meta API Sender Wrappers
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

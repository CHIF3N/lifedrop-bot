const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');
const { daysUntilEligible } = require('./deferral');
const geo = require('./geo');
const { upcomingSlots, formatSlot, slotId, parseSlotId } = require('./slots');
const { evaluateScreening } = require('./screening');
const { parseResultsRequest, normalizeBloodGroup, parseResultButton, neutralResultMessage } = require('./results');
const { formatTime, toTemplateParam, splitReport, formatStatsReport, dailySummaryParams } = require('./reports');
const { normalizePhone, parseAdminCommand, HELP_TEXT } = require('./admin');
const { BLOOD_GROUP_ROWS, REQUEST_REASONS, reasonTitle, requestSummary, parseContact } = require('./request-form');

const app = express();
app.use(bodyParser.json());

// Environment configuration
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const CS_PHONE_NUMBER = process.env.CS_PHONE_NUMBER;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Phones allowed to run admin commands (stats, addhospital...): the CS phone plus ADMIN_PHONES (comma-separated)
const ADMIN_PHONES = [CS_PHONE_NUMBER, ...(process.env.ADMIN_PHONES || '').split(',')].map(normalizePhone).filter(Boolean);
const REPORT_KEY = process.env.REPORT_KEY; // Secret for the /reports/daily endpoint (called by an external cron)
const DONOR_FLOW_ID =process.env.DONOR_FLOW_ID || '1747598403124876';
// Rest period between confirmed whole-blood donations (WHO minimum: 12 weeks men, 16 weeks women)
const DONATION_WAIT_DAYS_MALE = parseInt(process.env.DONATION_WAIT_DAYS_MALE, 10) || 90;
const DONATION_WAIT_DAYS_FEMALE = parseInt(process.env.DONATION_WAIT_DAYS_FEMALE, 10) || 120;
const donationWaitDays = (gender) => (gender === 'male' ? DONATION_WAIT_DAYS_MALE : DONATION_WAIT_DAYS_FEMALE);
const COMMUNITY_LINK ='https://chat.whatsapp.com/EPIAr0zFQxVEYXru4PmRwF?s=cl&p=a&mlu=4&ilr=4';
const SLOT_CAPACITY = parseInt(process.env.SLOT_CAPACITY, 10) || 3; // Max bookings per lab per time slot
const SEED_DEMO_LABS = process.env.SEED_DEMO_LABS === 'true'; // Test numbers only: adds FICTIONAL labs
// Facilities (shared table) that donors can book a free test at
const BOOKABLE_LAB = `is_partner AND does_lab_tests`;

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
      ALTER TABLE donors ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
      ALTER TABLE donors ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
      ALTER TABLE donors ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMP;
      ALTER TABLE requests ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
      ALTER TABLE requests ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS confirm_code TEXT;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS confirmed_by_facility_id INTEGER;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS responded_at TIMESTAMP;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS donation_confirmed_at TIMESTAMP;
      ALTER TABLE requests ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
      ALTER TABLE requests ADD COLUMN IF NOT EXISTS fulfilled_at TIMESTAMP;
      ALTER TABLE requests ADD COLUMN IF NOT EXISTS facility_id INTEGER;
      ALTER TABLE requests ADD COLUMN IF NOT EXISTS patient_name TEXT;
      ALTER TABLE requests ADD COLUMN IF NOT EXISTS reason TEXT;
      ALTER TABLE requests ADD COLUMN IF NOT EXISTS contact_name TEXT;
      ALTER TABLE requests ADD COLUMN IF NOT EXISTS contact_phone TEXT;
      ALTER TABLE donors ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
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
      ALTER TABLE facilities ADD COLUMN IF NOT EXISTS hours TEXT;
      ALTER TABLE facilities ADD COLUMN IF NOT EXISTS is_demo BOOLEAN DEFAULT FALSE;
      CREATE TABLE IF NOT EXISTS appointments (
        id SERIAL PRIMARY KEY,
        donor_phone TEXT NOT NULL,
        facility_id INTEGER NOT NULL REFERENCES facilities(id),
        slot_at TIMESTAMPTZ NOT NULL,
        status TEXT DEFAULT 'booked',
        reminder_sent BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS appointments_slot_idx ON appointments (facility_id, slot_at);
      CREATE TABLE IF NOT EXISTS feature_interest (
        phone TEXT NOT NULL,
        feature TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (phone, feature)
      );
    `);
    if (SEED_DEMO_LABS) await seedDemoLabs();
    console.log('✅ Database schema verified.');
  } catch (err) {
    console.warn('⚠️ Database schema verification warning:', err.message);
  }
}
initDb();

// FICTIONAL labs for testing the booking flow on a test number. These are NOT real partners.
// Only runs when SEED_DEMO_LABS=true; never set that on the live bot.
async function seedDemoLabs() {
  const existing = await pool.query(`SELECT 1 FROM facilities WHERE is_demo LIMIT 1`);
  if (existing.rows.length > 0) return;
  await pool.query(`
    INSERT INTO facilities (name, type, city, region, latitude, longitude, hours, is_partner, does_lab_tests, is_demo) VALUES
      ('DEMO Lab Buea (fictional)', 'lab', 'Buea', 'South-West', 4.1560, 9.2440, 'Mon-Sat 08:00-16:00', TRUE, TRUE, TRUE),
      ('DEMO Lab Limbe (fictional)', 'lab', 'Limbe', 'South-West', 4.0190, 9.2050, 'Mon-Fri 08:00-15:00', TRUE, TRUE, TRUE),
      ('DEMO Lab Tiko (fictional)', 'lab', 'Tiko', 'South-West', 4.0760, 9.3610, 'Mon-Sat 09:00-14:00', TRUE, TRUE, TRUE)
  `);
  console.log('🧪 Seeded FICTIONAL demo labs (SEED_DEMO_LABS=true).');
}

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
        await handleButton(from, message.interactive.button_reply.id);
      } else if (message.type === 'button' && message.button?.payload) {
        await handleButton(from, message.button.payload);
      } else if (message.type === 'interactive' && message.interactive?.type === 'list_reply') {
        await handleListReply(from, message.interactive.list_reply.id);
      } else if (message.type === 'location') {
        await handleLocation(from, geo.parseLocationMessage(message));
      } else {
        const text = message.text?.body?.trim() || '';
        const resultsCode = parseResultsRequest(text);
        const adminCommand = isAdmin(from) ? parseAdminCommand(text) : null;
        if (adminCommand) {
          await handleAdminCommand(from, adminCommand);
        } else if (resultsCode) {
          await handleResultsRequest(from, resultsCode);
        } else if (/^LD-?\s?\d{5}$/i.test(text)) {
          await handleFacilityCode(from, text);
        } else if (sessions[from]?.step !== 'results_blood_group' && await handleFacilityMessage(from, text)) {
          // Partner hospital staff: handled by the hospital menu
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

// Button taps (interactive buttons and template quick replies share the same ids)
async function handleButton(from, buttonId) {
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
  } else if (buttonId.startsWith('labs_')) {
    await handleLabOffer(from, buttonId);
  } else if (buttonId.startsWith('appt_')) {
    await handleAppointmentButton(from, buttonId);
  } else {
    await handleMessage(from, buttonId);
  }
}

// List picks: lab_<id> then slot_<labId>_<minutes>
async function handleListReply(from, rowId) {
  if (rowId.startsWith('lab_')) {
    await sendLabSlots(from, parseInt(rowId.replace('lab_', ''), 10));
  } else if (rowId.startsWith('slot_')) {
    await bookSlot(from, parseSlotId(rowId));
  } else {
    await handleMessage(from, rowId);
  }
}

// Safe Customer Service Notifications (Never crashes requester flows)
async function notifyCustomerService(text) {
  const report = `${text}\n\n🕒 ${formatTime()}`;
  if (!CS_PHONE_NUMBER) {
    console.log('[CS Log (No Phone Configured)]:\n', report);
    return;
  }
  const cleanNumber = CS_PHONE_NUMBER.replace(/\D/g, '');
  try {
    await sendMessage(cleanNumber, report);
  } catch (err) {
    // Usually the support phone is outside its 24h window: fall back to the approved ops report template
    try {
      const { title, details } = splitReport(report);
      await sendTemplate(cleanNumber, 'lifedrop_ops_report', [title, details]);
    } catch (templateErr) {
      console.warn('⚠️ Could not deliver CS message or lifedrop_ops_report template:', templateErr.response?.data?.error?.message || templateErr.message);
      console.log('📌 CS Alert Fallback Output:\n', report);
    }
  }
}

const isAdmin = (phone) => ADMIN_PHONES.includes(phone);

// Analytics numbers for the last N days (donor counts are current totals)
const READY_SQL = `eligibility_status = 'eligible'
  AND (deferred_until IS NULL OR deferred_until <= CURRENT_DATE)
  AND (last_donation_date IS NULL OR last_donation_date <= CURRENT_DATE - (CASE WHEN gender = 'male' THEN ${DONATION_WAIT_DAYS_MALE} ELSE ${DONATION_WAIT_DAYS_FEMALE} END))`;

async function getStats(days) {
  const since = [days];
  const recent = `created_at >= NOW() - $1 * INTERVAL '1 day'`;
  const [donors, donorsByCity, readyByType, requests, demandByType, topLocations, matches, donations, facilities, waitlist, activity] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) AS total,
         COUNT(*) FILTER (WHERE ${recent}) AS new,
         COUNT(*) FILTER (WHERE ${READY_SQL}) AS ready,
         COUNT(*) FILTER (WHERE last_donation_date > CURRENT_DATE - (CASE WHEN gender = 'male' THEN ${DONATION_WAIT_DAYS_MALE} ELSE ${DONATION_WAIT_DAYS_FEMALE} END)) AS resting,
         COUNT(*) FILTER (WHERE eligibility_status = 'eligible' AND deferred_until > CURRENT_DATE) AS waiting,
         COUNT(*) FILTER (WHERE eligibility_status = 'needs_review') AS needs_review,
         COUNT(*) FILTER (WHERE eligibility_status IN ('needs_update', 'on_hold')) AS paused,
         COUNT(*) FILTER (WHERE eligibility_status = 'not_eligible') AS not_eligible,
         COUNT(*) FILTER (WHERE verified_at IS NOT NULL) AS verified,
         COUNT(*) FILTER (WHERE blood_type IS NULL OR blood_type = 'UNKNOWN') AS unknown_type,
         COUNT(*) FILTER (WHERE lat IS NOT NULL) AS with_pin
       FROM donors`,
      since
    ),
    pool.query(
      `SELECT lower(trim(city)) AS city, COUNT(*) AS count, COUNT(*) FILTER (WHERE ${READY_SQL}) AS ready
       FROM donors GROUP BY 1 ORDER BY 2 DESC LIMIT 8`
    ),
    pool.query(`SELECT blood_type, COUNT(*) AS count FROM donors WHERE ${READY_SQL} GROUP BY 1`),
    pool.query(
      `SELECT COUNT(*) AS total,
         COALESCE(SUM(units_needed), 0) AS units,
         COUNT(*) FILTER (WHERE urgency = 'Emergency') AS emergency,
         COUNT(*) FILTER (WHERE urgency = 'Urgent') AS urgent,
         COUNT(*) FILTER (WHERE urgency = 'Routine') AS routine,
         COUNT(*) FILTER (WHERE status = 'fulfilled') AS fulfilled,
         COUNT(*) FILTER (WHERE facility_id IS NOT NULL) AS partner,
         COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM matches m WHERE m.request_id = r.id)) AS no_match,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM fulfilled_at - created_at) / 60)
           FILTER (WHERE fulfilled_at IS NOT NULL) AS median_minutes_to_fulfil
       FROM requests r WHERE ${recent}`,
      since
    ),
    pool.query(
      `SELECT blood_type_needed, COALESCE(SUM(units_needed), 0) AS units FROM requests WHERE ${recent} GROUP BY 1`,
      since
    ),
    pool.query(
      `SELECT lower(trim(location)) AS location, COUNT(*) AS count FROM requests
       WHERE ${recent} GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
      since
    ),
    pool.query(
      `SELECT COUNT(*) AS contacted,
         COUNT(*) FILTER (WHERE response = 'yes') AS yes,
         COUNT(*) FILTER (WHERE response = 'no') AS no,
         COUNT(*) FILTER (WHERE response = 'not_needed') AS not_needed,
         COUNT(*) FILTER (WHERE response IS NULL) AS no_reply,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM responded_at - contacted_at) / 60)
           FILTER (WHERE response = 'yes' AND responded_at IS NOT NULL) AS median_minutes_to_yes
       FROM matches WHERE contacted_at >= NOW() - $1 * INTERVAL '1 day'`,
      since
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE donation_confirmed_at >= NOW() - $1 * INTERVAL '1 day') AS confirmed,
         COUNT(*) FILTER (WHERE donation_confirmed_at >= NOW() - $1 * INTERVAL '1 day' AND confirmed_by_facility_id IS NOT NULL) AS by_facility,
         COUNT(*) FILTER (WHERE donation_confirmed_at >= NOW() - $1 * INTERVAL '1 day' AND confirmed_by_facility_id IS NULL) AS self_reported,
         COUNT(*) FILTER (WHERE results_at >= NOW() - $1 * INTERVAL '1 day') AS results
       FROM matches`,
      since
    ),
    pool.query(`SELECT COUNT(*) FILTER (WHERE is_partner AND is_demo IS NOT TRUE) AS partners FROM facilities`),
    pool.query(`SELECT COUNT(*) AS home_lab FROM feature_interest WHERE feature = 'home_lab_test'`),
    pool.query(`SELECT COUNT(*) AS tests_booked FROM appointments WHERE ${recent}`, since)
  ]);
  return {
    donors: donors.rows[0], donorsByCity: donorsByCity.rows, readyByType: readyByType.rows,
    requests: requests.rows[0], demandByType: demandByType.rows, topLocations: topLocations.rows,
    matches: matches.rows[0], donations: donations.rows[0], facilities: facilities.rows[0],
    waitlist: waitlist.rows[0], activity: activity.rows[0]
  };
}

// Admin phone texts "stats" or "stats 30": the reply is inside its 24h window, so plain messages work
async function sendStatsReport(to, days) {
  const stats = await getStats(days);
  for (const part of formatStatsReport(stats, days)) {
    await sendMessage(to, part);
  }
}

// Daily summary for the support line: full text if its window is open, else the lifedrop_daily_summary template
async function sendDailySummary() {
  const stats = await getStats(1);
  const parts = formatStatsReport(stats, 1);
  if (!CS_PHONE_NUMBER) {
    console.log('[Daily summary (No CS Phone Configured)]:\n', parts.join('\n\n'));
    return;
  }
  const cleanNumber = CS_PHONE_NUMBER.replace(/\D/g, '');
  try {
    for (const part of parts) await sendMessage(cleanNumber, part);
  } catch (err) {
    await sendTemplate(cleanNumber, 'lifedrop_daily_summary', dailySummaryParams(stats));
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

  // "test" books a free blood test any time, except in the middle of a blood request
  if (text.toLowerCase() === 'test' && !session.step.startsWith('request_')) {
    return offerLabs(from);
  }

  // New donor: waiting for a location pin (handleLocation continues when a pin arrives)
  if (session.step === 'donor_pin') {
    if (text.toLowerCase() === 'skip') return continueOnboarding(from);
    return sendLocationRequest(from, "Please tap *Send location* to share where you are, or reply 'skip'.");
  }

  // Free test offer / lab list is open: anything typed except a pick moves on
  if (session.step === 'lab_offer' || session.step === 'lab_booking') {
    if (text.toLowerCase() === 'skip') return finishLabStep(from, "No problem. Reply *test* any time to book a free blood test. 🧪");
    return sendMessage(from, "Please pick an option from the message above, or reply 'skip'.");
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
        return sendMessage(from, `Welcome back, ${donor.name}! 🩸${restLine}\n\nReply:\n1 - Update my donor info\n2 - Request blood\n3 - Home lab test (coming soon)\n4 - Book a free blood test\n\n📍 Tip: send your location pin any time so we match you with patients nearby.`);
      }
      return sendMessage(from, "Welcome to LifeDrop 🩸\n\nReply:\n1 - Register as a blood donor\n2 - Request blood\n3 - Home lab test (coming soon)");
    }

    case 'menu':
      if (text === '1') {
        sessions[from] = { step: 'start', data: {}, aiAttempts: 0 };
        return sendDonorFlow(from);
      } else if (text === '2') {
        return askBloodGroup(from, session);
      } else if (text === '3') {
        return sendButtons(
          from,
          "🧪 *Home Lab Tests: coming soon!*\nA trained lab technician will come to your home to collect samples for tests like blood group, blood count and more.\n\nWant us to tell you when it launches?",
          [
            { id: 'homelab_notify', title: 'Yes, notify me' },
            { id: 'homelab_no', title: 'No thanks' }
          ]
        );
      } else if (text === '4') {
        return offerLabs(from);
      } else {
        session.aiAttempts = (session.aiAttempts || 0) + 1;
        if (session.aiAttempts <= 3) {
          const aiResponse = await askGeminiGuidance(text);
          if (aiResponse) return sendMessage(from, aiResponse);
        }
        return sendMessage(from, "Please reply with *1* to register as a donor or *2* to request blood.");
      }

    case 'request_blood_type': {
      const group = normalizeBloodGroup(text.replace(/^bg_/, ''));
      if (!group) return askBloodGroup(from, session, "Please choose a blood group from the list, or type it (e.g. O+, AB-).\n\n");
      session.data.blood_type_needed = group;
      session.step = 'request_location';
      return sendLocationRequest(from, "📍 *Step 2 of 7: Location*\nWhere is the patient? Tap *Send location* (the hospital's pin is best), or type the city/town.");
    }

    case 'request_location':
      // A pin is handled in handleLocation; typed text is a town name
      session.data.location = text;
      return askHospital(from, session, '');

    case 'request_hospital': {
      if (text === 'hosp_other') {
        session.step = 'request_hospital_name';
        return sendMessage(from, "Please type the name of the hospital or clinic.");
      }
      if (text.startsWith('hosp_') && text !== 'hosp_skip') {
        const picked = await pool.query(`SELECT id, name FROM facilities WHERE id = $1 AND is_partner = TRUE`, [parseInt(text.replace('hosp_', ''), 10)]);
        session.data.facility_id = picked.rows[0]?.id || null;
        session.data.hospital_name = picked.rows[0]?.name || null;
      } else {
        session.data.hospital_name = text === 'hosp_skip' || text.toLowerCase() === 'skip' ? null : text;
      }
      return askPatientName(from, session);
    }

    case 'request_hospital_name':
      session.data.hospital_name = text.toLowerCase() === 'skip' ? null : text;
      return askPatientName(from, session);

    case 'request_patient':
      session.data.patient_name = text.toLowerCase() === 'skip' ? null : text.slice(0, 80);
      session.step = 'request_reason';
      return sendList(from, 'Reason', "📝 *Step 5 of 7: Reason*\nWhat is the blood needed for? This helps the hospital and our team prepare.", 'Choose reason', [
        { title: 'Reason', rows: REQUEST_REASONS }
      ]);

    case 'request_reason':
      session.data.reason = REQUEST_REASONS.some(r => r.id === text) ? text : 'reason_other';
      session.step = 'request_units';
      return sendButtons(from, "🧪 *Step 6 of 7: Units and urgency*\nHow many units (bags) of blood are needed?", [
        { id: 'units_1', title: '1 unit' },
        { id: 'units_2', title: '2 units' },
        { id: 'units_more', title: '3 or more' }
      ]);

    case 'request_units': {
      if (text === 'units_more') {
        return sendMessage(from, "How many units are needed? Reply with a number, e.g. 4.");
      }
      const parsed = parseInt(text.replace('units_', ''), 10);
      session.data.units_needed = isNaN(parsed) || parsed < 1 ? 1 : Math.min(parsed, 20);
      session.step = 'request_urgency';
      return sendButtons(from, "How urgent is this?\n• *Emergency*: needed within hours\n• *Urgent*: within 1–2 days\n• *Routine*: planned, a few days ahead", [
        { id: 'urgency_emergency', title: 'Emergency' },
        { id: 'urgency_urgent', title: 'Urgent' },
        { id: 'urgency_routine', title: 'Routine' }
      ]);
    }

    case 'request_urgency': {
      const urgencyMap = { urgency_routine: 'Routine', urgency_urgent: 'Urgent', urgency_emergency: 'Emergency' };
      session.data.urgency = urgencyMap[text] || 'Urgent';
      session.step = 'request_contact_choice';
      return sendButtons(from, "📞 *Step 7 of 7: Contact*\nWho should the donor call to coordinate?", [
        { id: 'contact_me', title: 'Me (this number)' },
        { id: 'contact_other', title: 'Someone else' }
      ]);
    }

    case 'request_contact_choice':
      if (text === 'contact_other') {
        session.step = 'request_contact';
        return sendMessage(from, "Send the contact person's name and phone number, e.g.:\nPaul 677123456");
      }
      session.data.contact_name = null;
      session.data.contact_phone = null;
      return showRequestSummary(from, session);

    case 'request_contact': {
      const contact = parseContact(text);
      if (!contact) return sendMessage(from, "Please include a phone number, e.g.:\nPaul 677123456");
      session.data.contact_name = contact.name;
      session.data.contact_phone = contact.phone;
      return showRequestSummary(from, session);
    }

    case 'request_consent': {
      if (text === 'consent_decline') {
        sessions[from] = { step: 'start', data: {}, aiAttempts: 0 };
        return sendMessage(from, "Request cancelled. Message us anytime you need assistance.");
      }

      if (text === 'request_edit') {
        sessions[from] = { step: 'menu', data: {}, aiAttempts: 0 };
        return askBloodGroup(from, sessions[from], "No problem, let's start the request again.\n\n");
      }

      if (text !== 'consent_agree') {
        return showRequestSummary(from, session);
      }

      const requestPayload = { ...session.data };
      sessions[from] = { step: 'start', data: {}, aiAttempts: 0 }; // Clear session state immediately

      try {
        const { matchCount, requestId } = await saveRequestAndMatch(from, requestPayload);
        if (matchCount === 0) {
          return sendMessage(from, `✅ Request *#${requestId}* logged.\n\nWe don't have an available ${requestPayload.blood_type_needed} donor near ${requestPayload.location} right now. Our support team has been alerted and will help you directly.`);
        }
        return sendMessage(from, `✅ Request *#${requestId}* logged.\n\nWe are contacting ${matchCount} available ${requestPayload.blood_type_needed} donor(s) near ${requestPayload.location} now. You will get the donor's name and number the moment someone accepts.`);
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

// Request step helpers (the request flow is: blood group, location, hospital, patient, reason, units + urgency, contact, summary)
function askBloodGroup(from, session, prefix = '') {
  session.step = 'request_blood_type';
  return sendList(from, 'Blood request', `${prefix}🩸 *Step 1 of 7: Blood group*\nWhich blood group does the patient need? Choose below, or type it (e.g. O+).`, 'Choose group', [
    { title: 'Blood group', rows: BLOOD_GROUP_ROWS }
  ]);
}

// Partner hospitals near the patient as a list (8 max + other/skip); otherwise the name is typed
async function askHospital(from, session, intro) {
  session.step = 'request_hospital';
  const hasPin = session.data.lat != null && session.data.lng != null;
  const partners = await pool.query(
    `SELECT id, name, city FROM facilities
     WHERE is_partner = TRUE AND does_blood_collection = TRUE AND is_demo IS NOT TRUE
       AND (city ILIKE $1 OR $1 ILIKE '%' || city || '%'
            ${hasPin ? `OR (latitude IS NOT NULL AND ${geo.distanceSql('$2', '$3', 'latitude', 'longitude')} <= 30)` : ''})
     ORDER BY name LIMIT 8`,
    hasPin ? [session.data.location || '', session.data.lat, session.data.lng] : [session.data.location || '']
  );
  if (partners.rows.length === 0) {
    return sendMessage(from, `${intro}🏥 *Step 3 of 7: Hospital*\nWhich hospital or clinic is the patient in? Type its name, or reply 'skip'.`);
  }
  return sendList(from, 'Hospital', `${intro}🏥 *Step 3 of 7: Hospital*\nWhich hospital or clinic is the patient in? LifeDrop partner hospitals are notified directly.`, 'Choose hospital', [
    { title: 'LifeDrop partners', rows: partners.rows.map(r => ({ id: `hosp_${r.id}`, title: truncate(r.name, 24), description: truncate(r.city || '', 72) })) },
    { title: 'Other', rows: [{ id: 'hosp_other', title: 'Another hospital' }, { id: 'hosp_skip', title: 'Skip' }] }
  ]);
}

function askPatientName(from, session) {
  session.step = 'request_patient';
  return sendMessage(from, "👤 *Step 4 of 7: Patient*\nWhat is the patient's name? Initials are fine (e.g. M. N.), or reply 'skip'.");
}

function showRequestSummary(from, session) {
  session.step = 'request_consent';
  return sendButtons(from, requestSummary(session.data), [
    { id: 'consent_agree', title: 'Confirm request' },
    { id: 'request_edit', title: 'Start over' },
    { id: 'consent_decline', title: 'Cancel' }
  ]);
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

    // Next: location pin -> free test offer -> feedback (see continueOnboarding)
    sessions[from] = {
      step: 'donor_pin',
      data: { donorName: flowData.name, unknownType: flowData.blood_type === 'UNKNOWN', onboarding: true },
      aiAttempts: 0
    };
    if (screening.status === 'not_eligible') return askFeedback(from);
    await sendLocationRequest(from, "📍 One more step: share your location so we only alert you for patients near you. We never show it to anyone. Tap *Send location*, or reply 'skip'.");
  } catch (err) {
    console.error('Error handling flow submission:', err);
    await sendMessage(from, "Thank you for submitting! Your details have been received.");
  }
}

// After the location step: "Don't know" donors go straight to the lab list, others get an optional offer
async function continueOnboarding(from) {
  const session = sessions[from];
  if (session.data.unknownType) {
    await sendMessage(from, "You told us you don't know your blood group. You can get it tested for free at a partner lab near you. 🧪");
    const shown = await offerLabs(from);
    if (!shown) return askFeedback(from);
    return;
  }
  session.step = 'lab_offer';
  return sendButtons(from, "Would you like a free blood test (blood group + screening) at a partner lab near you? 🧪", [
    { id: 'labs_yes', title: 'Book free test' },
    { id: 'labs_no', title: 'Not now' }
  ]);
}

// Ends a lab step: new donors still get the feedback question, everyone else goes back to the menu
async function finishLabStep(from, text) {
  if (text) await sendMessage(from, text);
  if (sessions[from]?.data?.onboarding) return askFeedback(from);
  sessions[from] = { step: 'start', data: {}, aiAttempts: 0 };
}

async function askFeedback(from) {
  sessions[from] = { step: 'awaiting_feedback', data: { donorName: sessions[from]?.data?.donorName }, aiAttempts: 0 };
  await sendMessage(from, "⭐ *Quick Feedback:* How was your registration experience? Reply with a rating (1-5) or a quick comment, or reply 'skip'.");
}

// Location pin: answers the requester's "where is the patient?" or saves/updates a donor's location
async function handleLocation(from, loc) {
  if (!loc) return sendMessage(from, "Sorry, we couldn't read that location. Please try again.");
  const session = sessions[from];
  const town = geo.nearestTown(loc.lat, loc.lng);
  const nearLine = town ? ` (near ${town.name})` : '';

  if (session?.step === 'request_location') {
    session.data.lat = loc.lat;
    session.data.lng = loc.lng;
    session.data.location = town?.name || loc.address || loc.name || 'Shared location';
    const hospitalHint = loc.name ? ` Your pin says *${loc.name}*.` : '';
    return askHospital(from, session, `📍 Got it${nearLine}.${hospitalHint}\n\n`);
  }

  const updated = await pool.query(
    `UPDATE donors SET lat = $2, lng = $3, location_updated_at = NOW() WHERE phone = $1 RETURNING id`,
    [from, loc.lat, loc.lng]
  );
  if (updated.rows.length === 0) {
    return sendMessage(from, "Thanks! To use your location, first reply *1* to register as a donor or *2* to request blood.");
  }
  if (session?.step === 'donor_pin') {
    await sendMessage(from, `📍 Location saved${nearLine}. Thank you!`);
    return continueOnboarding(from);
  }
  return sendMessage(from, `📍 Location updated${nearLine}. We'll alert you when a patient nearby needs your blood type.`);
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
    `INSERT INTO requests (requester_phone, blood_type_needed, location, hospital_name, units_needed, urgency, lat, lng, facility_id, patient_name, reason, contact_name, contact_phone)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [phone, d.blood_type_needed, d.location, d.hospital_name, d.units_needed, d.urgency, d.lat ?? null, d.lng ?? null,
     d.facility_id || null, d.patient_name || null, d.reason || null, d.contact_name || null, d.contact_phone || null]
  );
  const requestId = result.rows[0].id;
  const neededUnits = d.units_needed || 1;
  const notifyCount = neededUnits + 1;

  const matchedDonors = { rows: await findMatchingDonors(d, notifyCount) };
  const farthestKm = Math.max(0, ...matchedDonors.rows.map(r => r.dist_km ?? 0));
  const radiusLine = matchedDonors.rows.some(r => r.dist_km != null) ? `\n📏 *Search radius:* ${geo.ringFor(farthestKm)} km` : '';
  const detailLines = `\n👤 *Patient:* ${d.patient_name || 'Not given'}\n📝 *Reason:* ${reasonTitle(d.reason) || 'Not given'}\n📞 *Contact:* ${d.contact_name ? d.contact_name + ' (' + d.contact_phone + ')' : 'Requester'}\n🏷️ *Partner hospital:* ${d.facility_id ? 'Yes (ID ' + d.facility_id + ')' : 'No'}`;

  if (matchedDonors.rows.length === 0) {
    // How many donors of this group the area has at all, to tell "nobody registered" from "everyone resting"
    const areaPool = await pool.query(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE eligibility_status = 'eligible') AS eligible
       FROM donors WHERE blood_type = $1 AND city ILIKE $2`,
      [d.blood_type_needed, `%${d.location}%`]
    );
    await notifyCustomerService(
      `⚠️ *NO DONOR MATCH FOUND!*\n\n🆔 *Request:* #${requestId}\n👥 *Same blood group in this area:* ${areaPool.rows[0].total} registered, ${areaPool.rows[0].eligible} screened eligible (all resting or waiting)\n🩸 *Blood Needed:* ${d.blood_type_needed} (${neededUnits} unit(s))\n📍 *Location:* ${d.location}\n🏥 *Hospital:* ${d.hospital_name || 'Not specified'}\n⚡ *Urgency:* ${d.urgency}${detailLines}\n📱 *Requester Phone:* ${phone}\n\n*Action Required:* Manual donor outreach needed.`
    );
  } else {
    await notifyCustomerService(
      `🩸 *New Blood Request Logged*\n\n🆔 *Request:* #${requestId}\n🩸 *Blood Needed:* ${d.blood_type_needed} (${neededUnits} unit(s))\n📍 *Location:* ${d.location}\n🏥 *Hospital:* ${d.hospital_name || 'N/A'}\n⚡ *Urgency:* ${d.urgency}\n👥 *Donors Contacted:* ${matchedDonors.rows.length}${radiusLine}${detailLines}\n📱 *Requester Phone:* ${phone}`
    );

    for (const donor of matchedDonors.rows) {
      try {
        const matchResult = await pool.query(
          `INSERT INTO matches (request_id, donor_id, contacted_at) VALUES ($1, $2, NOW()) RETURNING id`,
          [requestId, donor.id]
        );
        await notifyDonor(donor.name, donor.phone, donor.last_inbound_at, matchResult.rows[0].id, d, donor.dist_km);
      } catch (err) {
        console.error(`Failed to notify donor ${donor.id}:`, err.message);
      }
    }
  }

  if (d.facility_id) await notifyFacilityOfRequest(d.facility_id, requestId, phone, d, matchedDonors.rows.length);

  scheduleRequesterFollowUp(phone, requestId);
  return { matchCount: matchedDonors.rows.length, requestId };
}

// Partner hospital chosen by the requester: tell its staff a LifeDrop request is coming in for their patient
async function notifyFacilityOfRequest(facilityId, requestId, requesterPhone, d, donorsContacted) {
  const result = await pool.query(`SELECT id, name, staff_phone FROM facilities WHERE id = $1 AND is_partner = TRUE`, [facilityId]);
  const facility = result.rows[0];
  if (!facility?.staff_phone) return;
  const contact = d.contact_name ? `${d.contact_name} (${d.contact_phone})` : requesterPhone;
  await sendToFacility(
    facility,
    `🏥 *New LifeDrop blood request for ${facility.name}*\n\n🆔 *Request:* #${requestId}\n🩸 *Blood:* ${d.blood_type_needed} × ${d.units_needed || 1} unit(s)\n⚡ *Urgency:* ${d.urgency}\n👤 *Patient:* ${d.patient_name || 'Not given'}\n📝 *Reason:* ${reasonTitle(d.reason) || 'Not given'}\n📞 *Family contact:* ${contact}\n👥 *Donors contacted:* ${donorsContacted}\n\nWhen a donor accepts, we will send you their name and donation code. Reply *requests* any time to see all requests.`,
    'hospital_request_alert',
    [facility.name, `#${requestId}`, `${d.blood_type_needed} x ${d.units_needed || 1}`, d.urgency, d.patient_name || 'Not given', contact]
  );
}

// Donor search: nearest pinned donors first (rings up to geo.MAX_RADIUS_KM), then donors without a pin
// whose typed city is the request's town or any known town in reach. Unknown town + no pin = old city text match.
async function findMatchingDonors(d, limit) {
  const baseFilter = `blood_type = $1 AND eligibility_status = 'eligible'
    AND (deferred_until IS NULL OR deferred_until <= CURRENT_DATE)
    AND (last_donation_date IS NULL OR last_donation_date <= CURRENT_DATE - (CASE WHEN gender = 'male' THEN $2 ELSE $3 END)::int)`;
  const baseParams = [d.blood_type_needed, DONATION_WAIT_DAYS_MALE, DONATION_WAIT_DAYS_FEMALE];
  const point = d.lat != null ? { lat: d.lat, lng: d.lng } : geo.findTown(d.location);
  let donors = [];

  if (point) {
    const nearby = await pool.query(
      `SELECT id, name, phone, last_inbound_at, dist_km FROM (
         SELECT id, name, phone, last_inbound_at, ${geo.distanceSql('$4', '$5')} AS dist_km
         FROM donors WHERE ${baseFilter} AND lat IS NOT NULL AND lng IS NOT NULL
       ) d WHERE dist_km <= $6 ORDER BY dist_km LIMIT $7`,
      [...baseParams, point.lat, point.lng, geo.MAX_RADIUS_KM, limit]
    );
    donors = nearby.rows;
  }

  if (donors.length < limit) {
    const towns = point ? geo.townsWithin(point.lat, point.lng, geo.MAX_RADIUS_KM) : [];
    const patterns = [...new Set([d.location, ...towns])].filter(Boolean).map(t => `%${t}%`);
    const byCity = await pool.query(
      `SELECT id, name, phone, last_inbound_at, NULL::float AS dist_km FROM donors
       WHERE ${baseFilter} AND city ILIKE ANY($4) AND NOT (id = ANY($5))
         ${point ? 'AND lat IS NULL' : ''}
       ORDER BY (city ILIKE $6) DESC
       LIMIT $7`,
      [...baseParams, patterns, donors.map(x => x.id), `%${d.location}%`, limit - donors.length]
    );
    donors = donors.concat(byCity.rows);
  }
  return donors;
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
async function notifyDonor(donorName, donorPhone, lastInboundAt, matchId, requestData, distanceKm) {
  const withinWindow = lastInboundAt && (Date.now() - new Date(lastInboundAt).getTime()) < 24 * 60 * 60 * 1000;
  if (withinWindow) {
    const hospitalLine = requestData.hospital_name ? ` at ${requestData.hospital_name}` : '';
    const unitsLine = requestData.units_needed ? ` (${requestData.units_needed} unit(s) needed total)` : '';
    const distanceLine = distanceKm != null ? `\n📍 About ${Math.max(1, Math.round(distanceKm))} km from you` : '';
    const body = `Hello ${donorName}! 🩸 Blood needed: ${requestData.blood_type_needed} in ${requestData.location}${hospitalLine}.\nUrgency: ${requestData.urgency}${unitsLine}${distanceLine}\n\nReminder: LifeDrop doesn't pay donors — any support is arranged directly with the requester.\n\nCan you donate?`;
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
    `SELECT m.request_id, m.response, m.contacted_at, r.units_needed, r.requester_phone, r.blood_type_needed, r.location, r.hospital_name, r.urgency,
       r.contact_name, r.contact_phone, r.facility_id
     FROM matches m JOIN requests r ON r.id = m.request_id WHERE m.id = $1`,
    [matchId]
  );
  if (matchRow.rows.length === 0) return;
  const { request_id, response: existingResponse, contacted_at, units_needed, requester_phone, blood_type_needed, location, hospital_name, urgency, contact_name, contact_phone, facility_id } = matchRow.rows[0];

  if (existingResponse) return;

  if (!isYes) {
    await pool.query(`UPDATE matches SET response = 'no', responded_at = NOW() WHERE id = $1`, [matchId]);
    return sendMessage(from, "No problem, thanks for letting us know. We'll reach out next time there's a match.");
  }

  // Donor already gave blood recently (e.g. tapped an older alert): keep them resting
  const donorRest = await pool.query(`SELECT last_donation_date, gender FROM donors WHERE phone = $1`, [from]);
  const daysLeft = daysUntilEligible(donorRest.rows[0]?.last_donation_date, donationWaitDays(donorRest.rows[0]?.gender));
  if (daysLeft > 0) {
    await pool.query(`UPDATE matches SET response = 'no', responded_at = NOW() WHERE id = $1`, [matchId]);
    return sendMessage(from, `Thank you for wanting to help! 🙏 You donated recently, so your body needs rest. You can donate again in ${daysLeft} day(s). We'll reach out after that.`);
  }

  const neededUnits = units_needed || 1;
  const acceptedCountResult = await pool.query(
    `SELECT COUNT(*) FROM matches WHERE request_id = $1 AND response = 'yes'`,
    [request_id]
  );
  const acceptedSoFar = parseInt(acceptedCountResult.rows[0].count, 10);

  if (acceptedSoFar >= neededUnits) {
    await pool.query(`UPDATE matches SET response = 'not_needed', responded_at = NOW() WHERE id = $1`, [matchId]);
    return sendMessage(from, "Thanks so much for being ready to help! We have already secured enough donors for this request. We will reach out next time there is a match. 🙏");
  }

  const confirmCode = await generateConfirmCode();
  await pool.query(`UPDATE matches SET response = 'yes', responded_at = NOW(), confirm_code = $2 WHERE id = $1`, [matchId, confirmCode]);
  const donorInfo = await pool.query(`SELECT name, blood_type FROM donors WHERE phone = $1`, [from]);
  const donorName = donorInfo.rows[0]?.name || 'A donor';
  const familyContact = contact_name ? `${contact_name}: ${contact_phone}` : requester_phone;

  await sendMessage(from, `Thank you, ${donorName}! 🙏 You are confirmed as a donor for request #${request_id}.\n\n🏥 *Where:* ${hospital_name || 'Hospital not specified'}, ${location}\n📞 *Family contact:* ${familyContact}\n\n🔑 Your donation code: *${confirmCode}*\nAt the blood bank, show this code and your ID card. The staff will confirm your donation with it.\n\nReminder: any transport/feeding support is arranged directly with the family. LifeDrop does not pay donors.`);
  await sendMessage(
    requester_phone,
    `Good news! ${donorName} (${from}) has agreed to donate ${blood_type_needed}${hospital_name ? ' at ' + hospital_name : ''} in ${location} for request #${request_id}.${contact_name ? `\n\nWe gave the donor ${contact_name}'s number (${contact_phone}) as the contact.` : ''} Please reach out to coordinate directly.`
  );
  await sendDonationConfirmButtons(from, requester_phone, donorName, matchId);

  if (facility_id) {
    const fac = await pool.query(`SELECT id, name, staff_phone FROM facilities WHERE id = $1 AND is_partner = TRUE`, [facility_id]);
    if (fac.rows[0]?.staff_phone) {
      const facility = fac.rows[0];
      await sendToFacility(
        facility,
        `🙋 *Donor on the way: request #${request_id}*\n\n👤 *Donor:* ${donorName}\n🩸 *Blood group (self-reported):* ${donorInfo.rows[0]?.blood_type || blood_type_needed}\n🔑 *Donation code:* ${confirmCode}\n📞 *Family contact:* ${familyContact}\n\nAfter the donation, check the donor's ID card and send the code to this number to confirm.`,
        'hospital_donor_incoming',
        [facility.name, donorName, donorInfo.rows[0]?.blood_type || blood_type_needed, confirmCode]
      );
    }
  }

  const newAcceptedCount = acceptedSoFar + 1;
  const minutesToReply = contacted_at ? Math.max(0, Math.round((Date.now() - new Date(contacted_at).getTime()) / 60000)) : null;
  await notifyCustomerService(
    `🙋 *Donor Accepted*\n\n🆔 *Request:* #${request_id}\n👤 *Donor:* ${donorName} (${from})\n🩸 *Blood:* ${blood_type_needed}\n📍 *Location:* ${location}\n🏥 *Hospital:* ${hospital_name || 'N/A'}\n⚡ *Urgency:* ${urgency || 'N/A'}\n📞 *Requester:* ${requester_phone}\n🔑 *Code:* ${confirmCode}\n⏱️ *Replied after:* ${minutesToReply != null ? minutesToReply + ' min' : 'N/A'}\n✅ *Accepted:* ${newAcceptedCount} of ${neededUnits} unit(s)`
  );
  if (newAcceptedCount >= neededUnits) {
    const pendingMatches = await pool.query(
      `SELECT m.id, d.phone FROM matches m JOIN donors d ON d.id = m.donor_id WHERE m.request_id = $1 AND m.response IS NULL`,
      [request_id]
    );
    for (const pm of pendingMatches.rows) {
      await pool.query(`UPDATE matches SET response = 'not_needed' WHERE id = $1`, [pm.id]);
      await sendMessage(pm.phone, "Thanks so much for offering to help! We've secured enough donors for this request. We will contact you next time there is a match. 🙏");
    }
    await pool.query(`UPDATE requests SET status = 'fulfilled', fulfilled_at = NOW() WHERE id = $1`, [request_id]);
    await notifyCustomerService(
      `🎉 *Request Fulfilled*\n\n🆔 *Request:* #${request_id}\n🩸 *Blood:* ${blood_type_needed} (${neededUnits} unit(s))\n📍 *Location:* ${location}\n📞 *Requester:* ${requester_phone}\n🔕 *Other donors told not needed:* ${pendingMatches.rows.length}`
    );
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
  await pool.query(`UPDATE matches SET donation_confirmed = TRUE, donation_confirmed_at = NOW(), confirmed_by_facility_id = $2 WHERE id = $1`, [matchId, facilityId]);
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

// Admin commands from the CS phone / ADMIN_PHONES (see admin.js for the syntax)
async function handleAdminCommand(from, command) {
  switch (command.cmd) {
    case 'stats':
      return sendStatsReport(from, command.days);

    case 'help':
      return sendMessage(from, HELP_TEXT);

    case 'add_invalid':
      return sendMessage(from, `⚠️ Could not read that. Use:\nadd${command.kind} Name | City | Staff phone\n\nExample:\nadd${command.kind} Buea Regional Hospital | Buea | 677123456`);

    case 'add': {
      const f = command.facility;
      const existing = await pool.query(`SELECT id, name FROM facilities WHERE regexp_replace(staff_phone, '\\D', '', 'g') = $1`, [f.staff_phone]);
      if (existing.rows.length > 0) {
        await pool.query(`UPDATE facilities SET is_partner = TRUE WHERE id = $1`, [existing.rows[0].id]);
        return sendMessage(from, `ℹ️ ${f.staff_phone} is already registered as *${existing.rows[0].name}* (ID ${existing.rows[0].id}). It is now active as a partner.`);
      }
      const inserted = await pool.query(
        `INSERT INTO facilities (name, type, city, staff_phone, is_partner, does_blood_collection, does_lab_tests)
         VALUES ($1, $2, $3, $4, TRUE, $5, $6) RETURNING id`,
        [f.name, f.type, f.city, f.staff_phone, f.does_blood_collection, f.does_lab_tests]
      );
      const id = inserted.rows[0].id;
      const welcome = await sendToFacility(
        { id, name: f.name, staff_phone: f.staff_phone },
        `🏥 Welcome to LifeDrop, ${f.name}!\n\nThis WhatsApp number is now registered as your facility's LifeDrop line.\n\n${facilityMenuText(f.name)}`,
        'hospital_admin_notice',
        [f.name, 'This WhatsApp number is now registered as your LifeDrop line. Reply "menu" to see what you can do.']
      );
      return sendMessage(
        from,
        `✅ *${f.name}* added (ID ${id}).\n📍 ${f.city}\n📞 ${f.staff_phone}\n🏷️ ${f.type}\n\n${welcome ? 'A welcome message was sent to the staff phone.' : '⚠️ The welcome message could not be delivered yet. Ask the staff to send "menu" to the LifeDrop number once, or get the hospital_admin_notice template approved.'}`
      );
    }

    case 'list': {
      const result = await pool.query(
        `SELECT id, name, type, city, staff_phone, is_partner FROM facilities WHERE is_demo IS NOT TRUE ORDER BY is_partner DESC, city, name`
      );
      if (result.rows.length === 0) return sendMessage(from, "No hospitals or labs registered yet. Use:\naddhospital Name | City | Staff phone");
      const lines = result.rows.map(r => `${r.is_partner ? '✅' : '⏸️'} *${r.id}* · ${r.name} (${r.type}, ${r.city || '?'}) · ${r.staff_phone || 'no phone'}`);
      return sendMessage(from, `🏥 *Registered facilities* (${result.rows.length})\n\n${lines.join('\n')}\n\n✅ active partner · ⏸️ not active`);
    }

    case 'remove': {
      const result = await pool.query(`UPDATE facilities SET is_partner = FALSE WHERE id = $1 RETURNING name`, [command.id]);
      if (result.rows.length === 0) return sendMessage(from, `No facility with ID ${command.id}. Send "hospitals" to see the list.`);
      return sendMessage(from, `⏸️ *${result.rows[0].name}* is no longer an active partner. Its history is kept.`);
    }
  }
}

function facilityMenuText(facilityName) {
  return [
    `🏥 *LifeDrop: ${facilityName}*`,
    '',
    'What you can do from this number:',
    '• *requests*: open blood requests for your facility',
    '• Send a donor\'s code, e.g. *LD-48213*: confirm their donation (check their ID card first)',
    '• *results LD-48213*: record the blood group and screening outcome',
    '',
    'Never send infection test results through LifeDrop.'
  ].join('\n');
}

// Partner staff phone: hospital menu and "requests". Returns false for everyone else.
async function handleFacilityMessage(from, text) {
  const facility = await getPartnerFacility(from);
  if (!facility) return false;

  if (text.toLowerCase() === 'requests') {
    const open = await pool.query(
      `SELECT r.id, r.blood_type_needed, r.units_needed, r.urgency, r.patient_name, r.reason, r.created_at,
         COALESCE(r.contact_name, 'Requester') AS contact_name, COALESCE(r.contact_phone, r.requester_phone) AS contact_phone,
         (SELECT string_agg(d.name || ' ' || m.confirm_code || CASE WHEN m.donation_confirmed THEN ' ✅' ELSE '' END, ', ')
            FROM matches m JOIN donors d ON d.id = m.donor_id WHERE m.request_id = r.id AND m.response = 'yes') AS donors
       FROM requests r
       WHERE r.facility_id = $1 AND r.created_at >= NOW() - INTERVAL '14 days'
       ORDER BY r.created_at DESC LIMIT 10`,
      [facility.id]
    );
    if (open.rows.length === 0) return sendMessage(from, `No LifeDrop requests for ${facility.name} in the last 14 days.`).then(() => true);
    const blocks = open.rows.map(r =>
      `🆔 *#${r.id}* · ${formatTime(r.created_at)}\n🩸 ${r.blood_type_needed} × ${r.units_needed || 1} · ⚡ ${r.urgency}\n👤 ${r.patient_name || 'Patient name not given'}${r.reason ? ' · ' + (reasonTitle(r.reason) || r.reason) : ''}\n📞 ${r.contact_name}: ${r.contact_phone}\n🙋 ${r.donors || 'No donor confirmed yet'}`
    );
    await sendMessage(from, `🏥 *LifeDrop requests for ${facility.name}* (last 14 days)\n\n${blocks.join('\n\n')}`);
    return true;
  }

  await sendMessage(from, facilityMenuText(facility.name));
  return true;
}

// Message a hospital's staff phone: plain text inside its 24h window, else an approved template.
// Returns true if something was delivered; tells support if not.
async function sendToFacility(facility, text, templateName, templateParams) {
  try {
    await sendMessage(facility.staff_phone, text);
    return true;
  } catch (err) {
    try {
      await sendTemplate(facility.staff_phone, templateName, templateParams.map(p => toTemplateParam(p)));
      return true;
    } catch (templateErr) {
      console.warn(`Could not reach facility ${facility.id}:`, templateErr.response?.data?.error?.message || templateErr.message);
      await notifyCustomerService(
        `⚠️ *Could not reach hospital*\n\n🏥 *Facility:* ${facility.name} (ID ${facility.id})\n📞 *Staff phone:* ${facility.staff_phone}\n📨 *Message:* ${text.split('\n')[0]}\n\nAsk the staff to message the LifeDrop number, or check that the '${templateName}' template is approved.`
      );
      return false;
    }
  }
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

// "Book free test" / "Not now" buttons
async function handleLabOffer(from, buttonId) {
  if (buttonId === 'labs_yes') {
    const shown = await offerLabs(from);
    if (!shown) return finishLabStep(from);
    return;
  }
  return finishLabStep(from, "No problem. Reply *test* any time to book a free blood test. 🧪");
}

// Shows the closest partner labs as a WhatsApp list. Returns false if there was nothing to pick.
async function offerLabs(from) {
  const donorRow = await pool.query(`SELECT name, city, lat, lng FROM donors WHERE phone = $1`, [from]);
  const donor = donorRow.rows[0];
  if (!donor) {
    await sendMessage(from, "Free blood tests are for registered donors. Reply *1* to register first. 🩸");
    return false;
  }

  const point = donor.lat != null ? { lat: donor.lat, lng: donor.lng } : geo.findTown(donor.city);
  const labs = point
    ? await pool.query(
        `SELECT * FROM (
           SELECT id, name, city AS town, hours, ${geo.distanceSql('$1', '$2', 'latitude', 'longitude')} AS dist_km
           FROM facilities WHERE ${BOOKABLE_LAB} AND latitude IS NOT NULL AND longitude IS NOT NULL
         ) l WHERE dist_km <= $3 ORDER BY dist_km LIMIT 3`,
        [point.lat, point.lng, geo.MAX_RADIUS_KM]
      )
    : await pool.query(
        `SELECT id, name, city AS town, hours, NULL::float AS dist_km FROM facilities WHERE ${BOOKABLE_LAB} AND city ILIKE $1 LIMIT 3`,
        [`%${donor.city || ''}%`]
      );

  if (labs.rows.length === 0) {
    await sendMessage(from, "We don't have a partner lab near you yet. Our team has been told and will contact you about a free test. 🙏");
    await notifyCustomerService(`🧪 *Free Test Wanted - No Lab Nearby*\n\n👤 *Donor:* ${donor.name} (${from})\n📍 *City:* ${donor.city || 'Unknown'}${donor.lat != null ? ' (has pin)' : ''}`);
    return false;
  }

  if (!sessions[from]) sessions[from] = { step: 'start', data: {}, aiAttempts: 0 };
  sessions[from].step = 'lab_booking';
  await sendList(from, 'Free blood test 🧪', 'Pick a partner lab near you. The test is free.', 'Choose a lab', [{
    title: 'Nearest labs',
    rows: labs.rows.map(l => ({
      id: `lab_${l.id}`,
      title: truncate(l.name, 24),
      description: truncate([l.town, l.dist_km != null ? `${Math.max(1, Math.round(l.dist_km))} km` : null, l.hours].filter(Boolean).join(' · '), 72)
    }))
  }]);
  return true;
}

// Free time slots at one lab (next 3 working days), as a WhatsApp list
async function sendLabSlots(from, labId) {
  const labRow = await pool.query(`SELECT id, name FROM facilities WHERE id = $1 AND ${BOOKABLE_LAB}`, [labId]);
  const lab = labRow.rows[0];
  if (!lab) return sendMessage(from, "Sorry, that lab is not available any more. Reply *test* to see other labs.");

  const slots = upcomingSlots(new Date());
  const taken = await pool.query(
    `SELECT slot_at, COUNT(*)::int AS n FROM appointments
     WHERE facility_id = $1 AND status = 'booked' AND slot_at = ANY($2::timestamptz[]) GROUP BY slot_at`,
    [lab.id, slots.map(s => s.toISOString())]
  );
  const full = new Set(taken.rows.filter(r => r.n >= SLOT_CAPACITY).map(r => new Date(r.slot_at).getTime()));
  const open = slots.filter(s => !full.has(s.getTime())).slice(0, 10); // WhatsApp lists allow 10 rows

  if (open.length === 0) {
    return sendMessage(from, `${lab.name} is fully booked for the next few days. Reply *test* to pick another lab.`);
  }
  return sendList(from, truncate(lab.name, 60), 'Pick a time (Cameroon time):', 'Choose a time', [{
    title: 'Available times',
    rows: open.map(s => ({ id: slotId(lab.id, s), title: formatSlot(s) }))
  }]);
}

async function bookSlot(from, slot) {
  if (!slot || slot.slotAt.getTime() <= Date.now()) {
    return sendMessage(from, "Sorry, that time has passed. Reply *test* to pick a new time.");
  }
  const labRow = await pool.query(`SELECT id, name, city AS town, hours, is_demo FROM facilities WHERE id = $1 AND ${BOOKABLE_LAB}`, [slot.labId]);
  const lab = labRow.rows[0];
  if (!lab) return sendMessage(from, "Sorry, that lab is not available any more. Reply *test* to see other labs.");

  const existing = await pool.query(
    `SELECT a.id, a.slot_at, l.name FROM appointments a JOIN facilities l ON l.id = a.facility_id
     WHERE a.donor_phone = $1 AND a.status = 'booked' AND a.slot_at > NOW() LIMIT 1`,
    [from]
  );
  if (existing.rows.length > 0) {
    const appt = existing.rows[0];
    return sendButtons(from, `You already have a free test booked at ${appt.name} on ${formatSlot(appt.slot_at)}. Cancel it first if you want a different time.`, [
      { id: `appt_cancel_${appt.id}`, title: 'Cancel booking' }
    ]);
  }

  const count = await pool.query(
    `SELECT COUNT(*)::int AS n FROM appointments WHERE facility_id = $1 AND slot_at = $2 AND status = 'booked'`,
    [lab.id, slot.slotAt]
  );
  if (count.rows[0].n >= SLOT_CAPACITY) {
    await sendMessage(from, "Sorry, that time just filled up. Here are the times still free:");
    return sendLabSlots(from, lab.id);
  }

  // Booked less than a day ahead: this confirmation is the reminder
  const remindLater = slot.slotAt.getTime() - Date.now() > 24 * 60 * 60 * 1000;
  const inserted = await pool.query(
    `INSERT INTO appointments (donor_phone, facility_id, slot_at, reminder_sent) VALUES ($1, $2, $3, $4) RETURNING id`,
    [from, lab.id, slot.slotAt, !remindLater]
  );
  const apptId = inserted.rows[0].id;

  const demoLine = lab.is_demo ? '\n\n⚠️ This is a DEMO lab for testing. It is not a real clinic.' : '';
  await sendButtons(
    from,
    `✅ Booked! Free blood test\n🏥 ${lab.name}, ${lab.town || ''}\n🕘 ${formatSlot(slot.slotAt)}${lab.hours ? `\n⏰ Open ${lab.hours}` : ''}\n\nPlease bring an ID card.${remindLater ? " We'll remind you the day before." : ''}${demoLine}`,
    [{ id: `appt_cancel_${apptId}`, title: 'Cancel booking' }]
  );
  await notifyCustomerService(`🧪 *Free Test Booked*\n\n📞 *Donor:* ${from}\n🏥 *Lab:* ${lab.name}${lab.is_demo ? ' (DEMO)' : ''}\n🕘 *Time:* ${formatSlot(slot.slotAt)}\n🆔 *Appointment ID:* ${apptId}`);
  return finishLabStep(from);
}

// Reminder / confirmation buttons: appt_yes_<id>, appt_cancel_<id>
async function handleAppointmentButton(from, buttonId) {
  const isCancel = buttonId.startsWith('appt_cancel_');
  const apptId = buttonId.replace('appt_cancel_', '').replace('appt_yes_', '');
  const row = await pool.query(
    `SELECT a.id, a.status, a.slot_at, l.name FROM appointments a JOIN facilities l ON l.id = a.facility_id
     WHERE a.id = $1 AND a.donor_phone = $2`,
    [apptId, from]
  );
  const appt = row.rows[0];
  if (!appt) return;
  if (appt.status !== 'booked') {
    return sendMessage(from, "This booking is already cancelled. Reply *test* to book a new time.");
  }

  if (isCancel) {
    await pool.query(`UPDATE appointments SET status = 'cancelled' WHERE id = $1`, [appt.id]);
    await sendMessage(from, "Your booking is cancelled. Reply *test* any time to book a new time. 🙏");
    return notifyCustomerService(`❌ *Free Test Cancelled*\n\n📞 *Donor:* ${from}\n🏥 *Lab:* ${appt.name}\n🕘 *Time:* ${formatSlot(appt.slot_at)}\n🆔 *Appointment ID:* ${appt.id}`);
  }
  return sendMessage(from, `Great, see you at ${appt.name} on ${formatSlot(appt.slot_at)}! 🩸`);
}

// Every 15 minutes: remind donors about tests starting in the next 24 hours (template if outside the 24h window)
async function sendAppointmentReminders() {
  try {
    const due = await pool.query(
      `SELECT a.id, a.donor_phone, a.slot_at, l.name AS lab_name, d.name AS donor_name, d.last_inbound_at
       FROM appointments a JOIN facilities l ON l.id = a.facility_id LEFT JOIN donors d ON d.phone = a.donor_phone
       WHERE a.status = 'booked' AND a.reminder_sent = FALSE AND a.slot_at > NOW() AND a.slot_at <= NOW() + INTERVAL '24 hours'`
    );
    for (const appt of due.rows) {
      // Mark first so a failed send is not retried (and logged) every 15 minutes
      await pool.query(`UPDATE appointments SET reminder_sent = TRUE WHERE id = $1`, [appt.id]);
      const name = appt.donor_name || 'there';
      const when = formatSlot(appt.slot_at);
      const withinWindow = appt.last_inbound_at && (Date.now() - new Date(appt.last_inbound_at).getTime()) < 24 * 60 * 60 * 1000;
      try {
        if (withinWindow) {
          await sendButtons(appt.donor_phone, `Hello ${name}, reminder: your free blood test is at ${appt.lab_name} on ${when}. Please bring an ID card. Can you still make it?`, [
            { id: `appt_yes_${appt.id}`, title: "Yes, I'll be there" },
            { id: `appt_cancel_${appt.id}`, title: 'Cancel booking' }
          ]);
        } else {
          await sendAppointmentReminderTemplate(appt.donor_phone, name, appt.lab_name, when, appt.id);
        }
      } catch (err) {
        console.warn(`Could not send reminder for appointment ${appt.id}:`, err.response?.data?.error?.message || err.message);
      }
    }
  } catch (err) {
    console.warn('Appointment reminder job error:', err.message);
  }
}
setInterval(sendAppointmentReminders, 15 * 60 * 1000);

// Outbound reminder template (needs Meta approval of "lab_appointment_reminder", see LOCATION_AND_LABS.md)
async function sendAppointmentReminderTemplate(to, donorName, labName, when, apptId) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: 'lab_appointment_reminder',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: donorName },
              { type: 'text', text: labName },
              { type: 'text', text: when }
            ]
          },
          {
            type: 'button', sub_type: 'quick_reply', index: '0',
            parameters: [{ type: 'payload', payload: `appt_yes_${apptId}` }]
          },
          {
            type: 'button', sub_type: 'quick_reply', index: '1',
            parameters: [{ type: 'payload', payload: `appt_cancel_${apptId}` }]
          }
        ]
      }
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

function truncate(text, max) {
  const s = String(text || '');
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
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

// Generic approved-template sender: body text params, plus one payload per quick-reply button
async function sendTemplate(to, name, bodyParams, buttonPayloads = []) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name,
        language: { code: 'en' },
        components: [
          { type: 'body', parameters: bodyParams.map(text => ({ type: 'text', text: String(text) })) },
          ...buttonPayloads.map((payload, index) => ({
            type: 'button', sub_type: 'quick_reply', index: String(index),
            parameters: [{ type: 'payload', payload }]
          }))
        ]
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

// Daily analytics: call once a day from an external cron (e.g. cron-job.org) with ?key=REPORT_KEY
app.get('/reports/daily', async (req, res) => {
  const key = req.get('x-report-key') || req.query.key;
  if (!REPORT_KEY || key !== REPORT_KEY) return res.sendStatus(403);
  try {
    await sendDailySummary();
    res.send('Daily summary sent.');
  } catch (err) {
    console.error('Daily summary error:', err.response?.data ? JSON.stringify(err.response.data) : err.message);
    res.sendStatus(500);
  }
});
// "Send location" button (the user's pin arrives as a normal location message)
async function sendLocationRequest(to, bodyText) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'location_request_message',
        body: { text: bodyText },
        action: { name: 'send_location' }
      }
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

// List message: up to 10 rows; row title max 24 chars, description max 72, button text max 20
async function sendList(to, headerText, bodyText, buttonText, sections) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: headerText },
        body: { text: bodyText },
        action: { button: buttonText, sections }
      }
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

app.get('/', (req, res) => res.send('LifeDrop bot is running.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

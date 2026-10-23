// Support-line report formatting and analytics text. Kept free of DB/network code so it can be unit-tested.

const TIME_ZONE = 'Africa/Douala';

// "23 Oct 2026, 14:05"
function formatTime(date = new Date()) {
  return new Date(date).toLocaleString('en-GB', {
    timeZone: TIME_ZONE, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
  });
}

// "23 Oct 2026"
function formatDay(date = new Date()) {
  return new Date(date).toLocaleDateString('en-GB', { timeZone: TIME_ZONE, day: '2-digit', month: 'short', year: 'numeric' });
}

// Template variables can't hold new lines, tabs or 4+ spaces, and the body is capped at 1024 chars.
function toTemplateParam(text, maxLength = 700) {
  const flat = String(text ?? '')
    .replace(/\*/g, '')
    .split('\n').map(l => l.trim()).filter(Boolean).join(' | ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const safe = flat || '-';
  return safe.length > maxLength ? `${safe.slice(0, maxLength - 3)}...` : safe;
}

// First line of a report is its title ("🩸 *New Blood Request Logged*"), the rest are details
function splitReport(text) {
  const lines = String(text).split('\n');
  const title = lines[0].replace(/[*_]/g, '').trim() || 'LifeDrop report';
  return { title: toTemplateParam(title, 80), details: toTemplateParam(lines.slice(1).join('\n')) };
}

const pct = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '-');
const num = (v) => Number(v || 0);

const minutesText = (m) => {
  if (m == null) return '-';
  const v = Number(m);
  if (v < 60) return `${Math.round(v)} min`;
  if (v < 48 * 60) return `${(v / 60).toFixed(1)} h`;
  return `${(v / 1440).toFixed(1)} days`;
};

// Full analytics for the admin phones ("stats" command and the daily report), split into 3 WhatsApp messages
// so each stays well under the 4096-character limit. Each line says what the number means.
function formatStatsReport(s, days, now = new Date()) {
  const period = days === 1 ? 'last 24 hours' : `last ${days} days`;
  const header = `📊 *LifeDrop Analytics: ${period}*\n🕒 ${formatTime(now)}`;
  const d = s.donors;
  const r = s.requests;
  const m = s.matches;

  // Supply vs demand per blood group: donors ready now vs units requested in the period
  const groups = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'];
  const ready = Object.fromEntries((s.readyByType || []).map(x => [x.blood_type, num(x.count)]));
  const demand = Object.fromEntries((s.demandByType || []).map(x => [x.blood_type_needed, num(x.units)]));
  const supplyLines = groups
    .filter(g => ready[g] || demand[g])
    .map(g => `• ${g}: ${ready[g] || 0} ready · ${demand[g] || 0} unit(s) asked${(demand[g] || 0) > (ready[g] || 0) ? ' ⚠️ short' : ''}`);

  const donorsPart = [
    header,
    '',
    '👥 *DONORS* (totals today)',
    `• Registered: *${num(d.total)}* (+${num(d.new)} new in ${period})`,
    `• ✅ Ready now: *${num(d.ready)}*: can be matched today`,
    `• 😴 Resting: ${num(d.resting)}: donated recently (90 days men / 120 women)`,
    `• ⏳ Waiting: ${num(d.waiting)}: short wait from health answers (e.g. malaria, tattoo)`,
    `• 🔎 Needs review: ${num(d.needs_review)}: team must check answers before matching`,
    `• ⏸️ Paused: ${num(d.paused)}: pregnant/breastfeeding, or blood bank follow-up`,
    `• ❌ Not eligible: ${num(d.not_eligible)}: ruled out by screening`,
    `• 🏅 Verified: ${num(d.verified)}: identity checked by a blood bank`,
    `• ❓ Blood group unknown: ${num(d.unknown_type)}: cannot be matched until tested`,
    `• 📍 Shared location pin: ${num(d.with_pin)} of ${num(d.total)}`,
    '',
    '🏙️ *Donors by city*',
    ...(s.donorsByCity || []).map(c => `• ${c.city || 'unknown'}: ${c.count} (${c.ready} ready)`),
    '',
    '🩸 *Supply vs demand*',
    ...(supplyLines.length ? supplyLines : ['• No requests or ready donors yet'])
  ].join('\n');

  const requestsPart = [
    header,
    '',
    `🆘 *REQUESTS* (${period})`,
    `• New requests: *${num(r.total)}* (${num(r.units)} unit(s) in total)`,
    `• By urgency: 🔴 ${num(r.emergency)} emergency · 🟠 ${num(r.urgent)} urgent · 🟢 ${num(r.routine)} routine`,
    `• ✅ Fulfilled: ${num(r.fulfilled)} (${pct(num(r.fulfilled), num(r.total))}): enough donors said yes`,
    `• ⏱️ Typical time to fulfil: ${minutesText(r.median_minutes_to_fulfil)}: from request to last needed yes`,
    `• 🚫 No donor found: ${num(r.no_match)}: nobody available to contact, support had to help`,
    `• 🏥 Through partner hospitals: ${num(r.partner)}`,
    `• 📍 Top places: ${(s.topLocations || []).map(l => `${l.location} (${l.count})`).join(', ') || '-'}`,
    '',
    `📨 *DONOR REPLIES* (${period})`,
    `• Donors contacted: ${num(m.contacted)}`,
    `• 👍 Yes: ${num(m.yes)} · 👎 No: ${num(m.no)} · 🔕 No reply: ${num(m.no_reply)} · ✋ Not needed: ${num(m.not_needed)}`,
    `• Yes rate: ${pct(num(m.yes), num(m.contacted))}: share of contacted donors who said yes`,
    `• Reply rate: ${pct(num(m.contacted) - num(m.no_reply), num(m.contacted))}: share who answered at all`,
    `• ⚡ Typical time to a yes: ${minutesText(m.median_minutes_to_yes)}`
  ].join('\n');

  const activityPart = [
    header,
    '',
    `✅ *DONATIONS* (${period})`,
    `• Confirmed donations: *${num(s.donations.confirmed)}*`,
    `   ↳ by a blood bank (code checked): ${num(s.donations.by_facility)}`,
    `   ↳ self-reported (donor/family tapped yes): ${num(s.donations.self_reported)}`,
    `• Lab results recorded: ${num(s.donations.results)}`,
    '',
    '🏥 *NETWORK* (totals today)',
    `• Active partner hospitals/labs: ${num(s.facilities.partners)}`,
    `• Free tests booked (${period}): ${num(s.activity?.tests_booked)}`,
    `• Home lab test waitlist: ${num(s.waitlist.home_lab)}`,
    '',
    'Reply *stats 30* for 30 days, *admin* for all commands.'
  ].join('\n');

  return [donorsPart, requestsPart, activityPart];
}

// Values for the lifedrop_daily_summary template, in {{1}}..{{12}} order
function dailySummaryParams(s, now = new Date()) {
  return [
    formatDay(now),
    num(s.donors.new), num(s.donors.total), num(s.donors.ready),
    num(s.requests.total), num(s.requests.fulfilled), num(s.requests.no_match),
    num(s.matches.yes), num(s.matches.no), num(s.matches.no_reply),
    num(s.donations.confirmed), num(s.donations.by_facility)
  ].map(String);
}

module.exports = { formatTime, formatDay, toTemplateParam, splitReport, formatStatsReport, dailySummaryParams };

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

// Full analytics text for the support line ("stats" command and the daily report)
function formatStatsReport(s, days, now = new Date()) {
  const period = days === 1 ? 'last 24 hours' : `last ${days} days`;
  const bloodTypes = s.bloodTypes.map(b => `${b.blood_type || '?'}: ${b.count}`).join(' · ') || '-';
  const topPlaces = s.topLocations.map(l => `${l.location} (${l.count})`).join(', ') || '-';
  const median = s.matches.median_minutes_to_yes != null ? `${Math.round(s.matches.median_minutes_to_yes)} min` : '-';

  return [
    `📊 *LifeDrop Analytics (${period})*`,
    `🕒 ${formatTime(now)}`,
    '',
    '👥 *Donors*',
    `• Total: ${num(s.donors.total)} (new: ${num(s.donors.new)})`,
    `• Ready to donate now: ${num(s.donors.ready)}`,
    `• Resting after donation: ${num(s.donors.resting)}`,
    `• Waiting (temporary): ${num(s.donors.waiting)}`,
    `• Needs team review: ${num(s.donors.needs_review)}`,
    `• Paused (pregnancy / blood bank): ${num(s.donors.paused)}`,
    `• Not eligible: ${num(s.donors.not_eligible)}`,
    `• Verified by blood bank: ${num(s.donors.verified)}`,
    `• Blood groups: ${bloodTypes}`,
    '',
    '🩸 *Requests*',
    `• New: ${num(s.requests.total)} (emergency: ${num(s.requests.emergency)})`,
    `• Fulfilled: ${num(s.requests.fulfilled)} (${pct(num(s.requests.fulfilled), num(s.requests.total))})`,
    `• No donor found: ${num(s.requests.no_match)}`,
    `• Top places: ${topPlaces}`,
    '',
    '📨 *Donor replies*',
    `• Contacted: ${num(s.matches.contacted)}`,
    `• Yes: ${num(s.matches.yes)} · No: ${num(s.matches.no)} · Not needed: ${num(s.matches.not_needed)} · No reply: ${num(s.matches.no_reply)}`,
    `• Yes rate: ${pct(num(s.matches.yes), num(s.matches.contacted))}`,
    `• Median time to a yes: ${median}`,
    '',
    '✅ *Donations*',
    `• Confirmed: ${num(s.donations.confirmed)} (blood bank: ${num(s.donations.by_facility)}, self-reported: ${num(s.donations.self_reported)})`,
    `• Results recorded: ${num(s.donations.results)}`,
    '',
    '🏥 *Network*',
    `• Partner facilities: ${num(s.facilities.partners)}`,
    `• Home lab test waitlist: ${num(s.waitlist.home_lab)}`
  ].join('\n');
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

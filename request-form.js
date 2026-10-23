// Blood request form options and texts. Kept free of DB/network code so it can be unit-tested.

const { normalizePhone } = require('./admin');

const BLOOD_GROUP_ROWS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map(g => ({ id: `bg_${g}`, title: g }));

// Context for the hospital and the support team (never sent to donors, never used for medical decisions)
const REQUEST_REASONS = [
  { id: 'reason_surgery', title: 'Surgery / operation' },
  { id: 'reason_childbirth', title: 'Childbirth / pregnancy' },
  { id: 'reason_accident', title: 'Accident / injury' },
  { id: 'reason_anaemia', title: 'Anaemia' },
  { id: 'reason_sickle', title: 'Sickle cell crisis' },
  { id: 'reason_cancer', title: 'Cancer treatment' },
  { id: 'reason_other', title: 'Other / not sure' }
];

const reasonTitle = (id) => REQUEST_REASONS.find(r => r.id === id)?.title || null;

// The requester checks everything before we contact donors
function requestSummary(d) {
  const contact = d.contact_name
    ? `${d.contact_name}${d.contact_phone ? ` (${d.contact_phone})` : ''}`
    : 'You (this WhatsApp number)';
  return [
    '📋 *Please check your request*',
    '',
    `🩸 *Blood group:* ${d.blood_type_needed}`,
    `🧪 *Units:* ${d.units_needed || 1}`,
    `⚡ *Urgency:* ${d.urgency}`,
    `📍 *Location:* ${d.location}`,
    `🏥 *Hospital:* ${d.hospital_name || 'Not specified'}`,
    `👤 *Patient:* ${d.patient_name || 'Not given'}`,
    `📝 *Reason:* ${reasonTitle(d.reason) || 'Not given'}`,
    `📞 *Contact for donors:* ${contact}`,
    '',
    'By confirming, you agree to arrange any transport, feeding or other support directly with the donor. LifeDrop does not pay donors and does not sell blood.'
  ].join('\n');
}

// "Paul 677 12 34 56" / "Mama Grace: +237677123456" -> { name, phone }, or null without a usable number
function parseContact(text) {
  const m = /^(.*?)[\s,:;-]*((?:\+|00)?\d[\d\s-]{7,})$/.exec(String(text || '').trim());
  if (!m) return null;
  const phone = normalizePhone(m[2]);
  if (!phone) return null;
  return { name: m[1].trim() || 'Contact person', phone };
}

module.exports = { BLOOD_GROUP_ROWS, REQUEST_REASONS, reasonTitle, requestSummary, parseContact };

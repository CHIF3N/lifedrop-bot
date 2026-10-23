// Donation result helpers (blood bank staff -> bot). Kept free of DB/network code so it can be unit-tested.
// Infection results are never entered here: staff only send the blood group and "cleared" / "follow-up".

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

// "results LD-48213", "LD48213 result", "Result LD 48213" -> 'LD-48213', else null
function parseResultsRequest(text) {
  const m = /^(?:results?\s+LD-?\s?(\d{5})|LD-?\s?(\d{5})\s+results?)$/i.exec((text || '').trim());
  return m ? `LD-${m[1] || m[2]}` : null;
}

// Accepts common ways staff type a group: "o+", "O pos", "AB neg", "0+" (zero for O)
function normalizeBloodGroup(text) {
  const t = (text || '').trim().toUpperCase()
    .replace(/\s+/g, '')
    .replace(/POS(ITIVE)?$/, '+')
    .replace(/NEG(ATIVE)?$/, '-')
    .replace(/^0/, 'O');
  return BLOOD_GROUPS.includes(t) ? t : null;
}

// Button ids: res_clear_<matchId>_<group>, res_follow_<matchId>_<group>, res_cancel_<matchId>, res_view_<matchId>
function parseResultButton(id) {
  const m = /^res_(clear|follow|cancel|view)_(\d+)(?:_([ABO+\-]{2,3}))?$/.exec(id || '');
  if (!m) return null;
  return { action: m[1], matchId: m[2], bloodGroup: m[3] && BLOOD_GROUPS.includes(m[3]) ? m[3] : null };
}

// The same text for every donor, whatever the screening outcome (silence or a different text would leak it)
function neutralResultMessage(donorName, code, bloodGroup, facilityName) {
  return `Hi ${donorName}, here is an update on your blood donation (${code}). 🩸\n\nYour blood group is confirmed: *${bloodGroup}*.\n\nYour full test results are kept at ${facilityName || 'the blood bank'}. If you would like to ask about them, show your code there.\n\nThank you for donating!`;
}

// "LT-12345" / "lt 12345" (free test booking code shown to the donor) -> 'LT-12345', else null
function parseLabCode(text) {
  const m = /^LT-?\s?(\d{5})$/i.exec((text || '').trim());
  return m ? `LT-${m[1]}` : null;
}

// A lab has confirmed the blood group: "I don't know" no longer needs review.
// donor: { eligibility_status, screening_reasons, on_medication, chronic_condition, recent_illness, recent_tattoo_piercing }
function statusAfterBloodGroupConfirmed(donor) {
  let status = donor.eligibility_status;
  const reasons = (donor.screening_reasons || '').split(',').filter(r => r && r !== 'blood_type_unknown');
  if (status === 'needs_review') {
    const legacy = donor.screening_reasons == null; // registered with the old form: no reasons stored
    const legacyOk = !donor.on_medication && !donor.chronic_condition && !donor.recent_illness && !donor.recent_tattoo_piercing;
    if ((legacy && legacyOk) || (!legacy && reasons.length === 0)) status = 'eligible';
  }
  return { status, reasons: reasons.join(',') };
}

module.exports = { BLOOD_GROUPS, parseResultsRequest, normalizeBloodGroup, parseResultButton, neutralResultMessage, parseLabCode, statusAfterBloodGroupConfirmed };

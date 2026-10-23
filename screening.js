// Donor pre-screening rules (bot side only; the blood bank still does its own interview and Hb test).
// Source: WHO "Blood donor selection: guidelines on assessing donor suitability for blood donation" (2012),
// which Cameroonian blood banks cite alongside the national PNTS protocol. Age 18-60 and 50 kg follow
// current Cameroonian practice. Kept free of DB/network code so it can be unit-tested.

const MIN_AGE = 18;
const MAX_AGE = 60;
const MIN_WEIGHT_KG = 50;

// "Have you EVER had..." answers that rule a donor out (WHO: defer permanently)
const NOT_ELIGIBLE_EVER = ['hiv', 'hepatitis_bc', 'syphilis', 'sickle_cell', 'injected_drugs', 'heart_stroke', 'insulin_diabetes', 'bleeding_disorder', 'sex_work'];
// "EVER" answers WHO accepts in some cases (cancer >5y ago, epilepsy seizure-free 3y off medication): team decides
const REVIEW_EVER = ['cancer', 'epilepsy'];

// Recent events -> days to wait, counted from the day they register (we don't know the exact event date)
const RECENT_DEFERRAL_DAYS = {
  fever_2w: 14,          // non-specific fever / acute infection: 14 days after recovery
  antibiotics_2w: 14,    // 14 days after antibiotics
  tooth_7d: 7,           // 7 days after extraction
  vaccine_4w: 28,        // live vaccines: 28 days
  bp_med_change_4w: 28,  // new/changed blood pressure medicine: 28 days after BP is stable
  malaria_6m: 182,       // endemic areas: 6 months after treatment and full recovery
  tattoo_12m: 365,       // tattoo, piercing, scarification, acupuncture: 12 months
  surgery_12m: 365,      // major surgery: 12 months
  transfusion_12m: 365,  // received blood: 12 months
  jaundice_12m: 365,     // hepatitis A/E or unknown hepatitis: 12 months after recovery
  risky_partner_12m: 365,// former partner with HIV/hepatitis/high-risk behaviour: 12 months
  tb_2y: 730             // tuberculosis: 2 years after cure
};

// Women's health answers
const FEMALE_PAUSE = ['pregnant', 'breastfeeding']; // no end date we can know: paused until the donor updates her info
const FEMALE_DEFERRAL_DAYS = { birth_6m: 182 };     // 6 months after delivery, miscarriage or termination
const FEMALE_REVIEW = ['heavy_periods'];            // heavy bleeding with low Hb: blood bank checks Hb

function asList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value) return [value];
  return [];
}

function addDays(date, days) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Returns { status, deferredUntil, reasons }
//   status: 'eligible' | 'needs_review' | 'needs_update' | 'not_eligible'
//   deferredUntil: 'YYYY-MM-DD' or null (temporary wait; donor is matchable again after it)
function evaluateScreening(d, today = new Date()) {
  const reasons = [];
  let notEligible = false;
  let review = false;
  let pause = false;
  let deferDays = 0;

  const age = parseInt(d.age, 10);
  const weight = parseInt(d.weight_kg, 10);
  const female = d.gender === 'female';

  if (!isNaN(age) && age < MIN_AGE) {
    deferDays = Math.max(deferDays, (MIN_AGE - age) * 365);
    reasons.push('under_18');
  }
  if (!isNaN(age) && age > MAX_AGE) { notEligible = true; reasons.push('over_60'); }
  if (!isNaN(weight) && weight < MIN_WEIGHT_KG) { notEligible = true; reasons.push('under_50kg'); }
  if (isNaN(age) || isNaN(weight)) { review = true; reasons.push('missing_age_or_weight'); }

  for (const id of asList(d.ever_conditions)) {
    if (NOT_ELIGIBLE_EVER.includes(id)) { notEligible = true; reasons.push(id); }
    if (REVIEW_EVER.includes(id)) { review = true; reasons.push(id); }
  }

  for (const id of asList(d.recent_conditions)) {
    if (RECENT_DEFERRAL_DAYS[id]) {
      deferDays = Math.max(deferDays, RECENT_DEFERRAL_DAYS[id]);
      reasons.push(id);
    }
  }

  if (female) {
    for (const id of asList(d.women_health)) {
      if (FEMALE_PAUSE.includes(id)) { pause = true; reasons.push(id); }
      if (FEMALE_DEFERRAL_DAYS[id]) { deferDays = Math.max(deferDays, FEMALE_DEFERRAL_DAYS[id]); reasons.push(id); }
      if (FEMALE_REVIEW.includes(id)) { review = true; reasons.push(id); }
    }
  }

  // Older registration Flow (yes/no fields) and general answers: team reviews, as before
  if (d.on_medication === 'yes') { review = true; reasons.push('on_medication'); }
  if (d.chronic_condition === 'yes') { review = true; reasons.push('chronic_condition'); }
  if (d.recent_illness === 'yes') { review = true; reasons.push('recent_illness'); }
  if (d.recent_tattoo_piercing === 'yes') { review = true; reasons.push('recent_tattoo_piercing'); }
  if (!d.blood_type || d.blood_type === 'UNKNOWN') { review = true; reasons.push('blood_type_unknown'); }

  let status = 'eligible';
  if (notEligible) status = 'not_eligible';
  else if (pause) status = 'needs_update';
  else if (review) status = 'needs_review';

  return { status, deferredUntil: deferDays > 0 ? addDays(today, deferDays) : null, reasons };
}

module.exports = { evaluateScreening, MIN_AGE, MAX_AGE, MIN_WEIGHT_KG };

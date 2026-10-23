// Appointment slot helpers for partner lab bookings.
// Kept free of DB/network code so it can be unit-tested on its own.

// Cameroon is on West Africa Time: UTC+1 all year, no daylight saving.
const WAT_OFFSET_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_TIMES = ['09:00', '11:00', '14:00'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Next bookable slots (as UTC Dates) over `days` working days, Cameroon local time.
// Sundays are skipped; slots starting within `leadMinutes` from now are skipped.
function upcomingSlots(now = new Date(), { days = 3, times = DEFAULT_TIMES, leadMinutes = 120 } = {}) {
  const slots = [];
  const earliest = now.getTime() + leadMinutes * 60 * 1000;
  const localToday = new Date(now.getTime() + WAT_OFFSET_MS);
  let dayStart = Date.UTC(localToday.getUTCFullYear(), localToday.getUTCMonth(), localToday.getUTCDate());

  for (let found = 0; found < days; dayStart += DAY_MS) {
    if (new Date(dayStart).getUTCDay() === 0) continue;
    const daySlots = times
      .map(t => {
        const [h, m] = t.split(':').map(Number);
        return new Date(dayStart + (h * 60 + m) * 60 * 1000 - WAT_OFFSET_MS);
      })
      .filter(slot => slot.getTime() >= earliest);
    if (daySlots.length === 0) continue;
    slots.push(...daySlots);
    found++;
  }
  return slots;
}

// "Mon 26 Oct, 09:00" in Cameroon time
function formatSlot(date) {
  const local = new Date(new Date(date).getTime() + WAT_OFFSET_MS);
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mm = String(local.getUTCMinutes()).padStart(2, '0');
  return `${DAYS[local.getUTCDay()]} ${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]}, ${hh}:${mm}`;
}

// Interactive reply id for a slot: slot_<labId>_<minutes since epoch>
function slotId(labId, date) {
  return `slot_${labId}_${Math.round(new Date(date).getTime() / 60000)}`;
}

function parseSlotId(id) {
  const m = /^slot_(\d+)_(\d+)$/.exec(id || '');
  if (!m) return null;
  return { labId: parseInt(m[1], 10), slotAt: new Date(parseInt(m[2], 10) * 60000) };
}

module.exports = { upcomingSlots, formatSlot, slotId, parseSlotId };

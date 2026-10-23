// Donor deferral (wait period between donations) date helpers.
// Kept free of DB/network code so it can be unit-tested on its own.

const DAY_MS = 24 * 60 * 60 * 1000;

// Calendar day as a UTC timestamp, so time-of-day and DST never shift the count.
// pg returns DATE columns as a JS Date at local midnight; strings are 'YYYY-MM-DD'.
function toDayNumber(value) {
  if (typeof value === 'string') {
    const [y, m, d] = value.slice(0, 10).split('-').map(Number);
    return Date.UTC(y, m - 1, d) / DAY_MS;
  }
  const date = new Date(value);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

// Days left before the donor can be matched again (0 = can donate now).
// Must agree with the SQL filter: last_donation_date <= CURRENT_DATE - waitDays
function daysUntilEligible(lastDonationDate, waitDays, today = new Date()) {
  if (!lastDonationDate) return 0;
  const elapsed = toDayNumber(today) - toDayNumber(lastDonationDate);
  return Math.max(0, waitDays - elapsed);
}

module.exports = { daysUntilEligible };

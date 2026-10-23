// Admin command parsing (support/admin phones only). Kept free of DB/network code so it can be unit-tested.

// "+237 6 77 12 34 56" / "677123456" / "00237677123456" -> "237677123456" (WhatsApp wa_id format), else null
function normalizePhone(text) {
  let digits = String(text || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 9 && digits.startsWith('6')) digits = `237${digits}`; // Cameroon mobile typed without country code
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

const HELP_TEXT = [
  '🛠️ *LifeDrop admin commands*',
  '',
  '*stats* - analytics for the last 7 days',
  '*stats 30* - analytics for the last 30 days',
  '*hospitals* - list partner hospitals and labs',
  '*addhospital* Name | City | Staff phone',
  '*addlab* Name | City | Staff phone',
  '*removehospital* ID - stop a partner (keeps history)',
  '',
  'Example:',
  'addhospital Buea Regional Hospital | Buea | 677123456'
].join('\n');

// Returns { cmd, ... } for a known admin command, else null (the text then goes to the normal bot flow)
function parseAdminCommand(text) {
  const t = String(text || '').trim();

  let m = /^(?:stats|report)(?:\s+(\d{1,3}))?$/i.exec(t);
  if (m) return { cmd: 'stats', days: Math.min(parseInt(m[1], 10) || 7, 365) };

  if (/^(?:admin|admin help|commands)$/i.test(t)) return { cmd: 'help' };
  if (/^(?:hospitals|partners|facilities)$/i.test(t)) return { cmd: 'list' };

  m = /^remove(?:hospital|lab|partner)\s+#?(\d+)$/i.exec(t);
  if (m) return { cmd: 'remove', id: parseInt(m[1], 10) };

  m = /^add(hospital|lab|bloodbank)\s+(.+)$/i.exec(t);
  if (m) {
    const kind = m[1].toLowerCase();
    const parts = m[2].split('|').map(p => p.trim());
    const [name, city, phoneText] = parts;
    const phone = normalizePhone(phoneText);
    if (parts.length < 3 || !name || !city || !phone) {
      return { cmd: 'add_invalid', kind };
    }
    return {
      cmd: 'add',
      facility: {
        name,
        city,
        staff_phone: phone,
        type: kind === 'lab' ? 'lab' : kind === 'bloodbank' ? 'blood_bank' : 'hospital',
        does_blood_collection: kind !== 'lab',
        does_lab_tests: kind === 'lab'
      }
    };
  }
  return null;
}

module.exports = { normalizePhone, parseAdminCommand, HELP_TEXT };

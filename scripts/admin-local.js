// Open the dashboard on your computer with the REAL LifeDrop database, read-mostly and with WhatsApp sending blocked.
// 1. Put DATABASE_URL (from Neon or Render) in a .env file in this folder. 2. npm run admin:local
// 3. Open http://localhost:3100/admin. Broadcasts are turned off here; send them from the live dashboard on Render.
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is missing. Add it to the .env file in this folder (copy it from Neon or Render), then run again.');
  process.exit(1);
}

process.env.PORT = process.env.ADMIN_LOCAL_PORT || '3100';
process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'local-admin-key';
process.env.WABA_ID = process.env.WABA_ID || '1095708656227443';
process.env.BROADCASTS_DISABLED = 'true';
delete process.env.CS_PHONE_NUMBER; // no reports to the support phone from this laptop

// Never send WhatsApp messages from this laptop. Reading template status from Meta is allowed.
axios.post = async (url) => {
  console.log(`🚫 [local mode] blocked outgoing call: ${String(url).replace(/\?.*$/, '')}`);
  throw new Error('Sending is blocked in local mode');
};

// The live server on Render already sends appointment reminders: don't run a second copy here
const realSetInterval = global.setInterval;
global.setInterval = (fn, ms, ...args) => (fn && fn.name === 'sendAppointmentReminders' ? { unref() {} } : realSetInterval(fn, ms, ...args));

require('../server');
console.log(`\n🩸 LifeDrop dashboard on the REAL database: http://localhost:${process.env.PORT}/admin  (key: ${process.env.ADMIN_KEY === 'local-admin-key' ? 'local-admin-key' : 'your ADMIN_KEY'})`);
console.log('   WhatsApp sending is blocked. Approving donors and editing hospitals DO change the real database.\n');

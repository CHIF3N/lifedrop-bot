// In-memory Postgres (PGlite) behind the same query() interface as pg.Pool. For tests and local dashboard runs only.
const { PGlite } = require('@electric-sql/pglite');

// Base tables (created outside server.js in production) with every column the bot and dashboard read
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS donors (
    id SERIAL PRIMARY KEY, name TEXT, phone TEXT UNIQUE, country TEXT, blood_type TEXT, city TEXT, age INTEGER,
    weight_kg INTEGER, email TEXT, on_medication BOOLEAN, chronic_condition BOOLEAN, recent_illness BOOLEAN,
    recent_tattoo_piercing BOOLEAN, consent_given BOOLEAN, no_payment_ack BOOLEAN, eligibility_status TEXT,
    gender TEXT, deferred_until DATE, screening_reasons TEXT, last_donation_date DATE, last_inbound_at TIMESTAMP,
    community_link_sent BOOLEAN DEFAULT FALSE, verified_at TIMESTAMP, verified_by_facility_id INTEGER,
    lat DOUBLE PRECISION, lng DOUBLE PRECISION, location_updated_at TIMESTAMP, town TEXT, created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS requests (
    id SERIAL PRIMARY KEY, requester_phone TEXT, blood_type_needed TEXT, location TEXT, urgency TEXT,
    status TEXT DEFAULT 'open', hospital_name TEXT, units_needed INTEGER DEFAULT 1, lat DOUBLE PRECISION, lng DOUBLE PRECISION,
    town TEXT, facility_id INTEGER, patient_name TEXT, reason TEXT, contact_name TEXT, contact_phone TEXT,
    created_at TIMESTAMP DEFAULT NOW(), fulfilled_at TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS matches (
    id SERIAL PRIMARY KEY, request_id INTEGER, donor_id INTEGER, contacted_at TIMESTAMP DEFAULT NOW(), response TEXT,
    responded_at TIMESTAMP, donation_confirmed BOOLEAN, donation_confirmed_at TIMESTAMP, confirm_code TEXT,
    confirmed_by_facility_id INTEGER, result_blood_group TEXT, result_outcome TEXT, results_at TIMESTAMP, results_facility_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS facilities (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'hospital', city TEXT, region TEXT, address TEXT,
    latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, staff_phone TEXT, is_partner BOOLEAN DEFAULT FALSE,
    does_blood_collection BOOLEAN DEFAULT FALSE, does_lab_tests BOOLEAN DEFAULT FALSE, hours TEXT, is_demo BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS appointments (
    id SERIAL PRIMARY KEY, donor_phone TEXT NOT NULL, facility_id INTEGER NOT NULL, slot_at TIMESTAMPTZ NOT NULL,
    status TEXT DEFAULT 'booked', reminder_sent BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS feature_interest (
    phone TEXT NOT NULL, feature TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (phone, feature)
  );
`;

class PglitePool {
  constructor() {
    // int8 and numeric come back as strings, like node-postgres
    this.db = new PGlite({ parsers: { 20: (v) => v, 1700: (v) => v } });
  }

  async query(text, params) {
    if (params && params.length) return this.db.query(text, params);
    const results = await this.db.exec(text); // allows several statements, like pg's simple query
    return results[results.length - 1] || { rows: [] };
  }

  on() {}

  end() { return this.db.close(); }
}

async function createTestPool() {
  const pool = new PglitePool();
  await pool.query(SCHEMA);
  return pool;
}

module.exports = { PglitePool, createTestPool, SCHEMA };

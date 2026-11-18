// Creates the sign-in passcodes for the Nadia Group Staff Portal.
//
//   1 Director + 1 HR Manager + STAFF_COUNT staff slots (default 20).
//   Each slot gets its own random 8-digit passcode.
//   The passcodes are printed once and saved to passcodes.csv. They are NOT
//   stored anywhere readable afterwards, so keep that file safe (and never
//   commit it to GitHub; .gitignore already excludes it).
//
// Run (in this scripts folder):
//   npm install
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=... npm run create
//
// Running it again only creates slots that don't exist yet; it never changes
// existing passcodes. To replace someone's passcode, use "New passcode" in the
// app's Staff & settings page.

import { createClient } from '@supabase/supabase-js';
import { randomInt, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STAFF_COUNT = Number(process.env.STAFF_COUNT || 20);
if (!URL || !KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first (Supabase > Project Settings > API).');
  process.exit(1);
}

// Must match js/backend.js and supabase/functions/reset-passcode.
const PASS_DOMAIN = 'staff.nadia-portal.app';
const emailFor = (code) => 'p' + createHash('sha256').update('nadia-passcode:' + code).digest('hex').slice(0, 24) + '@' + PASS_DOMAIN;
const passwordFor = (code) => 'Nadia#' + code;

const DEF = { annual: 14, mc: 14, hospital: 60, emergency: 3, timeoff: 4, maternity: 98, paternity: 7, compassionate: 3, marriage: 3, replacement: 0, exam: 3, pilgrimage: 0 };
const slots = [
  { sid: 'DIR', role: 'director', entity: 'Head Office', label: 'Director' },
  { sid: 'HR', role: 'hr', entity: 'Head Office', label: 'HR Manager' },
  ...Array.from({ length: STAFF_COUNT }, (_, i) => ({ sid: 'S' + String(i + 1).padStart(2, '0'), role: 'staff', entity: null, label: 'Staff' }))
];

const sb = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const { data: existing, error: e1 } = await sb.from('members').select('sid');
if (e1) { console.error('Could not read members. Did you run supabase/schema.sql first?\n', e1.message); process.exit(1); }
const have = new Set(existing.map((m) => m.sid));

const used = new Set();
const newCode = () => { let c; do { c = String(randomInt(10000000, 100000000)); } while (used.has(c) || /^(\d)\1+$/.test(c)); used.add(c); return c; };

const rows = [];
for (const s of slots) {
  if (have.has(s.sid)) { console.log(`${s.sid.padEnd(4)} already exists, skipped`); continue; }
  let code, user;
  for (let tries = 0; tries < 5 && !user; tries++) {
    code = newCode();
    const { data, error } = await sb.auth.admin.createUser({ email: emailFor(code), password: passwordFor(code), email_confirm: true, user_metadata: { sid: s.sid } });
    if (!error) user = data.user; else if (!/already/i.test(error.message)) { console.error(s.sid, error.message); process.exit(1); }
  }
  const { error: e2 } = await sb.from('members').insert({ auth_uid: user.id, sid: s.sid, role: s.role });
  if (e2) { console.error(s.sid, e2.message); process.exit(1); }
  const { error: e3 } = await sb.from('docs').upsert({ col: 'staff', id: s.sid, data: { role: s.role, entity: s.entity, name: null, ...DEF } });
  if (e3) { console.error(s.sid, e3.message); process.exit(1); }
  rows.push([s.sid, s.label, code]);
  console.log(`${s.sid.padEnd(4)} ${s.label.padEnd(11)} ${code}`);
}

if (rows.length) {
  writeFileSync('passcodes.csv', 'Slot,Role,Passcode,Given to\n' + rows.map((r) => r.join(',') + ',').join('\n') + '\n');
  console.log(`\nSaved ${rows.length} passcodes to scripts/passcodes.csv. Hand them out privately, then delete the file.`);
} else console.log('\nNothing new to create.');

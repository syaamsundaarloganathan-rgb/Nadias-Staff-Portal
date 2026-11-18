// Supabase Edge Function: gives a staff slot a new 8-digit passcode.
// Only the HR Manager and the Director can call it (HR cannot reset the Director).
// Deploy:  supabase functions deploy reset-passcode
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// Must match js/backend.js and scripts/create-passcodes.mjs.
const PASS_DOMAIN = 'staff.nadia-portal.app';
async function emailFor(code: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('nadia-passcode:' + code));
  return 'p' + [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 24) + '@' + PASS_DOMAIN;
}
const passwordFor = (code: string) => 'Nadia#' + code;
function newCode() {
  const a = new Uint32Array(1);
  let c = '';
  do { crypto.getRandomValues(a); c = String(10000000 + (a[0] % 90000000)); } while (/^(\d)\1+$/.test(c));
  return c;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: { user } } = await asCaller.auth.getUser();
    if (!user) return json({ error: 'Not signed in' }, 401);

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const { data: caller } = await admin.from('members').select('sid,role').eq('auth_uid', user.id).maybeSingle();
    if (!caller || !['hr', 'director'].includes(caller.role)) return json({ error: 'Only HR or the Director can do this' }, 403);

    const { sid } = await req.json();
    const { data: target } = await admin.from('members').select('auth_uid,sid,role').eq('sid', sid).maybeSingle();
    if (!target) return json({ error: 'Unknown slot' }, 404);
    if (target.role === 'director' && caller.role !== 'director') return json({ error: 'Only the Director can reset this passcode' }, 403);
    if (target.sid === caller.sid) return json({ error: 'Ask the other manager to reset your own passcode' }, 403);

    for (let i = 0; i < 5; i++) {
      const code = newCode();
      const { error } = await admin.auth.admin.updateUserById(target.auth_uid, {
        email: await emailFor(code), password: passwordFor(code), email_confirm: true,
      });
      if (!error) {
        // Sign that person out everywhere, so the old passcode's sessions end too.
        await admin.rpc('revoke_sessions', { p_uid: target.auth_uid });
        return json({ passcode: code });
      }
      if (!/already|exists|registered/i.test(error.message)) return json({ error: error.message }, 500);
    }
    return json({ error: 'Could not find a free passcode, try again' }, 500);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

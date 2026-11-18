/* Nadia Group Staff Portal: data and sign-in layer.
   With a Supabase project in config.js the portal uses it (shared, real-time).
   Without one it runs in DEMO MODE: data stays in this browser only. */
(function () {
  'use strict';
  const cfg = window.NADIA_CONFIG || {};
  const DEMO = !(cfg.supabaseUrl && cfg.supabaseAnonKey);
  const PASS_DOMAIN = 'staff.nadia-portal.app';

  async function sha256hex(t) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  // A passcode maps to a hidden sign-in email and password. Keep these two
  // functions identical in scripts/create-passcodes.mjs and the reset function.
  async function emailFor(code) { return 'p' + (await sha256hex('nadia-passcode:' + code)).slice(0, 24) + '@' + PASS_DOMAIN; }
  function passwordFor(code) { return 'Nadia#' + code; }
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  const snap = (map) => ({ docs: [...map].map(([id, data]) => ({ id, exists: true, data: () => data })), metadata: { fromCache: false, hasPendingWrites: false } });

  /* ---------------- Supabase ---------------- */
  function supabaseBackend() {
    const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
    const subs = new Set();
    function collection(col) {
      return {
        doc: (id) => docRef(col, id || uid()),
        onSnapshot(next, onErr) {
          const map = new Map(); let alive = true, timer = null;
          const emit = () => { if (!alive) return; clearTimeout(timer); timer = setTimeout(() => alive && next(snap(map)), 40); };
          const load = async () => {
            const { data, error } = await sb.from('docs').select('id,data').eq('col', col).limit(5000);
            if (!alive) return;
            if (error) { onErr && onErr({ code: 'unavailable', message: error.message }); return; }
            map.clear(); data.forEach(r => map.set(r.id, r.data)); emit();
          };
          const ch = sb.channel('docs-' + col + '-' + uid())
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'docs', filter: 'col=eq.' + col }, p => { map.set(p.new.id, p.new.data); emit(); })
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'docs', filter: 'col=eq.' + col }, p => { map.set(p.new.id, p.new.data); emit(); })
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'docs' }, p => { if (p.old && p.old.col === col) { map.delete(p.old.id); emit(); } })
            .subscribe(status => { if (status === 'SUBSCRIBED') load(); });
          const onVis = () => { if (document.visibilityState === 'visible') load(); };
          document.addEventListener('visibilitychange', onVis);
          const poll = setInterval(load, 60000); // safety net if a live message is missed
          load();
          const stop = () => { alive = false; clearInterval(poll); document.removeEventListener('visibilitychange', onVis); sb.removeChannel(ch); subs.delete(stop); };
          subs.add(stop); return stop;
        }
      };
    }
    function docRef(col, id) {
      const fail = (e) => { throw { code: /row-level security|permission|not allowed|denied/i.test(e.message || '') ? 'invalid_argument' : 'unavailable', message: e.message }; };
      return {
        id,
        async set(data) { const { error } = await sb.from('docs').upsert({ col, id, data }); if (error) fail(error); },
        async update(patch) { const { error } = await sb.rpc('merge_doc', { p_col: col, p_id: id, p_patch: patch }); if (error) fail(error); },
        async delete() { const { error } = await sb.from('docs').delete().eq('col', col).eq('id', id); if (error) fail(error); }
      };
    }
    const db = {
      collection,
      doc(path) { const [col, id] = path.split('/'); return docRef(col, id); }
    };
    const auth = {
      demo: false,
      async memberFor(user) {
        const { data, error } = await sb.from('members').select('sid,role').eq('auth_uid', user.id).maybeSingle();
        if (error || !data) return null; return data;
      },
      async restore() { const { data } = await sb.auth.getSession(); if (!data.session) return null; return auth.memberFor(data.session.user); },
      async signIn(code) {
        const { data, error } = await sb.auth.signInWithPassword({ email: await emailFor(code), password: passwordFor(code) });
        if (error) return { error: /rate|too many/i.test(error.message) ? 'rate' : 'wrong' };
        const m = await auth.memberFor(data.user); if (!m) { await sb.auth.signOut(); return { error: 'wrong' }; }
        return m;
      },
      async signOut() { subs.forEach(s => s()); await sb.auth.signOut(); },
      async resetPasscode(sid) {
        const { data, error } = await sb.functions.invoke('reset-passcode', { body: { sid } });
        if (error || !data || !data.passcode) throw new Error((data && data.error) || (error && error.message) || 'failed');
        return data.passcode;
      }
    };
    const assets = {
      async upload(file) {
        const sid = window.__nadiaSid || 'unknown';
        const ext = (file.name && file.name.includes('.')) ? file.name.split('.').pop().toLowerCase() : (file.type === 'application/pdf' ? 'pdf' : 'jpg');
        const path = sid + '/' + uid() + '.' + ext;
        if (file.size > 10 * 1024 * 1024) throw { code: 'too_large' };
        const { error } = await sb.storage.from('slips').upload(path, file, { contentType: file.type || undefined });
        if (error) throw { code: /mime|type/i.test(error.message) ? 'unsupported_type' : 'upstream_error', message: error.message };
        return { id: path, url: '', contentType: file.type || (ext === 'pdf' ? 'application/pdf' : 'image/jpeg') };
      },
      async urlFor(id) { const { data } = await sb.storage.from('slips').createSignedUrl(id, 3600); return data ? data.signedUrl : ''; }
    };
    return { db, auth, assets };
  }

  /* ---------------- Demo (this browser only) ---------------- */
  function demoBackend() {
    const KEY = 'nadiaDemoDB-v1';
    const DEMO_CODES = { '11111111': 'DIR', '22222222': 'HR' };
    for (let i = 1; i <= 20; i++) DEMO_CODES[String(30000000 + i)] = 'S' + String(i).padStart(2, '0');
    const DEF = { annual: 14, mc: 14, hospital: 60, emergency: 3, timeoff: 4, maternity: 98, paternity: 7, compassionate: 3, marriage: 3, replacement: 0, exam: 3, pilgrimage: 0 };
    function seed() {
      const docs = { staff: {}, leaves: {}, tasks: {}, sales: {}, settings: {} };
      docs.staff.DIR = { role: 'director', entity: 'Head Office', name: null, ...DEF };
      docs.staff.HR = { role: 'hr', entity: 'Head Office', name: null, ...DEF };
      for (let i = 1; i <= 20; i++) docs.staff['S' + String(i).padStart(2, '0')] = { role: 'staff', entity: null, name: null, ...DEF };
      docs.settings.holidays = { list: (window.NADIA_HOLIDAYS || []) };
      return { docs };
    }
    let store;
    const load = () => { try { store = JSON.parse(localStorage.getItem(KEY)) || seed(); } catch (e) { store = seed(); } };
    load();
    const listeners = new Set();
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { throw { code: 'quota_exceeded' }; } listeners.forEach(l => l()); };
    window.addEventListener('storage', e => { if (e.key === KEY) { load(); listeners.forEach(l => l()); } });
    const tbl = (col) => (store.docs[col] = store.docs[col] || {});
    function docRef(col, id) {
      return {
        id,
        async set(data) { tbl(col)[id] = JSON.parse(JSON.stringify(data)); save(); },
        async update(patch) { if (!tbl(col)[id]) throw { code: 'invalid_argument' }; tbl(col)[id] = { ...tbl(col)[id], ...JSON.parse(JSON.stringify(patch)) }; save(); },
        async delete() { delete tbl(col)[id]; save(); }
      };
    }
    const db = {
      collection: (col) => ({
        doc: (id) => docRef(col, id || uid()),
        onSnapshot(next) {
          const fire = () => next(snap(new Map(Object.entries(tbl(col)))));
          const l = () => setTimeout(fire, 0); listeners.add(l); setTimeout(fire, 30);
          return () => listeners.delete(l);
        }
      }),
      doc(path) { const [col, id] = path.split('/'); return docRef(col, id); }
    };
    const auth = {
      demo: true, codes: DEMO_CODES,
      async restore() { const s = sessionStorage.getItem('nadiaDemoSid'); return s ? { sid: s, role: tbl('staff')[s]?.role } : null; },
      async signIn(code) { const sid = DEMO_CODES[code]; if (!sid) return { error: 'wrong' }; sessionStorage.setItem('nadiaDemoSid', sid); return { sid, role: tbl('staff')[sid].role }; },
      async signOut() { sessionStorage.removeItem('nadiaDemoSid'); },
      async resetPasscode(sid) { return Object.keys(DEMO_CODES).find(k => DEMO_CODES[k] === sid) + ' (demo passcodes never change)'; },
      resetDemo() { localStorage.removeItem(KEY); load(); listeners.forEach(l => l()); }
    };
    const assets = {
      async upload(file) {
        if (file.size > 1.5 * 1024 * 1024) throw { code: 'too_large' };
        const url = await new Promise((r, j) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = j; fr.readAsDataURL(file); });
        const id = 'demo-' + uid(); tbl('_files')[id] = url; save();
        return { id, url, contentType: file.type || 'image/jpeg' };
      },
      async urlFor(id) { return tbl('_files')[id] || ''; }
    };
    return { db, auth, assets };
  }

  const be = DEMO || !window.supabase ? demoBackend() : supabaseBackend();
  if (!DEMO && !window.supabase) console.warn('Supabase library did not load; running in demo mode.');

  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000); return { status: 'saved' };
    }
  };
  window.NADIA_AUTH = be.auth;
  window.NADIA_DEMO = be.auth.demo;
  // Same interface the portal used inside Claude, so the app code stays the same.
  window.claude = {
    use: async (name) => ({
      db: be.db, assets: be.assets, downloads,
      user: { can: () => true }, sample: null
    })[name] ?? null
  };
})();

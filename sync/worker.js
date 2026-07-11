/* SCI BAM — synchro multi-appareils + comptes multi-utilisateurs (Cloudflare Worker + KV)
 *
 * v2 (2026-07-11) : comptes e-mail + mot de passe, validation admin, profils clonables.
 *
 * Bindings (dashboard Cloudflare ou wrangler.toml) :
 *   - KV namespace     : SCIBAM
 *   - Variable (texte) : ALLOW_ORIGIN = https://gmagnies-lgtm.github.io
 *   - Secret           : SYNC_TOKEN   = code de synchro historique de Guillaume (= admin)
 *
 * Clés KV :
 *   state          -> blob de données de Guillaume (héritage v1, inchangé)
 *   user:<email>   -> { salt, hash, iter, name, status: pending|approved|rejected, loadFrom?, createdAt, ... }
 *   sess:<token>   -> email (TTL 30 j)
 *   data:<email>   -> blob de données de l'utilisateur { status, notes, pricehist, gone, crm, updatedAt }
 *   reset:<email>  -> demande de réinitialisation de mot de passe (TTL 7 j, traitée par l'admin)
 *
 * Auth des routes :
 *   - token de session (issu de /auth/login) OU code de synchro historique (SYNC_TOKEN = Guillaume/admin).
 *   - routes /admin/* : SYNC_TOKEN uniquement (ou session d'un compte marqué admin).
 *
 * NB sécurité : les mots de passe ne sont JAMAIS stockés ni renvoyés en clair (hash PBKDF2, sel par compte).
 * « Mot de passe oublié » = demande visible par l'admin, qui génère un mot de passe temporaire.
 */
const KEY = 'state';                       // données historiques de Guillaume
const ADMIN_EMAIL = 'gmagnies@gmail.com';
const PBKDF2_ITER = 10000;                 // natif WebCrypto : rapide, suffisant pour ce niveau de sensibilité
const SESS_TTL = 60 * 60 * 24 * 30;        // 30 jours

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)).buffer);

async function pbkdf2(pw, saltHex, iter) {
  const salt = Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, key, 256));
}
const normEmail = (e) => String(e || '').trim().toLowerCase();
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const dataKey = (email) => email === ADMIN_EMAIL ? KEY : 'data:' + email;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store'
    };
    const json = (o, s = 200) =>
      new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...cors } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const body = (req.method === 'PUT' || req.method === 'POST') ? await req.json().catch(() => ({})) : {};
    const token = body.token || url.searchParams.get('token') || '';

    // — résolution du token : legacy (Guillaume) ou session —
    const isLegacy = env.SYNC_TOKEN && token === env.SYNC_TOKEN;
    let sessEmail = null;
    if (!isLegacy && token) sessEmail = await env.SCIBAM.get('sess:' + token);
    const getUser = async (email) => JSON.parse((await env.SCIBAM.get('user:' + email)) || 'null');
    const isAdmin = async () => {
      if (isLegacy) return true;
      if (!sessEmail) return false;
      const u = await getUser(sessEmail);
      return !!(u && u.admin);
    };

    // ============ AUTH ============
    if (url.pathname === '/auth/signup' && req.method === 'POST') {
      const email = normEmail(body.email), pw = String(body.password || ''), name = String(body.name || '').trim().slice(0, 60);
      if (!emailOk(email)) return json({ error: 'email_invalide' }, 400);
      if (pw.length < 6) return json({ error: 'mdp_trop_court' }, 400);
      if (await env.SCIBAM.get('user:' + email)) return json({ error: 'compte_existant' }, 409);
      const salt = randHex(16);
      const user = {
        salt, iter: PBKDF2_ITER, hash: await pbkdf2(pw, salt, PBKDF2_ITER),
        name: name || email.split('@')[0],
        status: email === ADMIN_EMAIL ? 'approved' : 'pending',
        admin: email === ADMIN_EMAIL,
        loadFrom: body.loadFrom === 'guillaume' ? ADMIN_EMAIL : null,
        createdAt: Date.now()
      };
      await env.SCIBAM.put('user:' + email, JSON.stringify(user));
      return json({ ok: true, pending: user.status === 'pending' });
    }

    if (url.pathname === '/auth/login' && req.method === 'POST') {
      const email = normEmail(body.email), pw = String(body.password || '');
      const u = await getUser(email);
      if (!u) return json({ error: 'inconnu' }, 401);
      if ((await pbkdf2(pw, u.salt, u.iter)) !== u.hash) return json({ error: 'mdp' }, 401);
      if (u.status === 'pending') return json({ error: 'en_attente' }, 403);
      if (u.status !== 'approved') return json({ error: 'refuse' }, 403);
      const t = randHex(24);
      await env.SCIBAM.put('sess:' + t, email, { expirationTtl: SESS_TTL });
      if (u.mustChange) { /* mot de passe temporaire : l'app invitera à le changer */ }
      return json({ ok: true, token: t, name: u.name, email, admin: !!u.admin, mustChange: !!u.mustChange });
    }

    if (url.pathname === '/auth/logout' && req.method === 'POST') {
      if (token && !isLegacy) await env.SCIBAM.delete('sess:' + token);
      return json({ ok: true });
    }

    if (url.pathname === '/auth/password' && req.method === 'POST') {   // changer SON mot de passe (connecté)
      if (!sessEmail) return json({ error: 'unauthorized' }, 401);
      const pw = String(body.newPassword || '');
      if (pw.length < 6) return json({ error: 'mdp_trop_court' }, 400);
      const u = await getUser(sessEmail);
      u.salt = randHex(16); u.iter = PBKDF2_ITER; u.hash = await pbkdf2(pw, u.salt, u.iter); delete u.mustChange;
      await env.SCIBAM.put('user:' + sessEmail, JSON.stringify(u));
      return json({ ok: true });
    }

    if (url.pathname === '/auth/reset-request' && req.method === 'POST') {   // « mot de passe oublié »
      const email = normEmail(body.email);
      if (await env.SCIBAM.get('user:' + email))
        await env.SCIBAM.put('reset:' + email, JSON.stringify({ at: Date.now() }), { expirationTtl: 60 * 60 * 24 * 7 });
      return json({ ok: true });   // réponse identique que le compte existe ou non (pas de fuite)
    }

    // ============ ADMIN ============
    if (url.pathname.startsWith('/admin/')) {
      if (!(await isAdmin())) return json({ error: 'unauthorized' }, 401);

      if (url.pathname === '/admin/users' && req.method === 'GET') {
        const out = [];
        const list = await env.SCIBAM.list({ prefix: 'user:' });
        for (const k of list.keys) {
          const u = JSON.parse((await env.SCIBAM.get(k.name)) || '{}');
          const email = k.name.slice(5);
          out.push({
            email, name: u.name, status: u.status, admin: !!u.admin, createdAt: u.createdAt,
            loadFrom: u.loadFrom || null,
            resetRequested: !!(await env.SCIBAM.get('reset:' + email))
          });
        }
        return json({ users: out });
      }

      if (url.pathname === '/admin/approve' && req.method === 'POST') {
        const email = normEmail(body.email);
        const u = await getUser(email);
        if (!u) return json({ error: 'inconnu' }, 404);
        u.status = body.ok ? 'approved' : 'rejected';
        u.approvedAt = Date.now();
        await env.SCIBAM.put('user:' + email, JSON.stringify(u));
        // clonage du profil demandé à l'inscription : on copie les TRIS (statuts + disparues),
        // pas les notes ni le CRM (personnels)
        if (body.ok && u.loadFrom) {
          const src = JSON.parse((await env.SCIBAM.get(dataKey(u.loadFrom))) || '{}');
          const dst = JSON.parse((await env.SCIBAM.get(dataKey(email))) || '{}');
          dst.status = Object.assign({}, src.status || {}, dst.status || {});
          dst.gone = Object.assign({}, src.gone || {}, dst.gone || {});
          dst.updatedAt = Date.now();
          await env.SCIBAM.put(dataKey(email), JSON.stringify(dst));
        }
        return json({ ok: true, status: u.status });
      }

      if (url.pathname === '/admin/setpass' && req.method === 'POST') {   // mot de passe temporaire (après « oublié »)
        const email = normEmail(body.email);
        const u = await getUser(email);
        if (!u) return json({ error: 'inconnu' }, 404);
        const tmp = body.password || (randHex(4) + '-' + randHex(4));
        u.salt = randHex(16); u.iter = PBKDF2_ITER; u.hash = await pbkdf2(tmp, u.salt, u.iter); u.mustChange = true;
        await env.SCIBAM.put('user:' + email, JSON.stringify(u));
        await env.SCIBAM.delete('reset:' + email);
        return json({ ok: true, tempPassword: tmp });   // affiché à l'admin, à transmettre à la personne
      }
      return json({ error: 'not_found' }, 404);
    }

    // ============ DONNÉES (synchro) ============
    const authedEmail = isLegacy ? ADMIN_EMAIL : sessEmail;

    if (url.pathname === '/data' && req.method === 'GET') {
      if (!authedEmail) return json({ error: 'unauthorized' }, 401);
      return json(JSON.parse((await env.SCIBAM.get(dataKey(authedEmail))) || '{}'));
    }
    if (url.pathname === '/data' && req.method === 'PUT') {
      if (!authedEmail) return json({ error: 'unauthorized' }, 401);
      const state = {
        status: body.status || {}, notes: body.notes || {}, pricehist: body.pricehist || {},
        gone: body.gone || {}, crm: body.crm || {}, updatedAt: Date.now()
      };
      await env.SCIBAM.put(dataKey(authedEmail), JSON.stringify(state));
      return json({ ok: true, updatedAt: state.updatedAt });
    }
    return json({ error: 'not_found' }, 404);
  }
};

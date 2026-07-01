/* SCI BAM — synchro multi-appareils (Cloudflare Worker + KV)
 *
 * Stocke un unique blob JSON { status, notes, pricehist, updatedAt } partagé entre
 * le téléphone et l'ordinateur. L'app le lit à la connexion et l'écrit à chaque changement.
 *
 * Bindings à configurer dans le dashboard Cloudflare (Worker > Settings) :
 *   - KV namespace        : variable  SCIBAM   (créer un namespace, ex. "sci-bam-sync")
 *   - Variable (texte)    : ALLOW_ORIGIN  = https://gmagnies-lgtm.github.io
 *   - Secret              : SYNC_TOKEN    = openssl rand -hex 24  (même valeur que SYNC.token dans index.html)
 *
 * Routes :
 *   GET /data?token=...          -> renvoie le blob (ou {})
 *   PUT /data  body {token,...}  -> enregistre status / notes / pricehist
 */
const KEY = 'state';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store'
    };
    const json = (o, s = 200) =>
      new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...cors } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const ok = (t) => env.SYNC_TOKEN && t === env.SYNC_TOKEN;

    if (url.pathname === '/data' && req.method === 'GET') {
      if (!ok(url.searchParams.get('token'))) return json({ error: 'unauthorized' }, 401);
      return json(JSON.parse((await env.SCIBAM.get(KEY)) || '{}'));
    }
    if (url.pathname === '/data' && req.method === 'PUT') {
      const b = await req.json().catch(() => ({}));
      if (!ok(b.token)) return json({ error: 'unauthorized' }, 401);
      const state = {
        status: b.status || {}, notes: b.notes || {}, pricehist: b.pricehist || {},
        gone: b.gone || {}, crm: b.crm || {}, updatedAt: Date.now()
      };
      await env.SCIBAM.put(KEY, JSON.stringify(state));
      return json({ ok: true, updatedAt: state.updatedAt });
    }
    return json({ error: 'not_found' }, 404);
  }
};

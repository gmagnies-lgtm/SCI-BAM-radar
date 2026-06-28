# Synchro multi-appareils — installation (Cloudflare, ~10 min)

Synchronise classements (à contacter/conserver/archiver), notes et historique des prix
entre le téléphone et l'ordinateur. Stockage : un petit JSON dans Cloudflare KV.

## 1. Worker

1. https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Create Worker** →
   nom `sci-bam-sync` → **Deploy**.
2. **Edit code** → coller `worker.js` → **Deploy**.

## 2. Stockage KV + variables

3. **Storage & Databases → KV** → **Create namespace** : `sci-bam-sync`.
4. Worker → **Settings → Bindings → Add → KV namespace** : variable **`SCIBAM`** → ce namespace.
5. Worker → **Settings → Variables and Secrets** :
   - Variable texte **`ALLOW_ORIGIN`** = `https://gmagnies-lgtm.github.io`
   - **Secret** **`SYNC_TOKEN`** = un secret fort (`openssl rand -hex 24`).
6. Noter l'URL du Worker : `https://sci-bam-sync.<sous-domaine>.workers.dev`

## 3. Brancher l'app

- L'**URL du Worker** (non secrète) va dans `index.html`, objet `const SYNC = { url: '…' }` (Claude le fait).
- Le **code de synchro** (= le Secret `SYNC_TOKEN`) **ne va PAS dans le dépôt**. Tu le saisis une fois
  par appareil dans l'app : panneau **« Sources & filtres » → champ « Code de synchro »**. Il est stocké
  en local (localStorage) et jamais publié.

À la connexion, l'app lit l'état distant et le fusionne ; chaque changement est renvoyé
automatiquement. Mets le même code sur le téléphone et l'ordinateur → tout converge.

## Notes
- Le code de synchro reste hors du dépôt public (stocké localement par appareil). Le dépôt ne
  contient que l'URL du Worker.
- Fusion « le plus récent gagne » par clé ; conçu pour un seul utilisateur sur plusieurs appareils.
- Données = classements/notes d'annonces publiques (sensibilité faible).

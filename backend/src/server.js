'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { getSecret } = require('./vaultClient');

const app = express();
app.use(express.json());

// Rempli depuis Vault au démarrage — jamais en dur ni en variable d'environnement
let prisma;
let jwtSecret;
let appUrl;
let oauthClientId;
let oauthClientSecret;

// ─── Démarrage : lecture des secrets dans Vault, connexion à la DB ───────────
async function init() {
  console.log('[init] Lecture des secrets depuis Vault...');

  // Chemins KV v2 (écrits par vault-init au démarrage) :
  //   secret/data/database → { DB_USER, DB_PASSWORD, DB_NAME }
  //   secret/data/app      → { NEXTAUTH_SECRET, NEXTAUTH_URL, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET }
  const dbCreds    = await getSecret('secret/data/database');
  const appSecrets = await getSecret('secret/data/app');

  // Dans le projet d'équipe, Next.js utilise NEXTAUTH_SECRET pour signer les sessions.
  // Ici, on l'utilise comme clé de signature JWT.
  jwtSecret         = appSecrets.NEXTAUTH_SECRET;
  appUrl            = appSecrets.NEXTAUTH_URL;
  oauthClientId     = appSecrets.OAUTH_CLIENT_ID;
  oauthClientSecret = appSecrets.OAUTH_CLIENT_SECRET;
  console.log('[init] Secrets chargés depuis Vault');

  // Prisma attend DATABASE_URL : on la construit avec les identifiants venant de Vault
  process.env.DATABASE_URL = `postgresql://${dbCreds.DB_USER}:${dbCreds.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${dbCreds.DB_NAME}`;

  prisma = new PrismaClient();
  await prisma.$connect(); // vérifie que la connexion fonctionne
  console.log('[init] Base de données connectée');
}

// ─── Middleware : vérifie le JWT sur les routes protégées ────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check — utilisé par le healthcheck Docker et pour tester le WAF
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Inscription — le mot de passe est haché avec bcrypt (coût 12) avant stockage
app.post('/api/auth/register', async (req, res) => {
  const { email, username, password } = req.body;

  if (!email || !username || !password) {
    return res.status(400).json({ error: 'email, username and password are required' });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { email, username, password_hash: hash },
      select: { id: true, email: true, username: true },
    });
    res.status(201).json({ user });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Email already registered' });
    console.error('[register]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Connexion — renvoie un JWT signé en cas de succès
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } });

    // Même message pour "utilisateur inconnu" et "mauvais mot de passe" — évite l'énumération
    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      jwtSecret,         // lu dans Vault — jamais en dur
      { expiresIn: '24h' }
    );

    res.json({ token, user: { id: user.id, email: user.email, username: user.username } });
  } catch (err) {
    console.error('[login]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Informations de l'utilisateur courant (route protégée — JWT valide requis)
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, username: true, created_at: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    console.error('[me]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── OAuth GitHub — helpers HTTP ─────────────────────────────────────────────

// POST JSON vers une URL, renvoie la réponse parsée
// (échange du "code" contre un access_token)
async function httpsPost(url, data) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    },
    body: JSON.stringify(data),
  });
  const raw = await res.text();
  try { return JSON.parse(raw); } catch { return raw; }
}

// GET authentifié avec l'access_token de l'utilisateur
async function httpsGet(url, token) {
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/json',
      'User-Agent':    'ft_transcendence-waf-lab', // GitHub exige un User-Agent
    },
  });
  const raw = await res.text();
  try { return JSON.parse(raw); } catch { return raw; }
}

// ─── OAuth GitHub — routes ───────────────────────────────────────────────────

// Étape 1 : redirection vers l'écran d'autorisation GitHub
app.get('/api/auth/github', (_req, res) => {
  const params = new URLSearchParams({
    client_id: oauthClientId,
    // Doit correspondre exactement à l'URL déclarée dans l'OAuth App GitHub
    redirect_uri: `${appUrl}/api/auth/github/callback`,
    scope: 'user:email',
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

// Étape 2 : GitHub revient ici avec ?code=XXXX (usage unique, valable 10 min)
app.get('/api/auth/github/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=missing_code');

  try {
    // Étape 3 : échange du code contre un access_token
    // Le client_secret reste côté serveur, il n'est jamais envoyé au navigateur
    const tokenRes = await httpsPost('https://github.com/login/oauth/access_token', {
      client_id:     oauthClientId,
      client_secret: oauthClientSecret,
      code,
    });

    const accessToken = tokenRes.access_token;
    if (!accessToken) {
      console.error('[github-callback] GitHub n\'a pas renvoyé d\'access_token:', tokenRes);
      return res.redirect('/?error=oauth_failed');
    }

    // Étape 4 : identité de l'utilisateur GitHub
    const ghUser = await httpsGet('https://api.github.com/user', accessToken);

    // L'email peut être privé : dans ce cas on le demande à /user/emails
    let email = ghUser.email;
    if (!email) {
      const emails = await httpsGet('https://api.github.com/user/emails', accessToken);
      const primary = Array.isArray(emails) && emails.find((e) => e.primary && e.verified);
      email = primary?.email;
    }

    if (!email) return res.redirect('/?error=no_email');

    // Étape 5 : recherche par github_id (l'email peut changer côté GitHub)
    let user = await prisma.user.findUnique({ where: { github_id: ghUser.id } });

    if (!user) {
      // Refuse de lier automatiquement un compte email/mot de passe existant
      const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (existing) return res.redirect('/?error=email_taken');

      // Utilisateur OAuth : pas de password_hash
      user = await prisma.user.create({
        data: { email, username: ghUser.login, github_id: ghUser.id },
      });
      console.log(`[github-callback] Nouvel utilisateur (github_id: ${ghUser.id})`);
    } else {
      console.log(`[github-callback] Connexion existante (github_id: ${ghUser.id})`);
    }

    // Étape 6 : même JWT que pour le login classique
    const token = jwt.sign({ id: user.id, email: user.email }, jwtSecret, { expiresIn: '24h' });

    // Le frontend lit le token dans l'URL, le stocke puis nettoie l'URL
    res.redirect(`/?token=${token}`);

  } catch (err) {
    console.error('[github-callback]', err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// ─── Démarrage du serveur ────────────────────────────────────────────────────
init()
  .then(() => {
    app.listen(3000, () => console.log('[server] En écoute sur le port 3000'));
  })
  .catch((err) => {
    console.error('[init] Échec du démarrage:', err.message);
    process.exit(1);
  });

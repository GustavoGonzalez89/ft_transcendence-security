'use strict';

// Ce fichier est exécuté par Next.js une seule fois avant le démarrage du serveur.
// Il lit les secrets depuis Vault et les injecte dans process.env
// pour que Prisma et NextAuth puissent les utiliser normalement.

const { getSecret } = require('./srcs/lib/vaultClient.js');

export async function register() {
  if (!process.env.VAULT_ADDR) {
    console.log('[instrumentation] VAULT_ADDR non défini — utilisation des variables d\'environnement directes');
    return;
  }

  try {
    console.log('[instrumentation] Lecture des secrets depuis Vault...');

    const db = await getSecret('secret/data/database');
    process.env.DATABASE_URL = `postgresql://${db.DB_USER}:${db.DB_PASSWORD}@db:5432/${db.DB_NAME}`;

    const app = await getSecret('secret/data/app');
    process.env.NEXTAUTH_SECRET        = app.NEXTAUTH_SECRET;
    process.env.NEXTAUTH_URL           = app.NEXTAUTH_URL;
    process.env.GOOGLE_CLIENT_ID       = app.GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET   = app.GOOGLE_CLIENT_SECRET;
    process.env.FORTYTWO_CLIENT_ID     = app.FORTYTWO_CLIENT_ID;
    process.env.FORTYTWO_CLIENT_SECRET = app.FORTYTWO_CLIENT_SECRET;

    console.log('[instrumentation] Secrets chargés avec succès depuis Vault');
  } catch (err) {
    console.error('[instrumentation] Erreur lors de la lecture des secrets Vault:', err.message);
    process.exit(1);
  }
}

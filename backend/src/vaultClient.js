'use strict';

// Client Vault KV v2 utilisant le module http natif de Node (aucune dépendance externe).
//
// Convention des chemins KV v2 :
//   Écriture : vault kv put secret/database ...  → stocké en interne à secret/data/database
//   Lecture  : GET /v1/secret/data/database      → réponse : { data: { data: { key: val } } }
//
// Le double "data.data" est la structure KV v2 :
//   - data externe = enveloppe de métadonnées
//   - data interne = les paires clé-valeur réellement stockées

const http = require('http');
const fs   = require('fs');

function getVaultToken() {
  return fs.readFileSync('/vault/data/root-token.txt', 'utf8').trim();
}

function getSecret(path) {
  const addr = new URL(process.env.VAULT_ADDR);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: addr.hostname,
        port: parseInt(addr.port, 10) || 8200,
        path: `/v1/${path}`,
        method: 'GET',
        headers: { 'X-Vault-Token': getVaultToken() },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          const parsed = JSON.parse(body);
          if (res.statusCode !== 200) {
            reject(new Error(`Vault a retourné ${res.statusCode}: ${JSON.stringify(parsed.errors)}`));
          } else {
            resolve(parsed.data.data); // KV v2 : les vraies paires clé-valeur
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// Réessaie jusqu'à `attempts` fois avec 2 secondes entre chaque tentative.
// Nécessaire car vault-init peut encore écrire les secrets quand le backend démarre.
async function getSecretWithRetry(path, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await getSecret(path);
    } catch (err) {
      if (i === attempts - 1) throw err;
      console.log(`[vault] Tentative ${i + 1}/${attempts} pour '${path}': ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

module.exports = { getSecret: getSecretWithRetry };

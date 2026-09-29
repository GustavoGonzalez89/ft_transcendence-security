# ft_transcendence-security — WAF ModSecurity + HashiCorp Vault

Ma partie du projet **ft_transcendence** (École 42 Paris) : le module de sécurité de l'application d'équipe *Echo of Morse*.

- **WAF** : ModSecurity + OWASP Core Rule Set en reverse proxy TLS devant l'application.
- **Gestion des secrets** : HashiCorp Vault en mode serveur (stockage chiffré sur disque), initialisé, descellé et alimenté automatiquement au démarrage.
- **Intégration docker-compose** : ordre de démarrage, volumes, réseau interne, exceptions WAF pour les faux positifs.

> **Projet d'équipe** : [bonbonkeai/42_transcendence](https://github.com/bonbonkeai/42_transcendence)
> Ce dépôt ne contient **que ma partie**. Le code applicatif de l'équipe (Next.js, Socket.IO, jeu, chat…) n'est pas publié ici. Pour pouvoir démontrer le WAF et Vault seuls, ils sont branchés sur un petit backend de démonstration (Express + Prisma) que j'ai écrit pour m'entraîner avant l'intégration.

---

## Architecture

```
                 Navigateur
                     │  https://localhost:8443   (http://…:8080 → redirection HTTPS)
                     ▼
     ┌──────────────────────────────────┐
     │ waf  ModSecurity + OWASP CRS 3.3 │  TLS (certificat autosigné)
     │      PARANOIA=1, seuil entrant 5 │  bloque SQLi, XSS, LFI, RCE… → 403
     └────────────────┬─────────────────┘
                      ▼
     ┌──────────────────────────────────┐
     │ frontend  Nginx                  │  fichiers statiques + proxy /api/*
     └────────────────┬─────────────────┘
                      ▼
     ┌──────────────────────────────────┐        ┌───────────────────────────┐
     │ backend  Express + Prisma        │──GET──▶│ vault  HashiCorp Vault    │ :8200
     │  lit ses secrets dans Vault      │        │  KV v2 : secret/database  │ (exposé,
     │  au démarrage                    │        │          secret/app       │  voir limites)
     └────────────────┬─────────────────┘        └──────▲─────────────▲──────┘
                      ▼                                 │ init/unseal │ kv put
     ┌──────────────────────────────────┐        ┌──────┴──────┐ ┌────┴───────┐
     │ db  PostgreSQL 15                │        │ vault-unseal│ │ vault-init │
     └──────────────────────────────────┘        └─────────────┘ └────────────┘
                     réseau bridge interne « app-net »
```

Ports publiés sur l'hôte : **8080 / 8443** (WAF) et **8200** (Vault). `frontend`, `backend` et `db` n'ont aucun port publié.

---

## Ce que j'ai mis en place

### 1. WAF — ModSecurity + OWASP CRS

`docker-compose.yml`, service `waf` :

| Paramètre | Valeur | Rôle |
|---|---|---|
| Image | `owasp/modsecurity-crs:3.3.9-nginx-202606290906` | version figée (plus de `:latest`) |
| `MODSEC_RULE_ENGINE` | `On` | bloque (et pas seulement journalise) |
| `PARANOIA` | `1` | niveau CRS par défaut, peu de faux positifs |
| `ANOMALY_INBOUND` / `OUTBOUND` | `5` / `4` | seuils du scoring d'anomalies |
| `NGINX_ALWAYS_TLS_REDIRECT` | `on` | HTTP 8080 → HTTPS 8443 |
| Certificat | `certs/cert.pem`, `certs/key.pem` | généré par `make certs` (openssl, sans sudo) |

**Exceptions ciblées pour les faux positifs** (`waf/modsecurity/`, `integration-echo-of-morse/modsecurity/`) — chaque exception retire *une* règle, sur *un* chemin quand c'est possible, au lieu de baisser le niveau global :

| Fichier | Règle CRS retirée | Pourquoi |
|---|---|---|
| `lan-ip-access-exception.conf` | 920350 (Host = IP) partout, 931100 (RFI) sur `/api/auth/` | accès par IP LAN (`https://192.168.x.x:8443`) : login bloqué en 403 |
| `socket-io-exception.conf` | 920420 sur `/socket.io/` | Socket.IO envoie ses POST de polling en `text/plain` |
| `google-oauth-exception.conf` | 930120 sur `/api/auth/callback/google` | le scope `userinfo.profile` est détecté comme accès à `~/.profile` (LFI) |

Seule l'exception LAN est montée dans ce stack minimal ; les deux autres ne concernent que l'application d'équipe (Socket.IO, OAuth Google).

### 2. Vault — secrets hors du code et hors de l'environnement du backend

- **Mode serveur**, pas `-dev` : stockage `file` dans le volume nommé `vault_data` (`vault/config/local.json`).
- **`vault-unseal`** (`vault/scripts/vault-unseal.sh`) :
  - premier démarrage : `vault operator init` (5 clés, seuil 3), écrit dans un fichier temporaire puis renommé → jamais de fichier de clés vide ou partiel ;
  - 5 tentatives d'init avec `chown` avant chaque essai (course au premier démarrage sur les permissions du volume) ;
  - détecte un `init-keys.txt` invalide ou des clés vides et s'arrête avec un message clair au lieu de boucler ;
  - descelle avec 3 clés, écrit `root-token.txt`, puis **surveille Vault toutes les 30 s** et le redescelle s'il a redémarré (Vault redémarre toujours scellé).
- **`vault-init`** (one-shot) : attend le token et le déscellement, active KV v2 sur `secret/`, écrit `secret/database` et `secret/app` à partir du `.env`.
- **Backend** : son bloc `environment` ne contient que `VAULT_ADDR`, `DB_HOST`, `DB_PORT`. Au démarrage, `backend/src/vaultClient.js` (module `http` natif, sans dépendance, 5 tentatives espacées de 2 s) lit les secrets ; `server.js` construit `DATABASE_URL` pour Prisma et récupère la clé de signature JWT. Il ne démarre qu'après `vault-init` terminé avec succès (`service_completed_successfully`).

### 3. Intégration dans le projet d'équipe

`integration-echo-of-morse/` contient ce que j'ai intégré dans l'application Next.js de l'équipe :

- `docker-compose.extrait.yml` : les services `waf`, `vault`, `vault-unseal`, `vault-init` tels qu'ils sont dans le compose d'équipe ;
- `instrumentation.js` : hook Next.js exécuté une fois au démarrage, qui lit Vault et remplit `process.env` pour Prisma et NextAuth (une ligne a ensuite été retirée par un coéquipier lors de la suppression de l'OAuth GitHub) ;
- `vaultClient.js` : le même client KV v2 ;
- les trois exceptions ModSecurity.

### 4. Backend de démonstration (Express + Prisma)

`backend/src/server.js` : inscription (bcrypt, coût 12), login (JWT 24 h signé avec la clé venant de Vault, même message d'erreur pour email inconnu et mauvais mot de passe), `/api/me` protégé, OAuth GitHub facultatif. Requêtes via Prisma (paramétrées). Le frontend (`frontend/src/`) inclut un panneau qui envoie des attaques connues pour voir le WAF répondre 403.

---

## Lancer / tester

Prérequis : Docker + Docker Compose v2, `openssl`, `curl`, `make`.

```bash
cp .env.example .env        # puis remplir POSTGRES_PASSWORD et NEXTAUTH_SECRET
make                        # génère le certificat puis docker compose up -d --build
make ps                     # tous les services "running", vault-init "exited (0)"
```

Application : <https://localhost:8443> (accepter le certificat autosigné).

**Tester le WAF** :

```bash
make test-waf
# clean        : 200
# SQLi         : 403
# XSS          : 403
# Path travers.: 403
# Cmd inject.  : 403
```

Journal des blocages : `docker compose logs waf | grep -i modsecurity`.

**Vérifier Vault** :

```bash
docker compose logs vault-unseal vault-init   # init, déscellement, secrets chargés
docker compose logs backend | grep init       # "Secrets chargés depuis Vault"
make secrets                                  # lit secret/database et secret/app
docker compose restart vault                  # Vault redémarre scellé…
docker compose logs -f vault-unseal           # …et est redescellé en moins de 30 s
```

Réinitialisation complète (base + clés Vault) : `make clean`.

> Les configurations WAF et Vault viennent du projet d'équipe, où elles tournaient ; ce dépôt les réassemble autour du backend de démonstration.

---

## Limites connues et ce que je changerais en production

| Limite actuelle | En production |
|---|---|
| Le backend utilise le **root token** (lu dans `vault_data`) | **AppRole** pour le backend + **policy en lecture seule** sur `secret/data/database` et `secret/data/app` |
| Les **clés d'unseal** sont dans le **même volume** que les données chiffrées | **Auto-unseal** (KMS cloud, HSM ou Transit d'un autre Vault) ; clés jamais stockées à côté des données |
| **Vault sans TLS** (`tls_disable: 1`) — le trafic backend ↔ Vault est en clair sur le réseau Docker | listener TLS avec certificat d'une CA interne |
| **Port 8200 exposé** sur l'hôte (UI et API) | ne pas publier le port, ou le limiter à un réseau d'administration |
| **IPC_LOCK désactivé** (`disable_mlock: true`, `SKIP_SETCAP`) car WSL2 ne le permet pas | `cap_add: IPC_LOCK` et mlock actif sur un Linux natif (secrets jamais swappés) |
| Les secrets passent par le **`.env`** et l'environnement de `vault-init` pendant le **bootstrap** | injection initiale manuelle ou par pipeline CI/CD, sans fichier en clair sur l'hôte |
| **Certificat autosigné** | certificat d'une CA reconnue (Let's Encrypt) ou d'une PKI interne |
| **Pas de rate limiting** sur `/api/auth/login` | `limit_req` Nginx ou middleware de limitation + verrouillage temporaire |

Autres points relevés en relisant le code : le JWT est stocké en `localStorage` et transite dans l'URL après l'OAuth GitHub (cookie `HttpOnly` préférable) ; l'image `hashicorp/vault` est en `:latest` (à figer comme celle du WAF).

---

## Difficultés rencontrées

Toutes tirées de l'historique du projet d'équipe :

- **Faux positifs du CRS** : le login par IP LAN (920350 + 931100 dépassaient le seuil de 5), le polling Socket.IO (920420), le callback OAuth Google (930120). Il a fallu lire les logs d'audit pour trouver l'ID exact et écrire une exception limitée au chemin concerné.
- **WebSocket à travers le WAF** : l'image ne permet d'ajouter un bloc `location` que via un template précis ; il a fallu trouver le bon chemin de montage et utiliser une variable dans `proxy_pass` pour que le DNS Docker soit réévalué quand le conteneur est recréé.
- **Permissions du volume Vault** : le volume nommé est créé `root:root`, le process Vault tourne en UID 100 → `permission denied`. Solution : `chown` avant de lancer le serveur, et à nouveau avant chaque tentative d'init (course au premier démarrage).
- **Boucle infinie de `vault-unseal`** quand `init-keys.txt` était vide ou partiel après un échec : écriture dans un fichier temporaire + vérification du contenu.
- **Vault rescellé après un crash** : ajout de la boucle de surveillance.
- **Portabilité Podman / Fedora** : WAF qui ne démarrait pas (droits sur `/etc/nginx`, d'où `user: "0:0"`), labels SELinux `:z` sur les montages, images qualifiées `docker.io/`.

---

## Compétences mobilisées

- WAF : ModSecurity v3, OWASP CRS 3.3, scoring d'anomalies, niveaux de paranoïa, exceptions `ctl:ruleRemoveById`
- Gestion des secrets : HashiCorp Vault (mode serveur, init/unseal Shamir, KV v2, API HTTP)
- Docker Compose : `depends_on` avec conditions, healthchecks, volumes nommés, réseau bridge interne, services one-shot
- Nginx : reverse proxy, terminaison TLS, WebSocket
- TLS : génération de certificat autosigné avec SAN (openssl)
- Shell POSIX : scripts d'initialisation idempotents, gestion d'erreurs
- Node.js : client HTTP natif, Express, Prisma, bcrypt, JWT
- Débogage : logs d'audit ModSecurity, permissions de volumes, SELinux, WSL2 / Podman

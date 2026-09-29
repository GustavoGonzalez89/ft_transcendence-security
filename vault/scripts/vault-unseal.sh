#!/bin/sh
set -e

# Garantit que le dossier data existe et est accessible en écriture
# même si le repo vient d'être cloné (vault/data est dans .gitignore)
mkdir -p /vault/data

KEYS_FILE=/vault/data/init-keys.txt

# Si une tentative précédente a échoué après la création du fichier (ex: permission
# denied lors du init), le fichier existe mais est vide ou incomplet. Dans ce cas
# on le supprime pour forcer une réinitialisation propre, sinon le script croit
# Vault déjà initialisé et tente un unseal avec des clés vides -> boucle infinie.
if [ -f "$KEYS_FILE" ] && ! grep -q "Initial Root Token" "$KEYS_FILE"; then
  echo "[vault-unseal] $KEYS_FILE existe mais est invalide/incomplet — suppression"
  rm -f "$KEYS_FILE"
fi

# Attend que Vault soit prêt à recevoir des requêtes
echo "[vault-unseal] Attente du démarrage de Vault..."
until vault status -address=http://vault:8200 2>&1 | grep -q "Initialized"; do
  sleep 2
done
echo "[vault-unseal] Vault est prêt"

if [ ! -f "$KEYS_FILE" ]; then
  # Vault peut déjà être initialisé même sans fichier de clés local (ex: volume
  # partagé réinitialisé par un autre essai) — dans ce cas on ne peut pas générer
  # de nouvelles clés, donc on ne tente init que si Vault n'est pas déjà initialisé.
  if vault status -address=http://vault:8200 2>&1 | grep -q "Initialized.*true"; then
    echo "[vault-unseal] ERREUR: Vault est déjà initialisé mais $KEYS_FILE est absent."
    echo "[vault-unseal] Impossible de descender sans les clés. Il faut effacer le volume vault_data (vault operator init perdu) et tout redémarrer de zéro."
    exit 1
  fi
  echo "[vault-unseal] Première initialisation..."
  # Écrit dans un fichier temporaire et ne déplace vers KEYS_FILE qu'en cas de succès,
  # pour ne jamais laisser un fichier vide/partiel si la commande échoue (ex: permission denied).
  TMP_FILE="${KEYS_FILE}.tmp"
  # Au tout premier démarrage, le chown de /vault/data fait par le service "vault"
  # peut ne pas être encore effectif au moment où "vault status" répond déjà
  # (race condition) -> le premier init échoue avec "permission denied". On
  # retente plusieurs fois avant d'abandonner.
  # Ce conteneur monte aussi /vault/data en root — on réapplique le chown
  # nous-mêmes à chaque tentative, car celui fait par le service "vault" au
  # démarrage ne suffit pas toujours (le volume nommé semble se réinitialiser
  # à root:root après coup, observé en pratique malgré le chown initial).
  INIT_OK=0
  for attempt in 1 2 3 4 5; do
    chown -R vault:vault /vault/data 2>/dev/null || true
    if vault operator init -address=http://vault:8200 > "$TMP_FILE"; then
      INIT_OK=1
      break
    fi
    rm -f "$TMP_FILE"
    echo "[vault-unseal] tentative $attempt/5 de 'vault operator init' échouée, nouvelle tentative dans 3s..."
    sleep 3
  done
  if [ "$INIT_OK" -ne 1 ]; then
    echo "[vault-unseal] ERREUR: échec de 'vault operator init' après 5 tentatives — voir les logs ci-dessus"
    exit 1
  fi
  mv "$TMP_FILE" "$KEYS_FILE"
  echo "[vault-unseal] Clés sauvegardées dans $KEYS_FILE"
else
  echo "[vault-unseal] Vault déjà initialisé — utilisation des clés existantes"
fi

# Descellement avec les 3 premières clés du fichier
UNSEAL_KEY_1=$(grep "Unseal Key 1" "$KEYS_FILE" | awk '{print $NF}')
UNSEAL_KEY_2=$(grep "Unseal Key 2" "$KEYS_FILE" | awk '{print $NF}')
UNSEAL_KEY_3=$(grep "Unseal Key 3" "$KEYS_FILE" | awk '{print $NF}')

# Sans cette vérification, une clé vide fait basculer "vault operator unseal" en
# mode interactif (prompt stdin), qui échoue silencieusement hors tty ("file
# descriptor 0 is not a terminal") au lieu de signaler clairement le vrai problème.
if [ -z "$UNSEAL_KEY_1" ] || [ -z "$UNSEAL_KEY_2" ] || [ -z "$UNSEAL_KEY_3" ]; then
  echo "[vault-unseal] ERREUR: clés de descellement vides — $KEYS_FILE est corrompu."
  echo "[vault-unseal] Supprimez le volume vault_data et redémarrez de zéro."
  rm -f "$KEYS_FILE"
  exit 1
fi

vault operator unseal -address=http://vault:8200 "$UNSEAL_KEY_1"
vault operator unseal -address=http://vault:8200 "$UNSEAL_KEY_2"
vault operator unseal -address=http://vault:8200 "$UNSEAL_KEY_3"

echo "[vault-unseal] Vault déscellé avec succès"

# Sauvegarde le root token pour que vault-init puisse le lire
grep "Initial Root Token" "$KEYS_FILE" | awk '{print $NF}' > /vault/data/root-token.txt
echo "[vault-unseal] Root token sauvegardé dans /vault/data/root-token.txt"

# Boucle de surveillance — si Vault redémarre (crash + restart: unless-stopped),
# il se reselle automatiquement. Ce loop détecte l'état sealed et le redescelle
# sans intervention manuelle. set +e pour que les erreurs réseau transitoires
# (Vault temporairement indisponible) ne tuent pas le script.
set +e
echo "[vault-unseal] Démarrage de la surveillance (vérification toutes les 30s)..."
while true; do
  sleep 30
  SEALED=$(vault status -address=http://vault:8200 -format=json 2>/dev/null | grep '"sealed"' | grep -o 'true\|false')
  if [ "$SEALED" = "true" ]; then
    echo "[vault-unseal] Vault scellé détecté — redescellement en cours..."
    vault operator unseal -address=http://vault:8200 "$UNSEAL_KEY_1" 2>/dev/null || true
    vault operator unseal -address=http://vault:8200 "$UNSEAL_KEY_2" 2>/dev/null || true
    vault operator unseal -address=http://vault:8200 "$UNSEAL_KEY_3" 2>/dev/null || true
    echo "[vault-unseal] Redescellement terminé"
  fi
done

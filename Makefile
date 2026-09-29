COMPOSE = docker compose
URL     = https://localhost:8443

.PHONY: all up certs down clean logs ps test-waf secrets

all: up

# Crée .env depuis l'exemple si absent (à compléter avant le premier lancement)
.env:
	cp .env.example .env
	@echo ">> .env créé depuis .env.example — remplis POSTGRES_PASSWORD et NEXTAUTH_SECRET puis relance make"
	@false

# Certificat autosigné pour le WAF (sans sudo)
certs:
	@mkdir -p certs
	@if [ ! -f certs/cert.pem ]; then \
		openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
			-keyout certs/key.pem -out certs/cert.pem \
			-subj "/CN=localhost" \
			-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"; \
		chmod 644 certs/cert.pem certs/key.pem; \
	fi

up: .env certs
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

# Supprime aussi les volumes : base de données ET clés Vault (réinitialisation complète)
clean:
	$(COMPOSE) down -v
	rm -rf certs

logs:
	$(COMPOSE) logs -f

ps:
	$(COMPOSE) ps

# Requête propre (200 attendu) puis 4 attaques connues (403 attendu)
test-waf:
	@printf "clean        : " ; curl -sk -o /dev/null -w "%{http_code}\n" "$(URL)/api/health"
	@printf "SQLi         : " ; curl -sk -o /dev/null -w "%{http_code}\n" "$(URL)/api/health?id=1%27%20OR%20%271%27%3D%271"
	@printf "XSS          : " ; curl -sk -o /dev/null -w "%{http_code}\n" "$(URL)/api/health?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E"
	@printf "Path travers.: " ; curl -sk -o /dev/null -w "%{http_code}\n" --path-as-is "$(URL)/api/health?file=../../../../etc/passwd"
	@printf "Cmd inject.  : " ; curl -sk -o /dev/null -w "%{http_code}\n" "$(URL)/api/health?cmd=%3Bcat%20/etc/passwd"

# Lit les secrets stockés dans Vault (démo — utilise le root token)
secrets:
	@TOKEN=$$($(COMPOSE) exec -T vault-unseal cat /vault/data/root-token.txt) && \
	for p in database app; do \
		echo "== secret/$$p"; \
		$(COMPOSE) exec -T -e VAULT_TOKEN=$$TOKEN vault-unseal vault kv get -address=http://vault:8200 secret/$$p; \
	done

---
role: composants déployés — fixture VERTE O-20 (TF-1986), valeurs inventées
sources_de_verite: ["docker ps", "compose.yaml"]
verifie_le: 2026-10-29
authentification: aucune
---

# Composants Ops — produit d'exemple

## Composants à état

| Composant | Image | Données de travail | Volume | Commande de création |
|---|---|---|---|---|
| nodeodm | opendronemap/nodeodm:3.5.4 | /var/www/data | nodeodm-donnees | `docker run -d --name nodeodm -p 3000:3000 -v nodeodm-donnees:/var/www/data opendronemap/nodeodm:3.5.4` |
| base-locale | postgres:16-alpine | /var/lib/postgresql/data | base-locale-donnees | `docker run -d --name base-locale -p 5432:5432 -v base-locale-donnees:/var/lib/postgresql/data postgres:16-alpine` |
| cache-local | redis:7 | /data | cache-donnees | `docker run -d --name cache-local -v cache-donnees:/data redis:7` |
| base-windows | postgres:15 | /var/lib/postgresql/data | C:\donnees\pg15 | `docker run -d --name base-windows -v C:\donnees\pg15:/var/lib/postgresql/data postgres:15` |
| base | postgres:18 | /var/lib/postgresql | base-donnees | `docker compose up -d base` |
| file | mongo:7 | /data/db | file-donnees | `docker compose up -d file` |

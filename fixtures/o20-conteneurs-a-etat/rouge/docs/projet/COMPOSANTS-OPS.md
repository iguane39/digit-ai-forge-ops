---
role: composants déployés — fixture ROUGE O-20 (TF-1986), valeurs inventées
sources_de_verite: ["docker ps", "compose.yaml"]
verifie_le: 2026-10-29
authentification: aucune
---

# Composants Ops — produit d'exemple

## Composants à état

| Composant | Image | Données de travail | Volume | Commande de création |
|---|---|---|---|---|
| moteur-odm | opendronemap/nodeodm:3.5.4 | /var/www/data | odm-donnees | `docker run -d --name moteur-odm -p 3000:3000 opendronemap/nodeodm:3.5.4` |
| cache-local | redis:7 | /data | cache-donnees | `docker run -d --name cache-local -v autre-volume:/data redis:7` |

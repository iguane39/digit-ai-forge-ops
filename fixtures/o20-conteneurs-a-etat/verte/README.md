# Produit d'exemple — fixture VERTE O-20 (TF-1986), valeurs inventées

Le moteur de traitement photogrammétrique tourne dans un conteneur local dont les données de
travail vivent dans un volume nommé : un redémarrage de Docker ne les efface pas.

## Créer le moteur (une fois)

```bash
docker volume create nodeodm-donnees
docker run -d --name nodeodm -p 3000:3000 \
  -v nodeodm-donnees:/var/www/data \
  opendronemap/nodeodm:3.5.4
```

## Relancer le moteur

```bash
docker start nodeodm
```

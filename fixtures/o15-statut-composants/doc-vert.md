# Composants Ops — fixture VERTE O-15 (TF-1113 + TF-1117), valeurs inventées, graphies mêlées

## Inventaire par environnement

| Composant | Type | Environnement | Statut |
|---|---|---|---|
| ca-exemple-api | application | qualification | actif |
| kv-exemple-01 | coffre | qualification | partagé |
| ca-exemple-worker | application | qualification | déclaré |
| st-exemple-archives | stockage | qualification | hors périmètre |

## Composants inutilisés — à supprimer

| Composant | Preuve d'inutilité | Ce qui cesse de fonctionner si on le supprime | Statut de supprimabilité | Créé par quoi | Geste | Titulaire du droit |
|---|---|---|---|---|---|---|
| acr-exemple-ancien | aucune image référencée | rien, mesuré le 2026-09-15 : aucune charge ne tire d'image de ce registre | supprimable | geste manuel | suppression du registre | équipe plateforme |
| fw-exemple-poste | aucun consommateur déclaré | l'accès humain à la base depuis le poste en service | non supprimable, decision | pile infra-tf, règle de pare-feu poste | aucun | équipe produit |
| sc-exemple-deploiement | aucun pipeline ne la nomme | l'application de la pile Terraform qui possède l'environnement | Non supprimable, droit absent | geste manuel | aucun | équipe plateforme |

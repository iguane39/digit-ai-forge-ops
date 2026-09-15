# Composants Ops — fixture ROUGE O-15 (TF-1113 + TF-1117), valeurs inventees, ecrite sans accents

## Inventaire par environnement

| Composant | Type | Environnement | Statut |
|---|---|---|---|
| ca-exemple-api | application | qualification | actif |
| kv-exemple-01 | coffre | qualification | partage |
| ca-exemple-worker | application | qualification | actif |
| st-exemple-archives | stockage | qualification | en service |

## Composants inutilises — a supprimer

| Composant | Preuve d'inutilite | Ce qui cesse de fonctionner si on le supprime | Statut de supprimabilite | Cree par quoi | Geste | Titulaire du droit |
|---|---|---|---|---|---|---|
| acr-exemple-ancien | aucune image referencee |  | supprimable | geste manuel | suppression du registre | equipe plateforme |
| fw-exemple-poste | aucun consommateur declare | rien | supprimable | pile infra-tf, regle de pare-feu poste | retrait de la regle | equipe produit |
| sc-exemple-deploiement | aucun pipeline ne la nomme | l'application de la pile Terraform | supprimable apres verification | geste manuel | suppression de la connexion | equipe plateforme |

# Journal de nettoyage — fixture ROUGE O-16 (TF-1120), valeurs inventées

## Nettoyage des composants inutilisés — qualification, 2026-09-15

Cinq composants traités ; le détail de chaque ligne vit dans l'inventaire.

### Clôture

1. L'instance est-elle supprimée sur chaque environnement où elle existe ?
   Réponse : oui, développement et qualification.
   Preuve : `az resource list -g rg-exemple-qualif` ne rend plus les cinq noms, relevé le 2026-09-15.
2. Ce qui la crée est-il traité ?
   Réponse : oui.
   Preuve :

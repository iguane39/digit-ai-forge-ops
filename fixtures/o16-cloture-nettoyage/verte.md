# Journal de nettoyage — fixture VERTE O-16 (TF-1120), valeurs inventees, ecrite sans accents

## Nettoyage des composants inutilises — qualification, 2026-09-15

Cinq composants traites ; le detail de chaque ligne vit dans l'inventaire.

### Cloture

1. L'instance est-elle supprimee sur chaque environnement ou elle existe ?
   Reponse : oui, developpement et qualification ; absente de production.
   Preuve : `az resource list -g rg-exemple-qualif` ne rend plus les cinq noms, releve le 2026-09-15.
2. Ce qui la cree est-il traite ?
   Reponse : oui, le bloc de la pile infra-tf qui la declarait est retire.
   Preuve : commit local a1b2c3d, `terraform plan` rend 0 ajout sur la qualification.
3. Le prochain environnement la recreera-t-il ?
   Reponse : non, l'interrupteur qui la cree vaut faux en production.
   Preuve : evaluation statique des fichiers de variables, releve le 2026-09-15.

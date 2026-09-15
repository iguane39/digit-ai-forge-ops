---
role: compte rendu de clôture — fixture ROUGE O-16 (TF-1120), forme table, valeurs inventées
nettoyage_infrastructure: composants inutilisés de qualification
---

# Compte rendu de clôture

| Question | Réponse | Preuve |
|---|---|---|
| L'instance est-elle supprimée sur chaque environnement où elle existe ? | oui, développement et qualification | `az resource list -g rg-exemple-qualif`, relevé le 2026-09-15 |
| Ce qui la crée est-il traité ? | oui, bloc retiré de la pile | `terraform plan` : 0 ajout |
| Le prochain environnement la recréera-t-il ? | non | — |

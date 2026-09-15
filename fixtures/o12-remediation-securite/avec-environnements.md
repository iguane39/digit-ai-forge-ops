---
remediation_securite: retrait de la regle AllowAllAzureServicesAndResources (0.0.0.0)
environnements:
  - dev: rejouee (25/08/2026)
  - qualif: a_rejouer (regle nominative permanente en place, seule voie de l'API — remplacement requis avant retrait)
  - production: sans_objet (environnement non provisionne)
---

# Matrice de flux — fixture VERTE (TF-1115)

Meme remediation que la fixture rouge : seul le champ `environnements:` les separe.

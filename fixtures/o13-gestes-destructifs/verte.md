# Carnet d'ecarts — fixture VERTE (TF-1116 + TF-1118)

Gestes a jouer sur l'environnement de qualification :

- Retirer la regle AllowAllAzureServicesAndResources et autoriser la seule adresse de sortie.
  Maturite : deduit d'une autre cible, a mesurer avant execution — le pool de sortie de
  Container Apps hors reseau virtuel n'est ni unitaire ni stable (161 adresses mesurees contre
  une seule sur l'environnement de developpement).
  Mesure de non-regression : `psql -h <hote> -c "select 1"` avant et apres le geste, sur la
  meme connexion.
- Purger les trois depots d'images de l'application demantelee.
  Maturite : eprouve sur cette cible le 2026-09-14.
  Mesure de non-regression : inventaire du registre jumeau, verifie intact apres coup.

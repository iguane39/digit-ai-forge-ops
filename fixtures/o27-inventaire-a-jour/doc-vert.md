---
verifie_le: 2026-11-06
---
# Composants Ops — fixture VERTE O-27 (TF-2209), valeurs inventées

Chaque composant que les sorties d'état de la pile, du démon Docker local et du groupe de ressources nomment figure ici.

## Inventaire par environnement

| Composant | Type | Environnement | Statut |
|---|---|---|---|
| azurerm_resource_group.rg | groupe de ressources | qualification | actif |
| azurerm_container_app.api | application | qualification | actif |
| azurerm_linux_virtual_machine.vm | machine virtuelle | qualification | actif |
| azurerm_ai_foundry.hub | hub d'intelligence artificielle | qualification | actif |
| ca-exemple-api | application | qualification | actif |
| vm-exemple-poste | machine virtuelle | qualification | actif |
| exemple-api | conteneur | local | actif |
| exemple-postgres | conteneur | local | actif |

## Composants inutilisés

| Composant | Preuve d'inutilité | Ce qui cesse de fonctionner si on le supprime | Statut de supprimabilité | Créé par quoi | Geste | Titulaire du droit |
|---|---|---|---|---|---|---|
| Aucun composant inutilisé | | | | | | |

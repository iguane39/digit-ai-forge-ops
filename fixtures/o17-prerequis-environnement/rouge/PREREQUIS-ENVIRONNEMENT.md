# Prérequis d'environnement — fixture ROUGE O-17 (TF-1122), valeurs inventées

| Ressource | Propriétaire | Commande de vérification |
|---|---|---|
| `data.azurerm_resource_group.socle` | équipe plateforme (pile socle-exemple) | `az group exists -n rg-exemple-socle` |
| `data.azurerm_key_vault.coffre` |  | `az keyvault show -n kv-exemple-01` |

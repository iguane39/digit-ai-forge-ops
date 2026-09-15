# Prerequis d'environnement — fixture VERTE O-17 (TF-1122), valeurs inventees, ecrite sans accents

| Ressource | Proprietaire | Commande de verification |
|---|---|---|
| `data.azurerm_resource_group.socle` | equipe plateforme (pile socle-exemple) | `az group exists -n rg-exemple-socle` |
| `data.azurerm_key_vault.coffre` | equipe plateforme (pile socle-exemple) | `az keyvault show -n kv-exemple-01` |
| `data.azurerm_container_app_environment.execution` | equipe plateforme (pile socle-exemple) | `az containerapp env show -n cae-exemple-socle -g rg-exemple-socle` |

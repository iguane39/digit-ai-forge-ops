# Fixture ROUGE O-17 (TF-1122), valeurs inventees : la pile LIT trois ressources qu'elle ne
# cree pas ; l'artefact de prerequis n'en declare qu'une completement.
data "azurerm_resource_group" "socle" {
  name = "rg-exemple-socle"
}

data "azurerm_key_vault" "coffre" {
  name                = "kv-exemple-01"
  resource_group_name = data.azurerm_resource_group.socle.name
}

data "azurerm_container_app_environment" "execution" {
  name                = "cae-exemple-socle"
  resource_group_name = data.azurerm_resource_group.socle.name
}

resource "azurerm_container_app" "api" {
  name                         = "ca-exemple-api"
  container_app_environment_id = data.azurerm_container_app_environment.execution.id
  resource_group_name          = data.azurerm_resource_group.socle.name
  revision_mode                = "Single"
}

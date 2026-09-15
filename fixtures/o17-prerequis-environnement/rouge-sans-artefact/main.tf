# Fixture ROUGE O-17 (TF-1122), valeurs inventees : deux ressources lues, aucun artefact de
# prerequis a la racine de la pile.
data "azurerm_resource_group" "socle" {
  name = "rg-exemple-socle"
}

data "azurerm_log_analytics_workspace" "journaux" {
  name                = "log-exemple-socle"
  resource_group_name = data.azurerm_resource_group.socle.name
}

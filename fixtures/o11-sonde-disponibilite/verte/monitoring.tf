# Fixture VERTE (TF-1121) — meme sonde, adresse SERVIE substituee quand connue (variable
# publicBaseUrl du pipeline), l'origine restant le repli quand aucun frontal n'est actif.
resource "azurerm_application_insights_web_test" "availability_qualif" {
  name    = "wt-exemple-disponibilite-qualif"
  enabled = true
  url     = var.public_base_url != "" ? "https://${var.public_base_url}/" : "https://${azurerm_container_app.front.ingress[0].fqdn}/"
}

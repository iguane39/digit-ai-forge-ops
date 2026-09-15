# Fixture ROUGE (TF-1121) — reproduction fidele de infra-tf/monitoring.tf:181, mesure
# Produit-11 du 14/09/2026 : la sonde vise le nom de domaine de l'ORIGINE, jamais l'adresse
# servie a l'utilisateur.
resource "azurerm_application_insights_web_test" "availability_qualif" {
  name    = "wt-exemple-disponibilite-qualif"
  enabled = true
  url     = "https://${azurerm_container_app.front.ingress[0].fqdn}/"
}

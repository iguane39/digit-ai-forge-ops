# Vert par absence : aucun ipam_config, le démon choisit la plage — rien à juger (SKIP, jamais un PASS vide).
resource "docker_network" "lab" {
  name = "lab"
}

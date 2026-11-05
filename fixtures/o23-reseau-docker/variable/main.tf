# Vert : subnet décidé hors du fichier (variable), ignore_changes posé. # ignore_changes = [] en commentaire ne compte pas.
variable "plage" {
  type = string
}

resource "docker_network" "lab" {
  name = "lab"

  ipam_config {
    subnet = var.plage
  }

  lifecycle {
    ignore_changes = [ipam_config]
  }
}

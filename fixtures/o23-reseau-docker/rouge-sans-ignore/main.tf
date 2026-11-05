# Rouge : la plage vient du relevé, mais le démon complète ipam_config et chaque apply remplace le réseau (RO-2, TF-2164).
data "external" "plage" {
  program = ["node", "${path.module}/plages-docker.mjs", "--externe"]
  query = {
    nom = "lab"
  }
}

resource "docker_network" "lab" {
  name = "lab"

  ipam_config {
    subnet = data.external.plage.result.subnet
  }
}

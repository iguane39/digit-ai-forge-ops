# Rouge : la plage vient d'un data "external", mais son programme ne relève aucune plage.
data "external" "horloge" {
  program = ["node", "-e", "console.log(JSON.stringify({ subnet: '10.9.0.0/24', gateway: '10.9.0.1' }))"]
}

resource "docker_network" "lab" {
  name = "lab"

  ipam_config {
    subnet  = data.external.horloge.result.subnet
    gateway = data.external.horloge.result.gateway
  }

  lifecycle {
    ignore_changes = [ipam_config]
  }
}

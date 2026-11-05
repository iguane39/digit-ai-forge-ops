# Rouge : ignore_changes est posé, mais la plage est écrite à la main — « Pool overlaps » le 04/11/2026 (RO-2, TF-2164).
resource "docker_network" "lab" {
  name = "lab"

  ipam_config {
    subnet  = "172.30.0.0/24"
    gateway = "172.30.0.1"
  }

  lifecycle {
    ignore_changes = [ipam_config]
  }
}

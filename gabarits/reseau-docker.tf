# Gabarit forge-ops : un réseau Docker posé par Terraform (TF-2164, Produit-86 lot 20261104a RO-2).
#
# Deux défauts mesurés le 04/11/2026, 3 déploiements en échec entre 10:12 et 10:18 :
#   1. une plage écrite à la main (172.30.0.0/24) était déjà prise par un autre réseau du démon :
#      « Pool overlaps » ;
#   2. le démon complète ipam_config (passerelle, adresses auxiliaires) : Terraform y lit un écart à chaque
#      apply et réclame le REMPLACEMENT du réseau, en échec tant que des conteneurs y sont attachés.
#
# Ce gabarit relève les plages prises avant d'en choisir une (scripts/plages-docker.mjs, à copier à côté de
# ce fichier) et pose lifecycle { ignore_changes = [ipam_config] } d'office. Si le réseau existe déjà, le
# relevé rend SA plage : le plan suivant ne change donc rien.
#
# Jugé par l'oracle O-23 : node oracles/oracle-ops.mjs --reseau-docker <racine de la pile>
# Référentiel : references/RESEAU-ET-FRONTAL-DOCKER.md

terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0"
    }
    external = {
      source  = "hashicorp/external"
      version = "~> 2.3"
    }
  }
}

variable "nom_reseau" {
  description = "Nom du réseau Docker du lab."
  type        = string
}

variable "base_plages" {
  description = "Zone où choisir la plage, hors des réservoirs par défaut de Docker (172.17.0.0/12, 192.168.0.0/16)."
  type        = string
  default     = "10.200.0.0/16"
}

variable "script_plages" {
  description = "Chemin du relevé de plages, relatif à ce module."
  type        = string
  default     = "plages-docker.mjs"
}

# Le relevé : lit le démon, rend une plage libre de la base (ou celle du réseau s'il existe déjà).
data "external" "plage" {
  program = ["node", "${path.module}/${var.script_plages}", "--externe"]
  query = {
    nom      = var.nom_reseau
    base     = var.base_plages
    longueur = "24"
  }
}

resource "docker_network" "lab" {
  name = var.nom_reseau

  ipam_config {
    subnet  = data.external.plage.result.subnet
    gateway = data.external.plage.result.gateway
  }

  lifecycle {
    # Le démon complète ipam_config après la création : sans cette ligne, chaque apply remplace le réseau.
    ignore_changes = [ipam_config]
  }
}

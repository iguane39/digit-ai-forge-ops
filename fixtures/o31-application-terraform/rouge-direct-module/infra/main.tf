variable "project_ref" { type = string }

module "auth" {
  source      = "../modules/auth"
  project_ref = var.project_ref
}

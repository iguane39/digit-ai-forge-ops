variable "project_ref" { type = string }

resource "supabase_settings" "reglages" {
  project_ref = var.project_ref
  auth        = jsonencode({ site_url = "https://exemple.test" })
}

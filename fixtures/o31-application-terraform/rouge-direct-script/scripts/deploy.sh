#!/usr/bin/env bash
set -euo pipefail
# terraform apply dans un commentaire : ne compte pas
cd infra && terraform apply -auto-approve

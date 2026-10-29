#!/bin/sh
# Fixture ROUGE O-20 (TF-1986) : base locale sans volume, retirée à son arrêt (--rm).
docker run --rm -d --name base-locale \
  -e POSTGRES_PASSWORD="$PGPASSWORD" \
  -p 5432:5432 \
  postgres:16-alpine

#!/bin/sh
# Fixture VERTE O-20 (TF-1986) : postgres 16 monte son volume sur /var/lib/postgresql/data.
docker run -d --name base-locale \
  -e POSTGRES_PASSWORD="$PGPASSWORD" \
  -p 5432:5432 \
  -v base-locale-donnees:/var/lib/postgresql/data \
  postgres:16-alpine

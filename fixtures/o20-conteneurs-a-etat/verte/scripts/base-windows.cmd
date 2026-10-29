@echo off
rem Fixture VERTE O-20 (TF-1986) : dossier de l'hôte Windows monté sur le chemin des données.
docker run -d --name base-windows ^
  -v C:\donnees\pg15:/var/lib/postgresql/data ^
  postgres:15

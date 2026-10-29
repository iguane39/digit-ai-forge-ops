# Fixture ROUGE O-20 (TF-1986) : volume monté sur un chemin où redis n'écrit pas (/data attendu).
docker run -d --name cache-local `
  -v cache-donnees:/var/lib/redis `
  redis:7

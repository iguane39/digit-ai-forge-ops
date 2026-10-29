# Fixture VERTE O-20 (TF-1986) : redis écrit dans /data, le volume y est monté.
docker run -d --name cache-local `
  -v cache-donnees:/data `
  redis:7

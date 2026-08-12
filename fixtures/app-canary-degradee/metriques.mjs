// Contrat de métriques canary (TF-0107) — candidat DÉGRADÉ (fixture rouge) : sain au
// démarrage puis dégradation qui n'apparaît qu'en montée en charge (palier >= 25 %) —
// reproduit le trou prouvé TF-0107 (une dégradation à 2 min post-bascule, vue par personne
// avec un healthcheck one-shot).
const palier = Number(process.argv[2] || 0);
const mesure = palier >= 25 ? { erreur_pct: 12, latence_ms: 900 } : { erreur_pct: 1, latence_ms: 150 };
process.stdout.write(JSON.stringify(mesure));
process.exit(0);

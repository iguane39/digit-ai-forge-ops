// Contrat de métriques canary (TF-0107) : appelé `node metriques.mjs <palier_pct>`,
// doit imprimer sur stdout {"erreur_pct":<num>,"latence_ms":<num>} et sortir en 0.
// Candidat STABLE (fixture verte) : métriques saines à tous les paliers.
process.stdout.write(JSON.stringify({ erreur_pct: 0.5, latence_ms: 120 }));
process.exit(0);

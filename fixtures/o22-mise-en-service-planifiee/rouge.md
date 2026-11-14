# Composants Ops — fixture ROUGE O-22 (D-108 (b)), valeurs inventées

Jouée avec `--le "2026-10-25 12:00"`. Six tâches fautives, une raison chacune, six constats :
- `publication-exemple` : « C'est en service », l'essai a passé — ni identifiant ni URL de publication ;
- `export-exemple` : preuve lue, mais sans date ni heure de lecture ;
- `sauvegarde-exemple` : preuve lue, aucune prochaine échéance ;
- `veille-exemple` : échéance du 21/10 à 18 h 45 passée, aucune lecture plus récente ;
- `rappel-exemple` : lecture datée après l'instant de référence ;
- `relance-exemple` : lecture sans heure.

## Tâches planifiées

| Composant | Cadence | Statut | En service depuis | Première exécution lue | Première lecture le | Prochaine échéance |
|---|---|---|---|---|---|---|
| publication-exemple | tous les jours à 18 h 45 | actif | 2026-10-21 04:56 | essai passé | 2026-10-21 18:30 | 2026-10-26 18:45 |
| export-exemple | le lundi | actif | 2026-10-19 06:00 | https://reseau.exemple/export/5521 | | 2026-11-02 08:00 |
| sauvegarde-exemple | chaque nuit | actif | 2026-10-24 02:00 | job-sauv-20261024 | 2026-10-24 03:10 | |
| veille-exemple | le 1er du mois | en service | 2026-10-20 06:00 | job-0042 | 2026-10-20 08:00 | 2026-10-21 18:45 |
| rappel-exemple | chaque mois | actif | 2026-10-24 12:00 | rappel-20261101 | 2026-11-01 09:00 | 2026-11-30 09:00 |
| relance-exemple | chaque semaine | partagé | 2026-10-22 06:00 | relance-0099 | 2026-10-22 | 2026-11-02 08:00 |
| inventaire-exemple | chaque semaine | déclaré | — | — | — | — |

# Composants Ops — fixture VERTE O-22 (D-108 (b), TF-2560), valeurs inventées

Jouée avec `--le "2026-10-25 12:00"`.

## Inventaire par environnement

Un composant qui n'est pas une tâche planifiée n'est pas jugé par O-22, même « actif » sans preuve d'exécution.

| Composant | Type | Environnement | Statut |
|---|---|---|---|
| ca-exemple-api | application | qualification | actif |

## Tâches planifiées

Chaque lecture est postérieure à la mise en service (« En service depuis »).

| Composant | Cadence | Statut | En service depuis | Première exécution lue | Première lecture le | Dernière exécution lue | Dernière lecture le | Prochaine échéance |
|---|---|---|---|---|---|---|---|---|
| publication-exemple | tous les jours à 18 h 45 | actif | 2026-10-21 04:56 | https://reseau.exemple/publication/17912345678 | 2026-10-21 18:50 | publication 17987654321 | 2026-10-25 09:05 | 2026-10-26 18:45 |
| veille-exemple | le 1er du mois | en service | 2026-10-20 06:00 | job-0042 | 2026-10-20T08:00 | job-0057 | 2026-10-24 19:02 | 2026-10-24 18:45 |
| export-exemple | le lundi | partagé | 2026-10-19 06:00 | `export-2026-10-19-0007` | 2026-10-19 07:15 | | | 2026-11-02 |
| relance-exemple | chaque semaine | déclaré | — | — | — | | | — |
| aucune autre tâche | | | | | | | | |

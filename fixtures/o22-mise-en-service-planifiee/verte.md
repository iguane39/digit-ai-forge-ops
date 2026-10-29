# Composants Ops — fixture VERTE O-22 (D-108 (b)), valeurs inventées

Jouée avec `--le "2026-10-25 12:00"`.

## Inventaire par environnement

Un composant qui n'est pas une tâche planifiée n'est pas jugé par O-22, même « actif » sans preuve d'exécution.

| Composant | Type | Environnement | Statut |
|---|---|---|---|
| ca-exemple-api | application | qualification | actif |

## Tâches planifiées

| Composant | Cadence | Statut | Première exécution lue | Première lecture le | Dernière exécution lue | Dernière lecture le | Prochaine échéance |
|---|---|---|---|---|---|---|---|
| publication-exemple | tous les jours à 18 h 45 | actif | https://reseau.exemple/publication/17912345678 | 2026-10-21 18:50 | publication 17987654321 | 2026-10-25 09:05 | 2026-10-26 18:45 |
| veille-exemple | le 1er du mois | en service | job-0042 | 2026-10-20T08:00 | job-0057 | 2026-10-24 19:02 | 2026-10-24 18:45 |
| export-exemple | le lundi | partagé | `export-2026-10-19-0007` | 2026-10-19 07:15 | | | 2026-11-02 |
| relance-exemple | chaque semaine | déclaré | — | — | | | — |
| aucune autre tâche | | | | | | | |

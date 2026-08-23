# digit-ai-forge-ops

Forge **exploitation** de l'écosystème Digit-AI — trois verbes : **déployer, exploiter,
restaurer**. Elle outille l'étape MEP du pilot (staging, bascule, rollback prouvé, journal) ;
elle ne décide rien : le GO de production reste humain, l'oracle M-1…M-5 du pilot reste la
vérité de l'étape. Née de TF-0040 (trou prouvé : MEP sans forge, déploiement artisanal).

## Catalogue de services

> Section proposée par la campagne « catalogues » du pilot (2026-08-13) — générée depuis
> la source unique `catalogues/catalogue.jsonl` du pilot (v1.6.0, challengée état de
> l'art le 12/08/2026). **prouvé** = preuve exécutée ; *déclaré* = méthode documentée seulement.

| Service | Intention (« je veux… ») | Point d'entrée | Statut |
|---|---|---|---|
| **Déployer, restaurer, état** | déployer mon produit avec bascule saine et retour arrière prouvé | `node scripts\ops.mjs deployer|restaurer|etat <cible>` | prouvé (experimental) |
| **Verdicts d'exploitation O-1…O-4** | prouver que mon déploiement est sain et réversible | `node oracles\oracle-ops.mjs <cible> --json-only` | prouvé (experimental) |
| **Plans cloud plan-first** | préparer un déploiement cloud sans exposer de credential | `node scripts\ops.mjs plan <cible> + oracle O-5` | prouvé (experimental) |
| **Canary local simulé** | basculer progressivement avec critère de promotion explicite | `node scripts\ops.mjs canary <build> <cible> [--seuils f.json]` | prouvé (experimental) |
| **Drift O-6 et verdict rollback SLO** | détecter la dérive déclaré↔constaté et savoir quand recommander un retour arrière | `node oracles\oracle-ops.mjs --drift <f> <cible> · --verdict-rollback <mesures> --seuils <f>` | prouvé (experimental) |
| **Empreinte de déploiement O-7** | savoir si un déploiement passé par ops a dérivé après coup (fichier modifié/ajouté/supprimé en place) | `node oracles\oracle-ops.mjs <cible> --empreinte` | prouvé (experimental) |

Le catalogue consolidé des dix forges vit chez le pilot :
[digit-ai-factory/catalogues/CATALOGUES.md](https://github.com/iguane39/digit-ai-factory/blob/main/catalogues/CATALOGUES.md).

## Quick start

```bash
# Déployer un build vers une cible d'exploitation (healthcheck AVANT bascule)
node scripts/ops.mjs deployer <dossier-build> <cible>

# Restaurer la release précédente (re-healthcheck puis bascule arrière journalisée)
node scripts/ops.mjs restaurer <cible>

# État machine-lisible de la cible
node scripts/ops.mjs etat <cible>

# Verdict d'exploitation O1-O4 (consommé par l'étape MEP du pilot)
node oracles/oracle-ops.mjs <cible> [--json-only]

# Plan cloud déterministe (railway | gcp | azure | aws) — génère, n'exécute jamais
node scripts/ops.mjs plan <cible> <build> --sortie plan.json
node oracles/oracle-ops.mjs --plan plan.json   # O-5 : 4 phases, rollback réel, zéro credential

# Canary local simulé : paliers de trafic croissants, promotion sur critère de config
node scripts/ops.mjs canary <dossier-build> <cible> [--seuils seuils-canary.json]

# Oracle O-6 : dérive entre état déclaré (instantané) et état constaté maintenant
node scripts/ops.mjs etat <cible> --sortie declare.json   # à un instant T
node oracles/oracle-ops.mjs <cible> --drift declare.json  # plus tard : dérive ?

# Oracle O-7 : empreinte de déploiement — le déployé a-t-il dérivé après coup ?
# scellée automatiquement par deployer ET par canary (TF-0298), comparée à la demande
# sur la release COURANTE
node oracles/oracle-ops.mjs <cible> --empreinte

# Verdict « rollback recommandé » : seuils SLO humains vs mesures post-bascule (jamais d'exécution)
node oracles/oracle-ops.mjs --verdict-rollback mesures.json --seuils seuils-slo.json

# Preuve par le geste : déploiement réel local + rollback + défauts types refusés
node oracles/self-test.mjs
```

## Contrat de la cible

```
<cible>/
├── releases/<AAAAMMJJTHHMMSS>/    # une release = un déploiement immuable
├── empreintes/<AAAAMMJJTHHMMSS>.json  # manifeste scellé au déploiement ou à la promotion canary (chemins + sha256, TF-0288, TF-0298)
├── COURANT                        # pointeur texte (portable Windows, pas de symlink)
└── journal.jsonl                  # append-only, contrat ledger (seq croissant depuis 1)
```

- Une release sans `sante.mjs` (contrat de santé, exit 0 = sain) est **refusée**.
- Un healthcheck en échec laisse `COURANT` intact : **jamais de bascule sur release malade**.
- Types d'événements du journal : `deploiement` · `deploiement_refuse` · `restauration` ·
  `canary_etape` · `canary_promotion` · `canary_annulation`.

## Oracles

| Règle | Contrôle |
|---|---|
| O1 | `COURANT` pointe une release existante |
| O2 | la release courante repasse son healthcheck (exécution réelle) |
| O3 | journal intègre : JSON valide, seq strictement croissant depuis 1, types connus |
| O4 | rollback prouvable : aucune release citée au journal n'est purgée ; pointeur ↔ histoire cohérents |
| O5 | `--plan <fichier>` : plan cloud complet (4 phases, rollback réel, zéro credential) |
| O6 | `--drift <fichier> <cible>` : état déclaré (`etat --sortie`) vs constaté — journal tronqué/réécrit, déploiement furtif |
| O7 | `<cible> --empreinte` : fichiers de la release courante vs empreinte scellée au déploiement ou à la promotion canary — fichier modifié/supprimé/ajouté en place ; SKIP motivé sans empreinte, ex. déploiement fait hors ops (TF-0288, TF-0298) |

`non_juge` déclaré : santé applicative au-delà du healthcheck, GO production (humain),
supervision continue, secrets/config d'environnement.

## Canary local simulé (TF-0107)

`node scripts/ops.mjs canary <build> <cible> [--seuils fichier.json]` — bascule progressive
**simulée** entre `COURANT` et un candidat : paliers de trafic croissants (défaut
`1→5→25→50→100`, override par fichier de config), chaque palier mesuré via le contrat
`metriques.mjs` de la release et confronté à un **critère de promotion explicite**. Un palier
rejeté ⇒ abandon (`canary_annulation`), `COURANT` intact. Candidat sans `metriques.mjs` →
canary refusé (l'oubli n'existe pas — utiliser `deployer`). Tous les paliers franchis ⇒
empreinte scellée (même fonction, même point du cycle que `deployer` : après critères,
avant bascule) puis promotion — une cible promue par canary n'est plus SKIP à vie sur O-7
(TF-0298).

## Verdict « rollback recommandé » (TF-0107, recommandation seule)

`node oracles/oracle-ops.mjs --verdict-rollback <mesures.json> --seuils <fichier.json>` —
compare des mesures post-bascule à des **seuils SLO fixés par l'humain** (fichier
obligatoire, aucun défaut implicite). Verdicts : `stable` (exit 0) ·
`rollback_recommande` (exit 1) · `donnees_insuffisantes` (exit 2). **Ne déclenche jamais de
rollback** — la bascule arrière reste un geste humain via `ops.mjs restaurer`.

## Un travail planifié s'exerce (O-8, TF-0527)

`node oracles/oracle-ops.mjs <racine> --planifie` — toute définition planifiée du dépôt
(`.github/workflows/`, `azure-pipelines*.yml`, `pipelines/`) doit porter un **mode d'exercice à la
demande**, distinct de sa cadence : un déclencheur manuel, ou un paramètre d'exécution forcée
**lu** dans la garde de cadence. Sans lui, le mécanisme ne peut être éprouvé qu'à sa prochaine
échéance — donc il se découvre cassé au moment précis où l'on compte dessus. Un paramètre déclaré
et jamais lu affiche une case à cocher qui ne fait rien : même verdict qu'un paramètre absent.

Les faits d'exploitation constatés (comportements d'outils tiers qu'aucune documentation n'énonce)
vivent dans `references/GESTES-EXPLOITATION.md`, datés et sourcés.

## Frontières

Voir [CLAUDE.md](CLAUDE.md) — la forge outille, le pilot orchestre, l'humain donne le GO.
Invocation par le pilot uniquement ; retours par lots vers `input\` du pilot.

## Prérequis

Node.js ≥ 18. Aucune dépendance externe.

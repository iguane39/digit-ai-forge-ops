# digit-ai-forge-ops

Forge **exploitation** de l'écosystème Digit-AI — trois verbes : **déployer, exploiter,
restaurer**. Elle outille l'étape MEP du pilot (staging, bascule, rollback prouvé, journal) ;
elle ne décide rien : le GO de production reste humain, l'oracle M-1…M-5 du pilot reste la
vérité de l'étape. Née de TF-0040 (trou prouvé : MEP sans forge, déploiement artisanal).

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

# Preuve par le geste : déploiement réel local + rollback + défauts types refusés
node oracles/self-test.mjs
```

## Contrat de la cible

```
<cible>/
├── releases/<AAAAMMJJTHHMMSS>/   # une release = un déploiement immuable
├── COURANT                       # pointeur texte (portable Windows, pas de symlink)
└── journal.jsonl                 # append-only, contrat ledger (seq croissant depuis 1)
```

- Une release sans `sante.mjs` (contrat de santé, exit 0 = sain) est **refusée**.
- Un healthcheck en échec laisse `COURANT` intact : **jamais de bascule sur release malade**.
- Types d'événements du journal : `deploiement` · `deploiement_refuse` · `restauration`.

## Oracles

| Règle | Contrôle |
|---|---|
| O1 | `COURANT` pointe une release existante |
| O2 | la release courante repasse son healthcheck (exécution réelle) |
| O3 | journal intègre : JSON valide, seq strictement croissant depuis 1, types connus |
| O4 | rollback prouvable : aucune release citée au journal n'est purgée ; pointeur ↔ histoire cohérents |

`non_juge` déclaré : santé applicative au-delà du healthcheck, GO production (humain),
supervision continue, secrets/config d'environnement.

## Frontières

Voir [CLAUDE.md](CLAUDE.md) — la forge outille, le pilot orchestre, l'humain donne le GO.
Invocation par le pilot uniquement ; retours par lots vers `input\` du pilot.

## Prérequis

Node.js ≥ 18. Aucune dépendance externe.

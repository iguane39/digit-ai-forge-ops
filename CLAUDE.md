# digit-ai-forge-ops — exploitation (déployer · exploiter · restaurer)

Forge **transverse** de l'écosystème Digit-AI, née de TF-0040 (trou prouvé : MEP sans forge,
déploiement artisanal, qualif sans instances outillées). Elle **outille** l'étape MEP du
pilot — elle ne la remplace pas.

## Frontières (non négociables)

- **La forge outille, le pilot décide, l'humain donne le GO.** Le GO de mise en production
  est un gate humain incompressible : forge-ops ne déploie jamais en production de sa propre
  initiative et ne rend jamais ce verdict à la place de l'oracle MEP.
- **L'oracle M-1…M-5 d'`ETAPE-MEP.md` (pilot) reste la seule vérité de l'étape MEP.**
  forge-ops fournit les *moyens* (staging, bascule, rollback, journal) et des *preuves*
  (verdicts O-1…O-4) que M-1…M-5 consomme — jamais un duplicata.
- **Invocation par le pilot uniquement.** Les projets produits, autonomes, ne l'appellent
  pas en direct : leurs besoins passent par un run piloté.
- Les retours d'usage remontent par lots vers `input\` du pilot, comme toute forge.

## Les trois verbes

| Verbe | Commande | Effet |
|---|---|---|
| **déployer** | `node scripts/ops.mjs deployer <build> <cible>` | copie le build en release datée, exécute le healthcheck **avant** toute bascule, repointe `COURANT`, journalise |
| **restaurer** | `node scripts/ops.mjs restaurer <cible>` | re-healthcheck de la release précédente puis bascule arrière, journalisée — le rollback n'est pas un écrit, c'est un geste prouvé |
| **exploiter** | `node scripts/ops.mjs etat <cible> [--sortie fichier.json]` + `journal.jsonl` | état machine-lisible (option : instantané déclaré pour O-6) et journal append-only au contrat ledger (seq croissant depuis 1) |

**Règle dure : jamais de bascule sur release malade.** Un healthcheck en échec laisse
`COURANT` intact et journalise `deploiement_refuse` (exit 1).

## Canary local simulé (v0 — TF-0107)

| Verbe | Commande | Effet |
|---|---|---|
| **canary** | `node scripts/ops.mjs canary <build> <cible> [--seuils fichier.json]` | bascule progressive **simulée** (paliers de trafic croissants, défaut `1→5→25→50→100`) entre `COURANT` et un candidat ; chaque palier mesuré (`metriques.mjs` de la release) contre un **critère de promotion explicite** venu du fichier de config — un palier rejeté ⇒ abandon (`canary_annulation`), `COURANT` intact |

Sans cible k8s : prépare la marche vers Argo Rollouts/Flagger. Candidat sans `metriques.mjs`
→ canary refusé (utiliser `deployer`) — l'oubli n'existe pas. Événements journal :
`canary_etape` (par palier) et `canary_promotion` (bascule finale, traité comme `deploiement`
par O4).

## Plans cloud (v1 — TF-0081, plan-first)

| Verbe | Commande | Effet |
|---|---|---|
| **plan** | `node scripts/ops.mjs plan <cible> <build> [--sortie plan.json]` | génère le plan d'exécution **déterministe** d'une cible cloud — 4 phases ordonnées (provision, déploiement, healthcheck, **rollback**) — sans rien exécuter |

Cibles : `railway` · `gcp` (Cloud Run) · `azure` (Container Apps) · `aws` (App Runner) —
chacune adossée à sa **fiche expert admise** (`experts-forge/fiches/expert-ops-<cible>.md`,
verdict MATERIEL). L'oracle **O-5** juge un plan (`oracle-ops.mjs --plan plan.json`) :
4 phases non vides, rollback réel, CLI cohérente avec la cible, zéro credential.

**Frontière credentials (non négociable).** Aucun credential ne transite par la forge,
jamais : les plans portent des **placeholders** (`<PROJET>`, `<REGION>`…) résolus par
l'environnement du run. Les self-tests restent hors-ligne, déterministes, à coût nul.
**L'exécution réelle d'un plan est un acte de run MEP** : environnement authentifié fourni
par l'humain, GO humain, verdicts O-1…O-5 + M-1…M-5 au dossier. La première exécution
réelle par cible est consignée dans `fiches\forge-ops.md` du pilot — c'est elle qui
transforme le plan prouvé en geste prouvé.

## Contrat de la cible d'exploitation

```
<cible>/
├── releases/<AAAAMMJJTHHMMSS>/   # une release = un déploiement immuable
├── COURANT                       # pointeur texte (pas de symlink : portable Windows)
└── journal.jsonl                 # append-only, contrat ledger forge-agents (seq, ts, type)
```

Healthcheck : si la release contient `sante.mjs`, il est exécuté (`node sante.mjs`,
exit 0 = sain). Sans `sante.mjs`, le déploiement est refusé — une app sans contrat de
santé n'est pas exploitable (l'oubli n'existe pas).

## Oracles (verdicts consommés par la MEP)

`node oracles/oracle-ops.mjs <cible>` — contrat JSON `{oracle,domaine,artefact,verdict,
findings,non_juge}`, exit 0/1/2 :
- **O1** `COURANT` pointe une release existante ;
- **O2** la release courante repasse son healthcheck (exécution réelle) ;
- **O3** journal intègre (seq strictement croissant depuis 1, types connus) ;
- **O4** rollback prouvable : la release précédente existe encore et le journal est
  cohérent avec `COURANT`.
- **O5** `--plan <fichier>` : plan cloud complet (4 phases, rollback réel, zéro credential).
- **O6** `--drift <fichier> <cible>` (TF-0107) : état déclaré (`etat --sortie`) vs constaté
  maintenant — comble un angle mort d'O1-O4 (self-cohérence interne seulement, jamais
  vérifiée contre un témoin extérieur) : journal tronqué/réécrit après coup, déploiement
  furtif (release sur disque, absente du journal). Toujours un constat, jamais un geste.

`non_juge` : santé applicative au-delà du healthcheck déclaré · GO production (humain) ·
supervision continue · secrets/config d'environnement (jamais transportés par la forge).

## Verdict « rollback recommandé » (v0 — TF-0107, recommandation seule)

`node oracles/oracle-ops.mjs --verdict-rollback <mesures.json> --seuils <fichier.json>` —
compare des mesures post-bascule (latence, taux d'erreur) à des **seuils SLO fixés par
l'humain** (fichier de config **obligatoire**, aucun défaut implicite). Verdict
`stable` (exit 0) · `rollback_recommande` (exit 1) · `donnees_insuffisantes` (exit 2, fenêtre
sous le minimum ou seuils absents). **Doctrine intacte : ops outille, ne décide jamais** —
la recommandation ne déclenche rien ; le rollback reste un geste humain via
`ops.mjs restaurer`.

## Preuve par le geste

`node oracles/self-test.mjs` rejoue un **déploiement réel local** : app témoin déployée,
mise à jour, restaurée — chaque état validé par l'oracle (fixture verte), et chaque défaut
type prouvé refusé (fixtures rouges : healthcheck en échec, journal corrompu, pointeur
fantôme, restauration sans précédent, canary dégradé, dérive O-6, mesures hors seuils SLO).
À rejouer après toute modification.

## Langue

Tout livrable et toute interaction en **français**.

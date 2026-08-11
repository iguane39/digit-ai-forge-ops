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
| **exploiter** | `node scripts/ops.mjs etat <cible>` + `journal.jsonl` | état machine-lisible et journal append-only au contrat ledger (seq croissant depuis 1) |

**Règle dure : jamais de bascule sur release malade.** Un healthcheck en échec laisse
`COURANT` intact et journalise `deploiement_refuse` (exit 1).

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

`non_juge` : santé applicative au-delà du healthcheck déclaré · GO production (humain) ·
supervision continue · secrets/config d'environnement (jamais transportés par la forge).

## Preuve par le geste

`node oracles/self-test.mjs` rejoue un **déploiement réel local** : app témoin déployée,
mise à jour, restaurée — chaque état validé par l'oracle (fixture verte), et chaque défaut
type prouvé refusé (fixtures rouges : healthcheck en échec, journal corrompu, pointeur
fantôme, restauration sans précédent). À rejouer après toute modification.

## Langue

Tout livrable et toute interaction en **français**.

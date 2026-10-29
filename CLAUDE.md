# digit-ai-forge-ops — exploitation (déployer · exploiter · restaurer)

Forge **transverse** de l'écosystème Digit-AI, née de TF-0040 (trou prouvé : MEP sans forge,
déploiement artisanal, qualif sans instances outillées). Elle **outille** l'étape MEP du
pilot — elle ne la remplace pas.

## Frontières (non négociables)

- **La forge outille, le pilot décide, l'humain donne le GO.** Le GO de mise en production
  est un gate humain incompressible : forge-ops ne déploie jamais en production de sa propre
  initiative et ne rend jamais ce verdict à la place de l'oracle MEP.
- **Les portes M (`ETAPE-MEP.md` du pilot, liste à jour sur ce document) restent la seule
  vérité de l'étape MEP.** forge-ops fournit les *moyens* (staging, bascule, rollback,
  journal) et des *preuves* (verdicts O-1…O-4) que ces portes consomment — jamais un
  duplicata.
- **Invocation par le pilot uniquement.** Les projets produits, autonomes, ne l'appellent
  pas en direct : leurs besoins passent par un run piloté.
- Les retours d'usage remontent par lots vers `input\` du pilot, comme toute forge.

## Les trois verbes

| Verbe | Commande | Effet |
|---|---|---|
| **déployer** | `node scripts/ops.mjs deployer <build> <cible>` | copie le build en release datée, exécute le healthcheck **avant** toute bascule, **scelle une empreinte** (chemins + sha256, TF-0288), repointe `COURANT`, journalise |
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
par O4). Tous les paliers franchis ⇒ **empreinte scellée** avant bascule (même fonction,
même point du cycle que `deployer` — TF-0298) : une cible promue par canary n'est plus
SKIP à vie sur O-7.

## Plans cloud (v1 — TF-0081, plan-first)

| Verbe | Commande | Effet |
|---|---|---|
| **plan** | `node scripts/ops.mjs plan <cible> <build> [--sortie plan.json]` | génère le plan d'exécution **déterministe** d'une cible cloud — 4 phases ordonnées (provision, déploiement, healthcheck, **rollback**) — sans rien exécuter |

Cibles : `railway` · `gcp` (Cloud Run) · `azure` (Container Apps) · `aws` (App Runner) · `supabase` (projet hébergé ; retour
arrière par migration corrective, restauration = geste humain irréversible ; depuis TF-2007, rejeu des migrations sur
une base locale vide et contrôle de dérive avant le push, secrets des fonctions posés avant elles, une seule voie face
à l'intégration GitHub, branching dit dépense humaine) · `cloudflare-workers` (Worker avec
ressources statiques ; version téléversée sans trafic puis déployée, retour arrière natif `wrangler rollback` ;
Workers n'accepte pas un domaine dont les serveurs de noms ne sont pas chez Cloudflare, TF-1995) —
chacune adossée à sa **fiche expert admise** (`experts-forge/fiches/expert-ops-<cible>.md`,
verdict MATERIEL). Un front sur Workers et une base sur Supabase se jouent dans un ordre et avec des
variables nommées : `references/ENCHAINEMENT-PLANS.md` (TF-2010). L'oracle **O-5** juge un plan (`oracle-ops.mjs --plan plan.json`) :
4 phases non vides, rollback réel, CLI cohérente avec la cible, zéro credential. Sur un plan `supabase` (TF-2007),
le push suit le rejeu local (`supabase db reset --local`) et le contrôle de dérive (`supabase db diff --linked`).
Les secrets y précèdent les fonctions, et la voie est tranchée face à « Deploy to production ».

**Frontière credentials (non négociable).** Aucun credential ne transite par la forge,
jamais : les plans portent des **placeholders** (`<PROJET>`, `<REGION>`…) résolus par
l'environnement du run. Les self-tests restent hors-ligne, déterministes, à coût nul.
**L'exécution réelle d'un plan est un acte de run MEP** : environnement authentifié fourni
par l'humain, GO humain, verdicts O-1…O-5 + les portes M de `ETAPE-MEP.md` (pilot) au
dossier. La première exécution
réelle par cible est consignée dans `fiches\forge-ops.md` du pilot — c'est elle qui
transforme le plan prouvé en geste prouvé.
**Vers un environnement géré, le plan s'exécute DANS la chaîne du produit, jamais depuis un
poste** (TF-1212, décision humaine D-3 (a) du 17/10/2026, porte M-16 de `ETAPE-MEP.md`) : ses
phases deviennent les étapes du pipeline, le jeton est un secret de la chaîne, et le GO humain
est la porte d'approbation de la chaîne ou la poussée d'un commit nommé. Le référentiel d'audit
de la maison le pose en contrôle fatal (CTL-D09-01) : « Tout déploiement vers un environnement
géré transite exclusivement par un pipeline CI/CD automatisé ; chaque exécution produit un
journal immuable et horodaté (auteur, version, cible, résultat). » `ops.mjs deployer` et
`canary` restent les gestes d'une cible LOCALE (staging sur le poste), qui n'est pas un
environnement géré.

## Réinitialiser une base hors production (TF-2013)

| Verbe | Commande | Effet |
|---|---|---|
| **reinitialiser-base** | `node scripts/ops.mjs reinitialiser-base <declaration.json> <cible> [--executer] [--sortie plan.json]` | lit la déclaration `forge-ops/bases@1` du produit et rend le **plan** ordonné (vider, rejouer les migrations, charger les données, vérifier) sans rien exécuter ; `--executer` le joue, et seulement sur une cible `postgres-docker` d'un Docker local |

**Jamais la production.** Une cible `production`, d'environnement non déclaré, ou qui partage le serveur,
le conteneur ou le projet Supabase d'une base production est refusée en exit 2, en plan comme en
exécution. La production se déclare, ou s'écarte par `aucune_production` motivé. Supabase : plan
seulement, commandes officielles lues le 29/10/2026 ; la remise à zéro d'un projet distant (`--linked`)
reste un geste humain sous GO (R-38). Chaque geste exécuté ou refusé entre au `journal.jsonl` posé à
côté de la déclaration. Format, refus et non-jugé : README, section du même nom.

## Contrat de la cible d'exploitation

```
<cible>/
├── releases/<AAAAMMJJTHHMMSS>/    # une release = un déploiement immuable
├── empreintes/<AAAAMMJJTHHMMSS>.json  # manifeste scellé au déploiement ou à la promotion canary (sha256, TF-0288, TF-0298)
├── COURANT                        # pointeur texte (pas de symlink : portable Windows)
└── journal.jsonl                  # append-only, contrat ledger forge-agents (seq, ts, type)
```

Healthcheck : si la release contient `sante.mjs`, il est exécuté (`node sante.mjs`,
exit 0 = sain). Sans `sante.mjs`, le déploiement est refusé — une app sans contrat de
santé n'est pas exploitable (l'oubli n'existe pas).

**Cible tenue par une plateforme externe (TF-0844).** Une cible déployée via `plan`
(railway, gcp, azure, aws...) ne porte ni `COURANT` ni `journal.jsonl` : la plateforme les
tient elle-même. Déclarer `<cible>/PLATEFORME` (texte, ex. `railway`) rend O1/O3
**SANS_OBJET** au lieu d'un FAIL à tort sur un déploiement sain et restauré — déclaration
explicite seulement, jamais déduite du nom du dossier (l'oubli n'existe pas).

## Oracles (verdicts consommés par la MEP)

`node oracles/decouvrir-oracles.mjs` — la liste des oracles de la forge, LUE SUR LE DISQUE
(contrat `digit-ai/decouverte-oracles@1` du pilot, TF-1319) : c'est elle que le juge
d'enclenchement du pilot confronte aux verdicts consignés au ledger d'un run.

`node oracles/oracle-ops.mjs <cible>` — contrat JSON `{oracle,domaine,artefact,verdict,
findings,non_juge}`, exit 0/1/2 :
- **O1** `COURANT` pointe une release existante (SANS_OBJET si `PLATEFORME` est déclaré, TF-0844) ;
- **O2** la release courante repasse son healthcheck (exécution réelle) ;
- **O3** journal intègre (seq strictement croissant depuis 1, types connus ; même SANS_OBJET
  que O1 si `PLATEFORME` est déclaré, TF-0844) ;
- **O4** rollback prouvable : la release précédente existe encore et le journal est
  cohérent avec `COURANT`.
- **O5** `--plan <fichier>` : plan cloud complet (4 phases, rollback réel, zéro credential).
- **O6** `--drift <fichier> <cible>` (TF-0107) : état déclaré (`etat --sortie`) vs constaté
  maintenant — comble un angle mort d'O1-O4 (self-cohérence interne seulement, jamais
  vérifiée contre un témoin extérieur) : journal tronqué/réécrit après coup, déploiement
  furtif (release sur disque, absente du journal). Toujours un constat, jamais un geste.
- **O7** `<cible> --empreinte` (TF-0288, étendu TF-0298) : fichiers de la release
  COURANTE vs empreinte scellée par `deployer` OU `canary` au moment de la promotion
  (sha256 par fichier) — comble l'angle mort laissé par O-6 (qui juge le journal, jamais
  le CONTENU d'une release déjà journalisée) : fichier modifié/supprimé/ajouté en place,
  nommé au verdict. SKIP motivé (jamais un FAIL rétroactif) si la release n'a pas
  d'empreinte (déploiement antérieur au contrôle, ou passé hors `ops.mjs` — le seul trou
  qui reste : un déploiement fait hors ops, pas via `deployer`/`canary`).

- **O8** `<racine> --planifie` (TF-0527) : toute définition **planifiée** du dépôt porte un
  **mode d'exercice à la demande**, câblé et distinct de sa cadence. Mesure fondatrice : une
  veille mensuelle déclarée « en place » dont le premier passage a rendu « rien à faire » **en
  succès** — pas une ligne n'avait tourné sur un agent, et le premier passage réel aurait eu lieu
  quinze jours plus tard, au moment où l'on compte dessus. Un paramètre **déclaré mais jamais lu**
  est jugé aussi durement qu'un paramètre absent : une affordance est câblée ou elle n'existe pas.
  L'oracle lit des définitions, jamais un historique — `# exerce_le: AAAA-MM-JJ` déclare l'exercice
  et reste un avertissement, jamais un FAIL rétroactif.

- **O18** `--revisions-actives <fichier.json>` (TF-1639) : sur une sortie **capturée** de
  `az containerapp revision list -o json` (aucun appel réseau), chaque application ne garde
  actives que ses révisions servies et **une** N-1 saine à 0 %. Mesure fondatrice (Produit-64,
  12/10/2026) : le mode multiple sans borne a laissé 100 révisions actives sur une application,
  minReplicas facturés à 0 % de trafic, 1 552,23 EUR en septembre pour un budget de 100, sous
  O-1 à O-4 PASS. Toute révision en trop est nommée avec sa commande de désactivation
  (réversible). Le plan `azure` porte la borne et l'étape de ménage qui la tient (TF-1638).

- **O19** `--sauvegarde <declaration.json> [--le AAAA-MM-JJ]` (TF-1212, décision humaine D-3 (a)
  du 17/10/2026) : sur une déclaration `forge-ops/sauvegarde@1` (aucun appel réseau), chaque actif
  de données critique porte son RPO, son RTO, le mécanisme, la fréquence (jamais plus lâche que le
  RPO) et la configuration effective de sa sauvegarde, et un exercice de restauration **réussi**
  depuis 12 mois au plus, de durée mesurée sous le RTO et d'intégrité constatée. `actifs: []`
  n'est recevable qu'avec `aucun_actif_critique: "<motif>"`. Mesure fondatrice : un produit à
  O-1…O-4 PASS a échoué au référentiel d'audit de la maison les trois contrôles fatals de
  sauvegarde (CTL-D05-09, CTL-D12-06, CTL-D16-09) ; O-4 prouve le retour à la release N-1, jamais
  la restauration des DONNÉES. Verdict brut (FAIL, exit 1) ; la porte M-17 du pilot le lit en
  avertissement tant que l'humain n'en a pas fait un blocage.

- **O20** `--conteneurs-a-etat <racine> [--composants <COMPOSANTS-OPS.md>]` (TF-1986, lot Produit-85 du
  24/10/2026). Une image est à état si le référentiel daté `references/CONTENEURS-A-ETAT.json` ou la table
  « Composants à état » de `COMPOSANTS-OPS.md` la nomme. Chacun de ses `docker run` et services compose monte
  alors un volume nommé ou un dossier de l'hôte sur le chemin exact de ses données. Chaque `docker start` vise
  un conteneur dont la commande de création est écrite, et la table déclare volume et commande de création.
  Mesure fondatrice : un conteneur sans volume, créé par une commande écrite nulle part, a perdu une tâche de
  612 photos au redémarrage de Docker. Lecture seule, aucune commande Docker exécutée.

- **O21** `--workflow-deploiement <fichier.yml> [--environnement <nom>] [--protection <capture.json>]`
  (TF-2003, étude du pilot du 28/10/2026). Le GO humain d'un déploiement de production par GitHub Actions est
  l'approbation d'un environnement protégé, et il doit être PROUVÉ : un environnement nommé mais jamais réglé
  est créé sans règle au premier run. Le gabarit `gabarits/workflow-deploiement-production.yml` porte un job
  de garde qui lit l'environnement par l'API et refuse sans relecteur requis. O-21 juge aussi la concurrence
  (jamais `cancel-in-progress: true`) et réserve `id-token: write` au job de production. Faits sourcés et
  datés : `references/WORKFLOW-DEPLOIEMENT.md`.

`non_juge` : santé applicative au-delà du healthcheck déclaré · GO production (humain) ·
supervision continue · secrets/config d'environnement (jamais transportés par la forge) ·
l'EXERCICE d'un travail planifié (O-8 lit des définitions, pas des passages) et les
planifications posées hors dépôt (interface web, tâche planifiée d'un serveur).

## Gestes d'exploitation constatés — `references/GESTES-EXPLOITATION.md`

Les **faits du monde** rencontrés en exploitation, qu'aucune documentation d'éditeur n'énonce et
qui se re-paient à chaque redécouverte : datés, sourcés, mesurés (loi n° 4). À LIRE avant de
conclure qu'un geste est impossible — conclure trop vite renvoie le sujet à l'humain sans raison.
Deux entrées au 23/08/2026 : une instance d'approbation **fige** la contrainte de séparation des
rôles à sa création (relâcher le réglage ne débloque que les instances futures : annuler puis
relancer, et remettre le réglage), et un travail planifié s'**exerce** avant d'être déclaré en
place. Une entrée non mesurée n'y entre pas.

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
fantôme, restauration sans précédent, canary dégradé, dérive O-6, écart d'empreinte O-7
(voies deployer et canary), mesures hors seuils SLO, base production ou non déclarée à
réinitialiser, conteneur à état sans volume ou recréé par une commande écrite nulle part). L'exercice réel de `reinitialiser-base` sur un conteneur Postgres jetable se joue à
la demande : `FORGE_OPS_EXERCICE_DOCKER=1 node oracles/self-test.mjs`. À rejouer après toute
modification.

## Langue

Tout livrable et toute interaction en **français**.

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

- **O22** `--mise-en-service <COMPOSANTS-OPS.md> [--le "AAAA-MM-JJ HH:MM"]` (D-108 (b), décision humaine du
  29/10/2026). Une tâche planifiée ou récurrente déclarée « en service » (« actif », « partagé » ou « en
  service ») porte la lecture d'une première exécution RÉELLE (identifiant ou URL de la publication, date et
  heure de lecture) et sa prochaine échéance ; une échéance dépassée sans lecture plus récente est un constat.
  Mesure fondatrice : le 21/10/2026, une tâche planifiée de publication sur un réseau social déclarée « C'est en
  service » sur la foi d'un essai ; aucune publication du 20 au 25/10, vérification de 18 h 45 non faite. La
  tâche est désignée par sa table (titre, Cadence ou Type), jamais devinée. Document seul, aucun appel réseau ;
  l'oracle ne tourne pas à l'échéance, c'est le run qui le rejoue. Fixtures :
  `fixtures/o22-mise-en-service-planifiee/`. **Depuis le 14/11/2026 (TF-2560, D-108 (b)) la lecture est
  postérieure à la mise en service** : colonne `En service depuis` (date et heure), une lecture qui la précède
  ou l'égale est un constat — l'identifiant d'une publication lue pendant l'essai n'est pas celui de la tâche en
  service. **L'alerte d'échéance est tenue hors de la tâche** : `node scripts/surveiller-echeances.mjs controler
  <echeancier.json> <releve.json> --lance-par <planificateur du contrôle> [--le <ISO 8601>]` lit l'échéancier
  déclaré (`forge-ops/echeancier@1`) et le relevé des publications lues (`forge-ops/publications-lues@1`, écrit
  par le run) et rend une alerte `ECHEANCE-DEPASSEE` nommée par échéance dépassée sans publication lue (exit 1) ;
  `releve-anterieur` (exit 3) quand le relevé précède la fenêtre qu'il devrait juger, exit 2 pour une entrée
  illisible et pour un contrôle lancé par le planificateur d'une tâche qu'il surveille (une tâche arrêtée
  n'exécute plus sa propre surveillance : le fait du 21/10/2026). Aucun appel à une plateforme ; qui le lance,
  quand, et vers qui va l'alerte restent des décisions de run (limites dites : `references/GESTES-EXPLOITATION.md`
  G-09 ; logique `scripts/lib-echeances.mjs`, fixtures `fixtures/echeances/`).

- **O23** `--reseau-docker <pile ou fichier.tf>` (TF-2164, lot Produit-86 20261104a RO-2). Un réseau Docker posé
  par Terraform relève les plages prises avant d'en choisir une (`scripts/plages-docker.mjs`, branché par un
  `data "external"`) et pose `lifecycle { ignore_changes = [ipam_config] }` d'office. Mesure fondatrice : une
  plage écrite à la main déjà prise (« Pool overlaps »), puis un remplacement du réseau à chaque apply, 3
  déploiements en échec le 04/11/2026 ; rejoué avec Terraform 1.12.2 : « must be replaced » sans la ligne, « No
  changes » avec. Gabarit `gabarits/reseau-docker.tf`, faits datés `references/RESEAU-ET-FRONTAL-DOCKER.md`.
  Statique, aucun appel au démon. Fixtures : `fixtures/o23-reseau-docker/`, `fixtures/plages-docker/`.

- **O24** `--frontal-nginx <fichier.conf ou dossier>` (TF-2165, lot Produit-86 20261104a RO-3). Un frontal
  nginx résout son amont à chaque requête : `resolver 127.0.0.11 valid=10s;`, l'amont dans une variable,
  `proxy_pass $amont;`. Mesure fondatrice : `proxy_pass http://app:8000;` résolu une fois, l'application
  recréée change d'adresse, 502 (1 déploiement en échec le 04/11/2026) ; rejoué sur nginx 1.30-alpine : 502 en
  littéral, 200 avec le gabarit (`FORGE_OPS_EXERCICE_DOCKER=1 node oracles/self-test.mjs`). Gabarit
  `gabarits/frontal-nginx.conf`, faits datés `references/RESEAU-ET-FRONTAL-DOCKER.md`. Statique, nginx n'est
  pas lancé. Fixtures : `fixtures/o24-frontal-nginx/`. TF-2177 : l'oracle juge aussi `fastcgi_pass`,
  `uwsgi_pass`, `scgi_pass` et `grpc_pass`, qui figent leur amont de la même façon (`nginx -t` refuse chacune
  écrite avec un nom d'hôte, « host not found in upstream », mesuré le 05/11/2026) ; le 502 après recréation
  n'est rejoué que pour `proxy_pass`.

- **O25** `--identifiants-test <fichier.json>` (TF-2167, lot Produit-86 20261104b RP-11). Un secret qu'un humain
  recopie se tire dans un alphabet sans sosie (0 O 1 l I) ni signe, 20 caractères au moins : générateur commun
  `scripts/lib-secret-humain.mjs`, commande `node scripts/tirer-secret-humain.mjs`. Mesure fondatrice : `secrets.token_urlsafe`
  produisait « _ » et des sosies, le porteur a essuyé 2 refus 401 alors que httpx et Playwright passaient. O-25 juge un
  fichier `forge-ops/identifiants-test@1`, nomme le compte et la POSITION du défaut, jamais la valeur. Écart à la
  lettre déclaré : minuscule, majuscule et chiffre exigés. Faits : `references/IDENTIFIANTS-DE-TEST.md`. Fixtures :
  `fixtures/o25-identifiants-test/`.
  **TF-2166 (règle du porteur, 04/11/2026 : « arrête de changer les mdp à chaque fois que tu déploies une nouvelle
  version. Et remonte cette règle à la Factory. »).** Les identifiants de test remis à l'humain restent stables d'un
  déploiement à l'autre : `scripts/identifiants-test.mjs assurer` garde les mots de passe existants et ne crée que
  pour un fichier ou un compte absent ; `renouveler --demande "…"` est le seul geste qui en change un ;
  `verifier --commande "…"` joue la connexion du produit (secrets dans l'environnement du fils, jamais affichés).
  `oracle-ops.mjs --identifiants-test <fichier> --journal <journal.jsonl>` refuse un renouvellement sans demande, une
  création hors fichier ou compte absent, et ce qui n'est pas suivi d'une connexion réussie. Mesure fondatrice : 14
  déploiements le 04/11, autant de mots de passe à recopier.

- **O26** `--version-servie <capture.json> [--depot <dossier git>] [--attendu <commit>]` (TF-2201, lot Produit-86
  20261105b RP-21). La version servie se LIT dans `/healthz`, elle ne se reconstitue pas : la réponse porte un champ
  `commit` de 7 à 40 caractères hexadécimaux ; avec `--depot`, c'est un commit du dépôt ; avec `--attendu`, c'est
  celui que le dossier de MEP annonce. Mesure fondatrice : l'empreinte servie `23ea38d71963` ne correspondait à aucun
  des 25 derniers commits, le dossier de MEP citait deux commits servis, 25 commits recalculés pour dater la
  préproduction. La lecture est `node scripts/version-servie.mjs lire <url ou capture> [--chemin /healthz] [--sortie
  capture.json] [--attendu <commit>]` (un GET, aucune écriture distante) : exit 0 lu, 1 autre version, 2 illisible.
  Les plans `azure` et `aws` passent le commit à l'image (`--build-arg COMMIT_SHA=<COMMIT>`, `<COMMIT>` = `git rev-parse
  HEAD` du produit) et relisent la version servie ; O-5 refuse (majeur) un plan de ces deux cibles qui ne le fait pas.
  Le Dockerfile du produit déclare `ARG COMMIT_SHA` et son `/healthz` rend `commit`. `gcp` (fichier de construction
  `gabarits/cloudbuild-commit.yaml` et substitution `_COMMIT_SHA`, `gcloud builds submit --tag` n'acceptant aucun argument de
  construction) et `railway` (variable de service `COMMIT_SHA` posée par `railway variable set … --skip-deploys`, lue par
  `ARG`) le passent depuis TF-2244, d'après les pages de l'éditeur lues le 06/11/2026 ; O-5 les refuse sans lui, et le
  non_juge d'O-26 dit que ni l'un ni l'autre n'est éprouvé par un déploiement réel. Le dossier de MEP cite la sortie JSON de `lire`.

- **O27** `--inventaire-a-jour <COMPOSANTS-OPS.md> --etat <genre>:<fichier> [--etat …]` (TF-2209, lot Produit-86
  20261105e RP-29). L'inventaire des composants est confronté aux sorties d'état de la MEP, et « prêt » est refusé sur un
  composant présent non inventorié (FAIL, un constat bloquant par composant, avec la sortie d'origine). Genres :
  `terraform:` (`terraform state list` ; `data.*` et les types sans ressource réelle ne comptent pas), `docker:`
  (`docker ps --format "{{.Names}}"`, filtré sur le produit), `azure:` (`az resource list -g <groupe> -o json` ou
  `az graph query`), `noms:` (export d'O-14). Un nom se lit comme un mot entier : `exemple-api` n'est pas inventorié par
  `ca-exemple-api`. Sans sortie d'état : SKIP, « prêt » ne s'appuie pas sur l'inventaire. Mesure fondatrice :
  `COMPOSANTS-OPS.md` resté au texte du premier commit pendant 3 déploiements, sans la machine Azure, le Docker local ni
  Foundry ; la machine est restée 2 jours sans usage. Le plan `azure` capture `az resource list` et rejoue O-27 après la
  bascule. `ops.mjs etat` n'est pas un genre (aucun nom de composant). Fixtures : `fixtures/o27-inventaire-a-jour/`.

- **O28** `--reglages-plateforme <releve.json> [--registre <fichier>] [--ecarts <fichier>]` (TF-2230, décision humaine D-178 (a)
  du 06/11/2026 : « réglage admissible appliqué à la création, vérifié à chaque livraison, exception décidée »). Chaque réglage des
  plateformes que le relevé déclare (Supabase, GitHub, Cloudflare) est LU et conforme à l'`attendu` du registre du pilot
  (`references/REGLAGES-SURS-PAR-DEFAUT.json`, lu par `$FORGE_ROOT`, sinon le parent de ce dépôt ; la recette en porte une copie,
  `fixtures/o28-reglages-plateforme/registre.json`, jamais le fichier du pilot). Un réglage non lu, une lecture en échec, un réglage
  hors de son attendu sans décision enregistrée est un constat bloquant : « prêt » est refusé, avant la MEP. Un réglage classé
  `decision` se juge de même ; l'écart que l'humain a accepté se déclare dans `--ecarts` (`forge-ops/ecarts-acceptes@1` : ses mots,
  sa date, la valeur lue qu'il accepte) et se vérifie TEL QUE DÉCIDÉ : si l'état lu bouge, l'écart n'est plus le sien. Le relevé se
  prend par `node scripts/relever-reglages.mjs <Plateforme> --executer` (chaque `cmd_lire` du registre, lecture seule : une commande
  qui écrit n'est jamais jouée ; les secrets restent dans l'environnement du run). Les plans `supabase` et `cloudflare-workers` le
  prescrivent dans leur phase provision, et O-5 les refuse sans lui. Le plan `supabase` déclare aussi que `supabase db push` est
  INCOMPATIBLE avec la restriction des adresses (`network-restrictions`) depuis un exécuteur hébergé : connexion directe à Postgres,
  filtrée, et 5 622 plages IPv4 d'exécuteurs GitHub (mesuré le 06/11/2026) impossibles à déclarer ; la voie compatible est l'API de
  gestion (HTTPS), ou un poste aux adresses déclarées sous GO humain.
- **O29** `--convergence <capture>` (TF-2271, lot Produit-86 20261106a RP-44). Une chaîne Terraform n'est réussie que si le
  plan SUIVANT son apply est vide. La capture est celle de `terraform show -json <plan>` (ou la sortie texte de `terraform
  plan`) pris juste après l'apply, par `node scripts/convergence-terraform.mjs verifier <pile> --sortie capture.json` ; un plan
  qui change encore une ressource est un constat bloquant, une ressource par constat, avec ses attributs et la commande
  `terraform apply -replace='<adresse>'` ; une capture illisible est FAIL. `converger <pile> [--executer]` joue le remède :
  UN tour de `-replace` pour les ressources que le plan dit « update », puis une nouvelle re-planification ; sans
  `--executer`, la commande est écrite et rien n'est appliqué, et un conteneur d'image à état (O-20,
  `references/CONTENEURS-A-ETAT.json`) n'est jamais remplacé par la chaîne. Mesure fondatrice : 5 conteneurs « mis à jour sur
  place » à chaque plan, jamais appliqués ; la sonde de WebGoat, désactivée au code depuis le 04/11, n'a jamais atteint le
  conteneur, « unhealthy » depuis 47 h, sous un apply rendu PASS. Remède éprouvé avec Terraform 1.12.2 le 06/11/2026
  (`FORGE_OPS_EXERCICE_TERRAFORM=1 node oracles/self-test.mjs`). Fixtures : `fixtures/o29-convergence/`.

- **O30** `--etat-servi <releve.json>` (TF-2308, lot Produit-86 20261109a RP-53, classe `etat-servi-non-relu-apres-epreuve`).
  Une épreuve qui change l'état de l'instance servie (arrêt, mode dégradé, verrou) ne le laisse pas au porteur : le test de
  mise en production LIT la santé avant ses épreuves, joue les épreuves, la RELIT après la dernière, et échoue si l'état
  servi diffère. Le gabarit est `gabarits/smoke-mise-en-production.mjs`, à copier chez le produit avec son
  `smoke.config.json` : `url`, `sante.chemin` (adresse de santé, `/healthz` par défaut : un produit dont la santé ne s'expose
  pas à `/healthz` la déclare), `sante.champs` (champs qui font l'état, tout le corps sinon), `sante.ignorer` (champs
  volatils), `epreuves` (`{ nom, commande }`, l'adresse arrive dans `SMOKE_URL`). Il compare le CORPS de la réponse, jamais
  le seul code : l'instance du cas fondateur répondait 200 en mode dégradé. Exit 0 identique · 1 état changé, instance muette
  ou épreuve en échec (la relecture a lieu quand même) · 2 usage ou départ illisible (aucune épreuve jouée). Il écrit un
  relevé `forge-ops/etat-servi@1` que l'oracle rejuge sans croire le gabarit : état de départ lu, relecture absente ou
  antérieure à la fin de la dernière épreuve (bloquant), un constat bloquant par champ changé avec sa valeur d'avant et
  d'après, réponse sans champ comparé (majeur). Remède : terminer par le geste qui remet l'état de départ (reprise de la
  passerelle), ou jouer l'épreuve contre une instance jetable. Mesure fondatrice : arrêt de mission joué en dernier, passerelle
  laissée en NO_EXTERNAL_AI pour toutes les missions, E-119, E-116 et E-125 en FAIL au second passage (04/11, 16:50). Fixtures :
  `fixtures/o30-etat-servi/` ; recette contre un faux service local dont une épreuve bascule l'état. Lacune dite : la porte M-3
  de `ETAPE-MEP.md` du pilot ne cite pas encore ce gabarit.

- **Application Terraform bornée** (TF-2312, lot Produit-84 20261109b, ledger seq 264, classe
  `attente-fournisseur-sur-service-inutilise`). Ce n'est pas une règle d'oracle mais un outil : `node
  scripts/appliquer-terraform.mjs <pile> (--projet <ref> | --sans-sonde) [--executer] [--relances N] [--attente S]`. Le fournisseur
  Supabase attend la santé de TOUS les services du projet après chaque modification (`supabase_settings` compris) : le 09/11/2026,
  une chaîne a échoué sur « Project Services Unhealthy … unhealthy service realtime » et passé à la relance 5 minutes plus tard ;
  sur le projet de qualification, realtime est UNHEALTHY de façon durable. L'outil (1) SONDE avant d'appliquer :
  `GET /v1/projects/<ref>/health?services=…` (API de gestion, HTTPS, lecture seule, jeton dans `SUPABASE_ACCESS_TOKEN` du run, jamais
  en argument), au plus N+1 lectures espacées de S secondes (défaut N = 3, S = 120) ; un projet encore malsain après la borne n'est
  PAS appliqué (exit 1, le service nommé) ; une sonde en erreur (401, réponse vide) n'est jamais lue comme « sain » (exit 2) ;
  (2) applique, et (3) ne relance QUE sur l'erreur de santé, au plus N fois, en relisant la santé entre deux essais ; toute autre erreur
  de Terraform s'arrête au premier essai (exit 2). `--sans-sonde` est un choix écrit : la sonde non jouée est dite à la première
  étape, la relance attend S secondes sans lire. Sans `--executer`, les gestes sont écrits et rien n'est appelé : l'application d'une
  pile sur un service hébergé se joue sous le GO du run (R-38). Désactiver realtime quand le produit ne l'utilise pas reste la décision
  du produit : la sortie la nomme, l'outil ne la prend jamais. Recette : `oracles/self-test.mjs` (faux serveur de santé sur la boucle
  locale, fixtures `fixtures/appliquer-terraform/`), plus l'exercice réel `FORGE_OPS_EXERCICE_TERRAFORM=1` sur une pile
  `terraform_data` dont le provisionneur local échoue N fois avec l'erreur de santé. Statuts rejoués le 12/11/2026 (TF-2397) : la liste
  des services et les statuts (`ACTIVE_HEALTHY`, `COMING_UP`, `UNHEALTHY`, `healthy` déprécié) sont relus sur la référence publique de
  l'API de gestion (`v1-get-services-health`, sans jeton), gardés en `fixtures/appliquer-terraform/api-sante-statuts.json` et rejoués
  par la recette. Lacune dite : le texte exact de l'erreur n'est connu que par ses mots du rapport. Geste : `references/GESTES-EXPLOITATION.md` G-06.

- **O31** `--application-terraform <racine ou fichier de chaîne> [--racine <dépôt>] [--releve <application.json>]` (TF-2397, suite de
  TF-2312, classe `controle-ecrit-non-cable-a-son-etape`). Une chaîne qui garde son `terraform apply` direct contre une pile qui pose
  `supabase_settings` retombe sur « Project Services Unhealthy », et rien ne la voyait. L'outil écrit désormais son relevé
  `forge-ops/application@1` par `--sortie <fichier>` (pile, choix de sonde, étapes, verdict, dernière lecture de santé ; jamais la sortie
  de Terraform ni le jeton ; écrit aussi en cas d'échec ; le dossier du relevé est vérifié AVANT l'apply). La règle lit les
  fichiers de chaîne (`.yml`/`.yaml`, `.sh`, `.bash`, `.ps1`, `.cmd`, `.bat`, `.mk`, Makefile) sous la racine : si une pile de la racine
  pose `supabase_settings` (directement ou par un module local), chaque `terraform` / `tofu` / `terragrunt apply` écrit en direct vers
  elle est un constat bloquant (fichier:ligne, commande `node <FORGE_OPS>/scripts/appliquer-terraform.mjs <pile> --projet <ref>
  --executer --sortie application.json`). La pile visée se lit à `-chdir=`, `cd <dossier> &&`, `working-directory:` de l'étape ou des
  `defaults.run` ; une pile qu'on ne sait pas lire est tenue pour concernée (un faux négatif de sécurité coûte plus qu'un faux positif
  qu'on lève en nommant la pile) ; un apply direct vers une autre pile est dit hors de la règle. L'outil appelé avec `--executer` sans
  `--sortie` est majeur (le relevé ne serait jamais écrit) ; `--sans-sonde` est un choix écrit, dit en information. Avec `--releve`,
  l'oracle juge que l'apply a abouti, que la santé a été lue saine avant, que les étapes sont cohérentes avec le verdict ; un projet
  refusé (`sante-refusee`), une santé persistante ou une erreur sont bloquants. Aucune pile ne pose `supabase_settings` et aucun relevé : SKIP.
  Logique : `scripts/lib-application-chaine.mjs`. Fixtures : `fixtures/o31-application-terraform/` (dix chaînes, onze relevés).
  Lacunes dites : une chaîne configurée hors fichiers de la racine (interface d'un service d'intégration, étape pliée `>`) n'est pas
  vue ; la porte M de `ETAPE-MEP.md` du pilot ne cite pas encore cette règle.

`non_juge` : santé applicative au-delà du healthcheck déclaré · GO production (humain) ·
supervision continue · secrets/config d'environnement (jamais transportés par la forge) ·
l'EXERCICE d'un travail planifié (O-8 lit des définitions, pas des passages) et les
planifications posées hors dépôt (interface web, tâche planifiée d'un serveur).

## Région de repli et sonde de capacité (TF-2129)

Le plan `azure` déclare une région de repli (`<REGION_REPLI>`) et prescrit, avant `az group create`, la
sonde `node scripts/sonder-capacite.mjs plan|juger`. Un SKU listé sans restriction (`az vm list-skus`)
ne prouve pas la capacité : le 03/11/2026, northeurope a refusé six fois une machine à deux cœurs
(409 `SkuNotAvailable`) alors que la liste ne montrait rien, et francecentral a répondu. Seul un essai
d'allocation prouve ; un réseau ne se déplaçant pas d'une région à l'autre, la sonde précède le premier
réseau. L'outil n'appelle jamais Azure et ne choisit rien : il propose la région retenue, le run
l'applique. O-5 refuse un plan azure sans repli ou dont la sonde suit le groupe. Le message
`SkuNotAvailable` mène à l'entrée G-05 de `references/GESTES-EXPLOITATION.md`.

## Restaurer une copie pg_dump dans Supabase (TF-2412, G-07)

Une copie pg_dump ne se restaure pas telle quelle dans un projet Supabase : `pg_restore --clean --single-transaction` échoue sur
« permission denied to change default privileges », car la copie porte les privilèges par défaut de `supabase_admin` sur `public`
(entrées `DEFAULT ACL` de son sommaire), que `postgres` ne peut pas rejouer (lot Produit-84 20261110a, ledger seq 278). Le gabarit
`gabarits/restauration-supabase.mjs` (à copier chez le produit, il n'importe rien de forge-ops) filtre ces entrées du sommaire :
`plan <copie.dump>` écrit les quatre commandes dans l'ordre (`pg_restore --list`, `liste`, `verifier`, `pg_restore --use-list`) ;
`liste` COMMENTE d'un « ; » les entrées `DEFAULT ACL` de `supabase_admin` (`--role` en ajoute) et laisse le reste du sommaire
identique à l'octet près ; `verifier` refuse une liste où il en reste (exit 1) et un texte qui n'est pas un sommaire (exit 2).
La forge ne se connecte à rien et ne restaure rien : la restauration (`--clean`, sur un service hébergé) se joue sous le GO du run
(R-38), la connexion par `SUPABASE_DB_URL` de l'environnement du run. Le plan `supabase` (phase `rollback`) le cite ; fixtures
`fixtures/restauration-supabase/`. Le fait et ses limites : G-07. Lacune dite : la forme des lignes `DEFAULT ACL` n'a pas été
relevée sur un vrai sommaire (`pg_restore` absent du poste de la campagne).

## Rattraper un déploiement Railway SKIPPED (TF-2519, G-08)

Quand les contrôles d'un commit échouent, le réglage « Wait for CI » de Railway marque son déploiement SKIPPED ; les contrôles relancés
au vert ne le redéclenchent pas, et la production reste sur l'ancienne version (16 minutes le 05/11/2026, lot Produit-02 20261105a
RT-148, ledger seq 693). `node scripts/rattraper-railway.mjs juger <releve.json> [--sortie verdict.json]` juge le relevé
`forge-ops/rattrapage-railway@1` que le run écrit (conclusion des contrôles, déploiements du service) : exit 1 `rattrapage-requis` (dernier
déploiement du commit SKIPPED, contrôles au vert) et ÉCRIT le geste, un déploiement NEUF du même commit (`serviceInstanceDeployV2`) ;
exit 0 quand le saut est la garde qui tient (contrôles non verts), quand le commit est déjà servi ou en route ; exit 3 pour FAILED ou
CRASHED ; exit 2 pour un relevé illisible. La forge n'appelle ni Railway ni GitHub : le geste change la production, il se joue sous le
GO du run (R-38), jeton de projet dans `RAILWAY_TOKEN` de l'environnement du run. Le plan `railway` (phase `healthcheck`) le cite ;
logique `scripts/lib-rattrapage-railway.mjs`, fixtures `fixtures/rattrapage-railway/`. Lacunes dites : arguments de la mutation et
en-tête du jeton à relire à l'API de Railway avant le premier envoi ; le workflow de rattrapage automatique et la stabilité de Chrome
dans l'oracle du consentement relèvent du produit.

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

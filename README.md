# digit-ai-forge-ops

Forge **exploitation** de l'écosystème Digit-AI — trois verbes : **déployer, exploiter,
restaurer**. Elle outille l'étape MEP du pilot (staging, bascule, rollback prouvé, journal) ;
elle ne décide rien : le GO de production reste humain, les portes M de l'étape MEP
(`ETAPE-MEP.md` du pilot, liste à jour sur ce document) restent la vérité de l'étape.
Née de TF-0040 (trou prouvé : MEP sans forge, déploiement artisanal).

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

# Plan cloud déterministe (railway | gcp | azure | aws | supabase | cloudflare-workers) — génère, n'exécute jamais
# Front Workers + base Supabase : ordre des deux plans, variables nommées, URL de redirection -> references/ENCHAINEMENT-PLANS.md
# Plan d'un PRODUIT DATA (databricks-bundle | powerbi-workspace) — même doctrine, publication sur GO humain (TF-0865)
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

# Oracle O-18 : révisions actives bornées (N servie + N-1 saine) sur une capture Container Apps
# (le plan azure porte la borne et l'étape de ménage qui la tient, TF-1638)
az containerapp revision list --name <app> --resource-group <rg> -o json > revisions.json
node oracles/oracle-ops.mjs --revisions-actives revisions.json

# Oracle O-19 : sauvegarde des actifs de données critiques (RPO/RTO, restauration exercée ≤ 12 mois)
# exemple de déclaration : fixtures/o19-sauvegarde/verte.json — porte M-17 de l'étape MEP du pilot
node oracles/oracle-ops.mjs --sauvegarde forge/etapes/mep/SAUVEGARDE.json

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
- **Cible tenue par une plateforme externe (TF-0844)** : une cible déployée par `plan`
  (railway, gcp, azure, aws...) ne porte NI `COURANT` NI `journal.jsonl` — la plateforme les
  tient elle-même. Déclarer un fichier `<cible>/PLATEFORME` (texte, ex. `railway`) pour que
  `oracle-ops.mjs` rende O1/O3 **SANS_OBJET** au lieu d'un FAIL à tort ; sans ce fichier,
  l'absence de `COURANT`/`journal.jsonl` reste jugée comme avant (l'oubli n'existe pas — la
  déclaration est explicite, jamais déduite du nom du dossier).
- **Cible conteneur Docker : `restaurer` refuse HORS CONTRAT (TF-1805).** La cible par défaut de
  l'étape MEP du pilot est un conteneur Docker local. `ops.mjs restaurer` ne restaure que des
  releases de fichiers : sur un dossier sans `COURANT` qui porte un `Dockerfile` ou un fichier
  compose, il sort en **exit 2** `[OPS HORS CONTRAT]`, nomme le geste manuel et n'écrit rien. Le
  retour arrière d'un conteneur suit le `ROLLBACK.md` du produit (arrêt de N, image N-1 taguée
  `<produit>:<run-id>`, healthcheck 200, retour à N : M-4 d'ETAPE-MEP). Restaurer un conteneur
  n'est pas implémenté ici : les conventions de tag et de service appartiennent au produit.
- **Un document `.md` passé à `oracle-ops.mjs` se juge comme document (TF-1804).** Seules O9,
  O12, O13 et O16 le jugent ; O1-O4 ne s'y appliquent pas, et le journal `.ops-journal.jsonl`
  scelle le verdict du document avec `nature: "document"`.

## Oracles

| Règle | Contrôle |
|---|---|
| O1 | `COURANT` pointe une release existante (SANS_OBJET si la cible porte `PLATEFORME` — pointeur tenu par une plateforme externe, ex. railway, TF-0844) |
| O2 | la release courante repasse son healthcheck (exécution réelle) |
| O3 | journal intègre : JSON valide, seq strictement croissant depuis 1, types connus (même SANS_OBJET que O1 si `PLATEFORME` est déclaré, TF-0844) |
| O4 | rollback prouvable : aucune release citée au journal n'est purgée ; pointeur ↔ histoire cohérents |
| O5 | `--plan <fichier>` : plan cloud complet (4 phases, rollback réel, zéro credential) |
| O6 | `--drift <fichier> <cible>` : état déclaré (`etat --sortie`) vs constaté — journal tronqué/réécrit, déploiement furtif |
| O7 | `<cible> --empreinte` : fichiers de la release courante vs empreinte scellée au déploiement ou à la promotion canary — fichier modifié/supprimé/ajouté en place ; SKIP motivé sans empreinte, ex. déploiement fait hors ops (TF-0288, TF-0298) |
| O10 | `--manifeste-servi <fichier>` : chaque paquet épinglé par version (`==`) dans un `requirements.txt` SERVI porte au moins une empreinte `--hash=` — une version republiée sous le même numéro entrerait sinon sans être vue (TF-1042) |
| O18 | `--revisions-actives <fichier.json>` : sur une sortie capturée de `az containerapp revision list -o json`, chaque application ne garde actives que ses révisions servies et une N-1 saine à 0 % ; toute révision en trop est nommée avec sa commande de désactivation (TF-1639) |
| O19 | `--sauvegarde <declaration.json> [--le AAAA-MM-JJ]` : sur une déclaration `forge-ops/sauvegarde@1`, chaque actif de données critique porte RPO, RTO, mécanisme, fréquence (≤ RPO) et configuration de sauvegarde, et un exercice de restauration réussi depuis ≤ 12 mois, de durée ≤ RTO et d'intégrité constatée ; `actifs: []` exige `aucun_actif_critique` motivé (TF-1212 ; CTL-D05-09, CTL-D12-06, CTL-D16-09 du référentiel d'audit) |

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

**Un worker qui planifie lui-même se lit aussi (TF-1806).** Une boucle `while True` à intervalles
`timedelta`, ou une bibliothèque de planification (APScheduler, `schedule`, Celery beat,
`node-cron`), ne laisse aucun fichier cron. O-8 lit donc aussi les sources `.py`, `.js`, `.mjs`
et `.ts` du dépôt, à quatre niveaux au plus, hors dépendances, tests et `frontend`. Il ne lit pas
un mode d'exercice dans du code : il lit sa déclaration, écrite en commentaire ou en docstring du
fichier qui planifie.

```python
"""Worker : santé, rafraîchissement planifié, purge.
exercice_a_la_demande: python -m app.cli executer-tache purge-creditsafe
exerce_le: 2026-10-15
"""
```

Déclaré, le worker compte comme une définition planifiée (PASS, avec la date d'exercice). Sans
déclaration, O-8 le nomme en avertissement et rend SKIP, jamais « rien à juger ». Mesuré le
15/10/2026 en lecture seule sur deux produits du parc : deux workers planifiés en code nommés,
là où O-8 rendait « aucune définition planifiée ».

Les faits d'exploitation constatés (comportements d'outils tiers qu'aucune documentation n'énonce)
vivent dans `references/GESTES-EXPLOITATION.md`, datés et sourcés.

## M-8 (fraîcheur de MEP) est tenu par O-7, pas par une page unique (TF-1075)

La porte de fraîcheur post-déploiement (règle M-8 de l'étape MEP du pilot) ne doit jamais se
fonder sur l'empreinte d'une seule page (banc défauts-échappés, livrable E-05 : comparer
uniquement `site/index.html` déclare « PRODUCTION CONFORME » quand une AUTRE page a changé
— faux vert mesuré le 26/08/2026, récidive le lendemain sur 70 pages). **O-7 (`--empreinte`)
tient déjà cette exigence** : il compare l'empreinte de TOUS les fichiers de la release, pas
seulement l'accueil. La preuve par perturbation (`self-test.mjs`, section M-8) modifie une
page hors accueil sans toucher l'accueil et vérifie qu'O-7 la voit et la NOMME, quand une
porte reproduisant le critère d'E-05 (une seule empreinte, une seule page) ne voit rien.
Reste côté pilot : citer O-7 comme le contrôle exécutable de M-8 dans `ETAPE-MEP.md`
(document hors périmètre de ce dépôt).

## Manifeste servi épinglé à l'empreinte (O-10, TF-1042)

`node oracles/oracle-ops.mjs --manifeste-servi <requirements.txt>` — mesure fondatrice
(Produit-11, 11/09/2026) : un `requirements.txt` copié dans l'image servie épinglait 37
paquets par **version** (`paquet==x.y.z`), aucun par **empreinte** (`--hash=sha256:...`).
Un numéro de version ne verrouille rien sur un registre qui admet la republication sous le
même numéro ; seule l'empreinte du contenu le fait — même principe qu'O-7 (déployé = scellé),
appliqué un cran plus tôt, au manifeste qui construit l'image. Périmètre v0 : format
`requirements.txt` (pip) uniquement, borné à la mesure fondatrice ; une ligne sans `==` (URL,
plage, `-r`/`-e`) n'épingle rien et n'est pas jugée.

## Kit Google Ads — import web et relevé en lecture seule (TF-1364)

`node scripts/google-ads/google-ads.mjs import-web | releve | delta | avant-depense` — le
déploiement de campagnes du Réseau de Recherche par l'écran Importations, sans jamais écrire dans le
compte : le kit génère le fichier que l'exploitant dépose, et juge un relevé que
`scripts/google-ads/collecter-compte.py` pose en lecture seule. Né du kit éprouvé chez un produit
les 21-22/09/2026 (191 lignes acceptées sur 191), rendu générique sur décision humaine D-69 (a) du
13/10/2026. Les règles apprises y sont des contrôles : colonnes, vocabulaires et colonnes
obligatoires lus dans les modèles de l'écran ; conformité comparée par contenu ; verdict de
**diffusion** sur une fenêtre qui inclut aujourd'hui (un relevé lu sur `LAST_30_DAYS` est refusé) ;
diagnostic d'une diffusion nulle borné à sa mesure ; liste « avant la première dépense ». Recette
sans réseau : `node scripts/google-ads/google-ads.mjs --self-test`, rejouée par
`oracles/self-test.mjs`. Mode d'emploi et non-jugé : [scripts/google-ads/README.md](scripts/google-ads/README.md).

## Frontières

Voir [CLAUDE.md](CLAUDE.md) — la forge outille, le pilot orchestre, l'humain donne le GO.
Invocation par le pilot uniquement ; retours par lots vers `input\` du pilot.

## Prérequis

Node.js ≥ 18. Aucune dépendance externe.

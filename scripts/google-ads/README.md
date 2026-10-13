# Kit Google Ads — déployer par l'import web, relever en lecture seule

Ce kit sert un run qui met en ligne des campagnes du Réseau de Recherche pour un produit. Il génère
le fichier que l'exploitant dépose dans l'écran Importations, puis juge le compte à partir d'un
relevé lu en lecture seule. Il ne publie rien et ne dépense rien : le dépôt, l'activation et
chaque dépense restent des gestes de l'exploitant, sur l'aperçu de Google.

Il est né de TF-1364 (décision humaine D-69 (a) du 13/10/2026), à partir du kit qu'un produit a
éprouvé les 21 et 22/09/2026 : 191 lignes acceptées sur 191, un relevé à 0 écart sur le compte
réel, un fichier de changements de 31 lignes égal aux 6 écarts du relevé. Il est rendu générique :
aucun nom, aucun identifiant de compte, aucun contenu de campagne réel. Les faits qui l'écrivent
vivent au référentiel du pilot, `references/INTEGRATIONS-FOURNISSEURS.md`, section Google Ads.

## Les cinq pièces

| Pièce | Fichier | Ce qu'elle fait |
|---|---|---|
| Plan de campagnes | `<produit>/…/plan.json` (exemple : `fixtures/google-ads/plan-factice.json`) | la source unique : préfixe, site, campagnes, groupes, mots-clés et correspondances, exclusions communes et propres, pages, textes d'annonces, conversions principales attendues |
| Générateur de l'import web | `google-ads.mjs import-web` | le fichier des Importations du web, confronté aux modèles à chaque génération ; écriture refusée au premier défaut |
| Relevé du compte | `collecter-compte.py` puis `google-ads.mjs releve` | lecture seule du compte, puis deux verdicts : conformité au plan et diffusion |
| Fichier des changements | `google-ads.mjs delta` | la différence entre le plan et l'état lu du compte, identifiants des retraits lus dans le compte |
| Commandes et paramétrage | ce document | les commandes, l'accès en lecture par l'API, la liste « avant la première dépense » |

La logique vit dans `lib-google-ads.mjs`, sans réseau. Les règles périssables (délai de diffusion,
bornes des annonces, prérequis hors API, exceptions mesurées) vivent dans `regles-google-ads.json`,
datées et sourcées. Les colonnes, les colonnes obligatoires et les vocabulaires fermés n'y sont pas :
ils se lisent dans les modèles de l'écran, à chaque génération.

## Les commandes, dans l'ordre d'un déploiement

**1. Demander les modèles, avant toute génération.** Le format des Importations du web n'est publié
nulle part, et il n'est pas celui de Google Ads Editor. Les modèles se téléchargent depuis l'écran
Importations (lien « Télécharger un exemple de modèle »), un par type d'objet, par l'humain connecté
au compte. Ils se demandent dans le tour qui prépare le dépôt : `campaign_template.csv`,
`ad_group_template.csv`, `keyword_template.csv`, `ad_group_negative_keyword_template.csv`,
`responsive_search_ad_template.csv`. Sans eux, le générateur sort en 2 et le dit.

**2. Générer le fichier d'import.**

```bash
node scripts/google-ads/google-ads.mjs import-web --plan <plan.json> --modeles <dossier-des-modeles> \
  --depart AAAA-MM-JJ --sortie <fichier.csv> [--site <dossier-du-site-construit>]
```

Le générateur écrit un seul fichier qui mêle cinq types de lignes. Chaque campagne porte tous ses
réglages sur sa propre ligne, et les exclusions de campagne sont des lignes `Negative keyword` au
niveau `Campaign`. Toutes les campagnes sortent en pause. Il refuse d'écrire (exit 1) dans ces cas :

- une colonne absente du modèle de son type de ligne ;
- une valeur hors du vocabulaire du modèle ;
- une colonne « Required on create » vide (c'est le refus `Missing value in "EU political ads"`) ;
- une date de départ passée ;
- une campagne sans le préfixe du plan ;
- un titre, une description ou un chemin trop long, ou une page d'arrivée absente du site construit.

Sans `--site`, la présence des pages est dite non jugée.

**3. Déposer, geste de l'exploitant.** Outils → Actions groupées → Importations, choix du fichier,
« Aperçu » (il compte les modifications et les erreurs sans rien écrire), puis « Appliquer ». Un
dépôt refusé se lit par ses causes distinctes : une campagne refusée fait échouer tous ses enfants.
Le rapport d'erreurs se demande à l'exploitant.

**4. Relever le compte, en lecture seule.**

```bash
uv run --with google-ads python scripts/google-ads/collecter-compte.py --prefixe "<PRÉFIXE> " --sortie <releve.json>
node scripts/google-ads/google-ads.mjs releve --plan <plan.json> --compte <releve.json>
```

Le relevé rend deux verdicts. La conformité au plan compare par contenu, pas par compte : budgets,
enchères, réseaux, option de zone, zones, langues, CPC, mots-clés, exclusions, annonces et
conversions principales. La diffusion lit chaque campagne depuis son départ, aujourd'hui compris.
Une campagne `ENABLED` et `SERVING` restée à 0 impression 24 h après son départ est un écart, même
conforme. Sorties : 0 conforme, 1 écart, 2 relevé non jugeable (fenêtre qui exclut aujourd'hui,
schéma, heure de lecture absente).

**5. Corriger par un fichier de changements.**

```bash
node scripts/google-ads/google-ads.mjs delta --plan <plan.json> --compte <releve.json> \
  --modeles <dossier-des-modeles> --sortie <changements.csv>
```

Il couvre les mots-clés des groupes et les exclusions de campagne, en ajout comme en retrait. Les
réglages de campagne, les groupes et les annonces restent hors de sa portée : le relevé les nomme.
Le dépôt suit le même geste qu'à l'étape 3.

**6. Avant d'activer : la liste « avant la première dépense ».**

```bash
node scripts/google-ads/google-ads.mjs avant-depense --liste <liste.json>
```

L'exploitant remplit la liste à l'écran du jour, l'agent la vérifie. Chaque élément porte `fait`,
`constate_le` et `vu_sur`, c'est-à-dire l'écran où il a été constaté. Les cinq éléments sont la
validation de l'annonceur, les noms alignés sur le registre public, un paiement valable au moins
60 jours, les codes promotionnels saisis et les notifications lues. Pour ces dernières, chaque avis
est confronté à l'écran qui porte l'état. Exemple : `fixtures/google-ads/avant-depense-complet.json`.

**Recette, sans réseau :** `node scripts/google-ads/google-ads.mjs --self-test`. Elle joue chaque
règle dans les deux sens sur les données factices de `fixtures/google-ads/`. La recette de la forge
(`node oracles/self-test.mjs`) la rejoue.

## Paramétrage de l'accès en lecture par l'API

Trois étapes, mesurées le 22/09/2026 (référentiel du pilot) :

1. Dans le projet Google Cloud du compte de service, activer l'API Google Ads. Sinon les versions
   en service rendent `403 SERVICE_DISABLED`. Une version retirée rend un `404` en page HTML, qui ne
   dit rien de l'accès : une sonde cite la version en service, relue le jour même.
2. Plus de jeton de développeur ni de compte administrateur depuis le 09/09/2026 : l'inscription se
   fait dans la console Google Cloud, et le niveau « Explorer » lit un compte réel.
3. Ajouter le compte de service comme utilisateur du compte publicitaire (Admin → Accès et sécurité
   → Utilisateurs), au niveau « Lecture seule ». La lecture fonctionne sans étape d'acceptation.

La configuration vit hors de tout dépôt, dans `~/.config/digit-ai/google-ads.yaml` ou dans le
fichier que désigne `GOOGLE_ADS_CONFIGURATION_FILE_PATH`. Elle porte `json_key_file_path`,
`customer_id` et, si besoin, `login_customer_id`. Le collecteur sort en 2 avant tout appel quand une
valeur manque. Aucune clé ne transite par la forge.

Ces parcours d'écran datent de leur mesure. Avant de les transmettre, on les relit sur l'écran du
jour, ou dans l'aide rédigée dans la langue de cet écran, avec sa date de lecture (TF-1588).

## Ce que le kit ne juge pas

- **L'acceptation réelle par Google.** Seul l'« Aperçu » de l'écran Importations la donne. La
  recette juge des modèles factices de même forme. Le générateur a aussi été joué contre de vrais
  modèles le 13/10/2026 : 46 colonnes, 0 défaut, mais aucun dépôt n'a été fait.
- **Le collecteur face à un compte réel.** Il n'a été joué que sur ses sorties en 2 (configuration
  absente ou incomplète). Ses requêtes reprennent celles du kit éprouvé, avec en plus l'option de
  zone, l'examen des annonces et les conversions. La première lecture réelle se consigne au ledger
  du run qui l'exécute.
- **Les prérequis que l'API ne voit pas.** Validation de l'annonceur, paiement, codes, notifications
  et limite de dépenses temporaire posée lors d'un examen : l'exploitant les constate à l'écran.
- **La cause d'une diffusion nulle.** Le relevé la mesure sans la diagnostiquer. Il liste les
  prérequis invisibles et les diagnostics d'écran qui ne concluent pas : une part d'impressions
  absente n'est pas une absence d'enchère, et un paiement refusé ancien n'est pas une cause. Si la
  prévisualisation répond « aucun mot clé ne correspondait » à une requête identique à un mot-clé
  éligible, on écrit à l'assistance dès le premier jour sans diffusion (TF-1587).

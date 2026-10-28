---
role: enchaînement des plans d'un front sur Cloudflare Workers et d'une base sur Supabase — ordre, variables nommées, URL de redirection des prévisualisations
nature: faits de documentation officielle lus à la date indiquée, plus des déductions marquées « déduit » ; rien ici n'a été mesuré sur une cible réelle
verifie_le: 2026-10-28
sources:
  - url: https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/
    lu_le: 2026-10-28
  - url: https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/
    lu_le: 2026-10-28
  - url: https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/
    lu_le: 2026-10-28
  - url: https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/
    lu_le: 2026-10-28
  - url: https://developers.cloudflare.com/workers/previews/
    lu_le: 2026-10-28
  - url: https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
    lu_le: 2026-10-28
  - url: https://developers.cloudflare.com/workers/configuration/secrets/
    lu_le: 2026-10-28
  - url: https://developers.cloudflare.com/workers/databases/third-party-integrations/supabase/
    lu_le: 2026-10-28
  - url: https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/
    lu_le: 2026-10-28
  - url: https://supabase.com/docs/guides/auth/redirect-urls
    lu_le: 2026-10-28
  - url: https://supabase.com/docs/guides/deployment/managing-environments
    lu_le: 2026-10-28
  - url: https://supabase.com/docs/guides/api/api-keys
    lu_le: 2026-10-28
---

# Enchaînement d'un front Workers et d'une base Supabase

**Pour qui.** Le pilot, quand un run MEP doit publier un front sur Cloudflare Workers et une base sur
Supabase. Les deux plans existent déjà (`node scripts/ops.mjs plan cloudflare-workers <build>` et
`node scripts/ops.mjs plan supabase <build>`) ; ce document dit dans quel ordre les jouer et ce qui
passe de l'un à l'autre. Il ne décide rien : l'exécution reste un acte de run MEP, sous GO humain
(R-38), dans la chaîne du produit (M-16).

Chaque fait porte l'adresse de sa page et la date de lecture (28/10/2026). « Déduit » marque ce
qu'aucune page n'énonce et qui découle de deux faits cités.

## 1. L'ordre des deux plans

**Déploiement : la base d'abord, le front ensuite.** Trois faits fondent l'ordre.

1. Une migration Supabase ne se défait pas : la documentation ne décrit aucune migration « down », le
   retour arrière d'un schéma est une migration corrective vers l'avant
   (https://supabase.com/docs/guides/deployment/managing-environments, lu le 28/10/2026 ; même fait
   dans la phase `rollback` du plan `supabase`).
2. Un retour arrière Workers ne touche pas aux ressources liées : « Resources connected to your Worker
   will not be changed during a rollback », et le code ancien peut échouer si la structure des données a
   changé entre les deux versions
   (https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/, lu le 28/10/2026).
3. Un déploiement progressif sert deux versions du Worker en même temps, avec des requêtes qui passent
   de l'une à l'autre
   (https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/, lu le
   28/10/2026).

Déduit : pendant un palier, l'ancienne et la nouvelle version du Worker lisent la même base ; après un
retour arrière, l'ancien code lit le schéma nouveau. Toute migration doit donc rester lisible par la
version précédente du Worker (ajouter avant de retirer, retirer dans une migration ultérieure, une fois
l'ancien code parti). Sans cette règle, le retour arrière natif du front ne rend pas le service.

Séquence de déploiement :

| # | Plan | Phase | Geste |
|---|---|---|---|
| 1 | `supabase` | provision, déploiement | `supabase db push --dry-run --linked`, puis `supabase db push --linked` et les fonctions, sous GO |
| 2 | `supabase` | healthcheck | `supabase migration list --linked` |
| 3 | `cloudflare-workers` | déploiement | `wrangler versions upload` : version créée, aucun trafic |
| 4 | `cloudflare-workers` | healthcheck | `curl` sur l'URL de la version, puis `wrangler versions deploy`, sous GO |

Séquence de retour arrière : le front d'abord, parce qu'il est
instantané et ne perd rien (`wrangler rollback <ID_VERSION_PRECEDENTE>`, plan `cloudflare-workers`,
phase `rollback`) ; la base ensuite, seulement si le schéma est fautif, par migration corrective
(plan `supabase`, phase `rollback`). La restauration d'une sauvegarde reste un geste humain
irréversible, hors des deux plans.

## 2. Variables d'environnement, nommées par plateforme

Seuls les NOMS figurent ici. Aucune valeur ne vit dans un plan, un dépôt ou ce document ; chaque valeur
est un secret de la chaîne du produit.

**Cloudflare, côté chaîne** (https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/,
lu le 28/10/2026) : `CLOUDFLARE_API_TOKEN` (jeton d'API créé avec le modèle « Edit Cloudflare Workers »,
restreint au seul compte du déploiement) et `CLOUDFLARE_ACCOUNT_ID`. La page prévient : ne jamais
stocker le jeton dans le dépôt.

**Supabase, côté chaîne** (https://supabase.com/docs/guides/deployment/managing-environments, lu le
28/10/2026) : `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` et `SUPABASE_PROJECT_ID`. L'exemple de la
page garde un jeu de secrets par environnement (`STAGING_PROJECT_ID`, `STAGING_DB_PASSWORD`,
`PRODUCTION_PROJECT_ID`, `PRODUCTION_DB_PASSWORD`) et exige un projet de préproduction NEUF, pas une
copie du schéma de production.

**Supabase, côté Worker** : le nom d'une variable ou d'un secret de Worker est un choix du produit, pas
une contrainte de plateforme. Les deux éditeurs n'emploient pas les mêmes :

- la page Cloudflare (mise à jour le 23/04/2026) pose `SUPABASE_URL` et `SUPABASE_KEY` par
  `wrangler secret put`, et fait de `SUPABASE_KEY` la clé « anon » ;
- la page Supabase (lue le 28/10/2026, https://supabase.com/docs/guides/api/api-keys) déclare les clés
  `anon` et `service_role` dépréciées d'ici la fin 2026, prescrit la clé publiable (`sb_publishable_…`)
  pour tout code qui atteint l'appareil d'un utilisateur et la clé secrète (`sb_secret_…`) pour le code
  serveur, « a server route or a worker » compris ; ses exemples emploient `SUPABASE_URL`,
  `SUPABASE_SECRET_KEY` et `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.

Écart entre les deux pages, à trancher à la conception : la page Cloudflare, mise à jour le
23/04/2026, prescrit encore la clé « anon » que Supabase déclare dépréciée. Déduit : un produit neuf nomme ses secrets de Worker `SUPABASE_URL` et `SUPABASE_PUBLISHABLE_KEY` (ou
`SUPABASE_SECRET_KEY` pour un accès serveur), et n'emploie pas la clé « anon ».

**En développement local** : `.dev.vars` ou `.env` à côté du fichier de configuration de Wrangler, jamais
les deux ; les deux se déclarent dans `.gitignore` (`.dev.vars*`, `.env*`)
(https://developers.cloudflare.com/workers/configuration/secrets/, lu le 28/10/2026).

**Si le Worker se connecte en direct à Postgres par Hyperdrive** (au lieu du client `supabase-js`) : la
page Hyperdrive demande la chaîne de connexion « Direct connection », pas les chaînes poolées, Hyperdrive
faisant lui-même le pooling
(https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/,
lu le 28/10/2026). Cette chaîne porte le mot de passe de la base : elle passe par un secret de la chaîne,
comme `SUPABASE_DB_PASSWORD`, jamais par le dépôt ni par un plan.

## 3. URL de redirection de l'auth Supabase pour les prévisualisations

Supabase n'accepte une redirection d'authentification que vers une URL de sa liste (« Redirect URLs »,
page URL Configuration) ; la `Site URL` est la redirection par défaut. Les jokers s'écrivent ainsi
(https://supabase.com/docs/guides/auth/redirect-urls, lu le 28/10/2026) : `*` couvre une suite de
caractères hors séparateurs, `**` couvre une suite quelconque, et les séparateurs sont `.` et `/`. La
page recommande, en production, l'URL exacte plutôt que `**`.

Cloudflare donne ces formes d'adresse pour un Worker :

| Objet | Forme | Source (lue le 28/10/2026) |
|---|---|---|
| Preview, sur workers.dev | `<preview-name>-<worker-name>.<subdomain>.workers.dev` | https://developers.cloudflare.com/workers/previews/ |
| Déploiement d'une Preview | `<deployment-id>-<worker-name>.<subdomain>.workers.dev` | idem |
| URL de version | `<version-prefix>-<worker-name>.<subdomain>.workers.dev` | https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/ |
| URL de version avec alias | `<alias>-<worker-name>.<subdomain>.workers.dev` | idem |
| Preview, sur domaine personnalisé | `<preview-name>.app.example.com` | https://developers.cloudflare.com/workers/previews/ |

Déduit, par analogie avec le modèle Vercel que la page Supabase documente
(`https://*-<team-or-account-slug>.vercel.app/**`) : l'entrée de la liste d'un projet Supabase de
préproduction est `https://*-<NOM_WORKER>.<SOUS_DOMAINE>.workers.dev/**`. Elle couvre les Previews, les
URL de déploiement et les URL de version d'un seul Worker, sous un seul sous-domaine workers.dev.
Réserves : `*` ne franchit pas un point, donc un nom de Preview qui contiendrait un point ne
correspondrait pas (la règle de nommage d'une Preview n'a pas été lue) ; et l'entrée ne couvre pas une
Preview servie sur domaine personnalisé, qui demande sa propre entrée
(`https://*.<DOMAINE_PREVIEW>/**`, déduit de la même façon).

Trois conséquences, déduites :

- **Un joker n'entre que dans le projet de préproduction.** Le projet de production garde sa `Site URL`
  et ses URL exactes (recommandation de la page Supabase). Une Preview doit donc être branchée sur le
  projet Supabase de préproduction : les Previews n'héritent d'aucun réglage de production et se
  configurent dans le bloc `previews` du fichier de configuration de Wrangler, secrets compris
  (https://developers.cloudflare.com/workers/previews/, lu le 28/10/2026).
- **Une Preview est publique par défaut** (même page). Une URL de redirection acceptée pour tout un
  joker tient lieu de porte d'entrée vers la session d'un utilisateur de test : mettre Cloudflare Access
  devant les Previews sur domaine personnalisé, comme la page le prévoit.
- **Les gabarits de courriel** : si le code passe `redirectTo`, remplacer `{{ .SiteURL }}` par
  `{{ .RedirectTo }}` dans les gabarits Supabase (page redirect-urls, lue le 28/10/2026).

## 4. Un seul déployeur par Worker

Trois voies créent une version du même Worker et la servent à 100 % : `wrangler deploy`, Workers Builds
(l'intégration Git de Cloudflare) et l'API d'envoi de script
(https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/, lu le
28/10/2026). Déduit : un produit déployé par GitHub Actions déconnecte l'intégration Git de Cloudflare,
sinon deux chaînes publient chacune de leur côté. Dans la chaîne, la page Cloudflare donne l'action
`cloudflare/wrangler-action@v4` avec `apiToken` et `accountId`, et la page Supabase l'action
`supabase/setup-cli@v1` ; les deux exemples déclenchent sur un push de branche, ce qui ne tient pas lieu
de GO humain : le GO est la porte d'approbation de la chaîne (M-16, `ETAPE-MEP.md` du pilot).

## 5. Ce que ce document ne couvre pas

- Aucun geste n'a été joué sur un compte Cloudflare ni sur un projet Supabase : les deux plans sont
  jugés hors ligne par O-5 sur des fixtures, et la première exécution réelle de chaque cible se
  consigne à `fiches\forge-ops.md` du pilot.
- Le projet Pages existant (variante de TF-1995) : le plan `cloudflare-workers` vise Workers, vers lequel
  conduit le guide de migration ; aucune cible Pages n'est décrite.
- Le domaine d'un projet migré : Workers n'accepte pas un domaine dont les serveurs de noms ne sont pas
  chez Cloudflare (provision du plan `cloudflare-workers`).

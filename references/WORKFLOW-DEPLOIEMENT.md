---
role: déploiement de production par GitHub Actions où le GO humain (R-38) est l'approbation d'un environnement protégé — faits de la plateforme, gabarit, règles d'O-21
nature: faits de documentation officielle lus à la date indiquée, plus des déductions marquées « déduit » ; rien ici n'a été exécuté sur un dépôt réel
verifie_le: 2026-10-29
sources:
  - url: https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments
    lu_le: 2026-10-29
  - url: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
    lu_le: 2026-10-29
  - url: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
    lu_le: 2026-10-29
  - url: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency
    lu_le: 2026-10-29
  - url: https://docs.github.com/en/actions/concepts/security/openid-connect
    lu_le: 2026-10-29
  - url: https://docs.github.com/en/actions/reference/security/oidc
    lu_le: 2026-10-29
  - url: https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure
    lu_le: 2026-10-29
  - url: https://docs.github.com/en/rest/deployments/environments
    lu_le: 2026-10-29
  - url: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
    lu_le: 2026-10-29
---

# Déployer en production par GitHub Actions, le GO humain en porte d'approbation

**Pour qui.** Le pilot et le produit qui déploient par GitHub Actions. Les plans de forge-ops
(`node scripts/ops.mjs plan <cible> <build>`) donnent les commandes ; ils ne disent pas quel workflow les
porte. La décision D-3 (a) du 17/10/2026 (porte M-16 du pilot) pose que le plan s'exécute dans la chaîne
du produit, et que le GO humain y est la porte d'approbation de la chaîne. Ce document la traduit pour
GitHub : le gabarit `gabarits/workflow-deploiement-production.yml` et le mode O-21 qui juge un workflow.

Chaque fait porte sa page et sa date de lecture (29/10/2026). « Déduit » marque ce qu'aucune page
n'énonce et qui découle de faits cités.

## 1. Ce que l'environnement protégé garantit

| Fait | Citation | Page |
|---|---|---|
| Les règles passent avant le job | « Any protection rules configured for the environment must pass before a job referencing the environment is sent to a runner. » | deployment-environments |
| Un job, un environnement | « Each job in a workflow can reference a single environment. » | deployment-environments |
| Relecteurs requis | « Enter up to 6 people or teams. » ; « Only one of the required reviewers needs to approve the job for it to proceed. » | manage-environments |
| Pas d'auto-approbation | « to prevent users from approving workflows runs that they triggered, select **Prevent self-review**. » | manage-environments |
| Secrets après approbation | les secrets d'environnement ne sont accessibles qu'« after any configured rules » ont passé | manage-environments |
| Job dépendant sauté | « If a job fails or is skipped, all jobs that need it are skipped » | workflow-syntax |

## 2. Le piège : un environnement inconnu est créé SANS règle

« Running a workflow that references an environment that does not exist will create an environment with
the referenced name. » Et : « the newly created environment will not have any protection rules or secrets
configured. » (manage-environments, lue le 29/10/2026).

Déduit : une faute de frappe dans `environment:`, ou un dépôt où personne n'a encore réglé l'environnement,
déploie sans aucune approbation, et le workflow a pourtant l'air protégé. Le fichier seul ne prouve donc pas
le GO. Le gabarit ajoute un job `garde-go` qui lit l'environnement par l'API et échoue s'il n'a pas de
relecteur requis : le job de déploiement, qui en dépend, est alors sauté.

**Disponibilité selon le plan GitHub.** « Users with GitHub Free plans can only configure environments for
public repositories. » ; « Organizations with GitHub Team and users with GitHub Pro can configure
environments for private repositories. » ; en passant un dépôt en privé, « any configured protection rules
or environment secrets will be ignored. » (manage-environments). Le plan du compte n'est pas mesuré (étude
du pilot du 28/10/2026). Déduit : sur un dépôt privé sans plan qui les porte, la garde échoue et rien ne se
déploie ; le GO passe alors par l'autre voie de M-16, la poussée d'un commit nommé.

## 3. La garde du GO lit l'API, en lecture seule

| Fait | Citation ou champ | Page |
|---|---|---|
| Lecture ouverte | « Anyone with read access to the repository can use this endpoint. » (`GET /repos/{owner}/{repo}/environments/{environment_name}`) | rest/deployments/environments |
| Permission du jeton | permission de dépôt « Actions » en lecture, sans autre permission | permissions-required-for-fine-grained-personal-access-tokens |
| Relecteurs | `protection_rules[]` : objet à `reviewers` (tableau) et `prevent_self_review` (booléen) | rest/deployments/environments |
| Branches autorisées | `deployment_branch_policy` : objet ou `null`, à `protected_branches` et `custom_branch_policies` | rest/deployments/environments |

La page ne liste pas les valeurs du champ `type` d'une règle : la garde teste un tableau `reviewers` non
vide, jamais une chaîne de type. Déduit, non exercé dans ce lot (aucun appel distant) : le `GITHUB_TOKEN`
du job reçoit cette lecture par `permissions: actions: read`.

## 4. La concurrence : un déploiement à la fois, jamais interrompu

| Fait | Citation | Page |
|---|---|---|
| Un seul à la fois | « to ensure that only a single job or workflow using the same concurrency group will run at a time » | control-workflow-concurrency |
| L'attente est remplacée | « any existing `pending` job or workflow in the same concurrency group will be canceled » | workflow-syntax |
| Annuler l'encours | « To also cancel any currently running job or workflow in the same concurrency group, specify `cancel-in-progress: true`. » | control-workflow-concurrency |
| File d'attente | « To allow multiple runs to queue instead of being canceled, set `queue: max`. » ; « up to 100 jobs or workflow runs can wait » | control-workflow-concurrency |
| Incompatibilité | « `queue: max` cannot be combined with `cancel-in-progress: true` » | control-workflow-concurrency |

Déduit : `cancel-in-progress: true` sur un déploiement de production interrompt une migration ou une
bascule à mi-chemin, et laisse la cible dans un état que ni N ni N-1 ne décrit. Le gabarit pose
`cancel-in-progress: false` ; `queue: max` reste un choix du produit, pour ne perdre aucun run en attente.

## 5. OIDC : la confiance du cloud passe par l'environnement

| Fait | Citation | Page |
|---|---|---|
| Plus de secret long | « No cloud secrets: You won't need to duplicate your cloud credentials as long-lived GitHub secrets. » | openid-connect |
| Permission requise | « Without `id-token: write`, the OIDC JWT ID token cannot be requested. » | reference/security/oidc |
| Sujet d'environnement | « The subject claim includes the environment name when the job references an environment. » : `repo:ORG-NAME/REPO-NAME:environment:ENVIRONMENT-NAME` | reference/security/oidc |
| Sujet de branche | les sujets de branche ou d'étiquette valent « but only if the job doesn't reference an environment » | reference/security/oidc |
| Sans droit d'écriture | « Setting `id-token: write` in the workflow's permissions does not give the workflow permission to modify or write to any resources. » | oidc-in-azure |
| Connexion Azure | `azure/login` avec `client-id`, `tenant-id`, `subscription-id` | oidc-in-azure |

Déduit : si la confiance fédérée du cloud vise le sujet `repo:<organisation>/<dépôt>:environment:production`,
seul un job qui référence l'environnement production, donc qui a passé ses relecteurs, obtient un jeton du
cloud. `id-token: write` posé au niveau du workflow donne ce droit de demande à tous les jobs, y compris à
ceux qui n'ont aucune porte : le gabarit le pose sur le seul job de déploiement.

## 6. Le gabarit

`gabarits/workflow-deploiement-production.yml` : à copier dans `.github/workflows/` du produit, chaque
`<JETON>` remplacé.

| Partie | Rôle |
|---|---|
| `permissions: contents: read` au niveau du workflow | aucun droit d'écriture par défaut |
| `concurrency` du workflow, `cancel-in-progress: false` | un déploiement à la fois, jamais interrompu |
| job `garde-go` (`actions: read`) | échoue si l'environnement production n'a pas de relecteur requis, pas de « Prevent self-review », ou aucune restriction de branche |
| job `deployer` : `needs: garde-go`, `environment: production` | attend l'approbation humaine, puis reçoit les secrets de l'environnement |
| `id-token: write` sur `deployer` seul, `azure/login` sans secret | jeton du cloud délivré au seul job approuvé |
| étapes provision, déploiement, healthcheck, puis rollback sur `failure()` | les 4 phases du plan forge-ops, jugé par O-5 |

Réglages GitHub à poser avant le premier run (geste humain, un réglage du dépôt) : l'environnement
`production` avec « Required reviewers », « Prevent self-review », et des « Deployment branches » restreintes
à la branche de production.

## 7. Ce que juge O-21

`node oracles/oracle-ops.mjs --workflow-deploiement <fichier.yml> [--environnement <nom>] [--protection <capture.json>]`

1. Un job qui déploie (commande d'une CLI des plans de forge-ops, ou action de déploiement connue) sans
   référencer d'environnement : bloquant.
2. Le job qui vise l'environnement de production (`production` par défaut) a son GO prouvé : un job de garde
   dans ses dépendances lit l'environnement par l'API et teste `reviewers` et `prevent_self_review`, ou la
   capture `--protection` (sortie de `gh api repos/<org>/<dépôt>/environments/production`) montre un
   relecteur, « Prevent self-review » et une restriction de branche. Sans l'un ni l'autre : bloquant.
3. Le job de production est couvert par un groupe de concurrence (majeur sinon), sans
   `cancel-in-progress: true` (bloquant).
4. `id-token: write` au niveau du workflow, ou sur un job qui ne référence pas l'environnement de
   production : majeur.

**Ce qui n'est pas jugé :** les réglages réels de l'environnement sans capture ni garde exécutée ; la
confiance fédérée côté cloud (son sujet se lit dans le cloud, pas dans le workflow) ; l'épinglage des actions
par SHA et le secret long d'une action de connexion (WF-2 et WF-5 de forge-websec) ; la justesse des
commandes du plan (O-5).

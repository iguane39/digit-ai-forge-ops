---
role: réseau Docker posé par Terraform et frontal nginx d'un lab — faits mesurés, faits de documentation, gabarits, règles d'O-23
nature: faits de documentation officielle lus à la date indiquée, plus des faits MESURÉS ici le 05/11/2026 (Terraform 1.12.2, Docker 29.4.2) ; « déduit » marque ce qu'aucune page n'énonce
verifie_le: 2026-11-05
sources:
  - url: https://developer.hashicorp.com/terraform/language/meta-arguments/lifecycle
    lu_le: 2026-11-05
  - url: https://docs.docker.com/engine/network/
    lu_le: 2026-11-05
  - url: https://docs.docker.com/engine/network/drivers/bridge/
    lu_le: 2026-11-05
  - url: https://nginx.org/en/docs/http/ngx_http_proxy_module.html
    lu_le: 2026-11-05
  - url: https://nginx.org/en/docs/http/ngx_http_core_module.html
    lu_le: 2026-11-05
  - url: https://nginx.org/en/docs/http/ngx_http_upstream_module.html
    lu_le: 2026-11-05
---

# Un réseau Docker posé par Terraform, et le frontal qui le traverse

**Pour qui.** Le pilot et le produit qui montent un lab Docker avec Terraform. Le lot Produit-86
`20261104a` (RO-2, RO-3) a mesuré deux défauts du même lab le 04/11/2026 : 3 déploiements en échec sur le
réseau, 1 sur le frontal. Ce document porte les gabarits qui les évitent, et les règles que l'oracle O-23
juge.

## 1. Le réseau : relever les plages prises, ne pas dériver (TF-2164)

**Le fait du 04/11/2026.** Deux réseaux Docker posés par Terraform sur le démon du poste. La plage écrite à
la main, `172.30.0.0/24`, était déjà prise par le réseau interne du produit : « Pool overlaps ». Puis le
démon a complété `ipam_config` (passerelle, adresses auxiliaires) : chaque `apply` y lisait un écart et
réclamait le remplacement du réseau, en échec tant que des conteneurs y étaient attachés. Trois déploiements
en échec entre 10:12 et 10:18.

**Rejoué le 05/11/2026** sur Terraform 1.12.2 et Docker 29.4.2, un réseau jetable créé par `terraform apply`
puis replanifié :

| Configuration | Plan qui suit l'apply | Code de sortie |
|---|---|---|
| `ipam_config { subnet = … }` sans `ignore_changes` | « docker_network.lab must be replaced », `ipam_config` « forces replacement » | 2 |
| gabarit `gabarits/reseau-docker.tf` | « No changes. Your infrastructure matches the configuration. » | 0 |

**Les plages du poste, mesurées le même jour.** Le démon de ce poste portait 18 plages prises et
`172.17.0.0/16` à `172.30.0.0/16` y étaient toutes occupées, dont `172.30.0.0/16` tout entière. Une plage
choisie à la main dans ce voisinage entre en collision. Docker puise lui-même ses plages dans
`172.17.0.0/16` à `172.28.0.0/14` (en `/16`) et `192.168.0.0/16` (en `/20`), et « attempts to avoid address
prefixes already in use on the host » (page `engine/network`, lue le 05/11/2026) : l'évitement vaut pour
lui, pas pour une plage posée à la main par Terraform. Le relevé choisit donc par défaut dans
`10.200.0.0/16`, hors de ces réservoirs.

**Ce que le gabarit pose.**

1. `scripts/plages-docker.mjs` relève les plages des réseaux du démon (`docker network inspect`) et choisit
   la première plage `/24` de la base qui ne chevauche aucune plage prise. Il se branche par un
   `data "external"` ; la requête porte `nom`, `base` et `longueur`.
2. Si le réseau `nom` existe déjà, le relevé rend sa plage telle quelle (`source: "existante"`). Sans cela,
   le plan suivant choisirait une autre plage, devenue « prise » par le réseau lui-même.
3. `lifecycle { ignore_changes = [ipam_config] }` est posé d'office. Ce que dit la documentation :
   « Use the ignore_changes argument when a resource is created with references to data that may change in
   the future, but should not affect the resource after its creation. » (page `lifecycle`, lue le
   05/11/2026).

Le script se joue seul : `node scripts/plages-docker.mjs choisir [--nom <réseau>] [--base <CIDR>]
[--longueur 24]` rend `{"subnet","gateway","source"}` (exit 1 si la base est pleine, exit 2 si le démon est
injoignable) ; `lister` imprime les plages prises. `--releve <fichier.json>` lit un relevé enregistré
(`fixtures/plages-docker/`) au lieu du démon.

**Ce que juge O-23** (`node oracles/oracle-ops.mjs --reseau-docker <pile ou fichier.tf>`), statique, sans
appel au démon :

- chaque `resource "docker_network"` qui déclare `ipam_config` pose `lifecycle { ignore_changes =
  [ipam_config] }` (ou `all`), sinon constat bloquant ;
- son `subnet` n'est pas un CIDR écrit en dur, sinon constat bloquant : il vient d'un `data "external"`
  dont le corps nomme un programme de plages ou Docker, sinon constat majeur ;
- un `subnet` tiré d'une variable ou d'un local n'est ni jugé ni refusé ; un réseau sans `ipam_config`
  laisse le démon choisir, rien à juger.

Fixtures à double sens : `fixtures/o23-reseau-docker/` (3 rouges, un vert par variable, un cas sans objet
rendu en SKIP), et le gabarit lui-même passe.

**Ce qui n'est pas jugé.** La plage réellement libre au moment de l'`apply` (le relevé la lit à l'`apply`,
l'oracle lit des fichiers), les routes de l'hôte (VPN, réseau d'entreprise) et les plages IPv6.

## 2. Le frontal : résoudre l'amont à chaque requête (TF-2165)

**Le fait du 04/11/2026.** Le frontal nginx de la préproduction portait `proxy_pass http://app:8000;`. nginx
résout « app » une fois, au chargement de la configuration. Après l'ajout de conteneurs au réseau interne,
l'application recréée a changé d'adresse et le frontal a rendu 502 : santé 1/3, un déploiement en échec à
12:31.

**Rejoué le 05/11/2026** sur `nginx:1.30-alpine` et Docker 29.4.2 : un réseau jetable, une application
(`python -m http.server 8000`, alias `app`), un frontal ; puis l'application est supprimée, un occupant prend
son adresse et l'application recréée reçoit la suivante.

| Frontal | `nginx -t` sans l'amont | Requête avant la recréation | Requête après la recréation |
|---|---|---|---|
| `proxy_pass http://app:8000;` | exit 1, « host not found in upstream "app" » | 200 | 502 Bad Gateway |
| `gabarits/frontal-nginx.conf` | exit 0 | 200 | 200 |

L'exercice se rejoue par `FORGE_OPS_EXERCICE_DOCKER=1 node oracles/self-test.mjs` : il lit les deux images
déjà présentes sur le poste, n'en télécharge aucune, et retire ce qu'il a créé.

**Ce que le gabarit pose.**

1. `resolver 127.0.0.11 valid=10s;` : 127.0.0.11 est le serveur DNS embarqué de Docker (« The embedded DNS
   server address is 127.0.0.11. », page `bridge`, lue le 05/11/2026) ; `valid=10s` remplace le TTL de la
   réponse (« By default, nginx caches answers using the TTL value of a response. An optional valid parameter
   allows overriding it », page `ngx_http_core_module`, lue le 05/11/2026).
2. `set $amont "http://app:8000";` puis `proxy_pass $amont;`. Avec une variable, nginx ne résout plus au
   chargement : « if an address is specified as a domain name, the name is searched among the described
   server groups, and, if not found, is determined using a resolver. » (page `ngx_http_proxy_module`, lue le
   05/11/2026). Déduit : sans `resolver`, la requête échoue, d'où la règle (1) d'O-24.

**Ce que juge O-24** (`node oracles/oracle-ops.mjs --frontal-nginx <fichier.conf ou dossier>`), statique, sans
lancer nginx :

- un `proxy_pass` vers un nom d'hôte écrit en clair est un constat bloquant ; une adresse IP, `localhost` et
  un socket unix ne se résolvent pas et sont écartés ;
- un `proxy_pass` par variable exige un `resolver` : constat bloquant sans lui, constat majeur s'il ne porte
  pas `valid=` ;
- un `proxy_pass` vers un groupe `upstream` dont un serveur est un nom d'hôte exige le paramètre `resolve`
  sur ce serveur, avec un `resolver` dans le bloc `upstream` ou dans `http`. Le paramètre est libre depuis
  nginx 1.27.3 (« Prior to version 1.27.3, this parameter was available only as part of our commercial
  subscription », page `ngx_http_upstream_module`, lue le 05/11/2026). Mesuré le 05/11/2026 : un `resolver`
  posé dans le bloc `server` ne lui sert pas, `nginx -t` répond « no resolver defined to resolve names at run
  time in upstream ».

Fixtures à double sens : `fixtures/o24-frontal-nginx/` (5 rouges, un vert par `resolve`, un cas sans objet
rendu en SKIP), et le gabarit lui-même passe. Chaque vert et chaque rouge d'`upstream` a été passé à `nginx -t`.

**Ce qui n'est pas jugé.** L'exécution de nginx (c'est le rôle de l'exercice), les autres directives de
passage (`fastcgi_pass`, `uwsgi_pass`, `scgi_pass`, `grpc_pass`), un `resolver` posé dans un autre fichier que
le `proxy_pass` quand un seul fichier est passé, et la valeur d'une variable.

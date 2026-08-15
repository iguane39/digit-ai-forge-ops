#!/usr/bin/env node
// ops.mjs — les trois verbes de forge-ops : deployer · restaurer · etat.
// Zéro dépendance, portable Windows/Unix. Règle dure : jamais de bascule sur
// release malade — le healthcheck s'exécute AVANT tout repointage de COURANT.
//
// Usage :
//   node ops.mjs deployer <dossier-build> <cible>
//   node ops.mjs restaurer <cible>
//   node ops.mjs etat <cible> [--sortie fichier.json]
//   node ops.mjs canary <dossier-build> <cible> [--seuils fichier.json]
//
// Contrat de la cible : releases/<ts>/ + COURANT (pointeur texte) + journal.jsonl
// (append-only, contrat ledger forge-agents : seq strictement croissant depuis 1).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const TYPES = ["deploiement", "deploiement_refuse", "restauration", "canary_etape", "canary_promotion", "canary_annulation"];

function fail(msg) { console.error(`[OPS REFUS] ${msg}`); process.exit(1); }

function journalAppend(cible, type, detail) {
  const jp = path.join(cible, "journal.jsonl");
  let seq = 0;
  if (fs.existsSync(jp)) {
    const lignes = fs.readFileSync(jp, "utf8").split("\n").filter(Boolean);
    if (lignes.length) seq = JSON.parse(lignes[lignes.length - 1]).seq;
  }
  const entree = { seq: seq + 1, ts: new Date().toISOString(), type, ...detail };
  fs.appendFileSync(jp, JSON.stringify(entree) + "\n", "utf8");
  return entree;
}

function lireCourant(cible) {
  const cp = path.join(cible, "COURANT");
  return fs.existsSync(cp) ? fs.readFileSync(cp, "utf8").trim() : null;
}

function ecrireCourant(cible, release) {
  // écriture atomique : tmp puis rename (même volume)
  const cp = path.join(cible, "COURANT");
  const tmp = cp + ".tmp";
  fs.writeFileSync(tmp, release, "utf8");
  fs.renameSync(tmp, cp);
}

function healthcheck(releaseDir) {
  const sante = path.join(releaseDir, "sante.mjs");
  if (!fs.existsSync(sante))
    return { ok: false, raison: "sante.mjs absent — une app sans contrat de santé n'est pas exploitable" };
  const r = spawnSync(process.execPath, [sante], { cwd: releaseDir, encoding: "utf8", timeout: 30000 });
  return r.status === 0
    ? { ok: true }
    : { ok: false, raison: `healthcheck exit ${r.status}${r.stderr ? " — " + r.stderr.trim().slice(0, 120) : ""}` };
}

function releasesTriees(cible) {
  const rd = path.join(cible, "releases");
  if (!fs.existsSync(rd)) return [];
  return fs.readdirSync(rd).filter(n => fs.statSync(path.join(rd, n)).isDirectory()).sort();
}

function deployer(build, cible) {
  if (!build || !fs.existsSync(build)) fail(`build introuvable : ${build}`);
  fs.mkdirSync(path.join(cible, "releases"), { recursive: true });
  const nom = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "T");
  // suffixe anti-collision si deux déploiements dans la même seconde
  let release = nom, i = 0;
  while (fs.existsSync(path.join(cible, "releases", release))) release = `${nom}-${++i}`;
  const dest = path.join(cible, "releases", release);
  fs.cpSync(build, dest, { recursive: true });

  const santé = healthcheck(dest);
  if (!santé.ok) {
    journalAppend(cible, "deploiement_refuse", { release, raison: santé.raison });
    // la release malade ne reste pas basculable : on la retire, COURANT est intact
    fs.rmSync(dest, { recursive: true, force: true });
    fail(`healthcheck en échec — COURANT inchangé : ${santé.raison}`);
  }
  const precedent = lireCourant(cible);
  ecrireCourant(cible, release);
  journalAppend(cible, "deploiement", { release, precedent });
  console.log(`[OPS OK] déployé : ${release}${precedent ? ` (précédent : ${precedent})` : ""}`);
}

function restaurer(cible) {
  const courant = lireCourant(cible);
  if (!courant) fail("aucun COURANT — rien à restaurer");
  const releases = releasesTriees(cible);
  const idx = releases.indexOf(courant);
  const precedente = idx > 0 ? releases[idx - 1] : null;
  if (!precedente) fail("aucune release précédente — restauration impossible");
  const santé = healthcheck(path.join(cible, "releases", precedente));
  if (!santé.ok) fail(`la release précédente ${precedente} ne passe plus son healthcheck : ${santé.raison}`);
  ecrireCourant(cible, precedente);
  journalAppend(cible, "restauration", { release: precedente, depuis: courant });
  console.log(`[OPS OK] restauré : ${precedente} (depuis ${courant})`);
}

function etat(cible, sortie) {
  const courant = lireCourant(cible);
  const releases = releasesTriees(cible);
  const jp = path.join(cible, "journal.jsonl");
  const contenu = fs.existsSync(jp) ? fs.readFileSync(jp, "utf8") : "";
  const lignes = contenu.split("\n").filter(Boolean);
  const dernier = lignes.length ? JSON.parse(lignes[lignes.length - 1]) : null;
  const doc = { courant, releases, evenements: lignes.length, dernier };
  if (sortie) {
    // état déclaré (référence pour l'oracle O-6 « dérive ») : le hash du journal fige le
    // segment qu'on pourra vérifier non réécrit, indépendamment du journal courant.
    const journal_sha256 = createHash("sha256").update(contenu).digest("hex");
    fs.writeFileSync(sortie, JSON.stringify({ ...doc, journal_sha256 }, null, 2) + "\n", "utf8");
    console.log(`[OPS OK] état déclaré écrit (référence O-6) : ${sortie}`);
  } else {
    console.log(JSON.stringify(doc, null, 2));
  }
}

// ─────────────────────── CANARY LOCAL SIMULÉ (TF-0107 · 1) ───────────────────────────
// Bascule progressive SIMULÉE entre COURANT et un candidat : paliers de trafic croissants,
// chaque palier mesuré (contrat metriques.mjs de la release candidate) et confronté à un
// critère de promotion EXPLICITE venu d'un fichier de config — jamais un seuil implicite.
// Un seul palier rejeté ⇒ abandon, COURANT intact (même garde-fou que deployer : jamais de
// bascule sur release dégradée). Sans cible k8s : prépare la marche vers Argo Rollouts/Flagger.
const CANARY_DEFAUT = { paliers_pct: [1, 5, 25, 50, 100], seuil_erreur_pct: 5, seuil_latence_ms: 500 };

function lireSeuilsCanary(fichier) {
  if (!fichier) return CANARY_DEFAUT;
  if (!fs.existsSync(fichier)) fail(`fichier de seuils canary introuvable : ${fichier}`);
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(fichier, "utf8")); }
  catch { fail(`fichier de seuils canary illisible (JSON invalide) : ${fichier}`); }
  const paliers = Array.isArray(cfg.paliers_pct) && cfg.paliers_pct.length ? cfg.paliers_pct : CANARY_DEFAUT.paliers_pct;
  if (paliers[paliers.length - 1] !== 100) fail("le dernier palier du canary doit être 100 (promotion complète)");
  return {
    paliers_pct: paliers,
    seuil_erreur_pct: typeof cfg.seuil_erreur_pct === "number" ? cfg.seuil_erreur_pct : CANARY_DEFAUT.seuil_erreur_pct,
    seuil_latence_ms: typeof cfg.seuil_latence_ms === "number" ? cfg.seuil_latence_ms : CANARY_DEFAUT.seuil_latence_ms,
  };
}

function mesurerPalier(releaseDir, palier) {
  const script = path.join(releaseDir, "metriques.mjs");
  const r = spawnSync(process.execPath, [script, String(palier)], { cwd: releaseDir, encoding: "utf8", timeout: 30000 });
  if (r.status !== 0)
    return { ok: false, raison: `métriques en échec (exit ${r.status})${r.stderr ? " — " + r.stderr.trim().slice(0, 120) : ""}` };
  let mesure;
  try { mesure = JSON.parse((r.stdout || "").trim()); }
  catch { return { ok: false, raison: "sortie de metriques.mjs illisible (JSON attendu)" }; }
  if (typeof mesure.erreur_pct !== "number" || typeof mesure.latence_ms !== "number")
    return { ok: false, raison: "mesure incomplète (erreur_pct/latence_ms numériques attendus)" };
  return { ok: true, mesure };
}

function canary(build, cible, fichierSeuils) {
  if (!build || !fs.existsSync(build)) fail(`build introuvable : ${build}`);
  const seuils = lireSeuilsCanary(fichierSeuils);
  fs.mkdirSync(path.join(cible, "releases"), { recursive: true });
  const nom = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  let release = nom, i = 0;
  while (fs.existsSync(path.join(cible, "releases", release))) release = `${nom}-${++i}`;
  const dest = path.join(cible, "releases", release);
  fs.cpSync(build, dest, { recursive: true });

  const annuler = (raison) => {
    journalAppend(cible, "canary_annulation", { release, raison });
    fs.rmSync(dest, { recursive: true, force: true }); // candidat non promu : jamais basculable
    fail(`canary refusé — ${raison}`);
  };

  const santé = healthcheck(dest);
  if (!santé.ok) annuler(`healthcheck en échec — ${santé.raison}`);
  if (!fs.existsSync(path.join(dest, "metriques.mjs")))
    annuler("candidat sans contrat de métriques (metriques.mjs absent) — canary impossible, utiliser deployer");

  for (const palier of seuils.paliers_pct) {
    const m = mesurerPalier(dest, palier);
    if (!m.ok) annuler(`palier ${palier}% : ${m.raison}`);
    const { erreur_pct, latence_ms } = m.mesure;
    const franchi = erreur_pct <= seuils.seuil_erreur_pct && latence_ms <= seuils.seuil_latence_ms;
    journalAppend(cible, "canary_etape", { release, palier_pct: palier, mesure: { erreur_pct, latence_ms }, seuils, verdict: franchi ? "franchi" : "rejete" });
    console.log(`  [CANARY ${franchi ? "OK" : "STOP"}] palier ${palier}% — erreur ${erreur_pct}% (seuil ${seuils.seuil_erreur_pct}%), latence ${latence_ms}ms (seuil ${seuils.seuil_latence_ms}ms)`);
    if (!franchi) annuler(`critère de promotion non atteint au palier ${palier}% (erreur ${erreur_pct}%/latence ${latence_ms}ms)`);
  }

  const precedent = lireCourant(cible);
  ecrireCourant(cible, release);
  journalAppend(cible, "canary_promotion", { release, precedent, paliers_pct: seuils.paliers_pct });
  console.log(`[OPS OK] canary promu : ${release}${precedent ? ` (précédent : ${precedent})` : ""}`);
}

// ───────────────────────────── PLANS CLOUD (v1, TF-0081) ─────────────────────────────
// Mode PLAN-FIRST : générer le plan d'exécution déterministe d'une cible cloud — commandes
// exactes ordonnées en 4 phases (provision, deploiement, healthcheck, rollback) — SANS RIEN
// exécuter et sans jamais lire de credential. L'exécution réelle d'un plan est un acte de
// run MEP (environnement authentifié fourni par l'humain, GO humain) — jamais un self-test.
// Chaque plan est adossé à sa fiche expert admise (experts-forge, verdict MATERIEL).
const PLANS = {
  railway: {
    service: "Railway service (conteneur)",
    fiche: "experts-forge/fiches/expert-ops-railway.md",
    placeholders: ["<PROJET>", "<ENVIRONNEMENT>", "<URL_SERVICE>", "<ID_DEPLOIEMENT_PRECEDENT>", "<SERVICE>", "<PRODUIT>"],
    provision: [
      "railway link <PROJET> --environment <ENVIRONNEMENT>",
      // TF-0269 (1/3) : le domaine genere est <nom-service>-<nom-environnement>.up.railway.app.
      // Un service nomme pour son usage (<appli>-recette) dans l'environnement par defaut
      // « production » donne <appli>-recette-production : doublon contradictoire, URL publique
      // fausse livree. Le nom du SERVICE ne porte jamais l'environnement.
      "nommer le service <SERVICE>=<appli> SANS suffixe d'environnement : le domaine genere concatene <nom-service>-<nom-environnement>.up.railway.app — l'environnement porte le suffixe R-24 (<appli>-{dev|qualif|production}), jamais le service ; a decider AVANT le premier deploiement (un domaine cree ne se renomme plus par le CLI)",
      // TF-0269 (2/3) : rattrapage si le domaine existe deja — `railway domain` repond
      // « Domains already exist » et n'offre aucun verbe de renommage.
      "si le domaine existe deja et doit etre renomme : API GraphQL (https://backboard.railway.com/graphql/v2, jeton de projet), mutation serviceDomainUpdate — 5 champs TOUS requis (serviceDomainId, domain, environmentId, serviceId, targetPort) ; le CLI `railway domain` ne renomme pas (« Domains already exist »)",
      "verifier railway.json : deploy.healthcheckPath=\"/sante\" + healthcheckTimeout (bascule aveugle sinon)",
      "verifier la region UE du service (europe-west4) — le defaut n'est pas garanti UE",
      // TF-0258 (1/4) : CMD en forme EXEC (tableau JSON) n'invoque aucun shell — $PORT n'est
      // jamais substitue, l'appli recoit la chaine litterale "$PORT" et crash-loop sans erreur
      // explicite. Verifier au Dockerfile.
      "verifier le Dockerfile : CMD en forme SHELL (`CMD sh -c \"... --port $PORT\"`) pour que $PORT soit substitue, JAMAIS une forme EXEC (tableau JSON) avec $PORT litteral — sinon crash-loop silencieux au demarrage",
      // TF-0258 (3/4) : un volume Railway est monte root ; un conteneur non-root ne peut pas y
      // ecrire (erreur a l'usage, pas au montage).
      "si un volume est monte : verifier RAILWAY_RUN_UID=0 (conteneur root, aligne avec le volume) ou l'UID du conteneur explicitement aligne sur celui du volume (root, uid 0) — sinon ecriture refusee a l'usage",
    ],
    deploiement: [
      "railway up --ci   # build Dockerfile + deploiement ; trafic route seulement apres healthcheck vert",
      // TF-0258 (2/4) : l'edge public et le prober de healthcheck de Railway joignent le
      // conteneur en IPv4 ; un bind IPv6-seul (`::`) ou loopback est injoignable sans erreur
      // applicative visible (healthcheck qui timeout, c'est tout).
      "verifier que le serveur applicatif bind 0.0.0.0 (ex. `uvicorn app:app --host 0.0.0.0 --port $PORT`) — jamais `::` seul ni `127.0.0.1` : edge et healthcheck parlent IPv4",
      // TF-0269 (3/3) : sans origine publique declaree, l'appli retombe sur son hote interne
      // et sert des URLs auto-referentes (canonical, og:url, sitemap, JSON-LD) pointant
      // localhost — invisible au healthcheck (200) comme aux tests unitaires.
      "poser l'origine publique en variable de service : railway variables --set <PRODUIT>_URL_BASE=https://<URL_SERVICE> — sans elle les URLs auto-referentes du produit (canonical, og:url, sitemap, JSON-LD) sortent sur l'hote interne localhost, invisible au healthcheck",
    ],
    healthcheck: [
      "railway status   # deploiement SUCCESS attendu",
      "curl -fsS <URL_SERVICE>/sante   # 200 attendu (contrat sante.mjs de forge-ops)",
    ],
    rollback: [
      "dashboard Railway → deployment <ID_DEPLOIEMENT_PRECEDENT> → Rollback (piege : `railway redeploy` rejoue le COURANT, pas l'anterieur)",
      "curl -fsS <URL_SERVICE>/sante   # re-verification apres retour",
      // TF-0258 (4/4) : pour un deploiement qui n'a jamais ete actif (crash-loop), `railway
      // logs` ne remonte pas la cause de facon fiable — le canal fiable est l'API GraphQL.
      "si le deploiement echoue sans cause visible (`railway logs` muet) : interroger l'API GraphQL Railway (https://backboard.railway.com/graphql/v2, jeton de projet) — `deploymentLogs` (build+runtime) et `httpLogs` (edge, champ `upstreamErrors`) — jamais le CLI seul pour diagnostiquer un deploiement mort",
    ],
  },
  gcp: {
    service: "Cloud Run — service conteneur managé",
    fiche: "experts-forge/fiches/expert-ops-gcp.md",
    placeholders: ["<PROJET>", "<REGION>", "<SERVICE>", "<IMAGE>", "<HASH>", "<REVISION_PRECEDENTE>"],
    provision: [
      "gcloud auth list   # identite de deploiement : roles/run.admin + iam.serviceAccountUser + artifactregistry.reader",
      "gcloud artifacts repositories describe <DEPOT> --location <REGION> --project <PROJET>",
    ],
    deploiement: [
      "gcloud builds submit <BUILD> --tag <IMAGE> --project <PROJET>",
      "gcloud run deploy <SERVICE> --image <IMAGE> --region <REGION> --project <PROJET> --port 8080 --no-traffic --tag candidat   # revision creee SANS trafic",
    ],
    healthcheck: [
      "curl -fsS https://candidat---<SERVICE>-<HASH>.a.run.app/sante   # smoke sur l'URL taguee, 200 attendu",
      "gcloud run services update-traffic <SERVICE> --region <REGION> --to-latest   # bascule APRES healthcheck vert",
    ],
    rollback: [
      "gcloud run services update-traffic <SERVICE> --region <REGION> --to-revisions <REVISION_PRECEDENTE>=100   # instantane, sans rebuild",
      "ne jamais purger les revisions saines anterieures (O-4 : histoire purgee = rollback impossible)",
    ],
  },
  azure: {
    service: "Azure Container Apps",
    fiche: "experts-forge/fiches/expert-ops-azure.md",
    placeholders: ["<RG>", "<REGION>", "<APP>", "<ACR>", "<IMAGE>", "<SUFFIXE>", "<SUFFIXE_PRECEDENT>"],
    provision: [
      "az group create --name <RG> --location <REGION>",
      "az containerapp env create --name <ENV> --resource-group <RG> --location <REGION>",
      "az containerapp revision set-mode --name <APP> --resource-group <RG> --mode multiple   # SANS multiple, aucun retour instantane possible",
    ],
    deploiement: [
      "az acr build --registry <ACR> --image <IMAGE> <BUILD>",
      "az containerapp update --name <APP> --resource-group <RG> --image <IMAGE> --revision-suffix <SUFFIXE>   # nouvelle revision, ingress targetPort=8080",
    ],
    healthcheck: [
      "curl -fsS https://<APP>--<SUFFIXE>.<DOMAINE_ENV>/sante   # URL de revision, 200 attendu",
      "az containerapp ingress traffic set --name <APP> --resource-group <RG> --revision-weight <SUFFIXE>=100   # bascule APRES healthcheck vert",
    ],
    rollback: [
      "az containerapp ingress traffic set --name <APP> --resource-group <RG> --revision-weight <SUFFIXE_PRECEDENT>=100   # instantane en mode multiple",
      "az containerapp revision activate --name <APP> --resource-group <RG> --revision <APP>--<SUFFIXE_PRECEDENT>   # si la revision etait desactivee",
    ],
  },
  aws: {
    service: "AWS App Runner",
    fiche: "experts-forge/fiches/expert-ops-aws.md",
    placeholders: ["<REGION>", "<ARN_SERVICE>", "<DEPOT_ECR>", "<TAG_IMMUABLE>", "<TAG_PRECEDENT>", "<URL_SERVICE>"],
    provision: [
      "aws ecr describe-repositories --repository-names <DEPOT_ECR> --region <REGION>   # tags IMMUABLES exiges (jamais :latest)",
      "verifier le role d'acces ECR : AWSAppRunnerServicePolicyForECRAccess + iam:PassRole restreint",
      "desactiver le deploiement automatique sur push ECR (la bascule reste un geste du run, pas un effet de bord)",
    ],
    deploiement: [
      "docker build -t <DEPOT_ECR>:<TAG_IMMUABLE> <BUILD> && docker push <DEPOT_ECR>:<TAG_IMMUABLE>",
      "aws apprunner update-service --service-arn <ARN_SERVICE> --region <REGION> --source-configuration ImageRepository={ImageIdentifier=<DEPOT_ECR>:<TAG_IMMUABLE>}",
    ],
    healthcheck: [
      "aws apprunner describe-service --service-arn <ARN_SERVICE> --region <REGION>   # Status=RUNNING, HealthCheck Path=/sante",
      "curl -fsS <URL_SERVICE>/sante   # 200 attendu (echec de deploiement = auto-rollback par le service)",
    ],
    rollback: [
      "aws apprunner update-service --service-arn <ARN_SERVICE> --region <REGION> --source-configuration ImageRepository={ImageIdentifier=<DEPOT_ECR>:<TAG_PRECEDENT>}   # pas de bascule de trafic native : le rollback volontaire est un redeploiement du tag anterieur",
      "condition : retention des images au registre (image purgee = rollback impossible)",
    ],
  },
};

function plan(cible, build, sortie) {
  const p = PLANS[cible];
  if (!p) fail(`cible inconnue « ${cible} » — cibles connues : ${Object.keys(PLANS).join(", ")}`);
  const doc = {
    format: "forge-ops/plan@1",
    cible,
    service: p.service,
    build: build,
    source_fiche: p.fiche,
    garde_fous: [
      "healthcheck avant toute bascule — jamais de bascule sur release malade",
      "aucun credential dans la forge ni dans ce plan (placeholders <...> a resoudre par l'environnement du run)",
      "execution reelle = run MEP, GO humain — jamais un self-test",
    ],
    placeholders: p.placeholders,
    phases: {
      provision: p.provision,
      deploiement: p.deploiement.map(c => c.replace("<BUILD>", build)),
      healthcheck: p.healthcheck,
      rollback: p.rollback,
    },
  };
  const json = JSON.stringify(doc, null, 2);
  if (sortie) { fs.writeFileSync(sortie, json + "\n", "utf8"); console.log(`[OPS OK] plan ${cible} écrit : ${sortie}`); }
  else console.log(json);
}

const argv = process.argv.slice(2);
const iSortie = argv.indexOf("--sortie");
const sortieOpt = iSortie >= 0 ? argv[iSortie + 1] : null;
if (iSortie >= 0) argv.splice(iSortie, 2);
const iSeuils = argv.indexOf("--seuils");
const fichierSeuils = iSeuils >= 0 ? argv[iSeuils + 1] : null;
if (iSeuils >= 0) argv.splice(iSeuils, 2);
const [verbe, a, b] = argv;
// TF-0245 : tout chemin reçu est résolu en absolu ICI, une seule fois — jamais de
// rustine en aval. healthcheck et mesurerPalier s'exécutent avec cwd=releaseDir : un
// chemin resté relatif serait résolu par node contre ce NOUVEAU cwd (module introuvable,
// refus à tort journalisé deploiement_refuse). Constaté aussi en amont : fs.cpSync
// échoue en relatif (EIO, node 25 / Windows). Exception : la cible de `plan` est un nom
// de plateforme (railway, gcp…), pas un chemin, et son build reste textuel — le plan
// s'exécute dans un autre environnement.
const abs = p => (p ? path.resolve(p) : p);
if (verbe === "deployer") { if (!b) fail("usage : deployer <build> <cible>"); deployer(abs(a), abs(b)); }
else if (verbe === "restaurer") { if (!a) fail("usage : restaurer <cible>"); restaurer(abs(a)); }
else if (verbe === "etat") { if (!a) fail("usage : etat <cible> [--sortie fichier.json]"); etat(abs(a), abs(sortieOpt)); }
else if (verbe === "plan") { if (!b) fail("usage : plan <cible> <build> [--sortie plan.json]"); plan(a, b, abs(sortieOpt)); }
else if (verbe === "canary") { if (!b) fail("usage : canary <build> <cible> [--seuils fichier.json]"); canary(abs(a), abs(b), abs(fichierSeuils)); }
else fail("verbe inconnu — deployer | restaurer | etat | plan | canary");

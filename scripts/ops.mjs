#!/usr/bin/env node
// ops.mjs — les trois verbes de forge-ops : deployer · restaurer · etat.
// Zéro dépendance, portable Windows/Unix. Règle dure : jamais de bascule sur
// release malade — le healthcheck s'exécute AVANT tout repointage de COURANT.
//
// Usage :
//   node ops.mjs deployer <dossier-build> <cible>
//   node ops.mjs restaurer <cible>
//   node ops.mjs etat <cible>
//
// Contrat de la cible : releases/<ts>/ + COURANT (pointeur texte) + journal.jsonl
// (append-only, contrat ledger forge-agents : seq strictement croissant depuis 1).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TYPES = ["deploiement", "deploiement_refuse", "restauration"];

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

function etat(cible) {
  const courant = lireCourant(cible);
  const releases = releasesTriees(cible);
  const jp = path.join(cible, "journal.jsonl");
  const lignes = fs.existsSync(jp) ? fs.readFileSync(jp, "utf8").split("\n").filter(Boolean) : [];
  const dernier = lignes.length ? JSON.parse(lignes[lignes.length - 1]) : null;
  console.log(JSON.stringify({ courant, releases, evenements: lignes.length, dernier }, null, 2));
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
    placeholders: ["<PROJET>", "<ENVIRONNEMENT>", "<URL_SERVICE>", "<ID_DEPLOIEMENT_PRECEDENT>"],
    provision: [
      "railway link <PROJET> --environment <ENVIRONNEMENT>",
      "verifier railway.json : deploy.healthcheckPath=\"/sante\" + healthcheckTimeout (bascule aveugle sinon)",
      "verifier la region UE du service (europe-west4) — le defaut n'est pas garanti UE",
    ],
    deploiement: [
      "railway up --ci   # build Dockerfile + deploiement ; trafic route seulement apres healthcheck vert",
    ],
    healthcheck: [
      "railway status   # deploiement SUCCESS attendu",
      "curl -fsS <URL_SERVICE>/sante   # 200 attendu (contrat sante.mjs de forge-ops)",
    ],
    rollback: [
      "dashboard Railway → deployment <ID_DEPLOIEMENT_PRECEDENT> → Rollback (piege : `railway redeploy` rejoue le COURANT, pas l'anterieur)",
      "curl -fsS <URL_SERVICE>/sante   # re-verification apres retour",
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
const sortiePlan = iSortie >= 0 ? argv[iSortie + 1] : null;
if (iSortie >= 0) argv.splice(iSortie, 2);
const [verbe, a, b] = argv;
if (verbe === "deployer") { if (!b) fail("usage : deployer <build> <cible>"); deployer(a, b); }
else if (verbe === "restaurer") { if (!a) fail("usage : restaurer <cible>"); restaurer(a); }
else if (verbe === "etat") { if (!a) fail("usage : etat <cible>"); etat(a); }
else if (verbe === "plan") { if (!b) fail("usage : plan <cible> <build> [--sortie plan.json]"); plan(a, b, sortiePlan); }
else fail("verbe inconnu — deployer | restaurer | etat | plan");

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
//   node ops.mjs reinitialiser-base <declaration.json> <cible> [--executer] [--sortie plan.json]
//
// Contrat de la cible : releases/<ts>/ + COURANT (pointeur texte) + journal.jsonl
// (append-only, contrat ledger forge-agents : seq strictement croissant depuis 1).
// Hors contrat : une cible conteneur Docker (restaurer sort en exit 2 avec le geste manuel, TF-1805) ;
// une base de production ou non déclarée (reinitialiser-base sort en exit 2, TF-2013).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { hacherFichier } from "./lib-empreinte.mjs";

const TYPES = ["deploiement", "deploiement_refuse", "restauration", "canary_etape", "canary_promotion", "canary_annulation",
  "base_reinitialisation_refusee", "base_reinitialisation_etape", "base_reinitialisation", "base_reinitialisation_echec"];

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

// ── EMPREINTE DE DÉPLOIEMENT (TF-0288, volet prévention · étendu canary TF-0298) ────
// Scellée juste après healthcheck vert et AVANT toute bascule de COURANT : manifeste des
// fichiers du build livré (chemin relatif + sha256), horodaté, VERSIONNÉ À CÔTÉ de
// releases/ (jamais mêlé au contenu déployé — même logique que journal.jsonl : un artefact
// de la cible, pas du build). Fonction réutilisée par deployer ET canary (TF-0298) : les
// deux voies de promotion scellent au même point du cycle (après healthcheck/critères,
// avant promotion) — une cible promue par canary n'est plus un SKIP permanent sur O-7.
// Comparée ensuite par oracle-ops.mjs --empreinte (O-7) : un fichier modifié/supprimé/ajouté
// dans releases/<release>/ après scellement est une dérive de déploiement détectable.
function listerFichiers(dir, base = dir, acc = []) {
  for (const nom of fs.readdirSync(dir)) {
    const p = path.join(dir, nom);
    if (fs.statSync(p).isDirectory()) listerFichiers(p, base, acc);
    else acc.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return acc;
}

// TF-0615 : le hachage vit dans `scripts/lib-empreinte.mjs` — normalise un fichier TEXTE, laisse
// un BINAIRE brut. Un repertoire de release contient les deux, et normaliser un binaire serait un
// defaut : deux binaires ne differant que par une paire CR-LF deviendraient indiscernables.

function scellerEmpreinte(cible, release, releaseDir) {
  const fichiers = {};
  for (const rel of listerFichiers(releaseDir).sort()) fichiers[rel] = hacherFichier(path.join(releaseDir, rel));
  const dir = path.join(cible, "empreintes");
  fs.mkdirSync(dir, { recursive: true });
  const doc = { format: "forge-ops/empreinte@1", release, ts: new Date().toISOString(), fichiers };
  fs.writeFileSync(path.join(dir, `${release}.json`), JSON.stringify(doc, null, 2) + "\n", "utf8");
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
  scellerEmpreinte(cible, release, dest);
  const precedent = lireCourant(cible);
  ecrireCourant(cible, release);
  journalAppend(cible, "deploiement", { release, precedent });
  console.log(`[OPS OK] déployé : ${release}${precedent ? ` (précédent : ${precedent})` : ""}`);
}

// TF-1805 (lot Produit-83 du 15/10/2026) : la cible par défaut du pilot est un conteneur Docker
// local (ETAPE-MEP § 1). `restaurer` ne sait repointer que des releases de FICHIERS (COURANT +
// releases/) ; sur un dossier de produit conteneurisé il répondait « rien à restaurer », phrase
// fausse sur un staging qui sert une version N. Il refuse désormais HORS CONTRAT (exit 2) en
// nommant le geste manuel, sans rien écrire. Restaurer un conteneur n'est pas implémenté : les
// conventions de tag et de service appartiennent au produit, qui les écrit dans son ROLLBACK.md.
const FICHIERS_CONTENEUR = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", "Dockerfile"];

function horsContrat(msg) { console.error(`[OPS HORS CONTRAT] ${msg}`); process.exit(2); }

function restaurer(cible) {
  const courant = lireCourant(cible);
  const conteneur = FICHIERS_CONTENEUR.filter(f => fs.existsSync(path.join(cible, f)));
  if (!courant && conteneur.length)
    horsContrat(`cible conteneur Docker (${conteneur.join(", ")}) : ops.mjs restaurer ne restaure que des `
      + "releases de fichiers (COURANT + releases/). Geste manuel, celui du ROLLBACK.md du produit : "
      + "docker compose down ; repointer le service sur l'image N-1 taguée <produit>:<run-id N-1> ; "
      + "docker compose up -d ; healthcheck 200 ; puis retour à N (ETAPE-MEP M-4). Rien n'a été écrit.");
  if (!courant) fail("aucun COURANT — cible sans release de fichiers active, rien à restaurer ici "
    + "(une cible conteneur se restaure par le ROLLBACK.md du produit, TF-1805)");
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

  // TF-0298 : tous les paliers sont franchis — le candidat est accepté, scellement avant
  // bascule (même point du cycle que deployer : après healthcheck/critères, avant promotion).
  scellerEmpreinte(cible, release, dest);
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
// TF-1685 : tout jeton <MAJUSCULES> employé dans une phase figure dans `placeholders`, <BUILD>
// compris (substitué en phase deploiement par l'argument build de `plan`) — un jeton non déclaré
// reste brut chez le consommateur qui ne remplit que les jetons déclarés. Le self-test le juge.
const PLANS = {
  railway: {
    service: "Railway service (conteneur)",
    fiche: "experts-forge/fiches/expert-ops-railway.md",
    placeholders: ["<PROJET>", "<ENVIRONNEMENT>", "<URL_SERVICE>", "<ID_DEPLOIEMENT_PRECEDENT>", "<SERVICE>", "<PRODUIT>"],
    provision: [
      "railway link <PROJET> --environment <ENVIRONNEMENT>",
      // TF-0845 (lot Produit-61 20260905a + seq 75) : `railway up -p <id>` (ou --project) NE
      // REMPLACE PAS cette liaison — sans dossier lie par `railway link`, `up` echoue
      // « Indexing... prefix not found » exit 1 (un televersement perdu), un message qui ne
      // nomme ni link ni la cause reelle (dossier non lie). `railway link` puis `railway up
      // --ci` (sans -p) reussit du premier coup : l'ordre ci-dessus est le correctif, pas une
      // option.
      "ne jamais substituer cette liaison par `railway up -p <id_projet>` : sans dossier deja lie, `up` echoue « prefix not found » (exit 1, message qui ne nomme ni link ni la cause reelle) — toujours `railway link` AVANT `railway up`, jamais `-p` a la place de `link` (TF-0845)",
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
    placeholders: ["<PROJET>", "<REGION>", "<SERVICE>", "<IMAGE>", "<HASH>", "<REVISION_PRECEDENTE>", "<DEPOT>", "<BUILD>"],
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
      // TF-1638 : « ne jamais purger les revisions saines anterieures » interdisait tout menage ;
      // la regle utile au retour arriere est de GARDER N-1 saine, pas de tout garder.
      "garder au moins la revision N-1 saine (O-4 : histoire purgee = rollback impossible) — jamais purger toutes les revisions saines anterieures",
    ],
  },
  azure: {
    service: "Azure Container Apps",
    fiche: "experts-forge/fiches/expert-ops-azure.md",
    placeholders: ["<RG>", "<REGION>", "<APP>", "<ACR>", "<IMAGE>", "<SUFFIXE>", "<SUFFIXE_PRECEDENT>", "<FORGE_OPS>", "<ENV>", "<DOMAINE_ENV>", "<BUILD>", "<BUDGET_MENSUEL>", "<SEUIL_ALERTE_PCT>", "<DESTINATAIRE_ALERTE_COUT>", "<DEBUT_MOIS>"],
    provision: [
      "az group create --name <RG> --location <REGION>",
      // TF-1684 (volet 3 de TF-1639) : sans alerte de cout, une derive reste invisible jusqu'a la
      // facture (34 jours chez Produit-64). `az consumption budget create` ne porte AUCUNE
      // notification (pas de --notifications) : un budget muet ne previent personne ; c'est
      // create-with-rg qui pose budget ET alerte sur le groupe de ressources. Cles de la
      // notification lues dans la source du CLI (_create_with_rg.py : contact-emails, enabled,
      // operator, threshold ; pas de thresholdType, donc seuil sur cout REEL) ; seuil en
      // pourcentage du budget (0 a 1000, API Budgets 2024-08-01) ; debut de periode = 1er du mois.
      // Commande de groupe « Preview » au 14/10/2026 : a reverifier si elle change de statut.
      "az consumption budget create-with-rg --resource-group <RG> --budget-name budget-<RG> --category Cost --amount <BUDGET_MENSUEL> --time-grain Monthly --time-period \"{start-date:<DEBUT_MOIS>}\" --notifications \"{Actual_GreaterThan_<SEUIL_ALERTE_PCT>_Percent:{enabled:true,operator:GreaterThan,threshold:<SEUIL_ALERTE_PCT>,contact-emails:[<DESTINATAIRE_ALERTE_COUT>]}}\"   # ALERTE DE COUT par groupe de ressources : budget mensuel <BUDGET_MENSUEL>, courriel a <DESTINATAIRE_ALERTE_COUT> des <SEUIL_ALERTE_PCT> % consommes, <DEBUT_MOIS> = AAAA-MM-01 (TF-1684) ; source : https://learn.microsoft.com/en-us/cli/azure/consumption/budget?view=azure-cli-latest#az-consumption-budget-create-with-rg, lue le 14/10/2026",
      "alerte d'ANOMALIE de cout en complement, a l'echelle de l'ABONNEMENT seulement (non posable par groupe de ressources ; detection quotidienne 36 h apres la fin de la journee UTC) : regle « Anomaly » de Cost Management, automatisable par l'API Scheduled Actions (kind InsightAlert) ; source : https://learn.microsoft.com/en-us/azure/cost-management-billing/understand/analyze-unexpected-charges, lue le 14/10/2026 (TF-1684)",
      "az containerapp env create --name <ENV> --resource-group <RG> --location <REGION>",
      "az containerapp revision set-mode --name <APP> --resource-group <RG> --mode multiple   # SANS multiple, aucun retour instantane possible",
      // TF-1638 (lot Produit-64 20261012c, RT-34) : le mode multiple sans borne a laisse 100
      // revisions actives sur une application ; une revision ACTIVE garde ses minReplicas
      // factures a 0 % de trafic (1 552,23 EUR en septembre 2026 pour un budget de 100).
      "BORNE du mode multiple : au plus N servie (trafic > 0) + UNE revision N-1 saine a 0 % actives par application, soit 2 dans le cas courant — une revision ACTIVE garde ses minReplicas factures a 0 % de trafic ; l'etape de menage (phase healthcheck, apres bascule) tient la borne, O-18 la juge (TF-1638)",
      // TF-1639 : un menage place seulement dans la chaine ne couvre ni un run qui echoue entre
      // bascule et menage, ni une revision activee a la main, ni un environnement que plus aucun
      // run ne touche.
      "menage PERIODIQUE independant des runs : planifier la MEME etape de menage (garde N-1, desactive le reste) au moins chaque jour sur chaque environnement, avec un mode d'exercice a la demande (O-8) — une revision activee a la main ou un run interrompu entre bascule et menage reste sinon facture sans fin (TF-1639)",
    ],
    deploiement: [
      "az acr build --registry <ACR> --image <IMAGE> <BUILD>",
      "az containerapp update --name <APP> --resource-group <RG> --image <IMAGE> --revision-suffix <SUFFIXE>   # nouvelle revision, ingress targetPort=8080",
    ],
    healthcheck: [
      "curl -fsS https://<APP>--<SUFFIXE>.<DOMAINE_ENV>/sante   # URL de revision, 200 attendu",
      "az containerapp ingress traffic set --name <APP> --resource-group <RG> --revision-weight <SUFFIXE>=100   # bascule APRES healthcheck vert",
      "curl -fsS https://<APP>.<DOMAINE_ENV>/sante   # controle post-bascule sur l'URL servie, 200 attendu",
      // TF-1638 : menage APRES le controle post-bascule, rejouable (idempotent : rejoue, il ne
      // trouve plus rien a desactiver). Garde N-1 = la plus recente revision active a 0 % qui
      // n'est pas Unhealthy — meme regle qu'O-18. Desactiver est reversible (phase rollback :
      // revision activate), O-4 tient. Un menage rate AVERTIT sans faire echouer le deploiement.
      "GARDE=$(az containerapp revision list --name <APP> --resource-group <RG> --query \"sort_by([?properties.active && properties.trafficWeight==\\`0\\` && properties.healthState!='Unhealthy'], &properties.createdTime)[-1].name\" -o tsv)   # menage 1/2 : N-1 saine gardee pour le retour instantane",
      "for R in $(az containerapp revision list --name <APP> --resource-group <RG> --query \"[?properties.active && properties.trafficWeight==\\`0\\`].name\" -o tsv); do [ \"$R\" = \"$GARDE\" ] || az containerapp revision deactivate --name <APP> --resource-group <RG> --revision \"$R\" || echo \"AVERTISSEMENT menage : $R reste active\"; done   # menage 2/2 : toute autre revision active a 0 % desactivee (TF-1638)",
      "az containerapp revision list --name <APP> --resource-group <RG> -o json > revisions-<APP>.json && node <FORGE_OPS>/oracles/oracle-ops.mjs --revisions-actives revisions-<APP>.json   # O-18 : revisions actives bornees, verdict au dossier de MEP (TF-1639)",
    ],
    rollback: [
      "az containerapp ingress traffic set --name <APP> --resource-group <RG> --revision-weight <SUFFIXE_PRECEDENT>=100   # instantane en mode multiple",
      "az containerapp revision activate --name <APP> --resource-group <RG> --revision <APP>--<SUFFIXE_PRECEDENT>   # si la revision etait desactivee",
    ],
  },
  aws: {
    service: "AWS App Runner",
    fiche: "experts-forge/fiches/expert-ops-aws.md",
    placeholders: ["<REGION>", "<ARN_SERVICE>", "<DEPOT_ECR>", "<TAG_IMMUABLE>", "<TAG_PRECEDENT>", "<URL_SERVICE>", "<BUILD>"],
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

// ── PRODUITS DATA (TF-0865, lot L8 de l'étude d'opportunité du pilot du 07/09/2026) ──
// Deux cibles de plan pour un produit data : un bundle déclaratif Databricks (Databricks
// Asset Bundles, disponibilité générale 2024-04 — le déploiement est un fichier de
// configuration validable HORS LIGNE) et un espace de travail Power BI alimenté par un projet
// PBIP versionné (promotion développement → test → production). Même doctrine que les cibles
// cloud : plan-first, quatre phases, retour arrière réel, zéro credential ; et une règle de
// plus, R-38 du pilot : la PUBLICATION sur le service est conditionnée au GO humain, le plan
// le dit dans sa phase de déploiement au lieu de le supposer.
PLANS["databricks-bundle"] = {
  service: "Databricks — bundle déclaratif (jobs, pipelines, notebooks, en tant qu'unité versionnée)",
  fiche: "experts-forge/fiches/expert-data-platform-cloud.md",
  placeholders: ["<CIBLE_BUNDLE>", "<PROFIL_CLI>", "<HOTE_WORKSPACE>", "<CATALOGUE>", "<JOB_SMOKE>", "<REF_GIT_PRECEDENTE>"],
  provision: [
    "databricks auth profiles   # identite de deploiement lue depuis le profil <PROFIL_CLI> du CLI — jamais un jeton dans le plan",
    "verifier databricks.yml : une cible par environnement (<CIBLE_BUNDLE> = dev | qualif | prod), workspace.host=<HOTE_WORKSPACE> et catalogue <CATALOGUE> DISTINCTS par cible — deux workspaces d'un meme groupe portent les memes noms de catalogues par construction (REX X13, T7 de forge-data) : le OU se declare dans la cible, jamais deduit du nom",
    "databricks bundle validate -t <CIBLE_BUNDLE> --profile <PROFIL_CLI>   # validation HORS LIGNE du bundle : schema, variables, references — exit 0 exige avant tout deploiement",
  ],
  deploiement: [
    "databricks bundle deploy -t <CIBLE_BUNDLE> --profile <PROFIL_CLI>   # applique jobs/pipelines/notebooks comme une unite versionnee (git rev enregistre par le bundle)",
    "databricks bundle summary -t <CIBLE_BUNDLE> --profile <PROFIL_CLI>   # ressources deployees, avec leurs identifiants — a archiver au dossier de MEP",
  ],
  healthcheck: [
    "databricks bundle run <JOB_SMOKE> -t <CIBLE_BUNDLE> --profile <PROFIL_CLI>   # health : le job de fumee (lecture Gold + oracle-reconcilier sur un lot archive) termine SUCCESS",
    "python mesurer_base.py sante-gold \"SELECT COUNT(*) FROM <CATALOGUE>.gold.fct_ventes\"   # sante de la couche servie : compte non nul, cible archivee (forge-data cat-dat-08)",
  ],
  rollback: [
    "git checkout <REF_GIT_PRECEDENTE> -- databricks.yml resources/   # le bundle precedent est une reference git, pas un souvenir",
    "databricks bundle deploy -t <CIBLE_BUNDLE> --profile <PROFIL_CLI>   # redeploie l'unite precedente a l'identique (retour arriere reel, jamais `bundle destroy` sur une cible partagee)",
    "databricks bundle run <JOB_SMOKE> -t <CIBLE_BUNDLE> --profile <PROFIL_CLI>   # re-verification apres retour",
  ],
};
PLANS["powerbi-workspace"] = {
  service: "Power BI — espace de travail alimente par un projet PBIP versionne (modele semantique TMDL + rapports PBIR)",
  fiche: "digit-ai-forge-audit/profiles/powerbi/README.md (profil Power BI, 10 controles) — aucune fiche expert dediee au 07/09/2026",
  placeholders: ["<ESPACE_DEV>", "<ESPACE_TEST>", "<ESPACE_PROD>", "<PROJET_PBIP>", "<MODELE>", "<RAPPORT>", "<COMMIT_PRECEDENT>"],
  provision: [
    "fab auth login   # identite de publication : compte de service Fabric/Power BI, jamais un jeton dans le plan",
    "verifier que le projet <PROJET_PBIP> est en formats texte (dossiers <MODELE>.SemanticModel/definition en TMDL et <RAPPORT>.Report en PBIR) et versionne — un PBIX binaire ne se juge ni ne se promeut",
    "node verifier-modele-semantique.mjs --modele <PROJET_PBIP>/<MODELE>.SemanticModel/definition   # forge-audit MS1-MS6 : exit 0 exige avant toute publication",
    "fab ls <ESPACE_DEV>.Workspace   # les trois espaces (dev, test, prod) existent et sont DISTINCTS : la promotion est un mouvement entre espaces, jamais une publication directe en prod",
  ],
  deploiement: [
    "fab import <ESPACE_DEV>.Workspace/<MODELE>.SemanticModel -i <PROJET_PBIP>/<MODELE>.SemanticModel   # publication du modele dans l'espace de developpement",
    "fab import <ESPACE_DEV>.Workspace/<RAPPORT>.Report -i <PROJET_PBIP>/<RAPPORT>.Report   # publication du rapport, lie au modele",
    "promotion <ESPACE_DEV> -> <ESPACE_TEST> -> <ESPACE_PROD> par pipeline de deploiement du service, chaque etape apres son healthcheck ; l'etape vers <ESPACE_PROD> exige le GO humain consigne au dossier de MEP (R-38 : aucune publication sur un service heberge sans GO)",
  ],
  healthcheck: [
    "fab job run <ESPACE_DEV>.Workspace/<MODELE>.SemanticModel --type Refresh   # health : le rafraichissement du modele termine sans erreur",
    "node oracle-reconcilier.mjs <lot-reconciliation.json>   # sante des chiffres : mesures du modele publie reconciliees avec Gold sous tolerance (forge-data RC1-RC6)",
  ],
  rollback: [
    "git checkout <COMMIT_PRECEDENT> -- <PROJET_PBIP>/   # le projet precedent est un commit, pas un PBIX conserve quelque part",
    "fab import <ESPACE_PROD>.Workspace/<MODELE>.SemanticModel -i <PROJET_PBIP>/<MODELE>.SemanticModel   # re-publication a l'identique de la version precedente (retour arriere reel)",
    "fab job run <ESPACE_PROD>.Workspace/<MODELE>.SemanticModel --type Refresh   # re-verification apres retour",
  ],
};

// ── SUPABASE (16/10/2026) : projet heberge (base Postgres, migrations, fonctions) ──
// Chaque commande vient d'une page officielle lue le 16/10/2026 (S1, S5, S6, S7, S8 de la
// fiche expert). Meme doctrine : plan-first, zero credential, publication sur GO humain (R-38).
// Retour arriere HONNETE : la documentation ne decrit aucune migration « down » ; la voie est
// une migration corrective poussee par `db push`, la restauration (PITR ou sauvegarde) n'etant
// qu'un dernier recours humain et irreversible, hors CLI.
// TF-2007 (29/10/2026, etude du pilot du 28/10, ligne S2) : la cible est completee par cinq garde-fous que la
// plateforme ne revele qu'au deploiement, chacun cite dans une page lue le 29/10/2026 : rejeu des migrations sur
// une base locale vide (supabase start, db reset --local), derive du projet distant (db diff --linked), secrets
// des fonctions poses AVANT elles (secrets set), une seule voie face a l'integration GitHub (« Deploy to
// production »), et le branching dit pour ce qu'il est, une depense humaine. O-5 juge les quatre premiers.
PLANS.supabase = {
  service: "Supabase — projet heberge (base Postgres, migrations, fonctions)",
  fiche: "experts-forge/fiches/expert-ops-supabase.md",
  placeholders: ["<PROJECT_REF>", "<NOM_CORRECTIF>", "<URL_SERVICE>", "<NOM_MIGRATION_DERIVE>", "<FICHIER_SECRETS>", "<REF_GIT_PRECEDENTE>", "<FONCTION>", "<NOM_SECRET>"],
  provision: [
    "identite de deploiement : variables SUPABASE_ACCESS_TOKEN (jeton personnel a portee limitee), SUPABASE_DB_PASSWORD et SUPABASE_PROJECT_ID fournies par l'environnement du run, jamais une valeur dans le plan ; source : https://supabase.com/docs/guides/deployment/managing-environments, lue le 16/10/2026",
    "supabase link --project-ref <PROJECT_REF>   # liaison au projet distant <PROJECT_REF> ; source : https://supabase.com/docs/reference/cli/introduction, lue le 16/10/2026",
    "supabase ssl-enforcement get --project-ref <PROJECT_REF> --experimental   # attendu « SSL is being enforced. » ; « SSL is *NOT* being enforced. » = ecart a traiter (l'activation redemarre la base) ; source : https://supabase.com/docs/guides/platform/ssl-enforcement, lue le 16/10/2026",
    "supabase network-restrictions get --project-ref <PROJECT_REF> --experimental   # 0.0.0.0/0 + ::/0 = aucune restriction ; couvre Postgres et le pooler, PAS les API HTTPS (PostgREST, Storage, Auth) ; source : https://supabase.com/docs/guides/platform/network-restrictions, lue le 16/10/2026",
    "integration GitHub de Supabase : « Enable the Deploy to production option in your GitHub Integration configuration to automatically deploy changes when you push or merge to production branch. » — UNE seule voie de deploiement : ce plan pousse par la chaine du produit, donc l'option Deploy to production reste DESACTIVEE dans la configuration de l'integration GitHub du projet ; sinon les memes migrations partent deux fois, dont une sans le GO de la chaine (R-38) ; et une migration hors transaction « applies with supabase db push but fails when branching deploys it » ; source : https://supabase.com/docs/guides/deployment/branching/github-integration, lue le 29/10/2026",
    "branching (environnements d'apercu par pull request) : « Each branch is a separate environment with its own Supabase instance and API credentials. » ; c'est une DEPENSE : « There is no fixed fee for a Preview branch. You only pay for the usage it incurs. » et « A branch running on the default Micro Compute size starts at $0.01344 per hour. » — l'activer est une decision humaine (R-29), jamais un geste du plan ; statut : la gestion des branches par le tableau de bord est « currently in beta », la contradiction alpha ou beta relevee le 28/10/2026 n'est pas tranchee par les pages lues ; sources : https://supabase.com/docs/guides/deployment/branching et https://supabase.com/docs/guides/platform/manage-your-usage/branching, lues le 29/10/2026",
    "supabase start   # pile locale du rejeu ci-dessous ; « A container manager compatible with Docker APIs is a prerequisite for supabase start » ; source : https://supabase.com/docs/guides/local-development, lue le 29/10/2026",
    "supabase db reset --local --no-seed   # REJEU de toutes les migrations sur une base locale vide AVANT tout push : « Resets the local database with local migrations. » ; une migration qui ne passe que sur la base de developpement echoue ici, pas en production ; source : https://supabase.com/docs/reference/cli/supabase-db-reset, lue le 29/10/2026",
    "supabase db diff --linked   # DERIVE du projet distant : « Diffs local migration files against the linked project. » ; une sortie non vide = un schema change hors des migrations (tableau de bord) : le capturer par `supabase db diff --linked -f <NOM_MIGRATION_DERIVE>` (« Saves schema diff to a new migration file. »), le relire et le versionner AVANT le push ; « Under the legacy migra engine, the diff is known to miss some changes. » ; source : https://supabase.com/docs/reference/cli/supabase-db-diff, lue le 29/10/2026",
    "verify_jwt des fonctions : « By default, Edge Functions require a valid JWT in the authorization header. » ; relire supabase/config.toml : toute fonction a `verify_jwt = false` (ou deployee avec --no-verify-jwt) est nommee au dossier de MEP avec sa raison (webhook signe), car « it will allow anyone to invoke your Edge Function without a valid JWT » ; source : https://supabase.com/docs/guides/functions/function-configuration, lue le 29/10/2026",
  ],
  deploiement: [
    "supabase db push --dry-run --linked   # essai a blanc (--dry-run), sa sortie relue avant le GO",
    "supabase db push --linked   # applique les migrations au projet distant : publication sur un service heberge, GO humain consigne au dossier de MEP (R-38) ; source : https://supabase.com/docs/reference/cli/introduction, lue le 16/10/2026",
    "supabase secrets set --env-file <FICHIER_SECRETS> --project-ref <PROJECT_REF>   # secrets des fonctions AVANT leur deploiement : « Push every secret in the file to your remote project. » ; <FICHIER_SECRETS> est ecrit par la chaine depuis ses propres secrets, jamais versionne (« A .env file committed to Git exposes every secret in it to anyone who can read the repository. ») ; « Your functions read a new secret immediately, so you don't need to redeploy. » : poser un secret change la production aussitot, sous GO humain (R-38) ; sources : https://supabase.com/docs/guides/functions/secrets et https://supabase.com/docs/reference/cli/supabase-secrets-set, lues le 29/10/2026",
    "supabase functions deploy --project-ref <PROJECT_REF>   # publication des fonctions, sous le meme GO humain (R-38) ; « Deploy a Function to the linked Supabase project. » ; jamais --prune sans la liste des fonctions supprimees au dossier de MEP (« Delete Functions that exist in Supabase project but not locally. ») ; source : https://supabase.com/docs/reference/cli/supabase-functions-deploy, lue le 29/10/2026",
  ],
  healthcheck: [
    "supabase migration list --linked   # health : etat des migrations du projet lie, relu apres le push",
    "supabase db diff --linked   # apres le push, sortie vide attendue : migrations locales et projet lie decrivent le meme schema ; source : https://supabase.com/docs/reference/cli/supabase-db-diff, lue le 29/10/2026",
    "supabase secrets list --project-ref <PROJECT_REF>   # les secrets qu'attendent les fonctions sont presents (« List all secrets in the linked project. ») ; source : https://supabase.com/docs/reference/cli/supabase-secrets-set, lue le 29/10/2026",
    "curl -fsS <URL_SERVICE>/sante   # 200 attendu (contrat sante.mjs de forge-ops) ; <URL_SERVICE> = le produit servi, aucune URL Supabase supposee",
  ],
  rollback: [
    "la documentation ne decrit AUCUNE migration « down » : le retour arriere d'un schema est une migration CORRECTIVE vers l'avant ; source : https://supabase.com/docs/guides/deployment/managing-environments, lue le 16/10/2026",
    "supabase migration new <NOM_CORRECTIF>   # ecrire le correctif qui defait la migration fautive, versionne avec le produit",
    "supabase db push --dry-run --linked && supabase db push --linked   # pousser le correctif, sous GO humain (R-38)",
    "supabase migration list --linked   # re-verification apres retour",
    "fonctions : la reference de `supabase functions deploy` lue le 29/10/2026 ne decrit aucun retour arriere natif ; le retour arriere d'une fonction est le redeploiement de sa version precedente, tiree du depot : `git checkout <REF_GIT_PRECEDENTE> -- supabase/functions/<FONCTION>` puis `supabase functions deploy <FONCTION> --project-ref <PROJECT_REF>`, sous GO humain (R-38) ; source : https://supabase.com/docs/reference/cli/supabase-functions-deploy, lue le 29/10/2026",
    "secrets : remettre la valeur precedente, tenue par la chaine, par `supabase secrets set` ; retirer un secret ajoute par `supabase secrets unset <NOM_SECRET> --project-ref <PROJECT_REF>` (« Unset a secret(s) from the linked Supabase project. ») ; effet immediat, sous GO humain (R-38) ; source : https://supabase.com/docs/reference/cli/supabase-secrets-set, lue le 29/10/2026",
    "DERNIER RECOURS, GESTE HUMAIN IRREVERSIBLE : restauration d'une sauvegarde ou PITR par le tableau de bord (Database > Backups) ou l'API de gestion `POST https://api.supabase.com/v1/projects/<PROJECT_REF>/database/backups/restore-pitr` — aucune commande CLI de restauration ; projet INACCESSIBLE pendant l'operation, tout ce qui suit le point choisi est PERDU ; sauvegardes quotidiennes Pro 7 j, Team 14, Enterprise jusqu'a 30, Free aucune (export par `supabase db dump`) ; PITR = add-on Pro/Team/Enterprise ; jamais lance par la forge ; source : https://supabase.com/docs/guides/platform/backups, lue le 16/10/2026",
  ],
};

// ── CLOUDFLARE WORKERS (28/10/2026, TF-1995) : Worker avec ressources statiques, versions et deploiements ──
// Chaque commande et chaque fait vient d'une page officielle lue le 28/10/2026 (adresse citee dans
// la ligne). Meme doctrine : plan-first, zero credential, publication sur GO humain (R-38).
// Le deploiement SEPARE la version du trafic : `versions upload` cree une version sans la servir,
// `versions deploy` la sert ; `wrangler deploy` fait les deux d'un coup, donc il n'est joue qu'a
// blanc (--dry-run). Le retour arriere est NATIF : `wrangler rollback` recree un deploiement de la
// version precedente. Il ne defait pas les ressources liees (KV, D1, R2, Durable Objects) : un
// changement de schema de la base se corrige par la voie de la base, pas par ce geste.
// Variante Pages (projet existant) : non couverte par cette cible — le plan vise Workers, vers
// lequel le guide de migration cite en provision conduit ; aucune cible Pages n'est inventee.
PLANS["cloudflare-workers"] = {
  service: "Cloudflare Workers — Worker avec ressources statiques (versions, deploiements, retour arriere natif)",
  fiche: "experts-forge/fiches/expert-ops-cloudflare.md",
  placeholders: ["<BUILD>", "<DOMAINE>", "<MESSAGE_VERSION>", "<MESSAGE_RETOUR>", "<ID_VERSION>", "<ID_VERSION_PRECEDENTE>", "<URL_VERSION>", "<POURCENT_NOUVELLE>", "<POURCENT_PRECEDENTE>", "<URL_SERVICE>"],
  provision: [
    "identite de deploiement : variables CLOUDFLARE_API_TOKEN (jeton d'API cree avec le modele « Edit Cloudflare Workers », restreint au seul compte du deploiement) et CLOUDFLARE_ACCOUNT_ID, fournies par l'environnement du run comme secrets de la chaine du produit (le plan s'execute dans la chaine, jamais depuis un poste), jamais une valeur dans le plan ni dans le depot ; source : https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/, lue le 28/10/2026",
    "npx wrangler whoami --json   # identite lue par la CLI ; sort en code non nul si elle n'est pas authentifiee ; le compte attendu est celui de CLOUDFLARE_ACCOUNT_ID ; source : https://developers.cloudflare.com/workers/wrangler/commands/general/, lue le 28/10/2026",
    "domaine personnalise <DOMAINE> : Workers n'accepte AUCUN domaine dont les serveurs de noms ne sont pas geres par Cloudflare (« Unlike Pages, Workers does not support any domain whose nameservers are not managed by Cloudflare. ») — verifier que la zone de <DOMAINE> est chez Cloudflare AVANT de migrer un projet Pages dont le domaine y pointe par un CNAME ; sinon la migration est bloquee, et deplacer les serveurs de noms est un geste humain hors forge ; source : https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/, lue le 28/10/2026",
    "front Workers devant une base Supabase : ordre des deux plans, variables d'environnement nommees par plateforme et URL de redirection de l'auth pour les previsualisations sont dans references/ENCHAINEMENT-PLANS.md de forge-ops (TF-2010) ; la base se deploie AVANT le front",
    "un secret change est un deploiement : `wrangler secret put` cree une nouvelle version ET la deploie aussitot ; avec des deploiements progressifs, poser le secret par `wrangler versions secret put`, qui ne cree que la version ; source : https://developers.cloudflare.com/workers/configuration/secrets/, lue le 28/10/2026",
  ],
  deploiement: [
    "npx wrangler deploy --dry-run --cwd <BUILD>   # essai a blanc : compile sans publier ; `wrangler deploy` seul cree la version ET la sert a 100 % d'un coup, ce plan ne le joue donc pas ; source : https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/, lue le 28/10/2026",
    "npx wrangler versions upload --cwd <BUILD> --message \"<MESSAGE_VERSION>\"   # cree une version SANS la deployer et rend son <URL_VERSION> (publique si les URL de version sont activees) : publication sur un service heberge, GO humain consigne au dossier de MEP (R-38) ; source : https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/, lue le 28/10/2026",
  ],
  healthcheck: [
    "curl -fsS <URL_VERSION>/sante   # smoke sur l'URL de la version, hors trafic, 200 attendu (contrat sante.mjs de forge-ops) ; source : https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/, lue le 28/10/2026",
    "npx wrangler versions deploy <ID_VERSION>@<POURCENT_NOUVELLE>% <ID_VERSION_PRECEDENTE>@<POURCENT_PRECEDENTE>% --yes   # bascule APRES healthcheck vert, en palier : deploiement PROGRESSIF entre deux versions, les pourcentages sont fixes par l'humain ; seules les 100 dernieres versions telechargees sont deployables ; GO humain (R-38) ; source : https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/, lue le 28/10/2026",
    "npx wrangler deployments status   # health : les versions qui servent le trafic et leur part, relues apres le palier ; source : https://developers.cloudflare.com/workers/wrangler/commands/workers/, lue le 28/10/2026",
    "npx wrangler versions deploy <ID_VERSION>@100% --yes   # promotion de la nouvelle version a 100 % une fois le palier sain (dernier geste de la bascule) ; sans palier, c'est la seule commande de bascule ; GO humain (R-38) ; source : https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/, lue le 28/10/2026",
    "curl -fsS <URL_SERVICE>/sante   # controle post-bascule sur l'URL servie, 200 attendu ; pendant un deploiement progressif deux versions servent, un client peut voir l'une puis l'autre (version skew) ; source : https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/, lue le 28/10/2026",
  ],
  rollback: [
    "npx wrangler deployments list   # les 10 deploiements les plus recents : relever <ID_VERSION_PRECEDENTE>, la version saine servie avant la bascule ; source : https://developers.cloudflare.com/workers/wrangler/commands/workers/, lue le 28/10/2026",
    "npx wrangler rollback <ID_VERSION_PRECEDENTE> --message \"<MESSAGE_RETOUR>\"   # cree AUSSITOT un nouveau deploiement de cette version, active sur toutes les routes et tous les domaines, a 100 % (aussi depuis un deploiement progressif) ; sans identifiant, la version televersee avant la derniere ; --message saute les invites, donc utilisable en chaine ; sous GO humain (R-38) ; source : https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/, lue le 28/10/2026",
    "limites du retour arriere : 100 versions les plus recentes seulement ; REFUSE si une classe de Durable Object a change de cycle de vie entre les deux versions, ou si la version visee lie un bucket R2, un namespace KV ou une file supprimes ; il ne change PAS les ressources liees (KV, D1, R2, Durable Objects) : une structure de donnees modifiee entre les deux versions peut faire echouer le code ancien — un changement de schema se defait par la voie de sa base (migration corrective), jamais par ce geste ; source : https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/, lue le 28/10/2026",
    "npx wrangler deployments status   # re-verification apres retour : la seule version servie est <ID_VERSION_PRECEDENTE>",
    "curl -fsS <URL_SERVICE>/sante   # re-verification apres retour, 200 attendu",
  ],
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

// ─────────── RÉINITIALISER UNE BASE HORS PRODUCTION (TF-2013, décision R-58 (a) du 29/10/2026) ───────────
// LE TROU, mesuré le 29/10/2026 : aucune forge ne savait vider et reconstruire une base de développement
// ou de qualification à la demande. `restaurer` ne repointe que des releases de FICHIERS ; le plan
// `supabase` ne pousse que des migrations vers l'avant et laisse la restauration (PITR) en dernier
// recours humain.
// LE VERBE lit une déclaration `forge-ops/bases@1` écrite par le produit (un fichier, même posture que la
// déclaration de sauvegarde d'O-19) et rend par défaut le PLAN ordonné : vider, rejouer les migrations,
// charger les données (commande déclarée par le produit : seed synthétique ou extrait déclaré), vérifier
// (migrations à jour, comptes de lignes non nuls). Rien ne s'exécute sans `--executer`, et `--executer` ne
// vise qu'une cible `postgres-docker` servie par un démon Docker LOCAL. Supabase : plan seulement,
// commandes lues dans la documentation officielle le 29/10/2026 ; la remise à zéro d'un projet distant
// (`--linked`) reste un geste humain sous GO (R-38).
// REFUS, en plan comme en exécution, chacun journalisé dans `journal.jsonl` à côté de la déclaration :
//   exit 2 (hors contrat) : déclaration introuvable, illisible ou porteuse d'un mot de passe ; cible
//     absente ; environnement absent, hors vocabulaire ou `production` ; production ni déclarée ni
//     écartée par un motif ; cible qui partage le serveur (hôte:port), le conteneur ou le projet Supabase
//     d'une cible production ou d'environnement non déclaré ; base de maintenance ; exécution hors d'une
//     cible postgres-docker locale (hôte, démon, conteneur démarré, port publié) ;
//   exit 1 : déclaration incomplète pour le geste demandé, ou geste exécuté en échec.
const FORMAT_BASES = "forge-ops/bases@1";
const ENVIRONNEMENTS_BASE = ["developpement", "qualification", "production"];
const MOTEURS_BASE = ["postgres-docker", "supabase-local", "supabase-distant"];
const NATURES_DONNEES = ["synthetique", "extrait"];
// `vider` se connecte à la base de maintenance `postgres` pour supprimer puis recréer la cible : la
// maintenance et les modèles ne sont jamais une cible.
const BASES_SYSTEME = ["postgres", "template0", "template1"];
const IDENTIFIANT_SQL = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TABLE_SQL = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const BOUCLE_LOCALE = ["localhost", "127.0.0.1", "::1", "[::1]"];
// Aucun credential ne transite par la forge : une clé de secret renseignée, une url `://u:p@` ou un
// `PGPASSWORD=` dans la déclaration la font refuser — le mot de passe vient de l'environnement du run.
const CLE_SECRET = /^(mot_de_passe|password|passwd|pwd|secret|jeton|token)$/i;
const SECRET_EN_CLAIR = /:\/\/[^\s:@\/]*:[^\s@\/]+@|\bPGPASSWORD\s*=/i;
const DELAI_COMMANDE_BASE_MS = 600000; // 10 min par commande
const SOURCES_BASE = {
  db_reset: "https://supabase.com/docs/reference/cli/supabase-db-reset, lue le 29/10/2026",
  migration_list: "https://supabase.com/docs/reference/cli/supabase-migration-list, lue le 29/10/2026",
  start: "https://supabase.com/docs/reference/cli/supabase-start, lue le 29/10/2026",
  link: "https://supabase.com/docs/reference/cli/supabase-link, lue le 29/10/2026",
  status: "https://supabase.com/docs/reference/cli/supabase-status, lue le 29/10/2026",
  seed: "https://supabase.com/docs/guides/local-development/seeding-your-database, lue le 29/10/2026",
  drop_database: "https://www.postgresql.org/docs/current/sql-dropdatabase.html (PostgreSQL 18.6), lue le 29/10/2026",
};
const NON_JUGE_BASE = [
  "la VÉRITÉ de la déclaration : une base déclarée « qualification » qui sert en réalité la production passe ; la production déclarée est la seule barrière d'adresse",
  "la CIBLE des commandes déclarées : la forge les exécute sans les lire ; elle leur passe PGHOST, PGPORT, PGDATABASE et PGUSER de la cible et vérifie SUR la cible (état des migrations, comptes), ce qui fait échouer une commande qui aurait écrit ailleurs sans l'empêcher d'y avoir écrit",
  "la QUALITÉ des données chargées au-delà des comptes non nuls (cohérence, volumétrie), et la pseudonymisation d'un extrait : sa source est exigée, jamais jugée",
  "les objets de niveau serveur : DROP DATABASE ne supprime ni les rôles ni les autres bases du serveur",
  "la PORTABILITÉ des commandes déclarées : elles passent au shell du poste (cmd.exe sous Windows, /bin/sh ailleurs), où une même commande peut se lire autrement",
  "Supabase : aucune exécution dans ce lot ; la remise à zéro d'un projet distant reste un geste humain sous GO (R-38)",
];

const afficherArgv = (argv) => argv.map(x => /[\s"]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x).join(" ");
const texteDeclare = (v) => typeof v === "string" && v.trim() !== "";

// Les chemins de la déclaration qui portent un secret en clair (clé de secret renseignée, url avec mot
// de passe, PGPASSWORD=) : la déclaration entière est refusée, pas seulement la cible demandée.
function secretsDeclares(v, ou = "") {
  if (typeof v === "string") return SECRET_EN_CLAIR.test(v) ? [ou] : [];
  if (Array.isArray(v)) return v.flatMap((x, i) => secretsDeclares(x, `${ou}[${i}]`));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => {
    const chemin = ou ? `${ou}.${k}` : k;
    return (CLE_SECRET.test(k) && x !== null && x !== "" ? [chemin] : []).concat(secretsDeclares(x, chemin));
  });
  return [];
}

// Les coordonnées d'une adresse : champs explicites, sinon lus dans `url` (sans mot de passe) ; un champ
// vide compte comme absent. Le port manquant d'un hôte déclaré est celui de PostgreSQL par défaut, 5432.
function coordonneesBase(a) {
  const champ = (v) => (v === "" || v === null ? undefined : v);
  const c = { hote: champ(a.hote), port: champ(a.port), base: champ(a.base), utilisateur: champ(a.utilisateur) };
  if (texteDeclare(a.url)) {
    const u = new URL(a.url.trim()); // illisible : levée, traitée par l'appelant
    c.hote ??= u.hostname || undefined;
    c.port ??= u.port ? Number(u.port) : undefined;
    c.base ??= decodeURIComponent(u.pathname.replace(/^\//, "")) || undefined;
    c.utilisateur ??= u.username ? decodeURIComponent(u.username) : undefined;
  }
  if (c.hote !== undefined && c.port === undefined) c.port = 5432;
  return c;
}

// Les identités d'une adresse : serveur (hôte:port, la boucle locale sous un seul nom), conteneur, projet
// Supabase. Deux cibles qui en partagent une désignent la même base ou le même serveur, et une remise à
// zéro ne s'exécute jamais là où la production est servie.
function identitesBase(a) {
  const ids = [];
  const c = coordonneesBase(a);
  if (texteDeclare(String(c.hote ?? ""))) {
    const port = Number(c.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`port illisible « ${c.port} »`);
    const h = String(c.hote).trim().toLowerCase();
    ids.push(`serveur ${BOUCLE_LOCALE.includes(h) ? "boucle-locale" : h}:${port}`);
  }
  if (texteDeclare(a.conteneur)) ids.push(`conteneur ${a.conteneur.trim().toLowerCase()}`);
  if (texteDeclare(a.project_ref)) ids.push(`projet Supabase ${a.project_ref.trim().toLowerCase()}`);
  return ids;
}

// Tout refus est journalisé à côté de la déclaration quand son dossier existe, puis sort avec son code.
// Un journal illisible n'efface jamais le refus : il se dit, et le code reste celui du refus.
function refuserBase(ctx, code, raison) {
  let trace = "refus NON journalisé : dossier de la déclaration introuvable";
  if (fs.existsSync(ctx.dossier)) {
    try {
      const e = journalAppend(ctx.dossier, "base_reinitialisation_refusee",
        { declaration: ctx.declaration, cible: ctx.nom, mode: ctx.mode, code, raison });
      trace = `refus journalisé (seq ${e.seq}, ${path.join(ctx.dossier, "journal.jsonl")})`;
    } catch (err) { trace = `refus NON journalisé : ${String(err.message).slice(0, 80)}`; }
  }
  console.error(`${code === 2 ? "[OPS HORS CONTRAT]" : "[OPS REFUS]"} reinitialiser-base « ${ctx.nom} » : ${raison}. Rien n'a été exécuté ; ${trace}.`);
  process.exit(code);
}

// Le démon que la CLI vise : DOCKER_HOST s'il est posé, sinon le contexte courant. Local = tube nommé,
// socket unix ou TCP sur la boucle locale.
function dockerLocal() {
  let hote = process.env.DOCKER_HOST;
  if (!hote) {
    const r = spawnSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { encoding: "utf8", timeout: 30000 });
    if (r.status !== 0) return { ok: false, raison: `démon Docker indéterminé (docker context inspect : ${r.error ? r.error.code : `exit ${r.status}`}) : l'exécution exige un Docker local joignable` };
    hote = r.stdout.trim();
  }
  const local = /^(npipe|unix):\/\//i.test(hote) || /^tcp:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/i.test(hote);
  return local ? { ok: true, hote } : { ok: false, raison: `démon Docker distant (${hote}) : --executer ne vise qu'un Docker local` };
}

// Le plan ordonné. Chaque étape porte ses actions : `argv` (commande construite par la forge, jouée sans
// shell) ou `shell` (commande déclarée par le produit, passée au shell du poste) ; le plan rendu n'en
// montre que l'affichage.
function planBase(doc, cible, ctx) {
  const a = cible.adresse, c = coordonneesBase(a), m = cible.moteur, tables = cible.verification.tables;
  const racine = path.resolve(ctx.dossier, texteDeclare(doc.racine) ? doc.racine.trim() : ".");
  const d = cible.donnees, distant = m === "supabase-distant";
  const etapeDonnees = { etape: "donnees", actions: [{ affichage: d.commande.trim(), shell: d.commande.trim() }],
    attendu: `exit 0 : données ${d.nature === "extrait" ? `extraites (source déclarée : ${d.source.trim()})` : "synthétiques"} chargées par la commande du produit${distant ? " ; sur un projet distant, sous le même GO humain que l'étape 1 (R-38)" : ""}` };
  let prealables, etapes, execution, placeholders = [];
  if (m === "postgres-docker") {
    const mig = cible.migrations;
    const psql = (base, ...options) => ["docker", "exec", a.conteneur.trim(), "psql", "-v", "ON_ERROR_STOP=1", "-U", c.utilisateur, "-d", base, ...options];
    const action = (argv) => ({ affichage: afficherArgv(argv), argv });
    prealables = [
      `conteneur ${a.conteneur.trim()} démarré sur le Docker LOCAL et publiant le port ${c.port} : contrôlé avant toute exécution (docker context inspect, docker inspect, docker port) ; la forge n'en crée aucun`,
      `commandes déclarées jouées depuis ${racine}, avec PGHOST=${c.hote} PGPORT=${c.port} PGDATABASE=${c.base} PGUSER=${c.utilisateur} de la cible (aucun mot de passe : il vient de l'environnement du run)`,
    ];
    etapes = [
      { etape: "vider", actions: [
        action(psql("postgres", "-c", `DROP DATABASE IF EXISTS "${c.base}" WITH (FORCE)`)),
        action(psql("postgres", "-c", `CREATE DATABASE "${c.base}"`)) ],
        attendu: `base ${c.base} supprimée puis recréée vide ; connexion à la base de maintenance postgres, car DROP DATABASE « cannot be executed while you are connected to the target database » ; FORCE : « Attempt to terminate all existing connections to the target database. » ; deux commandes, car « DROP DATABASE cannot be executed inside a transaction block » ; source : ${SOURCES_BASE.drop_database}` },
      { etape: "migrations", actions: [{ affichage: mig.commande.trim(), shell: mig.commande.trim() }],
        attendu: "exit 0 : toutes les migrations rejouées sur la base vide" },
      etapeDonnees,
      { etape: "verification", actions: [
        { affichage: mig.verification.trim(), shell: mig.verification.trim(), role: "migrations" },
        ...tables.map(t => ({ ...action(psql(c.base, "-t", "-A", "-c", `SELECT count(*) FROM ${t}`)), table: t })) ],
        attendu: `migrations à jour (exit 0 de la commande déclarée) ; comptes de lignes non nuls : ${tables.join(", ")}` },
    ];
    execution = "`--executer` joue ce plan sur le Docker local, après contrôle du démon (local), du conteneur (démarré) et du port déclaré (publié) ; sans `--executer`, rien ne s'exécute";
  } else {
    const portee = distant ? "--linked" : "--local";
    const url = distant ? "<URL_BASE_DISTANTE>" : "<URL_BASE_LOCALE>";
    placeholders = [url];
    prealables = distant ? [
      `supabase link --project-ref ${a.project_ref.trim()}   # « Link your local development project to a hosted Supabase project. » ; identité du run (jeton, mot de passe de la base) fournie par l'environnement, jamais dans ce plan ; source : ${SOURCES_BASE.link}`,
      `${url} : adresse de connexion de la base du projet ${a.project_ref.trim()}, fournie par l'environnement du run, jamais une valeur dans ce plan`,
    ] : [
      `supabase start   # « Starts the Supabase local development stack. » ; prérequis de db reset : « Requires the local development stack to be started by running \`supabase start\`. » ; la pile exige supabase/config.toml : « Requires \`supabase/config.toml\` to be created in your current working directory by running \`supabase init\`. » ; sources : ${SOURCES_BASE.start} ; ${SOURCES_BASE.db_reset}`,
      `supabase status   # « Shows status of the Supabase local development stack. » ; sa ligne « DB URL: postgresql://… » donne ${url}, l'adresse des comptes de l'étape 4 ; source : ${SOURCES_BASE.status}`,
    ];
    etapes = [
      { etape: "vider", actions: [{ affichage: `supabase db reset ${portee} --no-seed` }],
        attendu: distant
          ? `GESTE HUMAIN SOUS GO (R-38), jamais exécuté par la forge : « a SQL script is executed to identify and drop all user created entities in the remote database » ; « Resets the linked project with local migrations. » ; les rôles restent : « any custom roles created through the dashboard or \`supabase/roles.sql\` will not be deleted by remote reset. » ; --no-seed : les données sont l'étape 3 ; source : ${SOURCES_BASE.db_reset}`
          : `« Resets the local database to a clean state. » puis rejoue les migrations : « Resets the local database with local migrations. » ; --no-seed (« Skip running the seed script after reset. ») : les données sont l'étape 3, la commande du produit ; sans lui, supabase/seed.sql ou les sql_paths de [db.seed] seraient joués en plus : « Seed files are executed the first time you run \`supabase start\` and every time you run \`supabase db reset\`. » ; sources : ${SOURCES_BASE.db_reset} ; ${SOURCES_BASE.seed}` },
      { etape: "migrations", actions: [],
        attendu: `rejouées par l'étape 1 : supabase db reset applique les migrations du dossier supabase/migrations ; aucune commande de plus ; source : ${SOURCES_BASE.db_reset}` },
      etapeDonnees,
      { etape: "verification", actions: [
        { affichage: `supabase migration list ${portee}` },
        ...tables.map(t => ({ affichage: `psql "${url}" -t -A -c "SELECT count(*) FROM ${t}"`, table: t })) ],
        attendu: `migrations à jour : chaque migration de supabase/migrations figure aussi côté base (« Lists migrations applied to the ${distant ? "linked project" : "local database"}. » ; le tableau d'exemple de la page laisse vide la cellule d'une migration présente d'un seul côté) ; comptes de lignes non nuls : ${tables.join(", ")} ; source : ${SOURCES_BASE.migration_list}` },
    ];
    execution = distant
      ? "GESTE HUMAIN sous GO (R-38) : `--executer` est refusé (exit 2), la forge ne réinitialise jamais un projet Supabase distant"
      : "plan seulement dans ce lot : `--executer` est refusé (exit 2), les commandes se jouent dans la session du produit";
  }
  return {
    interne: { etapes, racine, coordonnees: c },
    doc: {
      format: "forge-ops/reinitialisation-base@1",
      verbe: "reinitialiser-base",
      declaration: ctx.declaration,
      produit: doc.produit ?? null,
      cible: cible.nom,
      environnement: cible.environnement,
      moteur: m,
      execution,
      garde_fous: [
        "environnement developpement ou qualification seulement : production ou non déclaré, refus exit 2, en plan comme en exécution",
        "la cible ne partage ni le serveur (hôte:port), ni le conteneur, ni le projet Supabase d'une cible production ou d'environnement non déclaré",
        "aucun credential dans la déclaration ni dans ce plan",
        "exécution sur `--executer` seulement, cible postgres-docker d'un Docker local ; chaque geste exécuté ou refusé est journalisé",
      ],
      placeholders,
      prealables,
      etapes: etapes.map((e, i) => ({ ordre: i + 1, etape: e.etape, commandes: e.actions.map(x => x.affichage), attendu: e.attendu })),
      non_juge: NON_JUGE_BASE,
    },
  };
}

// L'exécution : étapes dans l'ordre, chacune journalisée ; une étape de construction s'arrête au premier
// échec ; la vérification compte TOUTES les tables avant de conclure.
function executerBase(ctx, cible, p) {
  const { etapes, racine, coordonnees: c } = p.interne;
  if (!fs.existsSync(racine)) refuserBase(ctx, 1, `racine des commandes déclarées introuvable : ${racine}`);
  const env = { ...process.env, PGHOST: String(c.hote), PGPORT: String(c.port), PGDATABASE: c.base, PGUSER: c.utilisateur };
  const jouer = (x) => x.argv
    ? spawnSync(x.argv[0], x.argv.slice(1), { encoding: "utf8", timeout: DELAI_COMMANDE_BASE_MS })
    : spawnSync(x.shell, { shell: true, cwd: racine, env, encoding: "utf8", timeout: DELAI_COMMANDE_BASE_MS });
  const extrait = (r) => (r.error ? r.error.message : String(r.stderr || r.stdout || "").trim()).slice(0, 200);
  const debut = Date.now(), comptes = {};
  let detruite = false;
  for (const [i, e] of etapes.entries()) {
    const t0 = Date.now(), ecarts = [];
    for (const x of e.actions) {
      const r = jouer(x);
      if (x.table) {
        const sortie = String(r.stdout || "").trim(), n = Number(sortie);
        comptes[x.table] = r.status === 0 && sortie !== "" && Number.isInteger(n) ? n : null;
        if (r.status !== 0) ecarts.push(`table ${x.table} : compte impossible (exit ${r.status ?? r.signal}) — ${extrait(r)}`);
        else if (comptes[x.table] === null) ecarts.push(`table ${x.table} : compte illisible (« ${sortie.slice(0, 40)} »)`);
        else if (n === 0) ecarts.push(`table ${x.table} : 0 ligne, les données ne sont pas chargées sur la cible déclarée`);
        continue;
      }
      if (r.status === 0) { if (e.etape === "vider") detruite = true; continue; }
      ecarts.push(`${x.role === "migrations" ? "migrations en retard ou état illisible" : "commande en échec"} (exit ${r.status ?? r.signal}) : ${x.affichage} — ${extrait(r)}`);
      if (e.etape !== "verification") break;
    }
    const duree_ms = Date.now() - t0;
    journalAppend(ctx.dossier, "base_reinitialisation_etape", { declaration: ctx.declaration, cible: ctx.nom, ordre: i + 1, etape: e.etape,
      verdict: ecarts.length ? "echec" : "ok", duree_ms, commandes: e.actions.map(x => x.affichage),
      ...(e.etape === "verification" ? { comptes } : {}), ...(ecarts.length ? { ecarts } : {}) });
    console.log(`  [BASE ${ecarts.length ? "STOP" : "OK"}] ${i + 1}/${etapes.length} ${e.etape} — ${(duree_ms / 1000).toFixed(1)} s${ecarts.length ? ` — ${ecarts.join(" ; ")}` : ""}`);
    if (ecarts.length) {
      journalAppend(ctx.dossier, "base_reinitialisation_echec", { declaration: ctx.declaration, cible: ctx.nom, etape: e.etape, raison: ecarts.join(" ; ") });
      fail(`reinitialiser-base « ${ctx.nom} » : échec à l'étape ${e.etape} — ${ecarts.join(" ; ")}`
        + (detruite ? ". La base a été supprimée : elle reste absente, vide ou partielle jusqu'au prochain passage réussi" : ""));
    }
  }
  const fin = journalAppend(ctx.dossier, "base_reinitialisation", { declaration: ctx.declaration, cible: ctx.nom,
    environnement: cible.environnement, moteur: cible.moteur, comptes, duree_ms: Date.now() - debut });
  console.log(`[OPS OK] base « ${ctx.nom} » réinitialisée (${cible.environnement}, ${cible.moteur}) : migrations à jour ; `
    + `${Object.entries(comptes).map(([t, n]) => `${t}=${n}`).join(", ")} — journal seq ${fin.seq}`);
}

function reinitialiserBase(declaration, nom, executer, sortie) {
  const ctx = { declaration, dossier: path.dirname(declaration), nom, mode: executer ? "execution" : "plan" };
  const horsContratBase = (raison) => refuserBase(ctx, 2, raison);
  const refusBase = (raison) => refuserBase(ctx, 1, raison);

  // 1. La déclaration : lisible, au format, sans secret.
  if (!fs.existsSync(declaration)) horsContratBase(`déclaration introuvable (${declaration}) : une cible non déclarée ne se réinitialise pas`);
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(declaration, "utf8").replace(/^﻿/, "")); }
  catch { horsContratBase(`déclaration illisible (JSON invalide), attendu le format ${FORMAT_BASES}`); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || doc.format !== FORMAT_BASES)
    horsContratBase(`format inconnu « ${doc?.format} » (attendu ${FORMAT_BASES})`);
  const secrets = [...new Set(secretsDeclares(doc))];
  if (secrets.length) horsContratBase(`mot de passe en clair dans la déclaration (${secrets.join(", ")}) : aucun credential ne transite par la forge — retirer le mot de passe, il vient de l'environnement du run`);
  const bases = (Array.isArray(doc.bases) ? doc.bases : []).filter(b => b && typeof b === "object");

  // 2. La cible : déclarée une fois, et jamais en production.
  const homonymes = bases.filter(b => b.nom === nom);
  if (!homonymes.length) horsContratBase(`cible non déclarée : aucune entrée « ${nom} » dans bases[] (déclarées : ${bases.map(b => b.nom).filter(Boolean).join(", ") || "aucune"})`);
  if (homonymes.length > 1) horsContratBase(`cible « ${nom} » déclarée ${homonymes.length} fois : laquelle viser n'est pas dit`);
  const cible = homonymes[0];
  const env = cible.environnement;
  if (!texteDeclare(env)) horsContratBase("environnement non déclaré — déclarer `environnement` : developpement | qualification ; une base dont l'environnement n'est pas dit est traitée comme la production");
  if (!ENVIRONNEMENTS_BASE.includes(env)) horsContratBase(`environnement « ${env} » hors vocabulaire (developpement | qualification | production) : traité comme la production`);
  if (env === "production") horsContratBase("environnement production : une base de production ne se vide jamais par la forge, ni en plan ni en exécution ; sa remise en état passe par la restauration de ses sauvegardes (O-19), geste humain");

  // 3. L'adresse : la production est déclarée (ou écartée par un motif), et la cible ne partage rien avec
  // elle. Une entrée d'environnement non déclaré ou hors vocabulaire est gardée comme la production.
  const productions = bases.filter(b => b.environnement === "production");
  if (!productions.length && String(doc.aucune_production ?? "").trim().length < 10)
    horsContratBase("aucune cible production déclarée : le garde-fou d'adresse n'a rien à comparer — déclarer la production dans bases[] (son adresse suffit) ou `aucune_production: \"<motif>\"` ; le silence n'est pas une réponse");
  const a = cible.adresse;
  if (!a || typeof a !== "object" || Array.isArray(a)) horsContratBase("adresse non déclarée : rien ne prouve que la cible n'est pas la production");
  let ids = [];
  try { ids = identitesBase(a); } catch (err) { horsContratBase(`adresse illisible (${err.message})`); }
  if (!ids.length) horsContratBase("adresse sans identité comparable (ni hote ou url, ni conteneur, ni project_ref) : rien ne prouve que la cible n'est pas la production");
  for (const g of bases.filter(b => b !== cible && !["developpement", "qualification"].includes(b.environnement))) {
    const qualite = g.environnement === "production" ? "environnement production" : "environnement non déclaré, traité comme la production";
    const nomG = texteDeclare(g.nom) ? g.nom : "(base sans nom)";
    let idsG = [];
    try { idsG = identitesBase(g.adresse && typeof g.adresse === "object" ? g.adresse : {}); }
    catch (err) { horsContratBase(`adresse illisible pour « ${nomG} » (${qualite}) : ${err.message}`); }
    if (!idsG.length) horsContratBase(`« ${nomG} » (${qualite}) n'a pas d'adresse comparable : le garde-fou ne peut pas prouver que « ${nom} » n'est pas elle`);
    const commune = ids.find(i => idsG.includes(i));
    if (commune) horsContratBase(`même ${commune} que « ${nomG} » (${qualite}) : une remise à zéro ne s'exécute jamais là où la production est servie — déclarer une base de ${env} sur un autre serveur`);
  }

  // 4. Le moteur, puis la complétude de ce que le plan joue.
  const m = cible.moteur;
  if (!MOTEURS_BASE.includes(m)) horsContratBase(`moteur « ${m} » hors vocabulaire (${MOTEURS_BASE.join(" | ")})`);
  const c = coordonneesBase(a), manques = [];
  if (m === "postgres-docker") {
    if (!texteDeclare(String(c.hote ?? ""))) manques.push("adresse.hote (ou adresse.url)");
    if (!texteDeclare(a.conteneur)) manques.push("adresse.conteneur");
    if (!texteDeclare(c.base)) manques.push("adresse.base");
    if (!texteDeclare(c.utilisateur)) manques.push("adresse.utilisateur");
    if (!texteDeclare(cible.migrations?.commande)) manques.push("migrations.commande");
    if (!texteDeclare(cible.migrations?.verification)) manques.push("migrations.verification (commande dont l'exit 0 atteste les migrations à jour)");
  }
  if (m === "supabase-distant" && !texteDeclare(a.project_ref)) manques.push("adresse.project_ref");
  if (!texteDeclare(cible.donnees?.commande)) manques.push("donnees.commande");
  if (!NATURES_DONNEES.includes(cible.donnees?.nature)) manques.push("donnees.nature (synthetique | extrait)");
  if (cible.donnees?.nature === "extrait" && !texteDeclare(cible.donnees?.source)) manques.push("donnees.source (d'où vient l'extrait)");
  const tables = cible.verification?.tables;
  if (!Array.isArray(tables) || !tables.length) manques.push("verification.tables (au moins une table au compte de lignes non nul)");
  if (manques.length) refusBase(`déclaration incomplète — compléter : ${manques.join(", ")}`);
  // La base entre dans le SQL de `vider` et les tables dans celui des comptes : identifiants simples
  // seulement. L'utilisateur ne passe que par `-U` et PGUSER, jamais par le SQL : il n'est pas contraint.
  const malformes = [
    ...(m === "postgres-docker" && !IDENTIFIANT_SQL.test(String(c.base)) ? [["adresse.base", c.base]] : []),
    ...tables.map((t, i) => [`verification.tables[${i}]`, t]).filter(([, t]) => typeof t !== "string" || !TABLE_SQL.test(t)),
  ];
  if (malformes.length) refusBase(`identifiant non conforme, nom SQL simple attendu (schema.table admis pour une table) : ${malformes.map(([k, v]) => `${k} « ${v} »`).join(", ")}`);
  if (m === "postgres-docker" && BASES_SYSTEME.includes(c.base.toLowerCase()))
    horsContratBase(`base « ${c.base} » : base de maintenance ou modèle de PostgreSQL, que vider supprimerait depuis elle-même — déclarer une base dédiée`);

  // 5. Le plan : rendu par défaut ; écrit dans `--sortie` en plan comme avant une exécution.
  const p = planBase(doc, cible, ctx);
  const json = JSON.stringify(p.doc, null, 2);
  if (sortie) { fs.writeFileSync(sortie, json + "\n", "utf8"); console.log(`[OPS OK] plan de réinitialisation « ${nom} » écrit : ${sortie}`); }
  if (!executer) { if (!sortie) console.log(json); return; }

  // 6. L'exécution : postgres-docker sur un Docker local seulement.
  if (m === "supabase-local") horsContratBase("Supabase local : plan seulement dans ce lot — ses commandes se jouent dans la session du produit");
  if (m === "supabase-distant") horsContratBase("projet Supabase distant : sa remise à zéro est un geste humain sous GO (R-38), jamais exécuté par la forge — le plan donne la commande");
  if (!BOUCLE_LOCALE.includes(String(c.hote).trim().toLowerCase()))
    horsContratBase(`hôte « ${c.hote} » non local : --executer ne vise qu'une base du poste (127.0.0.1, localhost ou ::1) ; ailleurs, le plan seulement`);
  const dk = dockerLocal();
  if (!dk.ok) horsContratBase(dk.raison);
  const conteneur = a.conteneur.trim();
  const etat = spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", conteneur], { encoding: "utf8", timeout: 30000 });
  if (etat.status !== 0 || String(etat.stdout).trim() !== "true")
    horsContratBase(`conteneur « ${conteneur} » absent ou arrêté sur le Docker local (${dk.hote}) : la forge n'exécute que sur un conteneur déclaré et démarré, elle n'en crée aucun`);
  const pub = spawnSync("docker", ["port", conteneur], { encoding: "utf8", timeout: 30000 });
  const ports = [...String(pub.stdout || "").matchAll(/->\s*\S*:(\d+)\s*$/gm)].map(x => Number(x[1]));
  if (!ports.includes(Number(c.port)))
    horsContratBase(`le conteneur « ${conteneur} » ne publie pas le port déclaré ${c.port} (publiés : ${ports.join(", ") || "aucun"}) : l'adresse déclarée et le conteneur ne désignent pas la même base`);
  executerBase(ctx, cible, p);
}

const argv = process.argv.slice(2);
const iSortie = argv.indexOf("--sortie");
const sortieOpt = iSortie >= 0 ? argv[iSortie + 1] : null;
if (iSortie >= 0) argv.splice(iSortie, 2);
const iSeuils = argv.indexOf("--seuils");
const fichierSeuils = iSeuils >= 0 ? argv[iSeuils + 1] : null;
if (iSeuils >= 0) argv.splice(iSeuils, 2);
// TF-2013 : `--executer` est le seul drapeau qui fait agir reinitialiser-base ; sans lui, le plan.
const iExecuter = argv.indexOf("--executer");
const executerOpt = iExecuter >= 0;
if (iExecuter >= 0) argv.splice(iExecuter, 1);
const [verbe, a, b] = argv;
// TF-0245 : tout chemin reçu est résolu en absolu ICI, une seule fois — jamais de
// rustine en aval. healthcheck et mesurerPalier s'exécutent avec cwd=releaseDir : un
// chemin resté relatif serait résolu par node contre ce NOUVEAU cwd (module introuvable,
// refus à tort journalisé deploiement_refuse). Constaté aussi en amont : fs.cpSync
// échoue en relatif (EIO, node 25 / Windows). Exception : la cible de `plan` est un nom
// de plateforme (railway, gcp…), pas un chemin, et son build reste textuel — le plan
// s'exécute dans un autre environnement. De même, la cible de `reinitialiser-base` est un
// nom de la déclaration, pas un chemin.
const abs = p => (p ? path.resolve(p) : p);
if (verbe === "deployer") { if (!b) fail("usage : deployer <build> <cible>"); deployer(abs(a), abs(b)); }
else if (verbe === "restaurer") { if (!a) fail("usage : restaurer <cible>"); restaurer(abs(a)); }
else if (verbe === "etat") { if (!a) fail("usage : etat <cible> [--sortie fichier.json]"); etat(abs(a), abs(sortieOpt)); }
else if (verbe === "plan") { if (!b) fail("usage : plan <cible> <build> [--sortie plan.json]"); plan(a, b, abs(sortieOpt)); }
else if (verbe === "canary") { if (!b) fail("usage : canary <build> <cible> [--seuils fichier.json]"); canary(abs(a), abs(b), abs(fichierSeuils)); }
else if (verbe === "reinitialiser-base") { if (!b) fail("usage : reinitialiser-base <declaration.json> <cible> [--executer] [--sortie plan.json]"); reinitialiserBase(abs(a), b, executerOpt, abs(sortieOpt)); }
else fail("verbe inconnu — deployer | restaurer | etat | plan | canary | reinitialiser-base");

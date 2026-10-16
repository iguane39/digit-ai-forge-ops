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
// Hors contrat : une cible conteneur Docker (restaurer sort en exit 2 avec le geste manuel, TF-1805).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { hacherFichier } from "./lib-empreinte.mjs";

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
PLANS.supabase = {
  service: "Supabase — projet heberge (base Postgres, migrations, fonctions)",
  fiche: "experts-forge/fiches/expert-ops-supabase.md",
  placeholders: ["<PROJECT_REF>", "<NOM_CORRECTIF>", "<URL_SERVICE>"],
  provision: [
    "identite de deploiement : variables SUPABASE_ACCESS_TOKEN (jeton personnel a portee limitee), SUPABASE_DB_PASSWORD et SUPABASE_PROJECT_ID fournies par l'environnement du run, jamais une valeur dans le plan ; source : https://supabase.com/docs/guides/deployment/managing-environments, lue le 16/10/2026",
    "supabase link --project-ref <PROJECT_REF>   # liaison au projet distant <PROJECT_REF> ; source : https://supabase.com/docs/reference/cli/introduction, lue le 16/10/2026",
    "supabase ssl-enforcement get --project-ref <PROJECT_REF> --experimental   # attendu « SSL is being enforced. » ; « SSL is *NOT* being enforced. » = ecart a traiter (l'activation redemarre la base) ; source : https://supabase.com/docs/guides/platform/ssl-enforcement, lue le 16/10/2026",
    "supabase network-restrictions get --project-ref <PROJECT_REF> --experimental   # 0.0.0.0/0 + ::/0 = aucune restriction ; couvre Postgres et le pooler, PAS les API HTTPS (PostgREST, Storage, Auth) ; source : https://supabase.com/docs/guides/platform/network-restrictions, lue le 16/10/2026",
  ],
  deploiement: [
    "supabase db push --dry-run --linked   # essai a blanc (--dry-run), sa sortie relue avant le GO",
    "supabase db push --linked   # applique les migrations au projet distant : publication sur un service heberge, GO humain consigne au dossier de MEP (R-38) ; source : https://supabase.com/docs/reference/cli/introduction, lue le 16/10/2026",
    "supabase functions deploy --project-ref <PROJECT_REF>   # publication des fonctions, sous le meme GO humain (R-38)",
  ],
  healthcheck: [
    "supabase migration list --linked   # health : etat des migrations du projet lie, relu apres le push",
    "curl -fsS <URL_SERVICE>/sante   # 200 attendu (contrat sante.mjs de forge-ops) ; <URL_SERVICE> = le produit servi, aucune URL Supabase supposee",
  ],
  rollback: [
    "la documentation ne decrit AUCUNE migration « down » : le retour arriere d'un schema est une migration CORRECTIVE vers l'avant ; source : https://supabase.com/docs/guides/deployment/managing-environments, lue le 16/10/2026",
    "supabase migration new <NOM_CORRECTIF>   # ecrire le correctif qui defait la migration fautive, versionne avec le produit",
    "supabase db push --dry-run --linked && supabase db push --linked   # pousser le correctif, sous GO humain (R-38)",
    "supabase migration list --linked   # re-verification apres retour",
    "DERNIER RECOURS, GESTE HUMAIN IRREVERSIBLE : restauration d'une sauvegarde ou PITR par le tableau de bord (Database > Backups) ou l'API de gestion `POST https://api.supabase.com/v1/projects/<PROJECT_REF>/database/backups/restore-pitr` — aucune commande CLI de restauration ; projet INACCESSIBLE pendant l'operation, tout ce qui suit le point choisi est PERDU ; sauvegardes quotidiennes Pro 7 j, Team 14, Enterprise jusqu'a 30, Free aucune (export par `supabase db dump`) ; PITR = add-on Pro/Team/Enterprise ; jamais lance par la forge ; source : https://supabase.com/docs/guides/platform/backups, lue le 16/10/2026",
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

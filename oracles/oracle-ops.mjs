#!/usr/bin/env node
// oracle-ops — Domaine « Exploitation : cible déployée saine et restaurable » (déterministe).
// Quatre règles O1-O4 sur une CIBLE d'exploitation réelle (jamais sur le code générateur) :
//   O1  COURANT existe et pointe une release présente sur disque ;
//   O2  la release courante repasse son healthcheck (exécution réelle de sante.mjs) ;
//   O3  journal.jsonl intègre : JSON valide, seq strictement croissant depuis 1, types connus ;
//   O4  rollback prouvable : s'il existe une release antérieure à la courante, elle est
//       toujours présente (capacité de restauration réelle) ET le dernier événement du
//       journal désigne la release courante (cohérence pointeur ↔ histoire).
//   O5  --plan <fichier>       : plan cloud complet (TF-0081, cf. plus bas).
//   O6  --drift <fichier> <cible> : état déclaré (`ops.mjs etat --sortie`) vs constaté
//       maintenant — troncature/réécriture du journal, déploiement furtif (TF-0107).
//   O7  --empreinte <cible> : fichiers de la release COURANTE vs empreinte scellée par
//       `ops.mjs deployer` OU `ops.mjs canary` (TF-0298, sha256 par fichier) — fichier
//       modifié/supprimé/ajouté en place après coup ; SKIP motivé si aucune empreinte
//       (déploiement antérieur au contrôle ou passé hors ops.mjs) (TF-0288).
//   R   --verdict-rollback <mesures> --seuils <fichier> : RECOMMANDATION seule (pas un
//       oracle de conformité) — seuils SLO humains vs mesures post-bascule (TF-0107).
// Contrat : JSON {oracle,domaine,artefact,verdict,findings,non_juge} · exit 0/1/2.
// Usage : node oracle-ops.mjs <cible> [--json-only]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const DOM = "Exploitation : cible déployée saine et restaurable";
const NON_JUGE = [
  "santé applicative au-delà du healthcheck déclaré par la release (parcours réels, charge)",
  "GO de mise en production — décision humaine, jamais un verdict d'oracle",
  "supervision continue / alerting (hors périmètre v0)",
  "secrets et configuration d'environnement — jamais transportés par la forge",
];
const TYPES = ["deploiement", "deploiement_refuse", "restauration", "canary_etape", "canary_promotion", "canary_annulation"];

const args = process.argv.slice(2);
// TF-0281 (propagation de TF-0245) : la cible est résolue en absolu ICI, une seule fois.
// O2 exécute sante.mjs avec cwd=releaseDir : une cible restée relative rend le chemin du
// script relatif lui aussi, résolu par node contre ce NOUVEAU cwd — chemin doublé,
// « Cannot find module », exit 1 rapporté comme « healthcheck en échec » : un faux échec
// sur une release saine. Les autres chemins d'argument (--plan, --drift, --seuils,
// --verdict-rollback) ne sont lus que par fs depuis le cwd du process, jamais sous un cwd
// changé : ils restent tels quels, pas de rustine par usage.
const cibleArg = args.find(a => !a.startsWith("--"));
const cible = cibleArg ? path.resolve(cibleArg) : cibleArg;
const jsonOnly = args.includes("--json-only");
const iPlan = args.indexOf("--plan");
const planPath = iPlan >= 0 ? args[iPlan + 1] : null;
const F = [];
const add = (sev, regle, msg, where) => F.push({ sev, regle, msg, where });

// ── O5 · mode plan : un plan cloud est complet et cohérent (TF-0081) ────────
// Vérifie un fichier produit par `ops.mjs plan` : 4 phases non vides, rollback réel,
// commandes cohérentes avec la CLI de la cible, aucun credential en clair.
if (planPath) {
  const DOM5 = "Exploitation : plan de déploiement cloud complet (O-5)";
  const NJ5 = [
    "exécution réelle du plan (run MEP, environnement authentifié fourni par l'humain, GO humain)",
    "validité des valeurs substituées aux placeholders <...> au moment du run",
    "coûts réels de la cible — ordres de grandeur documentés par la fiche expert",
  ];
  const fin5 = (verdict, code) => {
    process.stdout.write(JSON.stringify({ oracle: "oracle-ops", domaine: DOM5, artefact: planPath, verdict, findings: F.length ? F : [{ sev: "info", regle: "O5", msg: "plan complet — 4 phases, rollback présent, CLI cohérente", where: planPath }], non_juge: NJ5 }, null, jsonOnly ? 0 : 2));
    process.exit(code);
  };
  if (!fs.existsSync(planPath)) { add("info", "O5", "plan introuvable", String(planPath)); fin5("SKIP", 2); }
  let p = null;
  try { p = JSON.parse(fs.readFileSync(planPath, "utf8")); } catch { add("bloquant", "O5", "JSON invalide", planPath); fin5("FAIL", 1); }
  const CLI = { railway: "railway", gcp: "gcloud", azure: "az ", aws: "aws " };
  if (p.format !== "forge-ops/plan@1") add("bloquant", "O5", `format inconnu « ${p.format} » (attendu forge-ops/plan@1)`, planPath);
  if (!CLI[p.cible]) add("bloquant", "O5", `cible inconnue « ${p.cible} »`, planPath);
  for (const ph of ["provision", "deploiement", "healthcheck", "rollback"]) {
    const l = p.phases?.[ph];
    if (!Array.isArray(l) || l.length === 0)
      add("bloquant", "O5", `phase « ${ph} » absente ou vide — un plan sans ${ph === "rollback" ? "retour arrière n'est pas un plan MEP" : "cette phase est incomplet"}`, planPath);
  }
  if (CLI[p.cible] && Array.isArray(p.phases?.deploiement) && !p.phases.deploiement.some(c => String(c).includes(CLI[p.cible])))
    add("bloquant", "O5", `aucune commande de déploiement n'utilise la CLI attendue « ${CLI[p.cible].trim()} » pour la cible ${p.cible}`, planPath);
  if (Array.isArray(p.phases?.healthcheck) && !p.phases.healthcheck.some(c => /sante|health/i.test(String(c))))
    add("majeur", "O5", "la phase healthcheck ne référence aucun contrôle de santé (/sante attendu)", planPath);
  const brut = JSON.stringify(p);
  if (/AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|sk-[a-zA-Z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY/.test(brut))
    add("bloquant", "O5", "motif de credential détecté dans le plan — un plan ne transporte jamais de secret", planPath);
  const durs5 = F.filter(f => f.sev === "bloquant" || f.sev === "majeur");
  fin5(durs5.length ? "FAIL" : "PASS", durs5.length ? 1 : 0);
}

// ── O6 · dérive état déclaré ↔ état constaté (TF-0107) ──────────────────────────────
// Compare un instantané DÉCLARÉ (produit par `ops.mjs etat <cible> --sortie fichier.json`,
// hash du journal inclus) à l'état RÉEL de la cible maintenant. Comble un angle mort d'O1-O4
// (self-cohérence interne du journal courant, jamais vérifiée contre un témoin extérieur) :
//   - journal tronqué/purgé après la déclaration (moins d'événements que déclaré) ;
//   - historique réécrit en conservant seq/types valides (hash du segment déclaré altéré) ;
//   - déploiement furtif : release présente sur disque, absente de tout événement journal.
// La correction de la dérive n'est jamais automatique — c'est un constat, pas un geste.
const iDrift = args.indexOf("--drift");
const driftPath = iDrift >= 0 ? args[iDrift + 1] : null;
if (driftPath) {
  const DOM6 = "Exploitation : dérive entre état déclaré et état constaté (O-6)";
  const NJ6 = [
    "cause du changement manuel (accès disque direct, script tiers...) — hors périmètre",
    "état déclaré issu d'un plan cloud jamais exécuté réellement — O-6 juge une cible réelle",
    "correction de la dérive — un constat, jamais un geste automatique",
  ];
  const fin6 = (verdict, code) => {
    process.stdout.write(JSON.stringify({ oracle: "oracle-ops", domaine: DOM6, artefact: cible || null, verdict, findings: F.length ? F : [{ sev: "info", regle: "O6", msg: "aucune dérive : état constaté conforme à l'état déclaré", where: cible }], non_juge: NJ6 }, null, jsonOnly ? 0 : 2));
    process.exit(code);
  };
  if (!cible || !fs.existsSync(cible)) { add("info", "O6", "cible introuvable", String(cible)); fin6("SKIP", 2); }
  if (!fs.existsSync(driftPath)) { add("bloquant", "O6", "état déclaré introuvable", driftPath); fin6("FAIL", 1); }
  let declare = null;
  try { declare = JSON.parse(fs.readFileSync(driftPath, "utf8")); } catch { add("bloquant", "O6", "état déclaré illisible (JSON invalide)", driftPath); fin6("FAIL", 1); }

  const jp6 = path.join(cible, "journal.jsonl");
  const contenuNow = fs.existsSync(jp6) ? fs.readFileSync(jp6, "utf8") : "";
  const lignesNow = contenuNow.split("\n").filter(Boolean);
  const declEven = declare.evenements ?? 0;

  if (lignesNow.length < declEven) {
    add("bloquant", "O6", `journal régressé : ${lignesNow.length} événement(s) constaté(s) contre ${declEven} déclaré(s) — troncature ou purge`, "journal.jsonl");
  } else if (declare.journal_sha256) {
    const prefixe = declEven ? lignesNow.slice(0, declEven).join("\n") + "\n" : "";
    if (createHash("sha256").update(prefixe).digest("hex") !== declare.journal_sha256)
      add("bloquant", "O6", "historique du journal modifié après la déclaration (segment déclaré altéré)", "journal.jsonl");
  }

  const releasesDisque = fs.existsSync(path.join(cible, "releases")) ? fs.readdirSync(path.join(cible, "releases")) : [];
  const releasesJournalisees = new Set(lignesNow.map(l => { try { return JSON.parse(l).release; } catch { return null; } }).filter(Boolean));
  for (const r of releasesDisque)
    if (!releasesJournalisees.has(r))
      add("majeur", "O6", `release « ${r} » présente sur disque mais absente de tout le journal — déploiement furtif (hors ops.mjs)`, "releases/" + r);

  const durs6 = F.filter(f => f.sev === "bloquant" || f.sev === "majeur");
  fin6(durs6.length ? "FAIL" : "PASS", durs6.length ? 1 : 0);
}

// ── O7 · empreinte de déploiement : le servi correspond au scellé (TF-0288, étendu TF-0298) ─
// Compare les fichiers de la release COURANTE, maintenant, à l'empreinte scellée par
// `ops.mjs deployer` OU `ops.mjs canary` au moment de la promotion (`empreintes/<release>.json`,
// sha256 par fichier). Comble le volet PRÉVENTION resté ouvert par O-6 (qui juge le journal,
// jamais le CONTENU d'une release déjà journalisée) : un fichier édité en place dans
// releases/<release>/ après coup — sans nouveau déploiement, sans trace au journal — est
// invisible à O1-O4 et à O-6, visible ici. SKIP (jamais FAIL rétroactif) si la release
// n'a pas d'empreinte : déploiement antérieur au contrôle, ou passé hors `ops.mjs` (les deux
// voies de promotion scellent désormais — TF-0298 a fermé le trou canary déclaré par TF-0288).
if (args.includes("--empreinte")) {
  const DOM7 = "Exploitation : empreinte de déploiement — servi conforme au scellé (O-7)";
  const NJ7 = [
    "déploiement passé hors `ops.mjs` (deployer et canary scellent tous deux — TF-0298) — aucune empreinte n'y est scellée",
    "cause de la modification en place (accès disque direct, script tiers...) — hors périmètre",
    "correction de l'écart — un constat, jamais un geste automatique",
  ];
  const fin7 = (verdict, code) => {
    process.stdout.write(JSON.stringify({ oracle: "oracle-ops", domaine: DOM7, artefact: cible || null, verdict, findings: F.length ? F : [{ sev: "info", regle: "O7", msg: "aucune dérive : fichiers de la release conformes à l'empreinte scellée", where: cible }], non_juge: NJ7 }, null, jsonOnly ? 0 : 2));
    process.exit(code);
  };
  if (!cible || !fs.existsSync(cible)) { add("info", "O7", "cible introuvable", String(cible)); fin7("SKIP", 2); }
  const cp7 = path.join(cible, "COURANT");
  const courant7 = fs.existsSync(cp7) ? fs.readFileSync(cp7, "utf8").trim() : null;
  if (!courant7) { add("info", "O7", "aucun COURANT — rien à comparer", "COURANT"); fin7("SKIP", 2); }
  const releaseDir7 = path.join(cible, "releases", courant7);
  if (!fs.existsSync(releaseDir7)) { add("bloquant", "O7", `COURANT pointe une release inexistante : ${courant7}`, "COURANT"); fin7("FAIL", 1); }
  const empreintePath = path.join(cible, "empreintes", `${courant7}.json`);
  if (!fs.existsSync(empreintePath)) {
    add("info", "O7", `aucune empreinte scellée pour la release ${courant7} — déploiement antérieur au contrôle ou passé hors ops.mjs (deployer/canary)`, empreintePath);
    fin7("SKIP", 2);
  }
  let empreinte = null;
  try { empreinte = JSON.parse(fs.readFileSync(empreintePath, "utf8")); }
  catch { add("bloquant", "O7", "empreinte illisible (JSON invalide)", empreintePath); fin7("FAIL", 1); }
  const attendus = empreinte.fichiers || {};
  const surDisque = new Set();
  (function lister(dir, base) {
    for (const nom of fs.readdirSync(dir)) {
      const p = path.join(dir, nom);
      if (fs.statSync(p).isDirectory()) lister(p, base);
      else surDisque.add(path.relative(base, p).split(path.sep).join("/"));
    }
  })(releaseDir7, releaseDir7);
  for (const [rel, hachAttendu] of Object.entries(attendus)) {
    const p = path.join(releaseDir7, rel);
    if (!fs.existsSync(p)) { add("bloquant", "O7", `fichier supprimé après scellement : ${rel}`, rel); continue; }
    const hachActuel = createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    if (hachActuel !== hachAttendu) add("bloquant", "O7", `fichier modifié après scellement : ${rel} (haché actuel ≠ empreinte)`, rel);
  }
  for (const rel of surDisque)
    if (!(rel in attendus)) add("majeur", "O7", `fichier présent mais absent de l'empreinte scellée : ${rel}`, rel);
  const durs7 = F.filter(f => f.sev === "bloquant" || f.sev === "majeur");
  fin7(durs7.length ? "FAIL" : "PASS", durs7.length ? 1 : 0);
}

// ── Verdict « rollback recommandé » · seuils SLO fixés par l'humain (TF-0107) ───────
// RECOMMANDATION SEULE : compare des mesures post-bascule à des seuils que l'humain a
// figés dans un fichier de config (latence, taux d'erreur, fenêtre minimale) — aucun défaut
// implicite (fichier de seuils obligatoire), jamais d'exécution. Doctrine « ops outille, ne
// décide jamais » : la bascule arrière reste un geste humain via `ops.mjs restaurer`.
const iVR = args.indexOf("--verdict-rollback");
const mesuresPath = iVR >= 0 ? args[iVR + 1] : null;
const iSeuilsSlo = args.indexOf("--seuils");
const seuilsSloPath = iSeuilsSlo >= 0 ? args[iSeuilsSlo + 1] : null;
if (mesuresPath) {
  const DOMR = "Exploitation : recommandation de rollback post-bascule (seuils SLO humains)";
  const NJR = [
    "exécution du rollback — geste humain via `ops.mjs restaurer`, jamais automatique",
    "le choix des seuils — responsabilité humaine ; l'oracle ne fixe ni ne devine de défaut",
    "cause racine de la dégradation observée",
  ];
  const finR = (verdict, code, extra = {}) => {
    process.stdout.write(JSON.stringify({ oracle: "oracle-ops", domaine: DOMR, artefact: mesuresPath, verdict, ...extra, findings: F.length ? F : [{ sev: "info", regle: "R", msg: "mesures sous les seuils — aucune dérive", where: mesuresPath }], non_juge: NJR }, null, jsonOnly ? 0 : 2));
    process.exit(code);
  };
  if (!seuilsSloPath || !fs.existsSync(seuilsSloPath)) { add("bloquant", "R", "fichier de seuils SLO introuvable — seuils obligatoirement humains, aucun défaut implicite", String(seuilsSloPath)); finR("donnees_insuffisantes", 2); }
  if (!fs.existsSync(mesuresPath)) { add("bloquant", "R", "fichier de mesures introuvable", mesuresPath); finR("donnees_insuffisantes", 2); }
  let mesures = null, seuilsSlo = null;
  try { mesures = JSON.parse(fs.readFileSync(mesuresPath, "utf8")); } catch { add("bloquant", "R", "mesures illisibles (JSON invalide)", mesuresPath); finR("donnees_insuffisantes", 2); }
  try { seuilsSlo = JSON.parse(fs.readFileSync(seuilsSloPath, "utf8")); } catch { add("bloquant", "R", "seuils illisibles (JSON invalide)", seuilsSloPath); finR("donnees_insuffisantes", 2); }
  if (!Array.isArray(mesures) || !mesures.length) { add("bloquant", "R", "mesures vides", mesuresPath); finR("donnees_insuffisantes", 2); }
  const requis = typeof seuilsSlo.fenetre_min_echantillons === "number" ? seuilsSlo.fenetre_min_echantillons : 1;
  if (mesures.length < requis) { add("info", "R", `fenêtre insuffisante : ${mesures.length}/${requis} échantillon(s) — verdict non rendu`, mesuresPath); finR("donnees_insuffisantes", 2); }

  const latences = mesures.map(m => m.latence_ms).filter(v => typeof v === "number").sort((a, b) => a - b);
  const erreurs = mesures.map(m => m.erreur_pct).filter(v => typeof v === "number");
  if (latences.length !== mesures.length || erreurs.length !== mesures.length)
    { add("bloquant", "R", "mesure incomplète (latence_ms/erreur_pct numériques attendus sur chaque échantillon)", mesuresPath); finR("donnees_insuffisantes", 2); }
  const p95 = latences[Math.min(latences.length - 1, Math.ceil(0.95 * latences.length) - 1)];
  const erreurMax = Math.max(...erreurs);

  if (typeof seuilsSlo.latence_p95_max_ms === "number" && p95 > seuilsSlo.latence_p95_max_ms)
    add("bloquant", "R", `latence p95 ${p95}ms > seuil humain ${seuilsSlo.latence_p95_max_ms}ms`, mesuresPath);
  if (typeof seuilsSlo.erreur_max_pct === "number" && erreurMax > seuilsSlo.erreur_max_pct)
    add("bloquant", "R", `taux d'erreur ${erreurMax}% > seuil humain ${seuilsSlo.erreur_max_pct}%`, mesuresPath);

  const dursR = F.filter(f => f.sev === "bloquant" || f.sev === "majeur");
  const verdictR = dursR.length ? "rollback_recommande" : "stable";
  finR(verdictR, dursR.length ? 1 : 0, {
    mesures_observees: { p95_latence_ms: p95, erreur_max_pct: erreurMax, echantillons: mesures.length },
    seuils_appliques: seuilsSlo,
    recommandation: dursR.length ? "geste humain suggéré : `node scripts/ops.mjs restaurer <cible>` après revue" : "aucune action requise",
  });
}

function sortir(verdict, code) {
  process.stdout.write(JSON.stringify({
    oracle: "oracle-ops", domaine: DOM, artefact: cible || null,
    verdict, findings: F.length ? F : [{ sev: "info", regle: "—", msg: "O1–O4 sans écart", where: cible }],
    non_juge: NON_JUGE,
  }, null, jsonOnly ? 0 : 2));
  process.exit(code);
}

if (!cible || !fs.existsSync(cible)) { add("info", "—", "cible introuvable", String(cible)); sortir("SKIP", 2); }

// ── O1 · pointeur ──────────────────────────────────────────────────────────
const cp = path.join(cible, "COURANT");
const courant = fs.existsSync(cp) ? fs.readFileSync(cp, "utf8").trim() : null;
if (!courant) add("bloquant", "O1", "COURANT absent — la cible n'a pas de release active désignée", "COURANT");
const releaseDir = courant ? path.join(cible, "releases", courant) : null;
if (courant && !fs.existsSync(releaseDir))
  add("bloquant", "O1", `COURANT pointe une release inexistante : ${courant}`, "COURANT");

// ── O2 · healthcheck réel de la release courante ──────────────────────────
if (courant && fs.existsSync(releaseDir)) {
  const sante = path.join(releaseDir, "sante.mjs");
  if (!fs.existsSync(sante)) add("bloquant", "O2", "sante.mjs absent de la release courante — santé invérifiable", courant);
  else {
    const r = spawnSync(process.execPath, [sante], { cwd: releaseDir, encoding: "utf8", timeout: 30000 });
    if (r.status !== 0) add("bloquant", "O2", `healthcheck en échec (exit ${r.status}) sur la release courante`, courant);
  }
}

// ── O3 · intégrité du journal (contrat ledger : seq croissant depuis 1) ───
const jp = path.join(cible, "journal.jsonl");
let entrees = [];
if (!fs.existsSync(jp)) add("bloquant", "O3", "journal.jsonl absent — exploitation non tracée", "journal.jsonl");
else {
  const lignes = fs.readFileSync(jp, "utf8").split("\n").filter(Boolean);
  let attendu = 1;
  for (let i = 0; i < lignes.length; i++) {
    let e = null;
    try { e = JSON.parse(lignes[i]); } catch { add("bloquant", "O3", `ligne ${i + 1} : JSON invalide`, "journal.jsonl:" + (i + 1)); continue; }
    if (e.seq !== attendu) add("bloquant", "O3", `ligne ${i + 1} : seq ${e.seq}, attendu ${attendu} (append-only rompu)`, "journal.jsonl:" + (i + 1));
    if (!TYPES.includes(e.type)) add("bloquant", "O3", `ligne ${i + 1} : type inconnu « ${e.type} »`, "journal.jsonl:" + (i + 1));
    attendu = (e.seq ?? attendu) + 1;
    entrees.push(e);
  }
  if (!entrees.length) add("bloquant", "O3", "journal vide — aucune exploitation tracée", "journal.jsonl");
}

// ── O4 · rollback prouvable + cohérence pointeur ↔ histoire ───────────────
// Rollback prouvable = l'histoire n'est pas purgée : toute release citée par un
// événement actif du journal existe encore sur disque (on peut toujours y revenir).
// Être positionné sur la plus ancienne release après une restauration est un état sain.
if (courant && fs.existsSync(releaseDir)) {
  const actifs = entrees.filter(e => e.type === "deploiement" || e.type === "restauration" || e.type === "canary_promotion");
  for (const e of actifs) {
    if (e.release && !fs.existsSync(path.join(cible, "releases", e.release)))
      add("majeur", "O4", `release ${e.release} citée au journal (seq ${e.seq}) mais purgée du disque — rollback impossible vers cet état`, "releases/");
  }
  const dernier = actifs[actifs.length - 1];
  if (dernier && dernier.release !== courant)
    add("bloquant", "O4", `incohérence : COURANT=${courant} mais le dernier événement actif du journal désigne ${dernier.release}`, "journal.jsonl");
}

const durs = F.filter(f => f.sev === "bloquant" || f.sev === "majeur");
sortir(durs.length ? "FAIL" : "PASS", durs.length ? 1 : 0);

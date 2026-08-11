#!/usr/bin/env node
// oracle-ops — Domaine « Exploitation : cible déployée saine et restaurable » (déterministe).
// Quatre règles O1-O4 sur une CIBLE d'exploitation réelle (jamais sur le code générateur) :
//   O1  COURANT existe et pointe une release présente sur disque ;
//   O2  la release courante repasse son healthcheck (exécution réelle de sante.mjs) ;
//   O3  journal.jsonl intègre : JSON valide, seq strictement croissant depuis 1, types connus ;
//   O4  rollback prouvable : s'il existe une release antérieure à la courante, elle est
//       toujours présente (capacité de restauration réelle) ET le dernier événement du
//       journal désigne la release courante (cohérence pointeur ↔ histoire).
// Contrat : JSON {oracle,domaine,artefact,verdict,findings,non_juge} · exit 0/1/2.
// Usage : node oracle-ops.mjs <cible> [--json-only]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DOM = "Exploitation : cible déployée saine et restaurable";
const NON_JUGE = [
  "santé applicative au-delà du healthcheck déclaré par la release (parcours réels, charge)",
  "GO de mise en production — décision humaine, jamais un verdict d'oracle",
  "supervision continue / alerting (hors périmètre v0)",
  "secrets et configuration d'environnement — jamais transportés par la forge",
];
const TYPES = ["deploiement", "deploiement_refuse", "restauration"];

const args = process.argv.slice(2);
const cible = args.find(a => !a.startsWith("--"));
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
  const actifs = entrees.filter(e => e.type === "deploiement" || e.type === "restauration");
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

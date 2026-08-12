#!/usr/bin/env node
// self-test.mjs — preuve par le geste : rejoue un DÉPLOIEMENT RÉEL local (fixture
// d'acceptation TF-0040) puis prouve que chaque défaut type est refusé.
//   Verte : déployer v1 → oracle PASS → déployer v2 → PASS → restaurer → PASS
//           (journal 3 événements, COURANT revenu à v1).
//   Rouges : healthcheck en échec → déploiement refusé, COURANT intact ;
//            journal corrompu → oracle FAIL O3 ; pointeur fantôme → FAIL O1 ;
//            restauration sans précédente → refus.
// Exit 0 si tous les contrôles passent, 1 sinon. À rejouer après toute modification.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ici = path.dirname(fileURLToPath(import.meta.url));
const ops = path.join(ici, "..", "scripts", "ops.mjs");
const oracle = path.join(ici, "oracle-ops.mjs");
const fx = f => path.join(ici, "..", "fixtures", f);
let pass = 0, echec = 0;
const ok = (b, m) => { console.log(`  [${b ? "PASS" : "FAIL"}] ${m}`); b ? pass++ : echec++; };

const run = (script, args) => execFileSync(process.execPath, [script, ...args], { encoding: "utf8" });
function mustFail(script, args, motif) {
  try { execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: "pipe" }); }
  catch (e) {
    const err = String(e.stderr || e.stdout || "");
    return !motif || err.includes(motif) ? true : (console.log(`        motif « ${motif} » absent : ${err.slice(0, 100)}`), false);
  }
  return false;
}
const verdict = cible => { try { return JSON.parse(run(oracle, [cible, "--json-only"])).verdict; }
  catch (e) { try { return JSON.parse(String(e.stdout)).verdict; } catch { return "ILLISIBLE"; } } };
const courant = cible => fs.readFileSync(path.join(cible, "COURANT"), "utf8").trim();

const base = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-selftest-"));
const cible = path.join(base, "cible");

console.log("SELF-TEST forge-ops — fixture d'acceptation : déploiement réel local + rollback\n");

// ── VERTE · v1 ─────────────────────────────────────────────────────────────
run(ops, ["deployer", fx("app-verte"), cible]);
const r1 = courant(cible);
ok(!!r1, `déploiement v1 réel : release ${r1}`);
ok(verdict(cible) === "PASS", "oracle O1-O4 PASS après v1");

// ── VERTE · v2 (mise à jour) ───────────────────────────────────────────────
const buildV2 = path.join(base, "build-v2");
fs.cpSync(fx("app-verte"), buildV2, { recursive: true });
fs.writeFileSync(path.join(buildV2, "index.html"),
  fs.readFileSync(path.join(buildV2, "index.html"), "utf8").replace("v1", "v2"), "utf8");
run(ops, ["deployer", buildV2, cible]);
const r2 = courant(cible);
ok(r2 !== r1, `déploiement v2 : bascule ${r1} → ${r2}`);
ok(verdict(cible) === "PASS", "oracle PASS après v2");

// ── VERTE · rollback prouvé ────────────────────────────────────────────────
run(ops, ["restaurer", cible]);
ok(courant(cible) === r1, `restauration réelle : COURANT revenu à ${r1}`);
ok(verdict(cible) === "PASS", "oracle PASS après restauration");
const nbEv = fs.readFileSync(path.join(cible, "journal.jsonl"), "utf8").split("\n").filter(Boolean).length;
ok(nbEv === 3, `journal : 3 événements tracés (obtenu ${nbEv})`);

// ── ROUGE · restauration sans précédente (COURANT = première release) ─────
ok(mustFail(ops, ["restaurer", cible], "aucune release précédente"), "restaurer sans précédente → refus");

// ── ROUGE · healthcheck en échec : COURANT intact, refus journalisé ───────
ok(mustFail(ops, ["deployer", fx("app-rouge"), cible], "healthcheck en échec"), "app malade → déploiement refusé");
ok(courant(cible) === r1, "COURANT intact après refus (jamais de bascule sur release malade)");
const evs = fs.readFileSync(path.join(cible, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
ok(evs[evs.length - 1].type === "deploiement_refuse", "refus journalisé (deploiement_refuse)");
ok(verdict(cible) === "PASS", "oracle toujours PASS (le refus n'a pas sali la cible)");

// ── ROUGE · journal corrompu → FAIL O3 (sur copie) ─────────────────────────
const c2 = path.join(base, "cible-journal");
fs.cpSync(cible, c2, { recursive: true });
fs.appendFileSync(path.join(c2, "journal.jsonl"), JSON.stringify({ seq: 99, ts: "2020-01-01T00:00:00Z", type: "deploiement", release: "triche" }) + "\n");
ok(verdict(c2) === "FAIL", "journal corrompu (saut de seq) → oracle FAIL");

// ── ROUGE · pointeur fantôme → FAIL O1 (sur copie) ─────────────────────────
const c3 = path.join(base, "cible-fantome");
fs.cpSync(cible, c3, { recursive: true });
fs.writeFileSync(path.join(c3, "COURANT"), "release-inexistante", "utf8");
ok(verdict(c3) === "FAIL", "COURANT fantôme → oracle FAIL");

// ── PLANS CLOUD (TF-0081) · vertes : un plan complet par cible, O-5 PASS ──
console.log("");
const verdictPlan = (fichier) => {
  try { return JSON.parse(run(oracle, ["--plan", fichier, "--json-only"])).verdict; }
  catch (e) { try { return JSON.parse(String(e.stdout)).verdict; } catch { return "ILLISIBLE"; } }
};
for (const cible of ["railway", "gcp", "azure", "aws"]) {
  const pf = path.join(base, `plan-${cible}.json`);
  run(ops, ["plan", cible, fx("app-verte"), "--sortie", pf]);
  const p = JSON.parse(fs.readFileSync(pf, "utf8"));
  ok(p.format === "forge-ops/plan@1" && ["provision", "deploiement", "healthcheck", "rollback"].every(k => p.phases[k]?.length),
    `plan ${cible} : 4 phases générées (déterministe, zéro exécution)`);
  ok(verdictPlan(pf) === "PASS", `oracle O-5 PASS sur le plan ${cible}`);
}
// rouge : cible inconnue refusée
ok(mustFail(ops, ["plan", "heroku", fx("app-verte")], "cible inconnue"), "plan heroku → refus explicite");
// rouge : plan amputé du rollback → FAIL O-5 localisant
const pAmpute = path.join(base, "plan-ampute.json");
run(ops, ["plan", "gcp", fx("app-verte"), "--sortie", pAmpute]);
const doc = JSON.parse(fs.readFileSync(pAmpute, "utf8"));
doc.phases.rollback = [];
fs.writeFileSync(pAmpute, JSON.stringify(doc), "utf8");
ok(verdictPlan(pAmpute) === "FAIL", "plan sans rollback → O-5 FAIL");

// ── CANARY LOCAL SIMULÉ (TF-0107 · 1) · verte : promotion sur critère atteint ──────
console.log("");
const journalDe = f => fs.readFileSync(path.join(f, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
const cibleCanary = path.join(base, "cible-canary");
run(ops, ["canary", fx("app-canary-stable"), cibleCanary]);
const evsCanary = journalDe(cibleCanary);
ok(evsCanary.filter(e => e.type === "canary_etape").length === 5, "canary vert : 5 paliers franchis et journalisés");
ok(evsCanary[evsCanary.length - 1].type === "canary_promotion", "canary vert : promotion journalisée");
ok(!!courant(cibleCanary), "canary vert : COURANT promu sur le candidat");
ok(verdict(cibleCanary) === "PASS", "oracle O1-O4 PASS après promotion canary");

// ── ROUGE · dégradation détectée en cours de palier → abandon, COURANT intact ──────
const cibleCanaryAbandon = path.join(base, "cible-canary-abandon");
run(ops, ["deployer", fx("app-verte"), cibleCanaryAbandon]);
const avantAbandon = courant(cibleCanaryAbandon);
ok(mustFail(ops, ["canary", fx("app-canary-degradee"), cibleCanaryAbandon], "critère de promotion non atteint"),
  "canary dégradé au palier 25 % → abandon");
ok(courant(cibleCanaryAbandon) === avantAbandon, "COURANT intact après abandon canary (jamais de bascule sur dégradation)");
const evsAbandon = journalDe(cibleCanaryAbandon);
ok(evsAbandon[evsAbandon.length - 1].type === "canary_annulation", "abandon journalisé (canary_annulation)");
ok(evsAbandon.filter(e => e.type === "canary_etape" && e.verdict === "franchi").length === 2,
  "paliers 1 % et 5 % franchis avant l'abandon à 25 %");

// ── ROUGE · candidat sans contrat de métriques → canary refusé (app-verte réutilisée) ──
ok(mustFail(ops, ["canary", fx("app-verte"), path.join(base, "cible-canary-sans-metriques")], "sans contrat de métriques"),
  "candidat sans metriques.mjs → canary refusé");

// ── Critère explicite par config : même candidat stable, seuils stricts → abandon ─────
ok(mustFail(ops, ["canary", fx("app-canary-stable"), path.join(base, "cible-canary-config"), "--seuils", fx("canary-seuils-strict.json")],
  "critère de promotion non atteint"),
  "seuils stricts (config humaine) → même candidat stable refusé (le critère vient du fichier, pas d'une valeur en dur)");

// ── ORACLE O-6 · DÉRIVE ÉTAT DÉCLARÉ ↔ CONSTATÉ (TF-0107 · 2) ──────────────────────
// O-6 comble un angle mort d'O1-O4 (self-cohérence interne du journal courant, jamais
// vérifiée contre un témoin extérieur) : troncature, réécriture d'historique, furtif.
console.log("");
const verdictDrift = (fichierDeclare, c) => { try { return JSON.parse(run(oracle, [c, "--drift", fichierDeclare, "--json-only"])).verdict; }
  catch (e) { try { return JSON.parse(String(e.stdout)).verdict; } catch { return "ILLISIBLE"; } } };

// VERTE · évolution légitime après déclaration (nouveau déploiement bien journalisé)
const cibleDrift = path.join(base, "cible-drift");
run(ops, ["deployer", fx("app-verte"), cibleDrift]);
const declareV1 = path.join(base, "declare-v1.json");
run(ops, ["etat", cibleDrift, "--sortie", declareV1]);
const buildV2drift = path.join(base, "build-v2-drift");
fs.cpSync(fx("app-verte"), buildV2drift, { recursive: true });
fs.writeFileSync(path.join(buildV2drift, "index.html"),
  fs.readFileSync(path.join(buildV2drift, "index.html"), "utf8").replace("v1", "v2"), "utf8");
run(ops, ["deployer", buildV2drift, cibleDrift]);
ok(verdictDrift(declareV1, cibleDrift) === "PASS", "O-6 : évolution légitime après déclaration (déploiement journalisé) n'est pas une dérive");

// ROUGE · journal tronqué après déclaration → dérive détectée
const cibleTronque = path.join(base, "cible-drift-troncature");
fs.cpSync(cibleDrift, cibleTronque, { recursive: true });
const declareTronque = path.join(base, "declare-troncature.json");
run(ops, ["etat", cibleTronque, "--sortie", declareTronque]);
const lignesAvantTroncature = fs.readFileSync(path.join(cibleTronque, "journal.jsonl"), "utf8").split("\n").filter(Boolean);
fs.writeFileSync(path.join(cibleTronque, "journal.jsonl"), lignesAvantTroncature.slice(0, 1).join("\n") + "\n", "utf8");
ok(verdictDrift(declareTronque, cibleTronque) === "FAIL", "O-6 : journal tronqué après déclaration → dérive détectée");

// ROUGE · historique réécrit (contenu altéré, seq/types intacts) → O1-O4 restent PASS
const cibleReecrit = path.join(base, "cible-drift-reecriture");
fs.cpSync(cibleDrift, cibleReecrit, { recursive: true });
const declareReecrit = path.join(base, "declare-reecriture.json");
run(ops, ["etat", cibleReecrit, "--sortie", declareReecrit]);
const lignesReecrites = fs.readFileSync(path.join(cibleReecrit, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
lignesReecrites[1].precedent = "falsifie"; // même seq, même type : passe O3 et O4 intacts
fs.writeFileSync(path.join(cibleReecrit, "journal.jsonl"), lignesReecrites.map(l => JSON.stringify(l)).join("\n") + "\n", "utf8");
ok(verdict(cibleReecrit) === "PASS", "réécriture d'historique : O1-O4 ne voient rien (angle mort comblé par O-6)");
ok(verdictDrift(declareReecrit, cibleReecrit) === "FAIL", "O-6 : historique réécrit après déclaration → dérive détectée");

// ROUGE · déploiement furtif (release copiée hors ops.mjs, jamais journalisée) → O1-O4 PASS
const cibleFurtif = path.join(base, "cible-drift-furtif");
run(ops, ["deployer", fx("app-verte"), cibleFurtif]);
const declareFurtif = path.join(base, "declare-furtif.json");
run(ops, ["etat", cibleFurtif, "--sortie", declareFurtif]);
fs.cpSync(fx("app-verte"), path.join(cibleFurtif, "releases", "20200101T000000-furtive"), { recursive: true });
ok(verdict(cibleFurtif) === "PASS", "déploiement furtif : O1-O4 ne voient rien (release non citée par le journal)");
ok(verdictDrift(declareFurtif, cibleFurtif) === "FAIL", "O-6 : release furtive hors journal → dérive détectée");

// ── VERDICT « ROLLBACK RECOMMANDÉ » · seuils SLO humains (TF-0107 · 3) ─────────────
// Recommandation SEULE : jamais d'exécution automatique — juste un verdict consommable.
console.log("");
const verdictRB = (mesuresFichier, seuilsFichier) => {
  const argsRB = ["--verdict-rollback", mesuresFichier, "--json-only"];
  if (seuilsFichier) argsRB.splice(2, 0, "--seuils", seuilsFichier);
  try { return JSON.parse(run(oracle, argsRB)); }
  catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE" }; } }
};
const seuilsSlo = fx("seuils-slo.json");

const mesuresStables = path.join(base, "mesures-stables.json");
fs.writeFileSync(mesuresStables, JSON.stringify([{ latence_ms: 110, erreur_pct: 0.3 }, { latence_ms: 130, erreur_pct: 0.4 }, { latence_ms: 120, erreur_pct: 0.2 }]), "utf8");
const rStable = verdictRB(mesuresStables, seuilsSlo);
ok(rStable.verdict === "stable", `mesures sous les seuils SLO → verdict stable (obtenu ${rStable.verdict})`);

const mesuresDegradees = path.join(base, "mesures-degradees.json");
fs.writeFileSync(mesuresDegradees, JSON.stringify([{ latence_ms: 600, erreur_pct: 5 }, { latence_ms: 650, erreur_pct: 6 }, { latence_ms: 700, erreur_pct: 8 }]), "utf8");
const rDeg = verdictRB(mesuresDegradees, seuilsSlo);
ok(rDeg.verdict === "rollback_recommande", `mesures au-delà des seuils SLO → rollback recommandé (obtenu ${rDeg.verdict})`);
ok(!!rDeg.recommandation && /restaurer/.test(rDeg.recommandation),
  "recommandation pointe vers le geste humain `ops.mjs restaurer` (jamais exécuté automatiquement)");

const mesuresInsuffisantes = path.join(base, "mesures-insuffisantes.json");
fs.writeFileSync(mesuresInsuffisantes, JSON.stringify([{ latence_ms: 110, erreur_pct: 0.3 }]), "utf8");
const rPeu = verdictRB(mesuresInsuffisantes, seuilsSlo);
ok(rPeu.verdict === "donnees_insuffisantes", `fenêtre sous le minimum requis → pas de verdict forcé (obtenu ${rPeu.verdict})`);

ok(mustFail(oracle, ["--verdict-rollback", mesuresStables, "--json-only"], "seuils SLO introuvable"),
  "sans fichier de seuils humain → refus (aucun défaut implicite)");

fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
console.log(`\nSelf-test forge-ops : ${pass} PASS, ${echec} FAIL`);
process.exit(echec ? 1 : 0);

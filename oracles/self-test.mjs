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

fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
console.log(`\nSelf-test forge-ops : ${pass} PASS, ${echec} FAIL`);
process.exit(echec ? 1 : 0);

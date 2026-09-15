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
import { createHash } from "node:crypto";
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

// ── O1/O3 · CIBLE PLATEFORME (TF-0844, lot Produit-61 20260905a) ───────────────────────
// FAIT : une cible railway (ou tout plan cloud) ne porte ni COURANT ni journal.jsonl — la
// plateforme les tient. Sans déclaration explicite, O1/O3 FAILaient à tort sur un
// déploiement RÉEL et SAIN (M-4 PASS côté pilot). Avec le marqueur PLATEFORME : SANS_OBJET.
const verdictJSON = c => { try { return JSON.parse(run(oracle, [c, "--json-only"])); }
  catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };

// VERTE · cible avec PLATEFORME déclarée → SKIP, jamais un FAIL sur un contrat qu'elle ne porte pas
const ciblePlateforme = path.join(base, "cible-railway-qualif");
fs.mkdirSync(ciblePlateforme, { recursive: true });
fs.writeFileSync(path.join(ciblePlateforme, "PLATEFORME"), "railway", "utf8");
const rPlateforme = verdictJSON(ciblePlateforme);
ok(rPlateforme.verdict === "SKIP", `cible PLATEFORME déclarée (railway) → SKIP, jamais un FAIL sur un contrat que la cible ne porte pas (obtenu ${rPlateforme.verdict})`);
ok((rPlateforme.findings || []).some(f => f.regle === "O1" && /plateforme/.test(f.msg))
  && (rPlateforme.findings || []).some(f => f.regle === "O3" && /plateforme/.test(f.msg)),
  "O1 et O3 déclarent SANS_OBJET en NOMMANT la plateforme (railway), pas un total anonyme");

// ROUGE (double sens) : LA MÊME cible vide, SANS le marqueur → FAIL inchangé — c'est le
// marqueur qui fait la différence, pas un dossier vide qui SKIPperait tout seul.
const cibleSansPlateforme = path.join(base, "cible-sans-plateforme");
fs.mkdirSync(cibleSansPlateforme, { recursive: true });
const rSansPlateforme = verdictJSON(cibleSansPlateforme);
ok(rSansPlateforme.verdict === "FAIL", `même cible vide SANS le marqueur PLATEFORME → FAIL inchangé (obtenu ${rSansPlateforme.verdict}) — le marqueur, pas le hasard d'un dossier vide, fait la différence`);

// ── VERTE · CHEMINS RELATIFS (TF-0245) ─────────────────────────────────────
// Le healthcheck s'exécute avec cwd=releaseDir : un chemin resté relatif serait résolu
// par node contre ce nouveau cwd — refus à tort journalisé deploiement_refuse (et, dès
// node 25/Windows, cpSync échoue avant même le healthcheck). ops.mjs doit résoudre ses
// chemins À L'ENTRÉE : le même déploiement, lancé en relatif depuis un cwd quelconque,
// aboutit exactement comme en absolu.
const buildRel = path.join(base, "build-relatif");
fs.cpSync(fx("app-verte"), buildRel, { recursive: true });
let relOk = true, relErr = "";
try {
  execFileSync(process.execPath, [ops, "deployer", "build-relatif", "cible-relative"],
    { cwd: base, encoding: "utf8", stdio: "pipe" });
} catch (e) { relOk = false; relErr = String(e.stderr || e.message).slice(0, 100); }
ok(relOk, `déploiement en chemins relatifs (cwd=${path.basename(base)}) : accepté${relOk ? "" : " — " + relErr}`);
const cibleRel = path.join(base, "cible-relative");
ok(relOk && !!courant(cibleRel), "chemins relatifs : COURANT pointé sur la release déployée");
ok(relOk && verdict(cibleRel) === "PASS", "oracle O1-O4 PASS sur la cible déployée en relatif");

// ── ROUGE→VERTE · L'ORACLE LUI-MÊME EN CIBLE RELATIVE (TF-0281) ────────────
// Même piège que TF-0245, resté à propager côté oracle : O2 lance sante.mjs avec
// cwd=releaseDir. Cible relative → chemin du script relatif lui aussi → résolu par node
// contre ce NOUVEAU cwd → chemin doublé, « Cannot find module », exit 1 rapporté comme
// « healthcheck en échec » : un FAUX ÉCHEC sur une release parfaitement saine. La cible
// est la MÊME qu'à la ligne précédente : seule la façon de la nommer change.
const oracleDepuis = (cwd, c) => {
  try { return JSON.parse(execFileSync(process.execPath, [oracle, c, "--json-only"], { cwd, encoding: "utf8", stdio: "pipe" })); }
  catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } }
};
const relOracle = oracleDepuis(base, "cible-relative");
ok(relOracle.verdict === "PASS",
  `oracle appelé en cible RELATIVE sur release saine → PASS (obtenu ${relOracle.verdict})`);
ok(!(relOracle.findings || []).some(f => f.regle === "O2"),
  "aucun finding O2 en cible relative — le healthcheck n'échoue pas à tort");

// ── PLANS CLOUD (TF-0081) · vertes : un plan complet par cible, O-5 PASS ──
console.log("");
const verdictPlan = (fichier) => {
  try { return JSON.parse(run(oracle, ["--plan", fichier, "--json-only"])).verdict; }
  catch (e) { try { return JSON.parse(String(e.stdout)).verdict; } catch { return "ILLISIBLE"; } }
};
// TF-0865 (lot L8, 07/09/2026) : deux cibles de produit data rejoignent la boucle — bundle
// déclaratif Databricks et espace de travail Power BI — mêmes exigences O-5 que les cibles cloud.
for (const cible of ["railway", "gcp", "azure", "aws", "databricks-bundle", "powerbi-workspace"]) {
  const pf = path.join(base, `plan-${cible}.json`);
  run(ops, ["plan", cible, fx("app-verte"), "--sortie", pf]);
  const p = JSON.parse(fs.readFileSync(pf, "utf8"));
  ok(p.format === "forge-ops/plan@1" && ["provision", "deploiement", "healthcheck", "rollback"].every(k => p.phases[k]?.length),
    `plan ${cible} : 4 phases générées (déterministe, zéro exécution)`);
  ok(verdictPlan(pf) === "PASS", `oracle O-5 PASS sur le plan ${cible}`);
}
// TF-0258 : les 4 pièges du premier déploiement réel Railway sont versés au plan et O-5
// reste PASS dessus — un plan qui les tairait serait complet en forme (4 phases, rollback,
// CLI) mais muet sur ce qui a fait échouer un déploiement réel.
{
  const pf = path.join(base, "plan-railway-tf0258.json");
  run(ops, ["plan", "railway", fx("app-verte"), "--sortie", pf]);
  const p = JSON.parse(fs.readFileSync(pf, "utf8"));
  const brut = JSON.stringify(p.phases);
  const piegesAttendus = [
    ["forme SHELL", /forme SHELL/],                       // (1) $PORT littéral en forme EXEC
    ["0.0.0.0", /0\.0\.0\.0/],                             // (2) edge/healthcheck IPv4
    ["RAILWAY_RUN_UID", /RAILWAY_RUN_UID/],                // (3) volume monté root
    ["API GraphQL", /GraphQL/],                            // (4) logs runtime en échec
  ];
  const manquants = piegesAttendus.filter(([, re]) => !re.test(brut)).map(([n]) => n);
  ok(manquants.length === 0,
    manquants.length === 0
      ? "plan railway : les 4 pièges TF-0258 sont présents (startCommand, bind IPv4, volume UID, logs GraphQL)"
      : `plan railway : pièges TF-0258 manquants : ${manquants.join(", ")}`);
  ok(verdictPlan(pf) === "PASS", "oracle O-5 toujours PASS sur le plan railway enrichi TF-0258");
}
// TF-0269 : les 3 constats du SECOND déploiement réel (run 20260815b-bdl) sont au plan —
// nommage du service vs domaine généré `<service>-<environnement>`, renommage d'un domaine
// existant par la seule mutation GraphQL, origine publique posée en variable. Fixture de
// PRÉSENCE : sans elle, le plan resterait complet en forme (O-5 PASS) tout en taisant ce
// qui a fait livrer une URL publique fausse.
{
  const pf = path.join(base, "plan-railway-tf0269.json");
  run(ops, ["plan", "railway", fx("app-verte"), "--sortie", pf]);
  const brut = JSON.stringify(JSON.parse(fs.readFileSync(pf, "utf8")).phases);
  const constatsAttendus = [
    ["domaine <service>-<environnement>", /<nom-service>-<nom-environnement>|nom-service.{0,3}-.{0,3}nom-environnement/],
    ["nommage R-24 du service", /R-24/],
    ["mutation serviceDomainUpdate", /serviceDomainUpdate/],
    ["5 champs requis de la mutation", /targetPort/],
    ["origine publique en variable", /URL_BASE/],
  ];
  const absents = constatsAttendus.filter(([, re]) => !re.test(brut)).map(([n]) => n);
  ok(absents.length === 0,
    absents.length === 0
      ? "plan railway : les 3 constats TF-0269 sont présents (nommage service/environnement, renommage GraphQL, origine publique en variable)"
      : `plan railway : constats TF-0269 absents : ${absents.join(", ")}`);
  ok(verdictPlan(pf) === "PASS", "oracle O-5 toujours PASS sur le plan railway enrichi TF-0269");
}
// TF-0845 (lot Produit-61 20260905a) : `railway up -p <id>` ne remplace pas `railway link`
// (« prefix not found », un téléversement perdu) — le plan porte désormais l'avertissement
// explicite dans sa phase provision, avant même la commande `up`.
{
  const pf = path.join(base, "plan-railway-tf0845.json");
  run(ops, ["plan", "railway", fx("app-verte"), "--sortie", pf]);
  const brut = JSON.stringify(JSON.parse(fs.readFileSync(pf, "utf8")).phases.provision);
  ok(/railway up -p/.test(brut) && /prefix not found/.test(brut),
    "plan railway : l'avertissement TF-0845 (`up -p` ne remplace pas `link`, « prefix not found ») est présent en phase provision");
  ok(verdictPlan(pf) === "PASS", "oracle O-5 toujours PASS sur le plan railway enrichi TF-0845");
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

// ── ORACLE O-7 · EMPREINTE DE DÉPLOIEMENT (TF-0288, volet prévention) ──────────────
// O-6 juge le journal ; O-7 juge le CONTENU d'une release déjà journalisée, comparé à
// l'empreinte scellée par `deployer` — un fichier édité en place sans nouveau déploiement
// est invisible à O1-O4 comme à O-6, visible ici.
console.log("");
const verdictEmpreinte = c => { try { return JSON.parse(run(oracle, [c, "--empreinte", "--json-only"])); }
  catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };

// VERTE · déployé = scellé → PASS
const cibleEmpreinte = path.join(base, "cible-empreinte");
run(ops, ["deployer", fx("app-verte"), cibleEmpreinte]);
const releaseEmpreinte = courant(cibleEmpreinte);
const empreintePath = path.join(cibleEmpreinte, "empreintes", `${releaseEmpreinte}.json`);
ok(fs.existsSync(empreintePath), `deployer scelle une empreinte : ${path.relative(base, empreintePath)}`);
const docEmpreinte = JSON.parse(fs.readFileSync(empreintePath, "utf8"));
ok(docEmpreinte.format === "forge-ops/empreinte@1" && !!docEmpreinte.fichiers["index.html"] && !!docEmpreinte.fichiers["sante.mjs"],
  "empreinte : manifeste horodaté avec hachés sha256 par fichier (index.html, sante.mjs)");
const rEmpreintePass = verdictEmpreinte(cibleEmpreinte);
ok(rEmpreintePass.verdict === "PASS", `O-7 : déployé = scellé → PASS (obtenu ${rEmpreintePass.verdict})`);

// ROUGE · fichier modifié après scellement → FAIL nommant le fichier
const cibleEmpreinteAltere = path.join(base, "cible-empreinte-alteree");
fs.cpSync(cibleEmpreinte, cibleEmpreinteAltere, { recursive: true });
const releaseAlteree = courant(cibleEmpreinteAltere);
const fichierAltere = path.join(cibleEmpreinteAltere, "releases", releaseAlteree, "index.html");
fs.writeFileSync(fichierAltere, fs.readFileSync(fichierAltere, "utf8") + "\n<!-- édité en place -->", "utf8");
const rEmpreinteFail = verdictEmpreinte(cibleEmpreinteAltere);
ok(rEmpreinteFail.verdict === "FAIL", `O-7 : fichier modifié après scellement → FAIL (obtenu ${rEmpreinteFail.verdict})`);
ok((rEmpreinteFail.findings || []).some(f => f.regle === "O7" && f.where === "index.html" && /modifié/.test(f.msg)),
  "O-7 : le fichier divergent est NOMMÉ (index.html), pas un total anonyme");

// ROUGE · fichier ajouté après scellement, absent de l'empreinte → FAIL nommant le fichier
const cibleEmpreinteAjout = path.join(base, "cible-empreinte-ajout");
fs.cpSync(cibleEmpreinte, cibleEmpreinteAjout, { recursive: true });
const releaseAjout = courant(cibleEmpreinteAjout);
fs.writeFileSync(path.join(cibleEmpreinteAjout, "releases", releaseAjout, "intrus.txt"), "ajouté hors ops", "utf8");
const rEmpreinteAjout = verdictEmpreinte(cibleEmpreinteAjout);
ok(rEmpreinteAjout.verdict === "FAIL", `O-7 : fichier ajouté après scellement → FAIL (obtenu ${rEmpreinteAjout.verdict})`);
ok((rEmpreinteAjout.findings || []).some(f => f.regle === "O7" && f.where === "intrus.txt"),
  "O-7 : le fichier ajouté est NOMMÉ (intrus.txt)");

// SKIP · aucune empreinte scellée (déploiement antérieur au contrôle) → jamais un FAIL rétroactif
const cibleEmpreinteAbsente = path.join(base, "cible-empreinte-absente");
run(ops, ["deployer", fx("app-verte"), cibleEmpreinteAbsente]);
fs.rmSync(path.join(cibleEmpreinteAbsente, "empreintes"), { recursive: true, force: true });
const rEmpreinteSkip = verdictEmpreinte(cibleEmpreinteAbsente);
ok(rEmpreinteSkip.verdict === "SKIP", `O-7 : aucune empreinte scellée → SKIP motivé, jamais un FAIL rétroactif (obtenu ${rEmpreinteSkip.verdict})`);
ok((rEmpreinteSkip.findings || []).some(f => /antérieur au contrôle|hors ops\.mjs/.test(f.msg)),
  "O-7 : motif du SKIP explicite (déploiement antérieur au contrôle ou hors ops.mjs)");

// ── O-7 · VOIE CANARY (TF-0298) : le trou SKIP-à-vie sur une cible promue par canary ─────
// est fermé — canary scelle désormais au même point du cycle que deployer (après critères,
// avant promotion), même fonction scellerEmpreinte, même format, même emplacement.
console.log("");

// VERTE · cible promue par canary → empreinte scellée, O-7 PASS (déployé = scellé)
const cibleEmpreinteCanary = path.join(base, "cible-empreinte-canary");
run(ops, ["canary", fx("app-canary-stable"), cibleEmpreinteCanary]);
const releaseEmpreinteCanary = courant(cibleEmpreinteCanary);
const empreinteCanaryPath = path.join(cibleEmpreinteCanary, "empreintes", `${releaseEmpreinteCanary}.json`);
ok(fs.existsSync(empreinteCanaryPath), `canary scelle une empreinte à la promotion : ${path.relative(base, empreinteCanaryPath)}`);
const docEmpreinteCanary = JSON.parse(fs.readFileSync(empreinteCanaryPath, "utf8"));
ok(docEmpreinteCanary.format === "forge-ops/empreinte@1" && !!docEmpreinteCanary.fichiers["index.html"] && !!docEmpreinteCanary.fichiers["metriques.mjs"],
  "empreinte canary : même format que deployer (manifeste horodaté, hachés sha256 par fichier)");
const rEmpreinteCanaryPass = verdictEmpreinte(cibleEmpreinteCanary);
ok(rEmpreinteCanaryPass.verdict === "PASS", `O-7 sur cible promue par canary : déployé = scellé → PASS (obtenu ${rEmpreinteCanaryPass.verdict}) — plus de SKIP à vie`);

// ROUGE · dérive après promotion canary → FAIL nommant le fichier
const cibleEmpreinteCanaryAlteree = path.join(base, "cible-empreinte-canary-alteree");
fs.cpSync(cibleEmpreinteCanary, cibleEmpreinteCanaryAlteree, { recursive: true });
const releaseCanaryAlteree = courant(cibleEmpreinteCanaryAlteree);
const fichierCanaryAltere = path.join(cibleEmpreinteCanaryAlteree, "releases", releaseCanaryAlteree, "index.html");
fs.writeFileSync(fichierCanaryAltere, fs.readFileSync(fichierCanaryAltere, "utf8") + "\n<!-- édité en place après promotion canary -->", "utf8");
const rEmpreinteCanaryFail = verdictEmpreinte(cibleEmpreinteCanaryAlteree);
ok(rEmpreinteCanaryFail.verdict === "FAIL", `O-7 : dérive après promotion canary → FAIL (obtenu ${rEmpreinteCanaryFail.verdict})`);
ok((rEmpreinteCanaryFail.findings || []).some(f => f.regle === "O7" && f.where === "index.html" && /modifié/.test(f.msg)),
  "O-7 : le fichier divergent après promotion canary est NOMMÉ (index.html), pas un total anonyme");

// ── M-8 · TF-1075 (D-4 (a) du 14/09/2026) : LA PORTE DE FRAÎCHEUR DOIT VOIR TOUT LE
// DÉPLOIEMENT, PAS SEULEMENT L'ACCUEIL — banc défauts-échappés E-05, preuve par perturbation ─
// LE FAIT (registre TF-0666/TF-0672, récidive E-05 le 26/08 puis le lendemain sur 70 pages) :
// la porte de fraîcheur du livrable E-05 (build/ci/verif-prod.mjs, Produit-02) ne compare que
// l'empreinte de site/index.html. Un déploiement qui modifie une AUTRE page sans toucher
// l'accueil est déclaré « PRODUCTION CONFORME » — faux vert. O-7 (empreinte de déploiement)
// compare déjà l'ENSEMBLE des fichiers de la release. Preuve par perturbation : on modifie une
// page HORS accueil après scellement, SANS toucher l'accueil, et on vérifie que les deux
// portes divergent — l'une aveugle au changement, l'autre le voit et le nomme.
console.log("");
const cibleM8 = path.join(base, "cible-m8-fraicheur");
const buildM8 = path.join(base, "build-m8");
fs.cpSync(fx("app-verte"), buildM8, { recursive: true });
fs.writeFileSync(path.join(buildM8, "mentions-legales.html"), "<html><body>v1</body></html>", "utf8");
run(ops, ["deployer", buildM8, cibleM8]);
const releaseM8 = courant(cibleM8);
const indexAvantM8 = fs.readFileSync(path.join(cibleM8, "releases", releaseM8, "index.html"), "utf8");

// Perturbation : SEULE la page hors accueil change après scellement — l'accueil, lui, est intact.
fs.writeFileSync(path.join(cibleM8, "releases", releaseM8, "mentions-legales.html"),
  "<html><body>v2 — deploiement reel non vu par une porte a une seule page</body></html>", "utf8");
const indexApresM8 = fs.readFileSync(path.join(cibleM8, "releases", releaseM8, "index.html"), "utf8");
ok(indexApresM8 === indexAvantM8, "perturbation M-8 : l'accueil n'a PAS changé (condition exacte du défaut E-05)");

// ROUGE — reproduction fidèle du CRITÈRE limitant du livrable E-05 : une empreinte, une seule
// page (site/index.html). Même fonction d'empreinte que verif-prod.mjs (sha256, 16 hex).
const empreinteE05 = (texte) => createHash("sha256").update(texte.replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);
const porteE05VoitLeChangement = empreinteE05(indexApresM8) !== empreinteE05(indexAvantM8);
ok(porteE05VoitLeChangement === false,
  "fixture ROUGE (E-05) : porte fondée sur la seule empreinte de l'accueil → ne voit RIEN, faux vert reproduit fidèlement");

// VERTE — O-7 : porte fondée sur l'empreinte de L'ENSEMBLE déployé (déjà la doctrine forge-ops).
const rM8 = verdictEmpreinte(cibleM8);
ok(rM8.verdict === "FAIL",
  `fixture VERTE (O-7) : porte fondée sur l'empreinte de l'ensemble déployé → voit le changement hors accueil (obtenu ${rM8.verdict})`);
ok((rM8.findings || []).some(f => f.regle === "O7" && f.where === "mentions-legales.html" && /modifié/.test(f.msg)),
  "O-7 nomme la page hors accueil modifiée (mentions-legales.html) — l'accueil, qui n'a pas bougé, n'est jamais accusé");
ok(!(rM8.findings || []).some(f => f.where === "index.html" && /modifié/.test(f.msg)),
  "O-7 n'accuse pas l'accueil à tort : seule la page réellement modifiée est nommée");

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

// ── O8 · UN TRAVAIL PLANIFIÉ S'EXERCE À LA DEMANDE (TF-0527, 23/08) ────────────────
// Le défaut rejoué est celui qui a été MESURÉ : une définition mensuelle enregistrée, déclarée
// « en place », dont le premier passage a rendu « rien à faire » EN SUCCÈS — donc dont pas une
// ligne n'avait tourné sur un agent. Trois états à prouver, et le troisième est le plus
// instructif : le paramètre DÉCLARÉ MAIS JAMAIS LU, qui donne l'impression d'un bouton.
const planifie = (nom, contenu) => {
  const d = path.join(base, "depot-" + nom);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "azure-pipelines-veille.yml"), contenu, "utf8");
  return d;
};
const o8 = (racine) => {
  try { return JSON.parse(run(oracle, [racine, "--planifie", "--json-only"])); }
  catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE" }; } }
};
const CADENCE = [
  "trigger: none",
  "schedules:",
  '  - cron: "7 7 1-7 * 1"',
  "    displayName: Premier lundi du mois",
  "    branches:",
  "      include:",
  "        - main",
  "    always: true",
  "steps:",
  "  - script: |",
  "      set -e",
].join("\n");

// (a) ROUGE — la cadence seule. C'est l'état exact du 23/08 avant correction.
const rSansExercice = o8(planifie("sans-exercice", CADENCE + "\n" +
  '      if [ "$(date -u +%d)" -gt 7 ]; then echo "Pas le premier lundi — rien a faire."; exit 0; fi\n' +
  "      node scripts/veille.mjs\n"));
ok(rSansExercice.verdict === "FAIL", `définition planifiée sans mode d'exercice → FAIL (obtenu ${rSansExercice.verdict})`);
ok(rSansExercice.findings.some(f => f.sev === "bloquant" && /SANS mode d'exercice/.test(f.msg) && /prochaine cadence/.test(f.msg)),
  "le constat dit POURQUOI c'est un défaut : le mécanisme ne peut être éprouvé qu'à sa prochaine échéance");
ok(rSansExercice.findings.some(f => f.where === "azure-pipelines-veille.yml"),
  "le constat localise le fichier fautif (jamais un total anonyme)");

// (b) ROUGE — le piège : un paramètre DÉCLARÉ, jamais LU. L'écran montre une case à cocher, la
// cocher ne change rien. Une affordance est câblée ou elle n'existe pas (loi n° 1).
const rNonLu = o8(planifie("param-non-lu", [
  "parameters:",
  "  - name: forcer",
  '    displayName: "Executer maintenant"',
  "    type: boolean",
  "    default: false",
  CADENCE,
  '      if [ "$(date -u +%d)" -gt 7 ]; then echo "Pas le premier lundi — rien a faire."; exit 0; fi',
  "      node scripts/veille.mjs",
].join("\n") + "\n"));
ok(rNonLu.verdict === "FAIL", `paramètre déclaré mais jamais lu → FAIL (obtenu ${rNonLu.verdict})`);
ok(rNonLu.findings.some(f => f.sev === "bloquant" && /JAMAIS LU/.test(f.msg) && /forcer/.test(f.msg)),
  "le constat NOMME le paramètre inerte — sans son nom, l'auteur cherche dans tout le fichier");

// (c) VERTE — le même fichier, paramètre LU dans la garde de cadence, et l'exercice DÉCLARÉ.
const vExercee = planifie("exercee", [
  "# exerce_le: 2026-08-23",
  "parameters:",
  "  - name: forcer",
  '    displayName: "Executer maintenant, hors du premier lundi"',
  "    type: boolean",
  "    default: false",
  CADENCE,
  '      if [ "${{ parameters.forcer }}" = "True" ]; then echo "Execution FORCEE."; ',
  '      elif [ "$(date -u +%d)" -gt 7 ]; then echo "Pas le premier lundi — rien a faire."; exit 0; fi',
  "      node scripts/veille.mjs",
].join("\n") + "\n");
const rVerte = o8(vExercee);
ok(rVerte.verdict === "PASS", `mode d'exercice câblé et exercice déclaré → PASS (obtenu ${rVerte.verdict})`);
ok(rVerte.findings.some(f => /exercé le 2026-08-23/.test(f.msg)),
  "le PASS DIT quand le mécanisme a réellement tourné — c'est le fait qui manquait au relevé du 23/08");

// (d) La MÊME verte sans sa déclaration d'exercice : le mode est câblé, donc pas un défaut, mais
// l'oracle le DIT. Un mécanisme jamais éprouvé n'est pas un mécanisme, c'est une intention.
const rPasExercee = o8(planifie("cablee-non-exercee", fs.readFileSync(path.join(vExercee, "azure-pipelines-veille.yml"), "utf8").replace("# exerce_le: 2026-08-23\n", "")));
ok(rPasExercee.verdict === "PASS", `mode câblé sans exercice déclaré → PASS, jamais un FAIL rétroactif (obtenu ${rPasExercee.verdict})`);
ok(rPasExercee.findings.some(f => f.sev === "info" && /AUCUN exercice déclaré/.test(f.msg)),
  "l'exercice manquant est DIT en avertissement (le fichier n'a rien fait de mal — c'est le contrôle qui naît)");

// (e) Ce qui n'a AUCUNE planification n'est jamais jugé : zéro faux positif sur un dépôt normal.
const rSansCron = o8(planifie("sans-cron", ["trigger:", "  - main", "steps:", "  - script: npm test"].join("\n") + "\n"));
ok(rSansCron.verdict === "SKIP" && rSansCron.findings.some(f => /aucune définition planifiée/.test(f.msg)),
  `un dépôt sans cron n'est pas jugé et le DIT (obtenu ${rSansCron.verdict})`);

// (f) La déclaration GitHub, autre dialecte du même parc : `workflow_dispatch` est un mode
// d'exercice de plein droit — il n'y a pas de garde de cadence à câbler.
const dGh = path.join(base, "depot-github");
fs.mkdirSync(path.join(dGh, ".github", "workflows"), { recursive: true });
fs.writeFileSync(path.join(dGh, ".github", "workflows", "veille.yml"),
  ["# exerce_le: 2026-08-23", "on:", "  schedule:", '    - cron: "7 7 1-7 * 1"', "  workflow_dispatch:", "jobs:", "  veille:", "    runs-on: ubuntu-latest"].join("\n") + "\n", "utf8");
const rGh = o8(dGh);
ok(rGh.verdict === "PASS", `déclencheur manuel GitHub reconnu comme mode d'exercice → PASS (obtenu ${rGh.verdict})`);
const rGhSans = path.join(base, "depot-github-sans");
fs.mkdirSync(path.join(rGhSans, ".github", "workflows"), { recursive: true });
fs.writeFileSync(path.join(rGhSans, ".github", "workflows", "veille.yml"),
  ["on:", "  schedule:", '    - cron: "7 7 1-7 * 1"', "jobs:", "  veille:", "    runs-on: ubuntu-latest"].join("\n") + "\n", "utf8");
ok(o8(rGhSans).verdict === "FAIL", "le même workflow GitHub SANS déclencheur manuel → FAIL (le sens rouge du même dialecte)");


// ── TF-0579 (25/08) : LE VERDICT S'ARCHIVE ET DIT SON REGIME ───────────────────────────────
// Le fait : un gate de MEP est reste ROUGE SIX JOURS pendant que le deploiement avait lieu.
// `git log -S` sur la ligne fautive ne rend AUCUN COMMIT — personne ne l'a ajustee et personne
// n'a ete arrete. Sans verdict horodate et archive, « les gates sont passes » est une
// affirmation invérifiable ; sans regime declare, un gate dont l'echec n'empeche rien n'est
// pas un gate, c'est un avis.
{
  const dJ = fs.mkdtempSync(path.join(base, "scel-"));
  fs.writeFileSync(path.join(dJ, "app.txt"), "release");
  const lire = () => { try { return JSON.parse(run(oracle, [dJ, "--json-only"])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return null; } } };
  const v1 = lire();
  ok(!!(v1 && v1.scellement && v1.scellement.archive === true),
    "le verdict est ARCHIVE — sans trace, « les gates sont passes » est invérifiable");
  const journal = path.join(dJ, ".ops-journal.jsonl");
  const lignesJ = fs.existsSync(journal)
    ? fs.readFileSync(journal, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
  ok(lignesJ.length === 1, `une ligne de journal par execution (obtenu ${lignesJ.length})`);
  const e = lignesJ[0] || {};
  ok(typeof e.ts === "string" && /^\d{4}-/.test(e.ts), "le verdict archive est HORODATE");
  ok(!!(e.empreinte && e.empreinte.fichiers && Object.keys(e.empreinte.fichiers).length),
    "le verdict dit SUR QUOI il a ete rendu — sans empreinte, il vieillit en silence");
  ok(Array.isArray(e.regles) && e.regles.every(r => r.regime === "bloque" || r.regime === "consultatif"),
    "CHAQUE regle dit son regime — bloque ou consultatif, jamais implicite");
  lire();
  const apres = fs.readFileSync(journal, "utf8").split(/\r?\n/).filter(Boolean).length;
  ok(apres === 2, `le journal S'AJOUTE, il n'ecrase pas (obtenu ${apres} ligne(s))`);
}

// BORNE — un journal qu'on ne peut pas ecrire ne doit JAMAIS empecher un deploiement : il se
// declare et l'oracle rend quand meme son verdict. Un scellement qui bloque serait un gate de
// plus, non decide, et exactement le contraire de ce que TF-0579 demande.
{
  const v = (() => { try { return JSON.parse(run(oracle, [path.join(base, "absent-xyz"), "--json-only"])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return null; } } })();
  ok(!!v && typeof v.verdict === "string",
    "cible introuvable : l'oracle rend quand meme un verdict, le scellement ne le bloque pas");
}


// ── O9 (TF-0607, 25/08) : UNE SOURCE DE VERITE DIT COMMENT ON S'Y AUTHENTIFIE ──────────────
// Le fait : un document donnait « deploiement via <commande> » et rien d'autre — ni variable,
// ni emplacement du justificatif, ni voie de repli. Et il declarait des `sources_de_verite`
// dont une commande d'etat qui, non authentifiee, rend « Unauthorized » : une sortie qu'un
// lecteur prend pour un fait sur l'infrastructure alors qu'elle parle de SA PROPRE SESSION.
// Les deux fixtures portent LES MEMES sources : seul le champ `authentification` les separe.
{
  const o9 = f => { const r = (() => { try { return JSON.parse(run(oracle, [f, "--json-only"])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { findings: [] }; } } })();
    return (r.findings || []).some(x => x.regle === "O9"); };
  const dir = path.join(ici, "..", "fixtures", "o9-sources-de-verite");
  ok(o9(path.join(dir, "sans-authentification.md")),
    "O9 : des sources de verite sans mode d'authentification -> constat");
  ok(!o9(path.join(dir, "avec-authentification.md")),
    "O9 : memes sources AVEC le champ authentification -> aucun constat (seul le champ les separe)");
  ok(!o9(path.join(ici, "self-test.mjs")),
    "O9 borne : un fichier sans frontmatter `sources_de_verite` n'est pas concerne");
}

// ── O12 (TF-1115, mesure Produit-11 du 14/09/2026) : UNE REMEDIATION DE SECURITE DIT SUR
// QUELS ENVIRONNEMENTS ELLE A ETE REJOUEE ──────────────────────────────────────────────────
// Le fait : une regle de pare-feu ouverte a tout Azure, retiree d'un environnement et
// documentee « appliquee » par une matrice qui ne connait qu'UN environnement — vingt jours
// plus tard la meme regle etait toujours presente sur l'environnement suivant, devenue sa
// SEULE voie d'acces. Meme doctrine qu'O-9 : seul le champ `environnements:` separe les deux
// fixtures, la meme remediation dans les deux cas.
{
  const o12 = f => { const r = (() => { try { return JSON.parse(run(oracle, [f, "--json-only"])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { findings: [] }; } } })();
    return (r.findings || []).some(x => x.regle === "O12"); };
  const dir12 = path.join(ici, "..", "fixtures", "o12-remediation-securite");
  ok(o12(path.join(dir12, "sans-environnements.md")),
    "O12 : remediation de securite sans liste d'environnements -> constat");
  ok(!o12(path.join(dir12, "avec-environnements.md")),
    "O12 : meme remediation AVEC la liste d'environnements -> aucun constat (seul le champ les separe)");
  ok(!o12(path.join(ici, "self-test.mjs")),
    "O12 borne : un fichier sans frontmatter `remediation_securite` n'est pas concerne");
}

// ── O11 (TF-1121, mesure Produit-11 du 14/09/2026) : UNE SONDE DE DISPONIBILITE VISE
// L'ADRESSE SERVIE, JAMAIS L'ORIGINE ───────────────────────────────────────────────────────
// Le fait : `infra-tf/monitoring.tf:181` posait `url = "https://${...ingress[0].fqdn}/"` — le
// nom de domaine de l'ORIGINE, injoignable derriere `publicNetworkAccess=Disabled` en
// qualification. La sonde etait Enabled, son alerte (severite 1) s'est declenchee dans la
// semaine — du bruit de severite 1 sans cause reelle.
{
  const o11 = (racine) => { try { return JSON.parse(run(oracle, ["--sonde-disponibilite", racine, "--json-only"])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };
  const dirRouge11 = path.join(ici, "..", "fixtures", "o11-sonde-disponibilite", "rouge");
  const rO11Rouge = o11(dirRouge11);
  ok(rO11Rouge.verdict === "FAIL", `O11 : sonde qui vise l'origine sans variable de repli -> FAIL (obtenu ${rO11Rouge.verdict})`);
  ok((rO11Rouge.findings || []).some(f => f.regle === "O11" && /ingress\[0\]\.fqdn/.test(f.msg)),
    "O11 : le constat nomme l'expression fautive (ingress[0].fqdn), pas un total anonyme");

  const dirVerte11 = path.join(ici, "..", "fixtures", "o11-sonde-disponibilite", "verte");
  const rO11Verte = o11(dirVerte11);
  ok(rO11Verte.verdict === "PASS", `O11 : meme sonde, adresse servie substituee via variable -> PASS (obtenu ${rO11Verte.verdict})`);

  // Bornage sur le code REEL du depot (scripts/), pas sur fixtures/ qui porte volontairement
  // une sonde rouge : ce depot ne produit ni ne consomme de Terraform, SKIP attendu.
  const rO11Skip = o11(path.join(ici, "..", "scripts"));
  ok(rO11Skip.verdict === "SKIP",
    `O11 borne : le code reel de ce depot (scripts/, aucun .tf) ne remonte aucun FAIL (obtenu ${rO11Skip.verdict})`);
}

// ── O13 (TF-1116 + TF-1118, mesure Produit-11 du 14/09/2026) : UN GESTE DESTRUCTIF PORTE
// SA MATURITE ET SA MESURE DE NON-REGRESSION ────────────────────────────────────────────────
// Le fait TF-1116 : un correctif eprouve sur un environnement, transpose tel quel a un second,
// etait INFAISABLE (161 adresses de sortie contre une seule) — rien ne distinguait le geste
// DEDUIT du geste EPROUVE. Le fait TF-1118 : dix lignes de suppression, aucune mesure de
// non-regression prescrite ; posee par prudence, elle a evite un retour arriere reel.
{
  const o13 = f => { const r = (() => { try { return JSON.parse(run(oracle, [f, "--json-only"])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { findings: [] }; } } })();
    return (r.findings || []).filter(x => x.regle === "O13"); };
  const dir13 = path.join(ici, "..", "fixtures", "o13-gestes-destructifs");
  const rouge13 = o13(path.join(dir13, "rouge.md"));
  ok(rouge13.some(f => /MATURITE/.test(f.msg)), "O13 : geste destructif sans marque de maturite -> constat");
  ok(rouge13.some(f => /NON-REGRESSION/.test(f.msg)), "O13 : geste destructif sans mesure de non-regression -> constat");
  ok(rouge13.length === 4, `O13 : DEUX gestes distincts x DEUX marques manquantes = 4 constats (obtenu ${rouge13.length})`);
  const verte13 = o13(path.join(dir13, "verte.md"));
  ok(verte13.length === 0, `O13 : memes gestes, les deux marques posees -> aucun constat (obtenu ${verte13.length})`);
  ok(o13(path.join(ici, "self-test.mjs")).length === 0,
    "O13 borne : ce fichier (aucun verbe destructif en tete de liste) ne remonte aucun constat");
}

// ── O14 (TF-1114, mesure Produit-11 du 14/09/2026) : L'INVENTAIRE DOCUMENTE CONTIENT
// CHAQUE NOM DE L'EXPORT REEL ────────────────────────────────────────────────────────────
// Le fait : un document d'inventaire verifie_le vieux de 34 jours, juge CONFORME par un
// oracle de presence de sections ; confronte a la main a un export du parc, 7 noms absents —
// dont cinq alertes ecrites « idem » et un nom entre accolades, jamais lus comme des noms.
{
  const o14 = (exp, doc) => { try { return JSON.parse(run(oracle, ["--inventaire-composants", exp, doc, "--json-only"])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };
  const dir14 = path.join(ici, "..", "fixtures", "o14-inventaire-composants");
  const exp14 = path.join(dir14, "export-reel.json");
  const rRouge14 = o14(exp14, path.join(dir14, "doc-incomplet.md"));
  ok(rRouge14.verdict === "FAIL", `O14 : document d'inventaire incomplet (« idem ») -> FAIL (obtenu ${rRouge14.verdict})`);
  ok((rRouge14.findings || []).filter(f => f.regle === "O14").length === 2,
    `O14 : les 2 noms absents (appi-exemple-qualif, id-exemple-api) sont NOMMES (obtenu ${(rRouge14.findings || []).filter(f => f.regle === "O14").length})`);
  ok((rRouge14.findings || []).some(f => f.where === "appi-exemple-qualif"), "O14 : le constat nomme la ressource fautive, pas un total anonyme");
  const rVerte14 = o14(exp14, path.join(dir14, "doc-complet.md"));
  ok(rVerte14.verdict === "PASS", `O14 : meme export, document complet -> PASS (obtenu ${rVerte14.verdict})`);
  ok(o14(path.join(dir14, "absent.json"), path.join(dir14, "doc-complet.md")).verdict === "donnees_insuffisantes",
    "O14 borne : export introuvable -> donnees_insuffisantes (aucun defaut implicite)");
}

// ── O15 (TF-1113 + TF-1117, mesures Produit-11 du 14/09/2026) : LE STATUT DECLARE TIENT FACE A
// L'EXPORT REEL, ET UN « SUPPRIMABLE » DIT CE QU'IL CASSE ─────────────────────────────────────
// Le fait TF-1113 : dix elements sans consommateur dans un document CONFORME, aucun statut pour
// distinguer ce qui sert de ce qui peut partir. Le fait TF-1117 : sur dix lignes « inutilisees »,
// cinq n'etaient pas supprimables — dont une regle de pare-feu qui portait l'adresse du poste en
// service. La rouge est ecrite SANS accents, la verte avec des graphies melees : les deux formes
// sont lues pareil. Messages rouges attendus (un par ligne fautive, cinq au total) :
//   - « ca-exemple-worker » declare « actif » mais ABSENT de l'export reel ;
//   - Statut « en service » hors du vocabulaire ferme ;
//   - « acr-exemple-ancien » supprimable avec « ce qui cesse de fonctionner » VIDE ;
//   - « fw-exemple-poste » supprimable avec « rien » sans mesure citee ;
//   - statut de supprimabilite « supprimable apres verification » hors du vocabulaire ferme.
{
  const o15 = (exp, doc) => { try { return JSON.parse(run(oracle, ["--statut-composants", exp, doc, "--json-only"])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };
  const dir15 = path.join(ici, "..", "fixtures", "o15-statut-composants");
  const exp15 = path.join(dir15, "export.json");
  const rRouge15 = o15(exp15, path.join(dir15, "doc-rouge.md"));
  const f15 = (rRouge15.findings || []).filter(f => f.regle === "O15");
  ok(rRouge15.verdict === "FAIL", `O15 : inventaire au statut faux ou au supprimable muet -> FAIL (obtenu ${rRouge15.verdict})`);
  ok(f15.some(f => f.where === "ca-exemple-worker" && /ABSENT de l'export/.test(f.msg)),
    "O15 : un composant « actif » absent de l'export est NOMME (ca-exemple-worker)");
  ok(f15.some(f => f.where === "st-exemple-archives" && /« en service ».*hors du vocabulaire fermé/.test(f.msg)),
    "O15 : un Statut hors vocabulaire (« en service ») -> constat");
  ok(f15.some(f => f.where === "acr-exemple-ancien" && /VIDE/.test(f.msg)),
    "O15 : un « supprimable » sans « ce qui cesse de fonctionner » -> constat");
  ok(f15.some(f => f.where === "fw-exemple-poste" && /« rien ».*sans mesure citée/.test(f.msg)),
    "O15 : un « supprimable » qui dit « rien » sans mesure -> constat");
  ok(f15.some(f => f.where === "sc-exemple-deploiement" && /supprimabilité.*hors du vocabulaire fermé/.test(f.msg)),
    "O15 : un statut de supprimabilite hors vocabulaire -> constat");
  ok(f15.length === 5, `O15 : cinq lignes fautives, cinq constats (obtenu ${f15.length})`);
  const rVerte15 = o15(exp15, path.join(dir15, "doc-vert.md"));
  ok(rVerte15.verdict === "PASS", `O15 : meme parc, statuts au vocabulaire (accentues ou non), « rien » mesure -> PASS (obtenu ${rVerte15.verdict})`);
  ok(o15(exp15, path.join(ici, "..", "fixtures", "o14-inventaire-composants", "doc-complet.md")).verdict === "SKIP",
    "O15 borne : un document sans colonne Statut ni section Inutilises -> SKIP (sa presence releve de R-20)");
  ok(o15(path.join(dir15, "absent.json"), path.join(dir15, "doc-vert.md")).verdict === "donnees_insuffisantes",
    "O15 borne : export introuvable -> donnees_insuffisantes (aucun defaut implicite)");
}

// ── O16 (TF-1120, mesure Produit-11 du 14/09/2026) : UN NETTOYAGE D'INFRASTRUCTURE SE CLOT
// SUR TROIS QUESTIONS ────────────────────────────────────────────────────────────────────────
// Le fait : un nettoyage restitue et double d'un journal date, juge complet, dont deux volets sur
// trois n'avaient jamais ete regardes ; seule une question humaine les a fait apparaitre.
// Messages rouges attendus :
//   rouge.md (detecte par son titre, forme liste) : deux constats —
//     « ce qui la crée est-il traité ? » sans PREUVE ;
//     sans la question de cloture « le prochain environnement la recréera-t-il ? » ;
//   rouge-table.md (detecte par son frontmatter, forme table) : un constat —
//     « le prochain environnement la recréera-t-il ? » sans PREUVE (cellule « — »).
{
  const o16 = f => { const r = (() => { try { return JSON.parse(run(oracle, [f, "--json-only"])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { findings: [] }; } } })();
    return (r.findings || []).filter(x => x.regle === "O16"); };
  const dir16 = path.join(ici, "..", "fixtures", "o16-cloture-nettoyage");
  const rouge16 = o16(path.join(dir16, "rouge.md"));
  ok(rouge16.some(f => /ce qui la crée est-il traité/.test(f.msg) && /sans PREUVE/.test(f.msg)),
    "O16 : question de cloture posee et repondue, preuve vide -> constat");
  ok(rouge16.some(f => /sans la question de cloture « le prochain environnement la recréera-t-il \? »/.test(f.msg)),
    "O16 : question de cloture absente (prochain environnement) -> constat qui la NOMME");
  ok(rouge16.length === 2, `O16 : un manque de preuve + une question absente = 2 constats (obtenu ${rouge16.length})`);
  const rougeTable16 = o16(path.join(dir16, "rouge-table.md"));
  ok(rougeTable16.length === 1 && /prochain environnement/.test(rougeTable16[0].msg) && /sans PREUVE/.test(rougeTable16[0].msg),
    `O16 : forme table, cellule Preuve « — » -> 1 constat nommant la question (obtenu ${rougeTable16.length})`);
  ok(o16(path.join(dir16, "verte.md")).length === 0,
    "O16 : trois questions, reponses et preuves posees (ecrit sans accents, forme liste) -> aucun constat");
  ok(o16(path.join(dir16, "verte-table.md")).length === 0,
    "O16 : meme cloture en table, detectee par le frontmatter -> aucun constat");
  const reels16 = ["README.md", "CLAUDE.md", path.join("references", "GESTES-EXPLOITATION.md")]
    .map(f => o16(path.join(ici, "..", f)).length);
  ok(reels16.every(n => n === 0) && o16(path.join(ici, "..", "fixtures", "o13-gestes-destructifs", "verte.md")).length === 0,
    `O16 borne : documents reels du depot et carnet d'ecarts sans nettoyage declare -> aucun constat (obtenu ${reels16.join("/")})`);
}

// G-03 (TF-0611/0613/0610, 25/08) — LES DEUX JUGES DE LA MIGRATION DNS. Leur recette vit dans
// l'outil lui-meme (`--self-test`, 17 cas, les deux sens sur les trois regles) ; elle est REJOUEE
// ici pour que l'invariant du depot la couvre — un controle que la recette du depot ne joue pas
// est un controle qu'on peut oublier de brancher, et c'est exactement la classe que TF-0583 nomme.
{
  const outil = path.join(ici, '..', 'scripts', 'verifier-migration-dns.mjs');
  let sortie = '';
  // `run` ajoute deja l'interpreteur : le passer une seconde fois lancait node sur node.
  try { sortie = run(outil, ['--self-test']); }
  catch (e) { sortie = String(e.stdout || '') + String(e.stderr || ''); }
  const m = sortie.match(/Recette verifier-migration-dns : (\d+)\/(\d+)/);
  ok(!!m && m[1] === m[2], `verifier-migration-dns : recette entierement verte (${m ? m[0] : 'sortie illisible'})`);
}

// ── O10 · manifeste de dépendances SERVI épinglé à l'empreinte (TF-1042, mesure Produit-11) ──
// Le fait rejoué : un requirements.txt épinglait 37 paquets par version, aucun par empreinte
// — une version republiée sous le même numéro serait entrée sans être vue.
console.log("");
const o10 = (fichier) => { try { return JSON.parse(run(oracle, ["--manifeste-servi", fichier, "--json-only"])); }
  catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };

// ROUGE — l'état exact mesuré : épinglé par version, aucune empreinte.
const manifesteSansHash = path.join(base, "requirements-sans-hash.txt");
fs.writeFileSync(manifesteSansHash, "fastapi==0.111.0\nuvicorn==0.30.1\n# commentaire\npydantic==2.7.4\n", "utf8");
const rO10Rouge = o10(manifesteSansHash);
ok(rO10Rouge.verdict === "FAIL", `manifeste épinglé par version sans empreinte → FAIL (obtenu ${rO10Rouge.verdict})`);
ok(rO10Rouge.findings.filter(f => f.regle === "O10").length === 3,
  `les 3 paquets sans empreinte sont NOMMÉS (obtenu ${rO10Rouge.findings.filter(f => f.regle === "O10").length})`);
ok(rO10Rouge.findings.some(f => f.where === "fastapi"), "le constat nomme le paquet fautif (fastapi), pas un total anonyme");

// VERTE — même manifeste, chaque ligne épinglée porte désormais une empreinte.
const manifesteAvecHash = path.join(base, "requirements-avec-hash.txt");
fs.writeFileSync(manifesteAvecHash,
  "fastapi==0.111.0 --hash=sha256:" + "a".repeat(64) + "\n"
  + "uvicorn==0.30.1 --hash=sha256:" + "b".repeat(64) + "\n"
  + "pydantic==2.7.4 --hash=sha256:" + "c".repeat(64) + "\n",
  "utf8");
ok(o10(manifesteAvecHash).verdict === "PASS", "même manifeste, empreinte posée sur chaque ligne → PASS");

// SKIP — rien d'épinglé par version exacte (URL, plage) : rien à contrôler, jamais un faux positif.
const manifesteSansPin = path.join(base, "requirements-sans-pin.txt");
fs.writeFileSync(manifesteSansPin, "requests>=2.31\n-e git+https://example.com/pkg.git#egg=pkg\n", "utf8");
ok(o10(manifesteSansPin).verdict === "SKIP", "manifeste sans épinglage de version exacte → SKIP, jamais un faux positif");

// BORNE — manifeste introuvable : donnees_insuffisantes, jamais un FAIL par défaut implicite.
ok(o10(path.join(base, "absent.txt")).verdict === "donnees_insuffisantes",
  "manifeste introuvable → donnees_insuffisantes (aucun défaut implicite)");

fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
console.log(`\nSelf-test forge-ops : ${pass} PASS, ${echec} FAIL`);
process.exit(echec ? 1 : 0);

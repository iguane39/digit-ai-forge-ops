#!/usr/bin/env node
// self-test.mjs — preuve par le geste : rejoue un DÉPLOIEMENT RÉEL local (fixture
// d'acceptation TF-0040) puis prouve que chaque défaut type est refusé.
//   Verte : déployer v1 → oracle PASS → déployer v2 → PASS → restaurer → PASS
//           (journal 3 événements, COURANT revenu à v1).
//   Rouges : healthcheck en échec → déploiement refusé, COURANT intact ;
//            journal corrompu → oracle FAIL O3 ; pointeur fantôme → FAIL O1 ;
//            restauration sans précédente → refus.
// Exit 0 si tous les contrôles passent, 1 sinon. À rejouer après toute modification.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
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

// ── TF-1805 (lot Produit-83 du 15/10/2026, RO-2) : la cible par défaut du pilot est un CONTENEUR
// Docker local (ETAPE-MEP § 1). `restaurer` n'y trouvait pas de COURANT et répondait « rien à
// restaurer » : une phrase fausse sur un staging qui servait bel et bien une version N.
{
  const dock = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-tf1805-"));
  try {
    fs.writeFileSync(path.join(dock, "Dockerfile"), "FROM scratch\n", "utf8");
    fs.writeFileSync(path.join(dock, "docker-compose.yml"), "services:\n  app:\n    image: produit:run-2\n", "utf8");
    const r = spawnSync(process.execPath, [ops, "restaurer", dock], { encoding: "utf8" });
    const err = String(r.stderr || "");
    ok(r.status === 2, `TF-1805 · cible conteneur Docker -> refus HORS CONTRAT exit 2, jamais « rien à restaurer » (obtenu exit ${r.status})`);
    ok(/conteneur Docker/.test(err) && /ROLLBACK\.md/.test(err) && /docker compose/.test(err) && !/rien à restaurer/.test(err),
      `TF-1805 · le refus nomme la cible, le geste manuel et ROLLBACK.md (obtenu « ${err.trim().slice(0, 90)} »)`);
    ok(!fs.existsSync(path.join(dock, "journal.jsonl")) && !fs.existsSync(path.join(dock, "COURANT")),
      "TF-1805 · le refus n'écrit rien dans le dossier du produit");
  } finally {
    fs.rmSync(dock, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

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
for (const cible of ["railway", "gcp", "azure", "aws", "databricks-bundle", "powerbi-workspace", "supabase", "cloudflare-workers"]) {
  const pf = path.join(base, `plan-${cible}.json`);
  run(ops, ["plan", cible, fx("app-verte"), "--sortie", pf]);
  const p = JSON.parse(fs.readFileSync(pf, "utf8"));
  ok(p.format === "forge-ops/plan@1" && ["provision", "deploiement", "healthcheck", "rollback"].every(k => p.phases[k]?.length),
    `plan ${cible} : 4 phases générées (déterministe, zéro exécution)`);
  ok(verdictPlan(pf) === "PASS", `oracle O-5 PASS sur le plan ${cible}`);
}
// TF-1685 (14/10/2026) : le plan azure employait <ENV>, <DOMAINE_ENV> et <BUILD> sans les
// déclarer (gcp : <DEPOT> et <BUILD>, aws : <BUILD>) ; un consommateur qui ne remplit que les
// jetons déclarés les laisse bruts dans la commande. Contrôle GÉNÉRIQUE : tout jeton <MAJUSCULES>
// d'une phase figure dans `placeholders`. Plan généré avec build="<BUILD>" : la substitution est
// alors l'identité, et le contrôle voit la source entière, <BUILD> compris.
const jetonsNonDeclares = (p) => {
  const declares = new Set(p.placeholders || []);
  const employes = new Set(JSON.stringify(p.phases || {}).match(/<[A-Z][A-Z0-9_]*>/g) || []);
  return [...employes].filter(j => !declares.has(j)).sort();
};
for (const cible of ["railway", "gcp", "azure", "aws", "databricks-bundle", "powerbi-workspace", "supabase", "cloudflare-workers"]) {
  const nd = jetonsNonDeclares(JSON.parse(run(ops, ["plan", cible, "<BUILD>"])));
  ok(nd.length === 0, `plan ${cible} : tout jeton <MAJUSCULES> employé est déclaré dans placeholders${nd.length ? ` — non déclarés : ${nd.join(" ")}` : ""} (TF-1685)`);
}
// Supabase (16/10/2026) : paire de fixtures figées — la verte passe O-5, une rouge sans
// rollback et une rouge dont le déploiement n'emploie pas le CLI `supabase ` échouent.
ok(verdictPlan(fx("o5-supabase/plan-vert.json")) === "PASS", "fixture plan supabase complet → O-5 PASS");
ok(verdictPlan(fx("o5-supabase/plan-rouge-rollback-vide.json")) === "FAIL", "fixture plan supabase sans rollback → O-5 FAIL");
ok(verdictPlan(fx("o5-supabase/plan-rouge-sans-cli.json")) === "FAIL", "fixture plan supabase sans commande `supabase ` au déploiement → O-5 FAIL");
// TF-2007 (29/10/2026) : les rouges échouent pour LEUR raison seule, et le plan du 16/10 (ancienne verte)
// devient rouge sur les 4 garde-fous neufs : rejeu local, dérive, secrets avant fonctions, voie unique.
{
  const constats = (f) => { try { return JSON.parse(run(oracle, ["--plan", fx(f), "--json-only"])).findings; }
    catch (e) { try { return JSON.parse(String(e.stdout)).findings; } catch { return []; } } };
  const rb = constats("o5-supabase/plan-rouge-rollback-vide.json");
  const sc = constats("o5-supabase/plan-rouge-sans-cli.json");
  ok(rb.length === 1 && /phase « rollback » absente ou vide/.test(rb[0].msg), `fixture supabase sans rollback : un seul constat, celui du rollback (obtenu ${rb.length})`);
  ok(sc.length === 1 && /CLI attendue « supabase »/.test(sc[0].msg), `fixture supabase sans CLI : un seul constat, celui de la CLI « supabase » (obtenu ${sc.length})`);
  const av = constats("o5-supabase/plan-rouge-avant-tf2007.json");
  const motifs = [/sans rejeu préalable sur une base locale vide/, /sans contrôle de dérive du projet distant/, /fonctions déployées avant la pose de leurs secrets/, /voie de déploiement n'est pas tranchée[\s\S]*Deploy to production/];
  ok(av.length === 4 && motifs.every(m => av.some(f => f.sev === "majeur" && /TF-2007/.test(f.msg) && m.test(f.msg))),
    `TF-2007 · ROUGE — le plan supabase du 16/10 (ancienne verte) : exactement les 4 garde-fous neufs manquants, chacun nommé (obtenu ${av.length})`);
  // TF-1013 : le remède nommé, les 4 lignes du plan neuf posées dans l'ancien, rend O-5 PASS.
  const neuf = JSON.parse(run(ops, ["plan", "supabase", "<BUILD>"]));
  const ancien = JSON.parse(fs.readFileSync(fx("o5-supabase/plan-rouge-avant-tf2007.json"), "utf8"));
  const prendre = (ph, re) => neuf.phases[ph].find(l => re.test(l));
  ancien.phases.provision.push(prendre("provision", /Deploy to production/), prendre("provision", /^supabase db reset --local/), prendre("provision", /^supabase db diff --linked/));
  ancien.phases.deploiement.splice(ancien.phases.deploiement.findIndex(l => /^supabase functions deploy/.test(l)), 0, prendre("deploiement", /^supabase secrets set/));
  const pRemede = path.join(base, "plan-supabase-remede-tf2007.json");
  fs.writeFileSync(pRemede, JSON.stringify(ancien), "utf8");
  ok(verdictPlan(pRemede) === "PASS", "TF-2007 · remède joué : les 4 lignes nommées posées dans le plan du 16/10 -> O-5 PASS (TF-1013)");
  // Le plan neuf : l'ordre, les sources du jour, la dépense dite humaine, et un retour arrière pour fonctions et secrets.
  const ordre = [...neuf.phases.provision, ...neuf.phases.deploiement];
  const rang = (re) => ordre.findIndex(l => re.test(l));
  ok(rang(/^supabase start /) < rang(/^supabase db reset --local/) && rang(/^supabase db reset --local/) < rang(/^supabase db push --linked/)
      && rang(/^supabase db diff --linked/) < rang(/^supabase db push --linked/) && rang(/^supabase secrets set /) < rang(/^supabase functions deploy /),
    "TF-2007 · plan supabase : pile locale, rejeu et dérive AVANT le push ; secrets AVANT les fonctions");
  const pv = neuf.phases.provision.join(" ");
  ok(/DEPENSE/.test(pv) && /decision humaine \(R-29\)/.test(pv) && pv.includes("$0.01344 per hour") && pv.includes("manage-your-usage/branching, lues le 29/10/2026"),
    "TF-2007 · plan supabase : le branching est dit pour ce qu'il est, une dépense à décision humaine (R-29), tarif cité et sourcé");
  ok(pv.includes("Deploy to production") && pv.includes("branching/github-integration, lue le 29/10/2026") && /UNE seule voie de deploiement/.test(pv),
    "TF-2007 · plan supabase : une seule voie face à l'intégration GitHub (« Deploy to production »), source datée");
  ok(pv.includes("verify_jwt = false") && pv.includes("function-configuration, lue le 29/10/2026"),
    "TF-2007 · plan supabase : une fonction ouverte sans JWT se nomme au dossier de MEP, source datée");
  const sec = neuf.phases.deploiement.find(l => /^supabase secrets set /.test(l)) || "";
  ok(/GO humain \(R-38\)/.test(sec) && sec.includes("jamais versionne") && sec.includes("functions/secrets et https://supabase.com/docs/reference/cli/supabase-secrets-set, lues le 29/10/2026"),
    "TF-2007 · plan supabase : poser un secret change la production aussitôt, sous GO humain ; fichier jamais versionné ; sources datées");
  const rbNeuf = neuf.phases.rollback.join(" ");
  ok(rbNeuf.includes("supabase functions deploy <FONCTION>") && rbNeuf.includes("supabase secrets unset <NOM_SECRET>"),
    "TF-2007 · plan supabase : le retour arrière couvre les fonctions (version précédente du dépôt) et les secrets (unset)");
}
// Le retour arrière supabase ne promet pas de migration « down » et marque la restauration comme
// geste humain irréversible (source officielle citée, datée).
{
  const rb = JSON.parse(run(ops, ["plan", "supabase", "<BUILD>"])).phases.rollback.join(" ");
  ok(rb.includes("AUCUNE migration « down »") && rb.includes("GESTE HUMAIN IRREVERSIBLE") && rb.includes("https://supabase.com/docs/guides/platform/backups, lue le 16/10/2026"),
    "plan supabase : rollback par migration corrective, restauration marquée humaine et irréversible, source datée");
}
// Cloudflare Workers (28/10/2026, TF-1995) : paire de fixtures figées — la verte passe O-5, une rouge
// sans rollback et une rouge dont le déploiement n'emploie pas la CLI `wrangler ` échouent.
ok(verdictPlan(fx("o5-cloudflare-workers/plan-vert.json")) === "PASS", "fixture plan cloudflare-workers complet → O-5 PASS");
ok(verdictPlan(fx("o5-cloudflare-workers/plan-rouge-rollback-vide.json")) === "FAIL", "fixture plan cloudflare-workers sans rollback → O-5 FAIL");
ok(verdictPlan(fx("o5-cloudflare-workers/plan-rouge-sans-cli.json")) === "FAIL", "fixture plan cloudflare-workers sans commande `wrangler ` au déploiement → O-5 FAIL");
// Les rouges échouent pour la BONNE raison, pas pour une cible inconnue (leçon du banc : une rouge
// qui échoue à côté de sa règle ne prouve rien).
{
  const raisons = (f) => { try { return JSON.parse(run(oracle, ["--plan", fx(f), "--json-only"])).findings; }
    catch (e) { try { return JSON.parse(String(e.stdout)).findings; } catch { return []; } } };
  const rb = raisons("o5-cloudflare-workers/plan-rouge-rollback-vide.json");
  const sc = raisons("o5-cloudflare-workers/plan-rouge-sans-cli.json");
  ok(rb.length === 1 && /phase « rollback » absente ou vide/.test(rb[0].msg), `fixture cloudflare-workers sans rollback : un seul constat, celui du rollback (obtenu ${rb.length})`);
  ok(sc.length === 1 && /CLI attendue « wrangler »/.test(sc[0].msg), `fixture cloudflare-workers sans CLI : un seul constat, celui de la CLI « wrangler » (obtenu ${sc.length})`);
}
// Le plan cloudflare-workers : le retour arrière est le geste NATIF `wrangler rollback` (source datée),
// il dit ce qu'il ne défait pas (ressources liées), la bascule passe par `versions upload` puis
// `versions deploy` (jamais `wrangler deploy` joué pour de bon), et le fait du guide de migration —
// Workers n'accepte pas un domaine dont les serveurs de noms ne sont pas chez Cloudflare — est noté
// dans la cible. Aucune valeur de jeton : seulement le NOM des variables.
{
  const cf = JSON.parse(run(ops, ["plan", "cloudflare-workers", "<BUILD>"]));
  const rb = cf.phases.rollback.join(" ");
  const dep = cf.phases.deploiement.join(" ");
  const hc = cf.phases.healthcheck.join(" ");
  const pv = cf.phases.provision.join(" ");
  ok(/npx wrangler rollback <ID_VERSION_PRECEDENTE> /.test(rb) && rb.includes("https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/, lue le 28/10/2026"),
    "plan cloudflare-workers : rollback par `wrangler rollback` sur une version nommée, source datée");
  ok(rb.includes("il ne change PAS les ressources liees") && rb.includes("REFUSE si une classe de Durable Object"),
    "plan cloudflare-workers : le rollback dit ce qu'il ne défait pas et quand il est refusé");
  ok(/wrangler versions upload /.test(dep) && /wrangler versions deploy <ID_VERSION>@100%/.test(hc) && /wrangler deploy --dry-run/.test(dep)
      && !cf.phases.deploiement.concat(cf.phases.healthcheck).some(l => /^npx wrangler deploy\b/.test(l) && !/^npx wrangler deploy --dry-run /.test(l)),
    "plan cloudflare-workers : version téléversée sans trafic puis déployée ; `wrangler deploy` seulement à blanc");
  ok(pv.includes("Unlike Pages, Workers does not support any domain whose nameservers are not managed by Cloudflare") && pv.includes("migrate-from-pages/, lue le 28/10/2026"),
    "plan cloudflare-workers : le fait du guide de migration (serveurs de noms chez Cloudflare) est noté, source datée");
  ok(pv.includes("CLOUDFLARE_API_TOKEN") && pv.includes("CLOUDFLARE_ACCOUNT_ID") && !/(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)\s*[=:]\s*\S/.test(JSON.stringify(cf)),
    "plan cloudflare-workers : variables d'identité nommées, aucune valeur affectée");
  ok(/GO humain[^;#]*\(R-38\)/.test(dep) && /GO humain[^;#]*\(R-38\)/.test(hc) && /GO humain[^;#]*\(R-38\)/.test(rb),
    "plan cloudflare-workers : publication, bascule et retour arrière sous GO humain (R-38)");
}
// TF-2010 (part ops) : l'enchaînement d'un front Workers et d'une base Supabase est un document
// CÂBLÉ (loi n° 1) — CLAUDE.md et README le nomment, le plan cloudflare-workers y renvoie — et SOURCÉ
// (chaque source porte son adresse et sa date de lecture). Il nomme les variables des deux plateformes
// sans leur donner de valeur, et l'oracle de documents le juge sans écart.
{
  const docChemin = path.join(ici, "..", "references", "ENCHAINEMENT-PLANS.md");
  const doc = fs.existsSync(docChemin) ? fs.readFileSync(docChemin, "utf8") : "";
  const sources = [...doc.matchAll(/^  - url: (https:\/\/\S+)\r?\n    lu_le: (\d{4}-\d{2}-\d{2})\r?$/gm)];
  ok(doc.length > 0 && sources.length >= 10 && sources.every(m => m[2] === "2026-10-28"),
    `ENCHAINEMENT-PLANS.md : sources[] avec adresse et date de lecture (obtenu ${sources.length} sources)`);
  ok(doc.includes("supabase db push") && doc.includes("wrangler versions upload") && doc.includes("wrangler rollback"),
    "ENCHAINEMENT-PLANS.md : les gestes des deux plans y sont nommés");
  const cfPlan = JSON.parse(run(ops, ["plan", "cloudflare-workers", "<BUILD>"]));
  const nomsPlan = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];
  const nomsSupabase = ["SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD", "SUPABASE_PROJECT_ID", "SUPABASE_URL"];
  ok([...nomsPlan, ...nomsSupabase].every(n => doc.includes(n)) && !/\b(CLOUDFLARE|SUPABASE)_[A-Z_]+\s*[=:]\s*["'`]?[A-Za-z0-9]/.test(doc.replace(/^sources:[\s\S]*?^---$/m, "")),
    "ENCHAINEMENT-PLANS.md : variables des deux plateformes nommées, aucune valeur affectée");
  // ROUGE du contrôle de valeur : une affectation, quelle qu'en soit la forme, serait vue.
  const motifValeur = /\b(CLOUDFLARE|SUPABASE)_[A-Z_]+\s*[=:]\s*["'`]?[A-Za-z0-9]/;
  ok(motifValeur.test("SUPABASE_URL=abc123") && motifValeur.test("CLOUDFLARE_API_TOKEN: \"x9\"") && !motifValeur.test("`SUPABASE_URL` et `SUPABASE_KEY` par `wrangler secret put`"),
    "contrôle des valeurs affectées : une affectation est vue, un nom cité dans la prose ne l'est pas");
  ok(cfPlan.phases.provision.some(l => l.includes("references/ENCHAINEMENT-PLANS.md")) && ["CLAUDE.md", "README.md"].every(f =>
      fs.readFileSync(path.join(ici, "..", f), "utf8").includes("ENCHAINEMENT-PLANS.md")),
    "ENCHAINEMENT-PLANS.md : appelé par CLAUDE.md, README.md et la provision du plan cloudflare-workers (loi n° 1)");
  ok(doc.includes("https://supabase.com/docs/guides/auth/redirect-urls") && doc.includes("*-<NOM_WORKER>.<SOUS_DOMAINE>.workers.dev/**"),
    "ENCHAINEMENT-PLANS.md : l'URL de redirection des prévisualisations est donnée, avec la page Supabase qui la fonde");
  let verdictDoc = "ILLISIBLE";
  try { verdictDoc = JSON.parse(run(oracle, [docChemin, "--json-only"])).verdict; }
  catch (e) { try { verdictDoc = JSON.parse(String(e.stdout)).verdict; } catch { /* reste ILLISIBLE */ } }
  ok(verdictDoc === "PASS", `ENCHAINEMENT-PLANS.md : oracle de documents (O9, O12, O13, O16) sans écart (obtenu ${verdictDoc})`);
}
// ROUGE : plan jouet dont une commande emploie <JETON_OUBLIE> absent de placeholders ; les jetons
// en minuscules (<appli>, <nom-service>) restent de la prose, jamais des jetons à remplir.
{
  const jouet = { placeholders: ["<RG>"], phases: { provision: ["az group create --name <RG> --location <JETON_OUBLIE>   # <appli>-qualif"], deploiement: [], healthcheck: [], rollback: [] } };
  const nd = jetonsNonDeclares(jouet);
  ok(nd.length === 1 && nd[0] === "<JETON_OUBLIE>", `plan jouet avec un jeton non déclaré → le contrôle le NOMME (obtenu ${JSON.stringify(nd)}) (TF-1685)`);
}
// TF-1684 (volet 3 de TF-1639) : la provision azure pose un budget AVEC alerte par groupe de
// ressources — la commande est là, avant l'environnement, son seuil et son destinataire sont des
// jetons déclarés, sa source officielle est citée avec sa date de lecture. Hors ligne : jamais
// un appel à Azure.
{
  const az = JSON.parse(run(ops, ["plan", "azure", "<BUILD>"]));
  const pv = az.phases.provision;
  const alerteBudget = (l) => /^az consumption budget create-with-rg /.test(l) && /--resource-group <RG>/.test(l)
    && /--notifications "\{\w*<SEUIL_ALERTE_PCT>\w*:\{enabled:true,/.test(l) && /contact-emails:\[<DESTINATAIRE_ALERTE_COUT>\]/.test(l);
  const iBudget = pv.findIndex(alerteBudget);
  const budget = pv[iBudget] || "";
  ok(iBudget > pv.findIndex(l => /^az group create /.test(l)) && iBudget < pv.findIndex(l => /^az containerapp env create /.test(l)),
    `plan azure : budget AVEC notification posé sur le groupe de ressources, après sa création (indice ${iBudget}) (TF-1684)`);
  const jetons = ["<BUDGET_MENSUEL>", "<SEUIL_ALERTE_PCT>", "<DESTINATAIRE_ALERTE_COUT>", "<DEBUT_MOIS>"];
  ok(jetons.every(j => budget.includes(j) && az.placeholders.includes(j)),
    "plan azure : montant, seuil, destinataire et début de période de l'alerte sont des jetons déclarés (TF-1684)");
  ok(/source : https:\/\/learn\.microsoft\.com\/\S*consumption\/budget\S*, lue le \d{2}\/\d{2}\/\d{4}/.test(budget),
    "plan azure : la commande de budget cite sa source officielle Microsoft et la date de lecture (TF-1684)");
  // ROUGE : la même ligne réduite à `az consumption budget create` (sans --notifications), la forme
  // qu'un lecteur pressé prendrait, n'est PAS une alerte : le contrôle la refuse.
  const muet = budget.replace("create-with-rg", "create").replace(/--notifications "[^"]*"/, "");
  ok(budget !== "" && !alerteBudget(muet),
    "plan azure : un budget sans --notifications (budget muet) ne satisfait pas le contrôle (TF-1684)");
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

// TF-1217 : le motif de credential (AKIA/ghp_/sk-/BEGIN PRIVATE KEY) cherche des FORMATS de
// clé réelle — il laisse passer un secret TRIVIAL en clair dans un champ mot_de_passe/
// password/secret/jeton (ex. "password": "azerty123", zéro entropie, aucun préfixe connu).
const planJson = (fichier) => { try { return JSON.parse(run(oracle, ["--plan", fichier, "--json-only"])); }
  catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };
// ROUGE : plan hors zone fixture, champ password littéral → O-5 FAIL, finding nommant TF-1217.
const pSecret = path.join(base, "plan-secret-trivial.json");
run(ops, ["plan", "railway", fx("app-verte"), "--sortie", pSecret]);
const docSecret = JSON.parse(fs.readFileSync(pSecret, "utf8"));
docSecret.environnement = { password: "azerty123" };
fs.writeFileSync(pSecret, JSON.stringify(docSecret), "utf8");
const rSecret = planJson(pSecret);
ok(rSecret.verdict === "FAIL", "plan avec secret trivial en clair (password) hors fixture → O-5 FAIL (TF-1217)");
ok((rSecret.findings || []).some(f => f.regle === "O5" && /TF-1217/.test(f.msg)),
  "plan avec secret trivial : le finding nomme TF-1217");
// VERTE : même secret trivial, mais plan déclaré sous fixtures/ (exemption de test) → O-5 PASS.
ok(planJson(fx("o5-secret-trivial/plan-secret-fixture.json")).verdict === "PASS",
  "plan équivalent déclaré sous fixtures/ (exemption de test) → O-5 PASS (TF-1217)");

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

// (g) TF-1806 (lot Produit-83 du 15/10/2026, RO-3) : un WORKER qui planifie lui-même (boucle à
// intervalles dans le code, ou bibliothèque de planification) ne laisse aucun fichier cron. O-8
// rendait « aucune définition planifiée — rien à juger », SKIP, alors que trois tâches tournaient
// à cadence et qu'un mode d'exercice à la demande existait. Le worker se lit désormais ; sa
// déclaration `exercice_a_la_demande:` fait le PASS, son absence est DITE (avertissement).
const worker = (nom, entete) => {
  const d = path.join(base, "depot-worker-" + nom);
  fs.mkdirSync(path.join(d, "backend", "app"), { recursive: true });
  fs.writeFileSync(path.join(d, "backend", "app", "batch.py"), [
    '"""Worker : santé, rafraîchissement planifié, purge.',
    ...entete,
    '"""',
    "from datetime import timedelta",
    "INTERVALLE_PURGE = timedelta(days=1)",
    "def main():",
    "    while True:",
    "        traiter_une_fois()",
  ].join("\n") + "\n", "utf8");
  return d;
};
const rWorkerDeclare = o8(worker("declare", [
  "exercice_a_la_demande: python -m app.cli executer-tache purge",
  "exerce_le: 2026-10-15",
]));
ok(rWorkerDeclare.verdict === "PASS" && (rWorkerDeclare.findings || []).some(f => /exercé le 2026-10-15/.test(f.msg) && f.where === "backend/app/batch.py"),
  `TF-1806 · worker planifié en code, exercice déclaré → PASS localisé (obtenu ${rWorkerDeclare.verdict})`);
const rWorkerMuet = o8(worker("muet", []));
ok(rWorkerMuet.verdict === "SKIP" && (rWorkerMuet.findings || []).some(f => /EN CODE/.test(f.msg) && /exercice_a_la_demande/.test(f.msg) && f.where === "backend/app/batch.py")
  && !(rWorkerMuet.findings || []).some(f => /rien à juger/.test(f.msg)),
  `TF-1806 · ROUGE — worker planifié sans déclaration → avertissement qui le NOMME, jamais « rien à juger » (obtenu ${rWorkerMuet.verdict}, ${(rWorkerMuet.findings || []).map(f => f.msg.slice(0, 40)).join(" | ")})`);


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

  // TF-1804 (lot Produit-83 du 15/10/2026, RO-1) : ETAPE-MEP § 3 septies prescrit
  // `oracle-ops.mjs <document.md>`. Le document conforme sortait FAIL O1/O3 (« COURANT absent »,
  // « journal.jsonl absent ») : l'oracle le jugeait AUSSI comme une cible de release, et
  // scellait ce FAIL dans .ops-journal.jsonl a cote du document.
  const tmp13 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-tf1804-"));
  try {
    const juger = f => { try { return { code: 0, j: JSON.parse(run(oracle, [f, "--json-only"])) }; }
      catch (e) { try { return { code: e.status, j: JSON.parse(String(e.stdout)) }; } catch { return { code: e.status, j: {} }; } } };
    const docVert = path.join(tmp13, "DOSSIER-MEP.md");
    fs.copyFileSync(path.join(dir13, "verte.md"), docVert);
    const v = juger(docVert);
    const reglesCible = (v.j.findings || []).filter(f => ["O1", "O2", "O3", "O4"].includes(f.regle));
    ok(v.j.verdict === "PASS" && v.code === 0 && reglesCible.length === 0,
      `TF-1804 · document conforme -> PASS exit 0, sans O1-O4 (obtenu ${v.j.verdict}, exit ${v.code}, ${reglesCible.map(f => f.regle).join(",") || "aucune regle de cible"})`);
    const scelle = fs.readFileSync(path.join(tmp13, ".ops-journal.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    ok(scelle.length === 1 && scelle[0].verdict === "PASS" && scelle[0].nature === "document",
      `TF-1804 · le journal scelle le verdict du DOCUMENT, jamais un FAIL de cible (obtenu ${scelle.map(s => s.verdict + "/" + s.nature).join(",")})`);
    const docRouge = path.join(tmp13, "rouge.md");
    fs.copyFileSync(path.join(dir13, "rouge.md"), docRouge);
    const r = juger(docRouge);
    ok(r.j.verdict === "FAIL" && r.code === 1 && (r.j.findings || []).every(f => !["O1", "O3"].includes(f.regle))
      && (r.j.findings || []).some(f => f.regle === "O13"),
      `TF-1804 · ROUGE — document aux gestes non marques -> FAIL par O13 seul (obtenu ${r.j.verdict}, ${[...new Set((r.j.findings || []).map(f => f.regle))].join(",")})`);
  } finally {
    fs.rmSync(tmp13, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
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

// ── O17 (TF-1122, mesure Produit-11 du 14/09/2026) : UNE RESSOURCE LUE PAR LA PILE EST UN
// PREREQUIS D'ENVIRONNEMENT DECLARE ─────────────────────────────────────────────────────────
// Le fait : sept blocs `data` lus et jamais crees par la pile, crees ailleurs par la pile d'une
// autre application, ecrits nulle part ; en production le groupe n'existait pas.
// Messages rouges attendus :
//   rouge/ (artefact incomplet) : deux constats —
//     bloc data.azurerm_container_app_environment.execution ABSENT de PREREQUIS-ENVIRONNEMENT.md ;
//     prerequis data.azurerm_key_vault.coffre sans PROPRIÉTAIRE ;
//   rouge-sans-artefact/ : un constat qui NOMME les deux blocs lus
//     (data.azurerm_resource_group.socle, data.azurerm_log_analytics_workspace.journaux).
{
  const o17 = (racine) => { try { return JSON.parse(run(oracle, ["--prerequis-environnement", racine, "--json-only"])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };
  const dir17 = path.join(ici, "..", "fixtures", "o17-prerequis-environnement");
  const rRouge17 = o17(path.join(dir17, "rouge"));
  const f17 = (rRouge17.findings || []).filter(f => f.regle === "O17");
  ok(rRouge17.verdict === "FAIL", `O17 : un bloc data lu et non declare -> FAIL (obtenu ${rRouge17.verdict})`);
  ok(f17.some(f => f.where === "data.azurerm_container_app_environment.execution" && /ABSENT de PREREQUIS-ENVIRONNEMENT\.md/.test(f.msg)),
    "O17 : le bloc absent de l'artefact est NOMME par son adresse Terraform");
  ok(f17.some(f => f.where === "data.azurerm_key_vault.coffre" && /sans PROPRIÉTAIRE/.test(f.msg)),
    "O17 : un prerequis declare sans proprietaire -> constat");
  ok(f17.length === 2, `O17 : un bloc absent + un proprietaire vide = 2 constats (obtenu ${f17.length})`);
  const rSans17 = o17(path.join(dir17, "rouge-sans-artefact"));
  ok(rSans17.verdict === "FAIL" && (rSans17.findings || []).some(f => f.regle === "O17"
      && /aucun artefact PREREQUIS-ENVIRONNEMENT\.md/.test(f.msg)
      && /data\.azurerm_resource_group\.socle/.test(f.msg) && /data\.azurerm_log_analytics_workspace\.journaux/.test(f.msg)),
    `O17 : blocs data sans artefact -> FAIL dont le message NOMME les deux blocs (obtenu ${rSans17.verdict})`);
  const rVerte17 = o17(path.join(dir17, "verte"));
  ok(rVerte17.verdict === "PASS", `O17 : memes blocs, tous declares (artefact sans accents, ligne commentee ignoree) -> PASS (obtenu ${rVerte17.verdict})`);
  const rSo17 = o17(path.join(ici, "..", "fixtures", "o11-sonde-disponibilite", "verte"));
  ok(rSo17.verdict === "SKIP" && (rSo17.findings || []).some(f => /SANS_OBJET/.test(f.msg)),
    `O17 borne : une pile sans bloc data -> SKIP SANS_OBJET (obtenu ${rSo17.verdict})`);
  ok(o17(path.join(dir17, "absente")).verdict === "SKIP",
    "O17 borne : racine introuvable -> SKIP, jamais un FAIL par defaut implicite");
}

// ── O18 (TF-1639) et menage du plan azure (TF-1638), mesure Produit-64 du 12/10/2026 : LES
// REVISIONS ACTIVES D'UNE APPLICATION CONTAINER APPS SONT BORNEES ────────────────────────────
// Le fait : mode multiple sans borne, 100 revisions actives sur une application, minReplicas
// factures a 0 % de trafic, 34 jours de derive sous O-1 a O-4 PASS.
// Messages rouges attendus (rouge.json) : deux constats, qui NOMMENT api-exemple--b16501 et
// api-exemple--b16500 avec leur commande de desactivation ; front-exemple (N + N-1) n'en a aucun.
{
  const o18 = (fichier) => { try { return JSON.parse(run(oracle, ["--revisions-actives", fichier, "--json-only"])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };
  const dir18 = path.join(ici, "..", "fixtures", "o18-revisions-actives");
  const rouge18 = path.join(dir18, "rouge.json");
  const rRouge18 = o18(rouge18);
  const f18 = (rRouge18.findings || []).filter(f => f.regle === "O18" && f.sev === "bloquant");
  ok(rRouge18.verdict === "FAIL", `O18 : 4 revisions actives dont 3 a 0 % -> FAIL (obtenu ${rRouge18.verdict})`);
  ok(f18.length === 2 && ["api-exemple--b16501", "api-exemple--b16500"].every(n => f18.some(f => f.where === n
      && f.msg.includes(`az containerapp revision deactivate --name api-exemple --resource-group rg-exemple-dev --revision ${n}`))),
    `O18 : les 2 revisions en trop sont NOMMEES avec leur commande de desactivation (obtenu ${f18.map(f => f.where).join(", ")})`);
  ok(!f18.some(f => /b16502|b16503|front-exemple/.test(f.where)),
    "O18 : N servie, N-1 saine (la plus recente a 0 %) et l'application conforme ne sont jamais accusees");
  // TF-1013 : jouer le remede recommande — desactiver ce que le constat nomme rend l'oracle PASS.
  const tmp18 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-o18-"));
  try {
    const remede = JSON.parse(fs.readFileSync(rouge18, "utf8"));
    for (const r of remede) if (f18.some(f => f.where === r.name)) r.properties.active = false;
    const pRemede = path.join(tmp18, "apres-menage.json");
    fs.writeFileSync(pRemede, JSON.stringify(remede));
    ok(o18(pRemede).verdict === "PASS", "O18 : remede joue (revisions nommees desactivees) -> PASS (TF-1013)");
    // Repartition de trafic (deux revisions servies) : la borne est servies + N-1, pas 2 en dur.
    const partage = JSON.parse(fs.readFileSync(path.join(dir18, "verte.json"), "utf8"));
    partage.find(r => r.name === "api-exemple--b16503").properties.trafficWeight = 80;
    partage.find(r => r.name === "api-exemple--b16502").properties.trafficWeight = 20;
    partage.find(r => r.name === "api-exemple--b16501").properties.active = true;
    const pPartage = path.join(tmp18, "partage.json");
    fs.writeFileSync(pPartage, JSON.stringify(partage));
    ok(o18(pPartage).verdict === "PASS", "O18 : trafic reparti sur 2 revisions + une N-1 saine -> PASS (borne = servies + 1)");
    // Application sans entree HTTP : aucune revision ne porte de trafic, la plus recente tient lieu de N.
    const sansEntree = JSON.parse(fs.readFileSync(rouge18, "utf8")).filter(r => r.name.startsWith("api-exemple--"));
    for (const r of sansEntree) delete r.properties.trafficWeight;
    const pSans = path.join(tmp18, "sans-entree.json");
    fs.writeFileSync(pSans, JSON.stringify(sansEntree));
    const rSans = o18(pSans);
    ok(rSans.verdict === "FAIL" && (rSans.findings || []).filter(f => f.regle === "O18" && f.sev === "bloquant").map(f => f.where).sort().join(",") === "api-exemple--b16500,api-exemple--b16501",
      `O18 : sans trafic declare, N = la plus recente, N-1 = la suivante saine, le reste nomme (obtenu ${rSans.verdict})`);
    const pVide = path.join(tmp18, "vide.json");
    fs.writeFileSync(pVide, "[]");
    ok(o18(pVide).verdict === "SKIP", "O18 borne : capture vide -> SKIP, rien a juger");
    const pCasse = path.join(tmp18, "casse.json");
    fs.writeFileSync(pCasse, "{ pas du json");
    ok(o18(pCasse).verdict === "FAIL", "O18 borne : capture illisible -> FAIL, jamais un PASS par defaut");
  } finally {
    fs.rmSync(tmp18, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  ok(o18(path.join(dir18, "verte.json")).verdict === "PASS", "O18 : N servie + N-1 saine par application, anciennes desactivees -> PASS");
  ok(o18(path.join(dir18, "absente.json")).verdict === "SKIP", "O18 borne : capture introuvable -> SKIP");

  // TF-1638 : la prescription azure BORNE le mode multiple et porte le menage APRES la bascule et
  // son controle, puis la capture jugee par O-18 ; la ligne gcp garde N-1 au lieu de tout garder.
  const tmpPlan = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-plan18-"));
  try {
    const pAz = path.join(tmpPlan, "plan-azure.json");
    run(ops, ["plan", "azure", fx("app-verte"), "--sortie", pAz]);
    const az = JSON.parse(fs.readFileSync(pAz, "utf8"));
    const hc = az.phases.healthcheck;
    const iBascule = hc.findIndex(l => /ingress traffic set/.test(l));
    const iPost = hc.findIndex((l, i) => i > iBascule && /curl -fsS .*\/sante/.test(l));
    const iMenage = hc.findIndex(l => /revision deactivate/.test(l));
    const iO18 = hc.findIndex(l => /--revisions-actives/.test(l));
    ok(az.phases.provision.some(l => /set-mode .*multiple/.test(l)) && az.phases.provision.some(l => /^BORNE du mode multiple/.test(l)),
      "plan azure : le mode multiple est suivi de sa BORNE explicite (N servie + une N-1 saine) (TF-1638)");
    ok(iBascule >= 0 && iPost > iBascule && iMenage > iPost && iO18 > iMenage,
      `plan azure : bascule -> controle post-bascule -> menage -> capture O-18, dans cet ordre (indices ${iBascule}/${iPost}/${iMenage}/${iO18})`);
    ok(/\|\| echo "AVERTISSEMENT menage/.test(hc[iMenage]) && /healthState!='Unhealthy'/.test(hc.find(l => /^GARDE=/.test(l)) || ""),
      "plan azure : le menage garde N-1 saine et AVERTIT sans faire echouer le deploiement");
    ok(az.phases.provision.some(l => /menage PERIODIQUE/.test(l)), "plan azure : un menage periodique independant des runs est prescrit (TF-1639)");
    ok(az.phases.rollback.some(l => /revision activate/.test(l)), "plan azure : la desactivation reste reversible (revision activate en rollback, O-4 tient)");
    ok(verdictPlan(pAz) === "PASS", "oracle O-5 toujours PASS sur le plan azure borne (TF-1638)");
    const pGcp = path.join(tmpPlan, "plan-gcp.json");
    run(ops, ["plan", "gcp", fx("app-verte"), "--sortie", pGcp]);
    const gcp = JSON.parse(fs.readFileSync(pGcp, "utf8"));
    ok(!gcp.phases.rollback.some(l => /^ne jamais purger les revisions saines/.test(l)) && gcp.phases.rollback.some(l => /garder au moins la revision N-1 saine/.test(l)),
      "plan gcp : « garder au moins N-1 saine » remplace « ne jamais purger » (TF-1638)");
  } finally {
    fs.rmSync(tmpPlan, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
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

// TF-1364 (D-69 a, 13/10/2026) — LE KIT GOOGLE ADS. Sa recette vit dans l'outil (`--self-test`, les
// deux sens sur chaque regle, donnees factices, aucun appel reseau) ; elle est REJOUEE ici pour la
// meme raison que celle de la migration DNS : un controle que la recette du depot ne joue pas peut
// etre oublie.
{
  const outil = path.join(ici, '..', 'scripts', 'google-ads', 'google-ads.mjs');
  let sortie = '';
  try { sortie = run(outil, ['--self-test']); }
  catch (e) { sortie = String(e.stdout || '') + String(e.stderr || ''); }
  const m = sortie.match(/Recette google-ads : (\d+)\/(\d+)/);
  ok(!!m && m[1] === m[2], `google-ads : recette entierement verte (${m ? m[0] : 'sortie illisible'})`);
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

// ── TF-1319 · la découverte des oracles LIT LE DISQUE, dans les deux sens ─────────────────────
// Le juge du pilot (méta-oracle d'enclenchement) confronte ce que cette forge DÉCOUVRE aux
// verdicts consignés au ledger d'un run. Une découverte qui raterait un oracle le rendrait
// invisible au juge ; une découverte qui prendrait une recette, un verbe de déploiement ou une
// fixture pour un oracle ferait accuser un run de n'avoir pas joué ce qui n'est pas un oracle.
{
  const DECOUVRIR = path.join(ici, "decouvrir-oracles.mjs");
  const decouvre = (racine) => {
    const r = spawnSync(process.execPath, [DECOUVRIR, ...(racine ? ["--racine", racine] : [])], { encoding: "utf8" });
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* sortie illisible : les contrôles ci-dessous la disent */ }
    return { code: r.status, j };
  };
  const reel = decouvre(null);
  ok(reel.code === 0 && reel.j?.contrat === "digit-ai/decouverte-oracles@1" && reel.j?.forge === "digit-ai-forge-ops"
    && reel.j.oracles.some(o => o.nom === "oracle-ops") && reel.j.oracles.every(o => fs.existsSync(path.join(ici, "..", o.chemin))),
    `TF-1319 · VERT — la forge découvre ${reel.j?.oracles?.length ?? "?"} oracle(s) sur son propre disque, oracle-ops compris, contrat digit-ai/decouverte-oracles@1 tenu`);
  const tmpDec = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-decouverte-"));
  try {
    const poser = (rel) => {
      const p = path.join(tmpDec, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "// fixture de découverte\n");
    };
    ["oracles/oracle-alpha.mjs", "scripts/oracle_beta.py"].forEach(poser);
    const leurres = ["oracles/oracle-alpha.test.mjs", "oracles/self-test.mjs", "scripts/ops.mjs",
      "fixtures/oracle-faux.mjs", "Old/oracle-vieux.mjs", "node_modules/paquet/oracle-dep.mjs", "input/oracle-entrant.mjs"];
    leurres.forEach(poser);
    const v = decouvre(tmpDec);
    const noms = (v.j?.oracles || []).map(o => o.nom).sort();
    ok(v.code === 0 && JSON.stringify(noms) === JSON.stringify(["oracle-alpha", "oracle_beta"]),
      `TF-1319 · VERT — un oracle posé sur le disque est découvert, où qu'il vive dans le dépôt (obtenu ${JSON.stringify(noms)})`);
    ok(v.code === 0 && !(v.j?.oracles || []).some(o => leurres.includes(o.chemin)),
      `TF-1319 · ROUGE — recette, verbe de déploiement, fixture, archive, dépendance et entrant ne sont JAMAIS pris pour des oracles (${leurres.length} leurres refusés)`);
    poser("oracles/oracle-gamma.mjs");
    const apres = decouvre(tmpDec);
    ok((apres.j?.oracles || []).some(o => o.nom === "oracle-gamma" && o.chemin === "oracles/oracle-gamma.mjs"),
      "TF-1319 · un oracle AJOUTÉ est découvert au passage suivant sans qu'aucune liste soit tenue à jour : la liste vient du disque");
    poser("scripts/oracle-alpha.mjs");
    const doublon = decouvre(tmpDec);
    ok((doublon.j?.non_juge || []).some(n => /oracle-alpha/.test(n) && /2 fichiers/.test(n)),
      "TF-1319 · deux fichiers du même nom sont DITS : un verdict qui le nomme ne dit pas lequel a tourné");
  } finally {
    fs.rmSync(tmpDec, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  // TF-1689 : la prose de la découverte disait « O-1 à O-17 » alors qu'O-18 existait. Le compte
  // vit dans l'en-tête d'oracle-ops.mjs (une ligne `//   O<n> ` par règle) ; toute plage « O-1 à
  // O-<n> » écrite dans decouvrir-oracles.mjs doit finir sur la dernière règle de cet en-tête.
  const regles = [...fs.readFileSync(oracle, "utf8").matchAll(/^\/\/ {3}O(\d+) /gm)].map(m => Number(m[1]));
  const derniere = Math.max(...regles);
  const plagesPerimees = (texte) => [...texte.matchAll(/O-?1 (?:à|a) O-?(\d+)/g)].map(m => Number(m[1])).filter(n => n !== derniere);
  ok(regles.length > 0 && plagesPerimees(fs.readFileSync(DECOUVRIR, "utf8")).length === 0,
    `TF-1689 · aucune plage de règles périmée dans decouvrir-oracles.mjs (dernière règle d'oracle-ops : O${derniere})`);
  ok(plagesPerimees(" * dont les règles (O-1 à O-17) se jouent par mode").length === 1,
    "TF-1689 · ROUGE — la phrase d'origine « O-1 à O-17 » est reconnue périmée");
  const absente = decouvre(path.join(tmpdir(), "forge-ops-racine-qui-n-existe-pas"));
  ok(absente.code === 2 && absente.j?.oracles?.length === 0 && /introuvable/.test(absente.j?.motif || ""),
    `TF-1319 · ROUGE — une racine absente sort en 2 avec son motif, jamais en liste vide muette (obtenu exit ${absente.code})`);
}

// ── O19 (TF-1212, décision humaine D-3 (a) du 17/10/2026) : LA SAUVEGARDE DES ACTIFS CRITIQUES ──
// Le fait : un produit à O-1…O-4 PASS a échoué au référentiel d'audit trois contrôles fatals de
// sauvegarde (CTL-D05-09, CTL-D12-06, CTL-D16-09) qu'aucun oracle de MEP ne regardait. Avant O-19,
// `--sauvegarde <declaration>` n'existait pas : la déclaration était lue comme une CIBLE (O1/O3).
// Rouges attendus (rouge.json, jour de référence 2026-10-17) : RPO absent, configuration non citée,
// exercice en échec, durée au-delà du RTO, intégrité non constatée, fréquence plus lâche que le RPO,
// aucun exercice, exercice de plus de 12 mois — chacun NOMMÉ sur son actif.
{
  const o19 = (fichier, ...extra) => { try { return JSON.parse(run(oracle, ["--sauvegarde", fichier, "--le", "2026-10-17", "--json-only", ...extra])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };
  const dir19 = path.join(ici, "..", "fixtures", "o19-sauvegarde");
  const rouge19 = path.join(dir19, "rouge.json");
  const rR = o19(rouge19);
  const b19 = (rR.findings || []).filter(f => f.regle === "O19" && f.sev === "bloquant");
  const nomme = (actif, motif) => b19.some(f => f.where === actif && motif.test(f.msg));
  ok(rR.verdict === "FAIL", `O19 : declaration rouge -> FAIL (obtenu ${rR.verdict})`);
  ok(nomme("base SQLite sur volume", /RPO non déclaré/) && nomme("base SQLite sur volume", /configuration effective/)
      && nomme("base SQLite sur volume", /« echec »/) && nomme("base SQLite sur volume", /au-delà du RTO/)
      && nomme("base SQLite sur volume", /intégrité/),
    "O19 : RPO absent, configuration non citée, exercice en échec, durée > RTO et intégrité non constatée sont NOMMÉS sur leur actif");
  ok(nomme("base de recette", /plus lâche que le RPO/) && nomme("base de recette", /aucun exercice de restauration/),
    "O19 : fréquence 24h pour un RPO de 1h, et une sauvegarde jamais restaurée, sont refusées");
  ok(nomme("journal d'audit", /plus de 12 mois/) && b19.filter(f => f.where === "journal d'audit").length === 1,
    "O19 : un exercice de plus de 12 mois est le SEUL constat d'un actif par ailleurs conforme (grille : partiel)");
  ok(o19(path.join(dir19, "verte.json")).verdict === "PASS", "O19 : RPO/RTO déclarés, sauvegarde continue ou ≤ RPO, restauration réussie ≤ 12 mois, durée ≤ RTO, intégrité constatée -> PASS");
  ok(o19(path.join(dir19, "aucun-actif.json")).verdict === "PASS", "O19 : « aucun actif critique » MOTIVÉ est une réponse valide -> PASS");
  const rS = o19(path.join(dir19, "silence.json"));
  ok(rS.verdict === "FAIL" && (rS.findings || []).some(f => /le silence n'en est pas une/.test(f.msg)), "O19 : actifs vides SANS motif -> FAIL, le silence n'est pas une réponse");
  ok(o19(path.join(dir19, "absente.json")).verdict === "SKIP", "O19 borne : déclaration introuvable -> SKIP, rien à juger");
  // TF-1013 : jouer le remède que les constats nomment rend l'oracle PASS.
  const tmp19 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-o19-"));
  try {
    const d = JSON.parse(fs.readFileSync(rouge19, "utf8"));
    const [a, b, c] = d.actifs;
    a.rpo = "24h"; a.sauvegarde.configuration = "copie-volume.sh (relevé du 2026-10-16)";
    a.derniere_restauration = { date: "2026-10-16", resultat: "succes", duree: "3h", integrite: "PRAGMA integrity_check = ok, comptes identiques" };
    b.sauvegarde.frequence = "1h"; b.derniere_restauration = { date: "2026-10-15", resultat: "succes", duree: "40 min", integrite: "comptes identiques" };
    c.derniere_restauration.date = "2026-10-01";
    const pRem = path.join(tmp19, "remede.json");
    fs.writeFileSync(pRem, JSON.stringify(d));
    ok(o19(pRem).verdict === "PASS", "O19 : remède joué (RPO déclaré, fréquence tenue, exercice rejoué et réussi) -> PASS (TF-1013)");
    const pFutur = path.join(tmp19, "futur.json");
    c.derniere_restauration.date = "2026-12-01";
    fs.writeFileSync(pFutur, JSON.stringify(d));
    ok(o19(pFutur).verdict === "FAIL", "O19 borne : un exercice daté APRÈS le jour de référence -> FAIL, une preuve du futur n'en est pas une");
    const pCasse = path.join(tmp19, "casse.json");
    fs.writeFileSync(pCasse, "{ pas du json");
    ok(o19(pCasse).verdict === "FAIL", "O19 borne : déclaration illisible -> FAIL, jamais un PASS par défaut");
  } finally {
    fs.rmSync(tmp19, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// ── TF-2013 (décision R-58 (a) du 29/10/2026) : RÉINITIALISER UNE BASE HORS PRODUCTION ─────────────────────
// Le trou : aucune forge ne savait vider et reconstruire une base de développement ou de qualification à la
// demande. Le verbe rend le PLAN par défaut, refuse en exit 2 une cible production, non déclarée ou qui partage
// l'adresse d'une production — en plan comme en exécution —, journalise chaque refus et chaque geste, et
// n'exécute que sur une cible postgres-docker d'un Docker local. Hors ligne ici, sauf un refus qui interroge le
// Docker local en lecture ; l'exercice réel sur un conteneur jetable se joue à la demande :
// FORGE_OPS_EXERCICE_DOCKER=1 node oracles/self-test.mjs
{
  console.log("");
  const dirRB = path.join(ici, "..", "fixtures", "reinitialiser-base");
  const tmpRB = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-tf2013-"));
  const rb = (...args) => spawnSync(process.execPath, [ops, "reinitialiser-base", ...args], { encoding: "utf8" });
  const poser = (dossier, doc) => {
    const d = path.join(tmpRB, dossier);
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, "BASES.json");
    fs.writeFileSync(f, JSON.stringify(doc, null, 1) + "\n", "utf8");
    return f;
  };
  const copie = (fixture, dossier, modifier) => {
    const doc = JSON.parse(fs.readFileSync(path.join(dirRB, fixture), "utf8"));
    if (modifier) modifier(doc);
    return poser(dossier, doc);
  };
  const journalRB = (f) => { const j = path.join(path.dirname(f), "journal.jsonl");
    return fs.existsSync(j) ? fs.readFileSync(j, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : []; };
  const planDe = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
  const etapeDe = (p, nom) => (p?.etapes || []).find(e => e.etape === nom) || { commandes: [], attendu: "" };
  const qualif = (d) => d.bases.find(b => b.nom === "qualif");
  try {
    // VERTE — le plan d'une cible de qualification Postgres : ordonné, complet, sans rien exécuter.
    const fVerte = copie("verte.json", "verte");
    const rV = rb(fVerte, "qualif");
    const pV = planDe(rV);
    ok(rV.status === 0 && pV?.format === "forge-ops/reinitialisation-base@1" && pV.cible === "qualif" && pV.environnement === "qualification" && pV.moteur === "postgres-docker",
      `TF-2013 · VERTE — plan de la cible de qualification Postgres rendu, exit 0 (obtenu exit ${rV.status})`);
    ok(JSON.stringify((pV?.etapes || []).map(e => `${e.ordre}:${e.etape}`)) === JSON.stringify(["1:vider", "2:migrations", "3:donnees", "4:verification"]),
      "TF-2013 · le plan est ordonné : vider, rejouer les migrations, charger les données, vérifier");
    const vider = etapeDe(pV, "vider").commandes;
    ok(vider.length === 2 && vider.every(c => c.startsWith("docker exec produit-exemple-pg-qualif psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "))
        && vider[0].includes('"DROP DATABASE IF EXISTS \\"app_qualif\\" WITH (FORCE)"') && vider[1].includes('"CREATE DATABASE \\"app_qualif\\""'),
      "TF-2013 · vider = DROP DATABASE … WITH (FORCE) puis CREATE DATABASE, deux commandes jouées depuis la base de maintenance");
    const verif = etapeDe(pV, "verification").commandes;
    ok(etapeDe(pV, "migrations").commandes[0] === "npm run db:migrate" && etapeDe(pV, "donnees").commandes[0] === "npm run db:seed"
        && verif[0] === "npm run db:migrate:status" && ["clients", "commandes"].every(t => verif.some(c => c.endsWith(`-d app_qualif -t -A -c "SELECT count(*) FROM ${t}"`))),
      "TF-2013 · migrations et données sont les commandes DÉCLARÉES ; la vérification joue l'état des migrations et compte chaque table déclarée");
    ok(/PostgreSQL 18\.6\), lue le 29\/10\/2026/.test(etapeDe(pV, "vider").attendu) && Array.isArray(pV?.non_juge) && pV.non_juge.length >= 4,
      "TF-2013 · le plan cite sa source datée et déclare son non-jugé");
    ok(journalRB(fVerte).length === 0, "TF-2013 · un plan n'exécute rien : aucune ligne de journal");

    // ROUGES — production, environnement non déclaré, cible absente, serveur de la production.
    const fRouge = copie("rouge.json", "rouge");
    const rProd = rb(fRouge, "production");
    ok(rProd.status === 2 && /^\[OPS HORS CONTRAT\]/.test(rProd.stderr) && /environnement production/.test(rProd.stderr) && rProd.stdout === "",
      `TF-2013 · ROUGE — cible production refusée en plan : exit 2, raison nommée, aucun plan rendu (obtenu exit ${rProd.status})`);
    const rProdExec = rb(fRouge, "production", "--executer");
    ok(rProdExec.status === 2 && /environnement production/.test(rProdExec.stderr),
      `TF-2013 · ROUGE — la même cible avec --executer : refus exit 2 avant tout geste (obtenu exit ${rProdExec.status})`);
    const rSansEnv = rb(fRouge, "sans-environnement");
    ok(rSansEnv.status === 2 && /environnement non déclaré/.test(rSansEnv.stderr),
      `TF-2013 · ROUGE — cible sans environnement déclaré refusée, exit 2 (obtenu exit ${rSansEnv.status})`);
    const rAbsente = rb(fRouge, "inconnue");
    ok(rAbsente.status === 2 && /cible non déclarée/.test(rAbsente.stderr) && /« inconnue »/.test(rAbsente.stderr),
      `TF-2013 · ROUGE — cible absente de la déclaration refusée, exit 2 (obtenu exit ${rAbsente.status})`);
    const rServeur = rb(fRouge, "qualif-sur-serveur-de-prod");
    ok(rServeur.status === 2 && /même serveur db\.produit-exemple\.invalid:5432 que « production »/.test(rServeur.stderr),
      `TF-2013 · ROUGE — base de qualification sur le serveur de la production (adresse lue dans l'url) refusée, exit 2 (obtenu exit ${rServeur.status})`);
    const jRouge = journalRB(fRouge);
    ok(jRouge.length === 5 && jRouge.every((e, i) => e.seq === i + 1 && e.type === "base_reinitialisation_refusee" && e.code === 2 && !!e.raison)
        && jRouge[0].mode === "plan" && jRouge[1].mode === "execution",
      `TF-2013 · chaque refus est journalisé : seq 1 à 5, mode plan ou exécution, raison (obtenu ${jRouge.length} ligne(s))`);
    // Une entrée d'environnement non déclaré est gardée comme la production ; localhost et 127.0.0.1 sont un même serveur.
    const fVoisine = copie("rouge.json", "voisine", d => d.bases.push({ ...JSON.parse(JSON.stringify(d.bases[1])), nom: "dev-voisine", environnement: "developpement",
      adresse: { hote: "127.0.0.1", port: 55433, base: "app_dev2", utilisateur: "postgres", conteneur: "produit-exemple-pg-dev2" } }));
    const rVoisine = rb(fVoisine, "dev-voisine");
    ok(rVoisine.status === 2 && /même serveur boucle-locale:55433 que « sans-environnement » \(environnement non déclaré, traité comme la production\)/.test(rVoisine.stderr),
      `TF-2013 · ROUGE — le serveur d'une base sans environnement déclaré est gardé comme celui de la production (obtenu exit ${rVoisine.status})`);
    const sansProd = (d) => { d.bases = d.bases.filter(b => b.environnement !== "production"); };
    const rSansProd = rb(copie("verte.json", "sans-production", sansProd), "qualif");
    ok(rSansProd.status === 2 && /aucune cible production déclarée/.test(rSansProd.stderr),
      `TF-2013 · ROUGE — production ni déclarée ni écartée : le garde-fou n'a rien à comparer, refus exit 2 (obtenu exit ${rSansProd.status})`);
    const prodUrl = (url) => (d) => { d.bases.find(b => b.nom === "production").adresse.url = url; };
    const rSecret = rb(copie("verte.json", "secret", prodUrl("postgresql://postgres:motdepasse@db.produit-exemple.invalid:5432/postgres")), "qualif");
    ok(rSecret.status === 2 && /mot de passe en clair dans la déclaration \(bases\[3\]\.adresse\.url\)/.test(rSecret.stderr),
      `TF-2013 · ROUGE — un mot de passe dans la déclaration, même sur une autre cible, la fait refuser et son chemin est NOMMÉ (obtenu exit ${rSecret.status})`);
    const rSys = rb(copie("verte.json", "systeme", d => { qualif(d).adresse.base = "postgres"; }), "qualif");
    ok(rSys.status === 2 && /base de maintenance/.test(rSys.stderr),
      `TF-2013 · ROUGE — la base de maintenance postgres n'est jamais une cible, exit 2 (obtenu exit ${rSys.status})`);
    const rInc = rb(copie("verte.json", "incomplete", d => { delete qualif(d).donnees.commande; delete qualif(d).migrations.verification; }), "qualif");
    ok(rInc.status === 1 && /^\[OPS REFUS\]/.test(rInc.stderr) && /déclaration incomplète/.test(rInc.stderr) && /donnees\.commande/.test(rInc.stderr) && /migrations\.verification/.test(rInc.stderr),
      `TF-2013 · ROUGE — déclaration incomplète : refus exit 1 qui NOMME chaque champ manquant (obtenu exit ${rInc.status})`);
    const rIdent = rb(copie("verte.json", "identifiant", d => { qualif(d).verification.tables = ["clients; DROP TABLE commandes"]; }), "qualif");
    ok(rIdent.status === 1 && /identifiant non conforme/.test(rIdent.stderr) && /verification\.tables\[0\]/.test(rIdent.stderr),
      `TF-2013 · ROUGE — un nom de table qui n'est pas un identifiant SQL simple est refusé, exit 1 (obtenu exit ${rIdent.status})`);
    fs.mkdirSync(path.join(tmpRB, "sans-declaration"));
    const fIntrouvable = path.join(tmpRB, "sans-declaration", "BASES.json");
    const rIntrouvable = rb(fIntrouvable, "qualif");
    ok(rIntrouvable.status === 2 && /déclaration introuvable/.test(rIntrouvable.stderr) && journalRB(fIntrouvable).length === 1,
      `TF-2013 · ROUGE — déclaration introuvable : refus exit 2, journalisé dans son dossier (obtenu exit ${rIntrouvable.status})`);
    const rSansDossier = rb(path.join(tmpRB, "dossier-absent", "BASES.json"), "qualif");
    ok(rSansDossier.status === 2 && /refus NON journalisé/.test(rSansDossier.stderr) && !fs.existsSync(path.join(tmpRB, "dossier-absent")),
      `TF-2013 · ROUGE — dossier de la déclaration absent : refus exit 2, non journalisé et DIT, aucun dossier créé (obtenu exit ${rSansDossier.status})`);
    fs.mkdirSync(path.join(tmpRB, "illisible"));
    fs.writeFileSync(path.join(tmpRB, "illisible", "BASES.json"), "{ pas du json", "utf8");
    ok(rb(path.join(tmpRB, "illisible", "BASES.json"), "qualif").status === 2, "TF-2013 · ROUGE — déclaration illisible : refus exit 2, jamais un plan par défaut");

    // TF-1013 — chaque correction que nomme un refus, jouée, rend le plan.
    const remede = (fixture, dossier, modifier, nom) => rb(copie(fixture, dossier, modifier), nom).status;
    ok(remede("rouge.json", "remede-env", d => { d.bases[1].environnement = "developpement"; }, "sans-environnement") === 0,
      "TF-2013 · remède joué : `environnement` déclaré (developpement) -> plan rendu, exit 0 (TF-1013)");
    ok(remede("rouge.json", "remede-serveur", d => { d.bases[2].adresse.url = "postgresql://app@localhost:55434/app_qualif"; }, "qualif-sur-serveur-de-prod") === 0,
      "TF-2013 · remède joué : base de qualification déclarée sur un autre serveur -> plan rendu, exit 0 (TF-1013)");
    ok(remede("verte.json", "remede-production", d => { sansProd(d); d.aucune_production = "produit en conception : aucune base de production n'existe au 29/10/2026"; }, "qualif") === 0,
      "TF-2013 · remède joué : `aucune_production` motivé -> plan rendu, exit 0 (TF-1013)");
    ok(remede("verte.json", "remede-secret", prodUrl("postgresql://postgres@db.produit-exemple.invalid:5432/postgres"), "qualif") === 0,
      "TF-2013 · remède joué : mot de passe retiré de l'url -> plan rendu, exit 0 (TF-1013)");
    ok(remede("verte.json", "remede-incomplete", d => { delete qualif(d).donnees.commande; delete qualif(d).migrations.verification;
      qualif(d).donnees.commande = "npm run db:seed"; qualif(d).migrations.verification = "npm run db:migrate:status"; }, "qualif") === 0,
      "TF-2013 · remède joué : champs manquants complétés -> plan rendu, exit 0 (TF-1013)");
    ok(remede("verte.json", "remede-identifiant", d => { qualif(d).verification.tables = ["public.clients"]; }, "qualif") === 0,
      "TF-2013 · remède joué : identifiant simple (schema.table admis) -> plan rendu, exit 0 (TF-1013)");
    // Un champ vide ne masque pas l'url, et un rôle au nom composé passe : il n'entre jamais dans le SQL.
    const pUrl = planDe(rb(copie("verte.json", "url-et-role", d => { qualif(d).adresse = { hote: "", url: "postgresql://app-qualif@localhost:55440/app_qualif2", conteneur: "produit-exemple-pg-qualif2" }; }), "qualif"));
    ok((pUrl?.prealables?.[1] || "").includes("PGHOST=localhost PGPORT=55440 PGDATABASE=app_qualif2 PGUSER=app-qualif")
        && etapeDe(pUrl, "vider").commandes[0]?.includes("-U app-qualif -d postgres"),
      "TF-2013 · adresse en url (hôte vide ignoré) et rôle au nom composé : plan rendu avec les coordonnées lues dans l'url");

    // SUPABASE — plan seulement : commandes officielles sourcées et datées, variante liée sous GO humain.
    const fSupa = copie("verte.json", "supabase");
    const pSl = planDe(rb(fSupa, "dev-supabase")), pSd = planDe(rb(fSupa, "qualif-supabase"));
    ok(etapeDe(pSl, "vider").commandes[0] === "supabase db reset --local --no-seed" && (pSl?.prealables || []).some(l => l.startsWith("supabase start "))
        && etapeDe(pSl, "verification").commandes[0] === "supabase migration list --local" && etapeDe(pSl, "donnees").commandes[0] === "npm run db:seed:local",
      "TF-2013 · plan supabase-local : supabase start, db reset --local --no-seed, données déclarées, migration list --local");
    ok(etapeDe(pSd, "vider").commandes[0] === "supabase db reset --linked --no-seed" && /^GESTE HUMAIN SOUS GO \(R-38\)/.test(etapeDe(pSd, "vider").attendu)
        && (pSd?.prealables?.[0] || "").startsWith("supabase link --project-ref qualifexemple0000000 ") && etapeDe(pSd, "verification").commandes[0] === "supabase migration list --linked",
      "TF-2013 · plan supabase-distant : variante liée (--linked) marquée geste humain sous GO (R-38), sur le projet déclaré");
    const textesSupabase = JSON.stringify([pSl, pSd]);
    ok(["supabase-db-reset", "supabase-migration-list", "supabase-start", "supabase-link", "supabase-status", "seeding-your-database"].every(s => textesSupabase.includes(`${s}, lue le 29/10/2026`)),
      "TF-2013 · chaque commande Supabase cite sa page officielle et sa date de lecture");
    const jetonsLibres = (p) => [...new Set(JSON.stringify({ prealables: p?.prealables, etapes: p?.etapes }).match(/<[A-Z][A-Z0-9_]*>/g) || [])].filter(j => !(p?.placeholders || []).includes(j));
    ok([pV, pSl, pSd].every(p => p && jetonsLibres(p).length === 0), "TF-2013 · tout jeton <MAJUSCULES> d'un plan figure dans ses placeholders (même règle que TF-1685)");
    const rSlExec = rb(fSupa, "dev-supabase", "--executer"), rSdExec = rb(fSupa, "qualif-supabase", "--executer");
    ok(rSlExec.status === 2 && /plan seulement/.test(rSlExec.stderr) && rSdExec.status === 2 && /geste humain sous GO \(R-38\)/.test(rSdExec.stderr),
      `TF-2013 · ROUGE — --executer sur Supabase refusé exit 2 : local en plan seulement, distant geste humain sous GO (obtenu ${rSlExec.status}/${rSdExec.status})`);

    // EXÉCUTION refusée hors d'une cible postgres-docker locale, avant tout geste.
    const fHote = copie("verte.json", "hote-distant", d => { qualif(d).adresse.hote = "db-qualif.produit-exemple.invalid"; });
    const rHote = rb(fHote, "qualif", "--executer");
    ok(rHote.status === 2 && /non local/.test(rHote.stderr) && rb(fHote, "qualif").status === 0,
      `TF-2013 · ROUGE — --executer sur un hôte non local refusé exit 2 ; la même cible garde son plan (obtenu exit ${rHote.status})`);
    const fAbsent = copie("verte.json", "conteneur-absent", d => { qualif(d).adresse.conteneur = `forge-ops-tf2013-absent-${randomBytes(4).toString("hex")}`; });
    const rAbsent = rb(fAbsent, "qualif", "--executer");
    ok(rAbsent.status === 2 && /^\[OPS HORS CONTRAT\]/.test(rAbsent.stderr) && journalRB(fAbsent).every(e => e.type === "base_reinitialisation_refusee"),
      `TF-2013 · ROUGE — conteneur introuvable (ou Docker absent) : refus exit 2, aucun geste journalisé (obtenu exit ${rAbsent.status} : ${String(rAbsent.stderr).trim().slice(0, 90)})`);

    // JOURNAL — au contrat ledger lu par O3, même partagé avec une cible d'exploitation ; O4 ne lit pas ces types.
    const cibleExpl = path.join(tmpRB, "cible-exploitation");
    run(ops, ["deployer", fx("app-verte"), cibleExpl]);
    fs.copyFileSync(path.join(dirRB, "rouge.json"), path.join(cibleExpl, "BASES.json"));
    rb(path.join(cibleExpl, "BASES.json"), "production");
    const ajouter = (type) => { const l = fs.readFileSync(path.join(cibleExpl, "journal.jsonl"), "utf8").split("\n").filter(Boolean);
      fs.appendFileSync(path.join(cibleExpl, "journal.jsonl"), JSON.stringify({ seq: JSON.parse(l[l.length - 1]).seq + 1, ts: new Date().toISOString(), type, cible: "qualif" }) + "\n", "utf8"); };
    ["base_reinitialisation_etape", "base_reinitialisation", "base_reinitialisation_echec"].forEach(ajouter);
    ok(journalDe(cibleExpl).some(e => e.type === "base_reinitialisation_refusee") && verdict(cibleExpl) === "PASS",
      "TF-2013 · O1-O4 PASS sur une cible dont le journal porte les quatre types du verbe (refus, étape, réussite, échec)");
    ajouter("base_type_inconnu");
    ok(verdict(cibleExpl) === "FAIL", "TF-2013 · ROUGE — un type inconnu au même journal -> O3 FAIL : les types restent une liste fermée");
    const typesDe = (f) => { const m = fs.readFileSync(f, "utf8").match(/^const TYPES = \[([^\]]*)\]/m); return m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map(x => x[1]) : []; };
    const tOps = typesDe(ops), tOracle = typesDe(oracle);
    ok(["base_reinitialisation_refusee", "base_reinitialisation_etape", "base_reinitialisation", "base_reinitialisation_echec"].every(t => tOps.includes(t))
        && tOps.every(t => tOracle.includes(t)),
      `TF-2013 · tout type que ops.mjs écrit est connu d'O3 (${tOps.length} types dans ops.mjs, ${tOracle.length} dans oracle-ops.mjs)`);

    // EXERCICE RÉEL, à la demande : un conteneur postgres:16-alpine jetable, créé puis détruit par ce banc.
    // Jamais par défaut (le banc reste hors ligne), jamais de téléchargement (image absente : SKIP dit).
    if (process.env.FORGE_OPS_EXERCICE_DOCKER !== "1") {
      console.log("  [SKIP] TF-2013 · exercice réel non demandé : FORGE_OPS_EXERCICE_DOCKER=1 le joue sur un conteneur postgres:16-alpine jetable, créé puis détruit");
    } else {
      const IMAGE = "postgres:16-alpine";
      const docker = (...args) => spawnSync("docker", args, { encoding: "utf8", timeout: 120000 });
      if (docker("image", "inspect", IMAGE).status !== 0) {
        console.log(`  [SKIP] TF-2013 · image ${IMAGE} absente du poste : l'exercice ne télécharge rien`);
      } else {
        const nomC = `forge-ops-tf2013-${randomBytes(3).toString("hex")}`;
        try {
          const cree = docker("run", "-d", "--rm", "--name", nomC, "-e", `POSTGRES_PASSWORD=${randomBytes(12).toString("hex")}`, "-e", "POSTGRES_DB=app", "-p", "127.0.0.1::5432", IMAGE);
          let pret = false;
          for (let i = 0; i < 120 && cree.status === 0 && !pret; i++) {
            pret = docker("exec", nomC, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "app").status === 0;
            if (!pret) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
          }
          const port = Number((String(docker("port", nomC, "5432").stdout).match(/:(\d+)\s*$/m) || [])[1]);
          ok(cree.status === 0 && pret && Number.isInteger(port), `TF-2013 · exercice : conteneur jetable ${nomC} (${IMAGE}) créé, prêt, port publié ${port}`);
          const sql = (q) => String(docker("exec", nomC, "psql", "-U", "postgres", "-d", "app", "-t", "-A", "-c", q).stdout).trim();
          sql("CREATE TABLE marqueur (x int)");
          const psqlC = `docker exec ${nomC} psql -v ON_ERROR_STOP=1 -U postgres -d app`;
          const declaration = ({ donnees, migrations, port: p = port } = {}) => ({ format: "forge-ops/bases@1", produit: "produit-exemple", bases: [
            { nom: "qualif-exercice", environnement: "qualification", moteur: "postgres-docker",
              adresse: { hote: "127.0.0.1", port: p, base: "app", utilisateur: "postgres", conteneur: nomC },
              migrations: migrations || {
                commande: `${psqlC} -c "CREATE TABLE schema_migrations (version text PRIMARY KEY)" -c "CREATE TABLE clients (id int PRIMARY KEY, nom text NOT NULL)" -c "INSERT INTO schema_migrations VALUES ('001')"`,
                verification: `${psqlC} -t -A -c "SELECT 1/((SELECT count(*) FROM schema_migrations) = 1)::int"` },
              donnees: { nature: "synthetique", commande: donnees || `${psqlC} -c "INSERT INTO clients VALUES (1, 'Client-A'), (2, 'Client-B'), (3, 'Client-C')"` },
              verification: { tables: ["clients"] } },
            { nom: "production", environnement: "production", adresse: { hote: "db.produit-exemple.invalid", port: 5432, base: "app" } } ] });
          // VERTE : vider (la table posée avant disparaît), migrer, charger, vérifier — puis rejouer.
          const fEx = poser("exercice-vert", declaration());
          const rEx = rb(fEx, "qualif-exercice", "--executer");
          const jEx = journalRB(fEx);
          ok(rEx.status === 0 && /\[OPS OK\] base « qualif-exercice » réinitialisée \(qualification, postgres-docker\)/.test(rEx.stdout),
            `TF-2013 · exercice VERT — --executer sur la base jetable : exit 0 (obtenu exit ${rEx.status}${rEx.status ? ` — ${String(rEx.stderr).trim().slice(0, 200)}` : ""})`);
          ok(JSON.stringify(jEx.map(e => e.etape || e.type)) === JSON.stringify(["vider", "migrations", "donnees", "verification", "base_reinitialisation"])
              && jEx.slice(0, 4).every(e => e.type === "base_reinitialisation_etape" && e.verdict === "ok") && jEx[jEx.length - 1]?.comptes?.clients === 3,
            `TF-2013 · exercice : chaque étape exécutée est journalisée, puis la réussite avec ses comptes (obtenu ${jEx.map(e => e.etape || e.type).join(", ")})`);
          ok(sql("SELECT count(*) FROM pg_tables WHERE tablename = 'marqueur'") === "0" && sql("SELECT count(*) FROM clients") === "3",
            "TF-2013 · exercice : la table posée avant a disparu (base vidée) et les 3 lignes synthétiques sont chargées");
          const rRejeu = rb(fEx, "qualif-exercice", "--executer");
          ok(rRejeu.status === 0 && sql("SELECT count(*) FROM clients") === "3", "TF-2013 · exercice : rejoué, le verbe revide puis recharge (3 lignes, jamais 6)");
          // ROUGES : données jamais chargées, migration en échec, port qui n'est pas celui du conteneur.
          const fVide = poser("exercice-sans-donnees", declaration({ donnees: `${psqlC} -c "SELECT 1"` }));
          const rVide = rb(fVide, "qualif-exercice", "--executer");
          const jVide = journalRB(fVide);
          ok(rVide.status === 1 && /échec à l'étape verification/.test(rVide.stderr) && /table clients : 0 ligne/.test(rVide.stderr)
              && jVide[jVide.length - 1]?.type === "base_reinitialisation_echec" && jVide[jVide.length - 1]?.etape === "verification",
            `TF-2013 · exercice ROUGE — données non chargées : vérification en échec, exit 1, table nommée, échec journalisé (obtenu exit ${rVide.status})`);
          const fMig = poser("exercice-migration-ko", declaration({ migrations: { commande: `${psqlC} -c "CREATE TABLE ("`, verification: `${psqlC} -c "SELECT 1"` } }));
          const rMig = rb(fMig, "qualif-exercice", "--executer");
          const jMig = journalRB(fMig);
          ok(rMig.status === 1 && /échec à l'étape migrations/.test(rMig.stderr) && /La base a été supprimée/.test(rMig.stderr) && !jMig.some(e => e.etape === "donnees"),
            `TF-2013 · exercice ROUGE — migration en échec : arrêt à l'étape migrations, données jamais jouées, état de la base dit (obtenu exit ${rMig.status})`);
          const fPort = poser("exercice-port-faux", declaration({ port: port === 65535 ? 65534 : port + 1 }));
          const rPort = rb(fPort, "qualif-exercice", "--executer");
          ok(rPort.status === 2 && /ne publie pas le port déclaré/.test(rPort.stderr) && journalRB(fPort).every(e => e.type === "base_reinitialisation_refusee"),
            `TF-2013 · exercice ROUGE — port déclaré qui n'est pas celui du conteneur : refus exit 2 avant tout geste (obtenu exit ${rPort.status})`);
        } finally {
          docker("rm", "-f", nomC);
          ok(String(docker("ps", "-a", "--filter", `name=${nomC}`, "--format", "{{.Names}}").stdout).trim() === "", `TF-2013 · exercice : conteneur ${nomC} détruit`);
        }
      }
    }
  } finally {
    fs.rmSync(tmpRB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// ── O20 (TF-1986, lot Produit-85 du 24/10/2026) : UN CONTENEUR À ÉTAT GARDE SES DONNÉES DANS UN VOLUME ─────
// Le fait : un conteneur de traitement sans volume, dont la commande de création n'était écrite nulle part (le
// README ne donnait que `docker start`), a perdu une tâche de 612 photos au redémarrage de Docker. Avant O-20,
// `--conteneurs-a-etat` n'existait pas : la racine du produit était lue comme une cible (O1/O3), sans aucun
// constat sur un volume. Rouges attendus : chacun NOMMÉ à sa ligne.
{
  console.log("");
  const o20 = (racine, ...extra) => { try { return JSON.parse(run(oracle, ["--conteneurs-a-etat", racine, "--json-only", ...extra])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };
  const dir20 = path.join(ici, "..", "fixtures", "o20-conteneurs-a-etat");
  const rR = o20(path.join(dir20, "rouge"));
  const c20 = (rR.findings || []).filter(f => f.regle === "O20");
  const nomme = (ou, sev, motif) => c20.some(f => f.where === ou && f.sev === sev && motif.test(f.msg));
  ok(rR.verdict === "FAIL", `O20 : fixture rouge -> FAIL (obtenu ${rR.verdict})`);
  ok(nomme("scripts/base-locale.sh:3", "bloquant", /SANS -v ni --mount[\s\S]*--rm/),
    "O20 : docker run postgres sans -v ni --mount, avec --rm -> bloquant, la phrase de docs.docker.com citée (continuation shell lue)");
  ok(nomme("scripts/cache.ps1:2", "bloquant", /monté sur \/var\/lib\/redis, pas sur le chemin des données \/data/),
    "O20 : redis avec un volume sur un autre chemin que /data -> bloquant (continuation PowerShell lue)");
  ok(nomme("compose.yaml (service base)", "bloquant", /WILL NOT PERSIST/),
    "O20 : postgres 17 monté sur /var/lib/postgresql -> bloquant, la documentation de l'image citée (« WILL NOT PERSIST »)");
  ok(nomme("compose.yaml (service file)", "bloquant", /est un tmpfs/), "O20 : mongo sur un tmpfs -> bloquant");
  ok(nomme("README.md:10", "majeur", /docker start nodeodm : la commande qui CRÉE ce conteneur n'est écrite nulle part/),
    "O20 : docker start d'un conteneur dont la commande de création n'est écrite nulle part -> majeur (le fait du 24/10/2026)");
  ok(c20.filter(f => f.where.startsWith("README.md")).length === 1 && !c20.some(f => /suffit/.test(f.msg)),
    "O20 : une phrase qui cite « docker start » hors du code Markdown n'est pas lue comme une commande");
  ok(!c20.some(f => /nginx/.test(f.msg)), "O20 : nginx, image sans état, n'est pas jugé");
  ok(nomme("COMPOSANTS-OPS.md:14", "bloquant", /« moteur-odm » : sa commande de création déclarée ne monte aucun volume sur \/var\/www\/data/),
    "O20 : table, commande de création déclarée sans volume -> bloquant");
  ok(nomme("COMPOSANTS-OPS.md:15", "majeur", /volume déclaré « cache-donnees » n'est pas celui que monte/),
    "O20 : table, volume déclaré différent de celui que monte la commande -> majeur");
  ok(["scripts/base-locale.sh:3", "compose.yaml (service base)", "compose.yaml (service file)"].every(ou => nomme(ou, "majeur", /sans ligne dans la table « Composants à état »/)),
    "O20 : chaque composant à état lancé sans ligne dans la table est nommé");
  ok(c20.length === 10, `O20 : la rouge porte ses 10 constats attendus, aucun de plus (obtenu ${c20.length})`);
  const rV = o20(path.join(dir20, "verte"));
  ok(rV.verdict === "PASS" && !(rV.findings || []).some(f => f.sev === "bloquant" || f.sev === "majeur"),
    `O20 : verte -> PASS (volume nommé, dossier Windows, postgres 16 et 18 à leur chemin, compose court et long, table complète ; obtenu ${rV.verdict})`);
  const tmp20 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-o20-"));
  try {
    const poser = (rel, contenu) => { const p = path.join(tmp20, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, contenu, "utf8"); return p; };
    const table = (cmd) => ["# Composants Ops", "", "## Composants à état", "", "| Composant | Volume | Commande de création |", "|---|---|---|", "| base-q | base-q-donnees | `" + cmd + "` |", ""].join("\n");
    const sansVolume = "docker run -d --name base-q postgres:16";
    const avecVolume = "docker run -d --name base-q -v base-q-donnees:/var/lib/postgresql/data postgres:16";
    poser("remede/lancer.sh", sansVolume + "\n");
    poser("remede/docs/projet/COMPOSANTS-OPS.md", table(sansVolume));
    const rAvant = o20(path.join(tmp20, "remede"));
    poser("remede/lancer.sh", avecVolume + "\n");
    poser("remede/docs/projet/COMPOSANTS-OPS.md", table(avecVolume));
    const rApres = o20(path.join(tmp20, "remede"));
    ok(rAvant.verdict === "FAIL" && rApres.verdict === "PASS",
      `O20 : remède joué (-v <volume>:/var/lib/postgresql/data dans le script et dans la table) -> PASS (TF-1013 ; avant ${rAvant.verdict}, après ${rApres.verdict})`);
    poser("anonyme/lancer.sh", "docker run --rm -d --name b-mysql -v /var/lib/mysql mysql:8\ndocker run -d --name b-mongo -v /data/db mongo:7\n");
    const cA = (o20(path.join(tmp20, "anonyme")).findings || []).filter(f => f.regle === "O20");
    ok(cA.some(f => f.sev === "bloquant" && /b-mysql/.test(f.msg) && /ANONYME[\s\S]*--rm/.test(f.msg)) && cA.some(f => f.sev === "majeur" && /b-mongo/.test(f.msg) && /ANONYME/.test(f.msg)),
      "O20 : volume anonyme avec --rm -> bloquant (détruit à l'arrêt), sans --rm -> majeur (rien ne le désigne)");
    poser("sans-declaration/lancer.sh", avecVolume + "\n");
    const rSD = o20(path.join(tmp20, "sans-declaration"));
    ok(rSD.verdict === "FAIL" && (rSD.findings || []).some(f => f.sev === "majeur" && /aucune déclaration/.test(f.msg)),
      "O20 : composant à état bien monté mais aucune COMPOSANTS-OPS.md -> majeur, la déclaration manque");
    fs.mkdirSync(path.join(tmp20, "vide"));
    ok(o20(path.join(tmp20, "vide")).verdict === "SKIP", "O20 borne : aucun conteneur ni déclaration -> SKIP, rien à juger");
    poser("ancre/compose.yaml", "x-commun: &commun\n  restart: always\nservices:\n  base:\n    image: postgres:16\n");
    const rAn = o20(path.join(tmp20, "ancre"));
    ok(rAn.verdict === "FAIL" && (rAn.findings || []).some(f => f.sev === "majeur" && /non lu par le lecteur/.test(f.msg)),
      "O20 borne : fichier compose que le lecteur refuse (ancre) -> FAIL dit, jamais un PASS silencieux");
    ok(o20(path.join(tmp20, "racine-absente")).verdict === "SKIP", "O20 borne : racine introuvable -> SKIP");
    // Faux positifs fermés (rejeu d'O-20 sur forge-ops elle-même, 29/10/2026 : 26 constats, tous dans des citations) :
    // un fichier de test, une ligne de commentaire et un mot de prose après « docker start » ne sont pas des commandes ;
    // une chaîne de code qui lance un conteneur, si.
    poser("citations/lancer.test.mjs", 'const cas = "docker run -d --name base-t postgres:16";\n');
    poser("citations/notes.sh", "# docker run -d --name base-c postgres:16\n# docker start nodeodm\n");
    poser("citations/outil.mjs", "const aide = \"relancer : docker start (voir le guide)\";\n");
    const rCit = o20(path.join(tmp20, "citations"));
    ok(rCit.verdict === "SKIP" && !(rCit.findings || []).some(f => f.sev === "bloquant" || f.sev === "majeur"),
      `O20 : fichier de test, commentaire de script et mot de prose après docker start -> aucun constat, SKIP (obtenu ${rCit.verdict})`);
    poser("code/lancer.mjs", 'execSync("docker run -d --name base-code postgres:16");\n');
    const rCode = o20(path.join(tmp20, "code"));
    ok(rCode.verdict === "FAIL" && (rCode.findings || []).some(f => f.sev === "bloquant" && f.where === "lancer.mjs:1" && /SANS -v ni --mount/.test(f.msg)),
      "O20 : une chaîne de code qui lance un postgres sans volume reste jugée -> bloquant à sa ligne");
    poser("sans-etat/lancer.sh", "docker run -d --name web nginx:1.27\n");
    ok(o20(path.join(tmp20, "sans-etat")).verdict === "SKIP", "O20 borne : des docker run d'images sans état seulement -> SKIP, jamais un PASS vide");
  } finally {
    fs.rmSync(tmp20, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const ref20 = JSON.parse(fs.readFileSync(path.join(ici, "..", "references", "CONTENEURS-A-ETAT.json"), "utf8"));
  ok(ref20.format === "forge-ops/conteneurs-a-etat@1" && ref20.verifie_le === "2026-10-29"
      && [...ref20.images, ...ref20.faits_docker].every(e => /^https:\/\//.test(e.source) && e.lu_le === "2026-10-29" && !!e.citation),
    `O20 : référentiel daté, chaque image (${ref20.images.length}) et chaque fait Docker (${ref20.faits_docker.length}) cite sa source et sa date de lecture`);
}

// ── O21 (TF-2003, étude du pilot du 28/10/2026, ligne G3) : LE GO HUMAIN EST UNE APPROBATION D'ENVIRONNEMENT ─────
// Le fait : les plans donnaient les commandes, jamais le workflow qui les porte, et un environnement GitHub nommé
// mais jamais réglé est créé SANS règle au premier run. Avant O-21, `--workflow-deploiement` n'existait pas : le
// fichier était lu comme une cible (O1/O3). Chaque rouge échoue pour UNE raison, la sienne.
{
  console.log("");
  const o21 = (fichier, ...extra) => { try { return JSON.parse(run(oracle, ["--workflow-deploiement", fichier, "--json-only", ...extra])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };
  const fx21 = (f) => path.join(ici, "..", "fixtures", "o21-workflow-deploiement", f);
  const gabarit21 = path.join(ici, "..", "gabarits", "workflow-deploiement-production.yml");
  const durs = (r) => (r.findings || []).filter(f => f.regle === "O21" && (f.sev === "bloquant" || f.sev === "majeur"));
  const seul = (r, sev, motif) => durs(r).length === 1 && durs(r)[0].sev === sev && motif.test(durs(r)[0].msg);
  const rG = o21(gabarit21);
  ok(rG.verdict === "PASS" && durs(rG).length === 0 && (rG.findings || []).some(f => /GO gardé par le job « garde-go »/.test(f.msg)),
    `O21 : le gabarit gabarits/workflow-deploiement-production.yml -> PASS, son GO gardé par le job garde-go (obtenu ${rG.verdict})`);
  const rE = o21(fx21("rouge-sans-environnement.yml"));
  ok(rE.verdict === "FAIL" && seul(rE, "bloquant", /déploie sans référencer d'environnement/),
    `O21 : un job qui déploie (az containerapp update) sans environnement -> FAIL, ce seul constat (obtenu ${rE.verdict}, ${durs(rE).length} constat(s))`);
  const rS = o21(fx21("rouge-sans-garde.yml"));
  ok(rS.verdict === "FAIL" && seul(rS, "bloquant", /GO humain NON PROUVÉ[\s\S]*will not have any protection rules/),
    `O21 : environnement production sans garde ni capture -> FAIL, la phrase de la documentation citée (obtenu ${rS.verdict})`);
  const rA = o21(fx21("rouge-annulation.yml"));
  ok(rA.verdict === "FAIL" && seul(rA, "bloquant", /cancel-in-progress: true/),
    `O21 : groupe de concurrence à cancel-in-progress: true -> FAIL, ce seul constat (obtenu ${rA.verdict})`);
  const rT = o21(fx21("rouge-id-token-workflow.yml"));
  ok(rT.verdict === "FAIL" && seul(rT, "majeur", /id-token: write posé au niveau du workflow/),
    `O21 : id-token: write au niveau du workflow -> FAIL, ce seul constat ; environment sous la forme {name, url} reconnu (obtenu ${rT.verdict})`);
  const rC = o21(fx21("rouge-sans-concurrence.yml"));
  ok(rC.verdict === "FAIL" && seul(rC, "majeur", /aucun groupe de concurrence/),
    `O21 : aucun groupe de concurrence -> FAIL, ce seul constat ; needs en liste [garde-go] lu (obtenu ${rC.verdict})`);
  // TF-1013 : le second remède que nomme le constat (la capture de l'environnement) rend PASS ; une capture
  // sans relecteur ni restriction de branche est refusée.
  const rCv = o21(fx21("rouge-sans-garde.yml"), "--protection", fx21("protection-verte.json"));
  ok(rCv.verdict === "PASS", `O21 : remède joué, capture d'un environnement à relecteur, Prevent self-review et branches restreintes -> PASS (TF-1013 ; obtenu ${rCv.verdict})`);
  const rCr = o21(fx21("rouge-sans-garde.yml"), "--protection", fx21("protection-rouge.json"));
  ok(rCr.verdict === "FAIL" && durs(rCr).some(f => f.sev === "bloquant" && /sans relecteur requis/.test(f.msg)) && durs(rCr).some(f => f.sev === "majeur" && /sans restriction de branche/.test(f.msg)),
    "O21 : capture sans relecteur requis -> bloquant, sans restriction de branche -> majeur");
  const tmp21 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-o21-"));
  try {
    const texteG = fs.readFileSync(gabarit21, "utf8");
    // Le premier remède : retirer la garde du gabarit le rend rouge, la remettre le rend vert.
    const sansNeeds = path.join(tmp21, "gabarit-sans-garde.yml");
    // Fins de ligne CRLF ou LF : une extraction sous Windows (core.autocrlf) écrit le gabarit en CRLF.
    const ligneNeeds = /^    needs: garde-go\r?\n/m;
    fs.writeFileSync(sansNeeds, texteG.replace(ligneNeeds, ""), "utf8");
    const rN = o21(sansNeeds);
    ok(ligneNeeds.test(texteG) && rN.verdict === "FAIL" && seul(rN, "bloquant", /GO humain NON PROUVÉ/),
      "O21 : le gabarit privé de needs: garde-go -> FAIL ; c'est la garde, et rien d'autre, qui prouve le GO");
    const prot = JSON.parse(fs.readFileSync(fx21("protection-verte.json"), "utf8"));
    prot.protection_rules[1].prevent_self_review = false;
    const pAuto = path.join(tmp21, "auto-approbation.json");
    fs.writeFileSync(pAuto, JSON.stringify(prot), "utf8");
    const rAuto = o21(fx21("rouge-sans-garde.yml"), "--protection", pAuto);
    ok(rAuto.verdict === "FAIL" && seul(rAuto, "majeur", /Prevent self-review/), "O21 : relecteur requis mais auto-approbation permise -> majeur");
    prot.name = "staging"; prot.protection_rules[1].prevent_self_review = true;
    const pAutre = path.join(tmp21, "autre-environnement.json");
    fs.writeFileSync(pAutre, JSON.stringify(prot), "utf8");
    ok(seul(o21(fx21("rouge-sans-garde.yml"), "--protection", pAutre), "majeur", /capture de l'environnement « staging »/), "O21 : capture d'un autre environnement -> majeur, elle ne prouve rien pour la production");
    const pProd = path.join(tmp21, "prod-nomme.yml");
    fs.writeFileSync(pProd, texteG.split("production").join("prod"), "utf8");
    ok(o21(pProd).verdict === "SKIP" && o21(pProd, "--environnement", "prod").verdict === "PASS",
      "O21 : un environnement nommé « prod » n'est pas la production par défaut (SKIP) ; --environnement prod le juge (PASS)");
    const pAncre = path.join(tmp21, "ancre.yml");
    fs.writeFileSync(pAncre, "jobs:\n  a: &a\n    runs-on: ubuntu-latest\n", "utf8");
    ok(o21(pAncre).verdict === "FAIL", "O21 borne : workflow que le lecteur refuse (ancre) -> FAIL dit, jamais un PASS silencieux");
    ok(o21(path.join(tmp21, "absent.yml")).verdict === "SKIP", "O21 borne : workflow introuvable -> SKIP");
  } finally {
    fs.rmSync(tmp21, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  // Le référentiel est câblé (loi n° 1) et sourcé : chaque source porte sa date de lecture.
  const doc21 = fs.readFileSync(path.join(ici, "..", "references", "WORKFLOW-DEPLOIEMENT.md"), "utf8");
  const sources21 = [...doc21.matchAll(/^  - url: (https:\/\/\S+)\r?\n    lu_le: (\d{4}-\d{2}-\d{2})\r?$/gm)];
  ok(sources21.length >= 9 && sources21.every(m => m[2] === "2026-10-29" && m[1].startsWith("https://docs.github.com/")),
    `O21 : WORKFLOW-DEPLOIEMENT.md porte ses sources docs.github.com, chacune lue le 29/10/2026 (obtenu ${sources21.length})`);
  // Un retour à la ligne du Markdown vaut une espace : la citation se compare sur le texte replié.
  const doc21Plie = doc21.replace(/\s+/g, " ");
  ok(doc21Plie.includes("will not have any protection rules or secrets configured") && doc21Plie.includes("cannot be combined with `cancel-in-progress: true`")
      && doc21Plie.includes("The subject claim includes the environment name when the job references an environment."),
    "O21 : les trois faits qui fondent les règles (environnement créé sans règle, concurrence, sujet OIDC) sont cités mot pour mot");
  ok(["CLAUDE.md", "README.md"].every(f => { const t = fs.readFileSync(path.join(ici, "..", f), "utf8"); return t.includes("WORKFLOW-DEPLOIEMENT.md") && t.includes("workflow-deploiement-production.yml"); }),
    "O21 : le référentiel et le gabarit sont appelés par CLAUDE.md et README.md (loi n° 1)");
  let verdictDoc21 = "ILLISIBLE";
  try { verdictDoc21 = JSON.parse(run(oracle, [path.join(ici, "..", "references", "WORKFLOW-DEPLOIEMENT.md"), "--json-only"])).verdict; }
  catch (e) { try { verdictDoc21 = JSON.parse(String(e.stdout)).verdict; } catch { /* reste ILLISIBLE */ } }
  ok(verdictDoc21 === "PASS", `O21 : WORKFLOW-DEPLOIEMENT.md passe l'oracle de documents (O9, O12, O13, O16) (obtenu ${verdictDoc21})`);
}

console.log(`\nSelf-test forge-ops : ${pass} PASS, ${echec} FAIL`);
process.exit(echec ? 1 : 0);

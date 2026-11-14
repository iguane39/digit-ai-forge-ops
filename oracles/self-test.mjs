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

// TF-2129 (lot Produit-86 20261103d, RO-1, G-05) — LA REGION DE REPLI ET LA SONDE DE CAPACITE.
// Le 03/11, northeurope a refuse six fois une machine a deux coeurs (409 SkuNotAvailable) alors que
// `az vm list-skus` ne montrait aucune restriction ; francecentral a repondu. Trois choses se jugent :
//   1) le plan azure DECLARE un repli (<REGION_REPLI>) et joue la sonde AVANT `az group create` (O-5) ;
//   2) la sonde distingue « SKU liste » de « capacite disponible » : seul un essai d'allocation prouve ;
//   3) le message SkuNotAvailable mene, dans le runbook (G-05), a ce repli.
// Hors ligne : l'outil n'appelle jamais Azure ; les captures sont des fixtures.
{
  const sonde = path.join(ici, "..", "scripts", "sonder-capacite.mjs");
  const lancer = (args) => {
    const r = spawnSync(process.execPath, [sonde, ...args], { encoding: "utf8" });
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* sortie non JSON : plan ou usage */ }
    return { code: r.status, json, sortie: String(r.stdout || ""), erreur: String(r.stderr || "") };
  };
  const juge = (f) => lancer(["juger", fx(`sonder-capacite/${f}`)]);

  // 1) le plan azure : repli declare, sonde avant le groupe, O-5 PASS ; deux rouges et le remede joue (TF-1013).
  const tmp2129 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-plan2129-"));
  try {
    const pAz = path.join(tmp2129, "plan-azure.json");
    run(ops, ["plan", "azure", fx("app-verte"), "--sortie", pAz]);
    const az = JSON.parse(fs.readFileSync(pAz, "utf8"));
    const pv = az.phases.provision;
    const iSonde = pv.findIndex(l => /sonder-capacite\.mjs plan /.test(l));
    const iVerdict = pv.findIndex(l => /sonder-capacite\.mjs juger /.test(l));
    const iGroupe = pv.findIndex(l => /^az group create /.test(l));
    ok(az.placeholders.includes("<REGION_REPLI>") && az.placeholders.includes("<TAILLE_MACHINE>") && pv.some(l => l.includes("<REGION_REPLI>")),
      "TF-2129 · plan azure : la region de repli <REGION_REPLI> et la taille sondee <TAILLE_MACHINE> sont des jetons declares et employes");
    ok(iSonde >= 0 && iVerdict > iSonde && iGroupe > iVerdict,
      `TF-2129 · plan azure : sonde -> verdict -> az group create, dans cet ordre (indices ${iSonde}/${iVerdict}/${iGroupe}) : aucun reseau avant la sonde`);
    ok(/ne prouve PAS la capacite/.test(pv[iSonde] || ""), "TF-2129 · plan azure : la ligne de sonde dit qu'un SKU liste ne prouve pas la capacite");
    ok(verdictPlan(pAz) === "PASS", "TF-2129 · oracle O-5 PASS sur le plan azure qui declare son repli");

    const constats2129 = (plan) => { const f = path.join(tmp2129, "rouge.json"); fs.writeFileSync(f, JSON.stringify(plan), "utf8");
      try { return JSON.parse(run(oracle, ["--plan", f, "--json-only"])).findings; }
      catch (e) { try { return JSON.parse(String(e.stdout)).findings; } catch { return []; } } };
    const sansSonde = structuredClone(az);
    // le repli reste declare (jeton employe) : seule la sonde disparait, pour que le constat soit unique
    sansSonde.phases.provision = pv.map(l => l.replace(/sonder-capacite\.mjs/g, "autre-outil.mjs"));
    const f1 = constats2129(sansSonde);
    ok(f1.length === 1 && f1[0].sev === "majeur" && /sonde de capacité .* manque ou suit `az group create`/.test(f1[0].msg),
      `TF-2129 · ROUGE — plan azure sans sonde : exactement un constat, celui de la sonde (obtenu ${f1.length})`);
    const sansRepli = structuredClone(az);
    sansRepli.placeholders = az.placeholders.filter(j => j !== "<REGION_REPLI>");
    sansRepli.phases.provision = pv.map(l => l.split("<REGION_REPLI>").join("<REGION>"));
    const f2 = constats2129(sansRepli);
    ok(f2.length === 1 && f2[0].sev === "majeur" && /aucune région de repli déclarée/.test(f2[0].msg),
      `TF-2129 · ROUGE — plan azure sans region de repli : exactement un constat, celui du repli (obtenu ${f2.length})`);
    const apresGroupe = structuredClone(az);
    apresGroupe.phases.provision = [...pv.filter(l => !/sonder-capacite\.mjs/.test(l)), ...pv.filter(l => /sonder-capacite\.mjs/.test(l))];
    const f3 = constats2129(apresGroupe);
    ok(f3.length === 1 && /manque ou suit `az group create`/.test(f3[0].msg),
      `TF-2129 · ROUGE — sonde posee APRES le groupe (reseau deja cree) : un constat (obtenu ${f3.length})`);
    // TF-1013 : le remede que le message propose (poser la sonde avant le groupe) est joue et doit PASSER.
    const remede = structuredClone(sansSonde);
    remede.phases.provision = pv.slice();   // les lignes de sonde nommees par le constat, reposees avant `az group create`
    const fr = constats2129(remede);
    ok(fr.length === 1 && fr[0].sev === "info", "TF-2129 · remede joue : la sonde reposee avant `az group create` rend O-5 PASS (TF-1013)");
  } finally {
    fs.rmSync(tmp2129, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 2) la sonde : liste et capacite sont deux preuves ; seule la seconde ouvre la region.
  const vBascule = juge("verte-bascule-sur-repli.json");
  ok(vBascule.code === 0 && vBascule.json?.verdict === "PASS" && vBascule.json?.region_retenue === "francecentral",
    `TF-2129 · VERTE — le cas du 03/11 (northeurope listee sans restriction mais refusee SkuNotAvailable, francecentral allouee) : repli retenu (obtenu ${vBascule.code}/${vBascule.json?.region_retenue})`);
  ok(vBascule.json?.regions?.[0]?.tailles?.every(t => t.etat === "REFUSE_CAPACITE" && /LISTÉE sans restriction/.test(t.msg)),
    "TF-2129 · le refus de la principale dit que la taille etait LISTEE sans restriction : la liste ne prouvait rien");
  const vPrincipale = juge("verte-principale-allouee.json");
  ok(vPrincipale.code === 0 && vPrincipale.json?.region_retenue === "northeurope",
    `TF-2129 · VERTE — region de convention allouee : pas de bascule (obtenu ${vPrincipale.json?.region_retenue})`);
  const rListe = juge("rouge-liste-sans-essai.json");
  ok(rListe.code === 2 && rListe.json?.verdict === "NON_PROUVE" && rListe.json?.region_retenue === null
    && rListe.json?.regions?.every(r => r.tailles.every(t => t.etat === "LISTEE_SANS_PREUVE")),
    `TF-2129 · ROUGE — SKU liste sans restriction et aucun essai d'allocation : capacite NON prouvee, aucune region retenue (obtenu ${rListe.code}/${rListe.json?.verdict})`);
  const rSansRepli = juge("rouge-sans-repli.json");
  ok(rSansRepli.code === 1 && rSansRepli.json?.verdict === "FAIL" && /aucune région de repli déclarée/.test(rSansRepli.json?.findings?.[0]?.msg || ""),
    `TF-2129 · ROUGE — relevé sans region de repli : FAIL qui le nomme (obtenu ${rSansRepli.code})`);
  const rAucune = juge("rouge-aucune-region.json");
  ok(rAucune.code === 1 && rAucune.json?.verdict === "FAIL" && rAucune.json?.region_retenue === null
    && rAucune.json?.regions?.[1]?.tailles?.[0]?.etat === "RESTREINTE",
    `TF-2129 · ROUGE — ni la principale (refusee) ni le repli (restreint) : FAIL, rien a creer (obtenu ${rAucune.code})`);
  const rQuota = juge("rouge-refus-de-quota.json");
  ok(rQuota.code === 2 && rQuota.json?.region_retenue === null && rQuota.json?.regions?.[0]?.tailles?.[0]?.etat === "REFUSE_AUTRE",
    `TF-2129 · ROUGE — refus QuotaExceeded : ce n'est pas la capacite, on ne bascule pas (obtenu ${rQuota.code}/${rQuota.json?.region_retenue})`);
  const illisible = lancer(["juger", fx("sonder-capacite/inexistant.json")]);
  ok(illisible.code === 2 && illisible.json?.verdict === "NON_PROUVE", "TF-2129 · borne — relevé introuvable : NON_PROUVE (exit 2), jamais un PASS");

  // le mode plan : les deux regions, une liste ET un essai d'allocation par region, le repli obligatoire et different.
  const pl = lancer(["plan", "--region", "northeurope", "--repli", "francecentral", "--taille", "Standard_D2s_v5"]);
  ok(pl.code === 0 && /az vm list-skus --location northeurope/.test(pl.sortie) && /az vm list-skus --location francecentral/.test(pl.sortie)
    && /az vm create --resource-group sonde-capacite-northeurope .*--size Standard_D2s_v5/.test(pl.sortie) && /az vm create --resource-group sonde-capacite-francecentral /.test(pl.sortie)
    && /ne prouve PAS la capacité/.test(pl.sortie),
    "TF-2129 · plan de sonde : par region, la liste (qui ne prouve pas) PUIS l'essai d'allocation (qui prouve)");
  ok(lancer(["plan", "--region", "northeurope", "--taille", "Standard_D2s_v5"]).code === 2, "TF-2129 · plan de sonde sans repli : refuse (exit 2)");
  ok(lancer(["plan", "--region", "northeurope", "--repli", "NorthEurope", "--taille", "Standard_D2s_v5"]).code === 2, "TF-2129 · plan de sonde dont le repli est la region principale : refuse (exit 2)");

  // 3) le runbook : le message SkuNotAvailable mene au repli.
  const gestes = fs.readFileSync(path.join(ici, "..", "references", "GESTES-EXPLOITATION.md"), "utf8");
  const g05 = (gestes.match(/## G-05 [\s\S]*?(?=\n## G-\d\d |\s*$)/) || [""])[0];
  ok(/SkuNotAvailable/.test(g05) && /AllocationFailed/.test(g05) && /sonder-capacite\.mjs/.test(g05) && /REGION_REPLI/.test(g05) && /orphelin/.test(g05),
    "TF-2129 · runbook G-05 : SkuNotAvailable (et AllocationFailed) -> region de repli, sonde nommee, reseau orphelin dit");
  ok(/SkuNotAvailable/.test(fs.readFileSync(path.join(ici, "..", "README.md"), "utf8")) && /sonder-capacite\.mjs/.test(fs.readFileSync(path.join(ici, "..", "CLAUDE.md"), "utf8")),
    "TF-2129 · README.md et CLAUDE.md appellent la sonde et le message SkuNotAvailable (loi n° 1 : affordance cablee)");
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

// ── O22 (D-108 (b), décision humaine du 29/10/2026) : « EN SERVICE » D'UNE TÂCHE PLANIFIÉE PORTE LA LECTURE D'UNE ─────
// PREMIÈRE EXÉCUTION RÉELLE, ET UNE ÉCHÉANCE PASSÉE SANS PREUVE PLUS RÉCENTE EST UN CONSTAT ───────────────────────────
// Le fait du 21/10/2026 : une tâche planifiée de publication déclarée « C'est en service », l'essai avait passé,
// aucune publication du 20 au 25/10, la vérification de 18 h 45 jamais faite. Avant O-22, `--mise-en-service`
// n'existait pas. Les fixtures se jouent à l'instant fixe `--le "2026-10-25 12:00"` : le verdict ne vieillit pas.
{
  console.log("");
  const REF22 = "2026-10-25 12:00";
  const o22 = (fichier, ...extra) => { try { return JSON.parse(run(oracle, ["--mise-en-service", fichier, "--json-only", ...extra])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };
  const dir22 = path.join(ici, "..", "fixtures", "o22-mise-en-service-planifiee");
  const fx22 = (f) => path.join(dir22, f);
  const durs = (r) => (r.findings || []).filter(f => f.regle === "O22" && (f.sev === "bloquant" || f.sev === "majeur"));
  const rVerte22 = o22(fx22("verte.md"), "--le", REF22);
  ok(rVerte22.verdict === "PASS" && durs(rVerte22).length === 0,
    `O22 : quatre tâches (id lu, URL, id en code, échéance passée suivie d'une lecture plus récente), une « déclaré », un composant non planifié -> PASS (obtenu ${rVerte22.verdict})`);
  const rRouge22 = o22(fx22("rouge.md"), "--le", REF22);
  const f22 = durs(rRouge22);
  ok(rRouge22.verdict === "FAIL", `O22 : six tâches « en service » sans preuve valable -> FAIL (obtenu ${rRouge22.verdict})`);
  const de22 = (nom, motif) => f22.filter(f => f.where === nom && motif.test(f.msg)).length === 1;
  ok(de22("publication-exemple", /« essai passé » est un essai.*ni identifiant ni URL/), "O22 : « essai passé » tenu pour preuve -> constat, le fait du 21/10 (publication-exemple)");
  ok(de22("export-exemple", /date et heure de lecture absentes/), "O22 : preuve sans date ni heure de lecture -> constat (export-exemple)");
  ok(de22("sauvegarde-exemple", /prochaine échéance absente/), "O22 : aucune prochaine échéance -> constat (sauvegarde-exemple)");
  ok(de22("veille-exemple", /DÉPASSÉE à 2026-10-25 12:00 sans preuve plus récente \(la lecture la plus récente date du 2026-10-20 08:00\)/),
    "O22 : échéance du 21/10 à 18 h 45 passée sans lecture plus récente -> constat qui dit la dernière lecture (veille-exemple)");
  ok(de22("rappel-exemple", /après l'instant de référence/), "O22 : lecture datée du futur -> constat (rappel-exemple)");
  ok(de22("relance-exemple", /SANS heure/), "O22 : lecture sans heure -> constat (relance-exemple)");
  ok(f22.length === 6 && !f22.some(f => f.where === "inventaire-exemple"), `O22 : six tâches fautives, six constats, la tâche « déclaré » non jugée (obtenu ${f22.length})`);
  const rCol22 = o22(fx22("rouge-sans-colonnes.md"), "--le", REF22);
  ok(rCol22.verdict === "FAIL" && durs(rCol22).length === 1 && /publication-exemple/.test(durs(rCol22)[0].msg)
      && /« Première exécution lue » ni « Première lecture le » ni « Prochaine échéance »/.test(durs(rCol22)[0].msg),
    `O22 : tâche « actif » dans une table sans colonne de preuve -> FAIL, ce seul constat, qui nomme la tâche et les trois colonnes (obtenu ${rCol22.verdict}, ${durs(rCol22).length})`);
  const tmp22 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-o22-"));
  try {
    const ecrire = (nom, texte) => { const p = path.join(tmp22, nom); fs.writeFileSync(p, texte, "utf8"); return p; };
    const EN = ["Composant", "Statut", "Première exécution lue", "Première lecture le", "Prochaine échéance"];
    const doc22 = (entetes, ...lignes) => `## Tâches planifiées\n\n| ${entetes.join(" | ")} |\n|${entetes.map(() => "---").join("|")}|\n${lignes.map(l => `| ${l.join(" | ")} |`).join("\n")}\n`;
    const un = (id, stat, pre, lec, ech) => ecrire(`${id}.md`, doc22(EN, [id, stat, pre, lec, ech]));
    const sansConstat = (r) => r.verdict === "PASS" && durs(r).length === 0;
    // TF-1013 : les remèdes que nomment les constats se jouent, et rendent PASS.
    const tacheRouge = ["veille-exemple", "en service", "job-0042", "2026-10-20 08:00", "2026-10-21 18:45"];
    ok(o22(ecrire("echue.md", doc22(EN, tacheRouge)), "--le", REF22).verdict === "FAIL", "O22 remède : la tâche à échéance passée, seule dans sa table -> FAIL");
    ok(sansConstat(o22(ecrire("echue-relue.md", doc22([...EN, "Dernière exécution lue", "Dernière lecture le"], [...tacheRouge, "job-0057", "2026-10-25 09:00"])), "--le", REF22)),
      "O22 remède 1 : lire la dernière exécution (identifiant + heure de lecture) après l'échéance -> PASS, l'échéance restant passée");
    const rDecl = o22(ecrire("declaree.md", doc22(EN, ["veille-exemple", "déclaré", "—", "—", "—"])), "--le", REF22);
    ok(rDecl.verdict === "SKIP" && durs(rDecl).length === 0, `O22 remède 2 : ramener le Statut à « déclaré » -> plus de constat, SKIP et jamais un PASS vide (obtenu ${rDecl.verdict})`);
    ok(sansConstat(o22(un("pub-exemple", "actif", "https://reseau.exemple/p/881122", "2026-10-21 18:50", "2026-10-26 18:45"), "--le", REF22)),
      "O22 remède 3 : l'URL de la publication réelle + l'heure de lecture + l'échéance -> PASS");
    ok(sansConstat(o22(ecrire("colonnes-ajoutees.md", doc22(EN, ["publication-exemple", "actif", "post-17912345678", "2026-10-21 18:50", "2026-10-26 18:45"])), "--le", REF22)),
      "O22 remède 4 : table de rouge-sans-colonnes.md complétée des trois colonnes -> PASS");
    // La preuve : un identifiant ou une URL, jamais une date, une heure, un mot ou un essai.
    const refus = (pre) => o22(un("preuve", "actif", pre, "2026-10-21 18:50", "2026-10-26 18:45"), "--le", REF22);
    ok(refus("2026-10-21 18:50").verdict === "FAIL" && refus("ok").verdict === "FAIL" && refus("publié").verdict === "FAIL",
      "O22 : une date, « ok » ou « publié » ne sont pas un identifiant -> FAIL");
    ok(sansConstat(refus("id 17912345678")) && sansConstat(refus("https://reseau.exemple/p/881122")), "O22 : un identifiant à chiffres ou une URL -> PASS");
    ok(/cite un essai/.test(durs(refus("https://reseau.exemple/p/881122 (publication d'essai)"))[0]?.msg || ""),
      "O22 : une URL de publication « d'essai » -> FAIL (cite un essai : la preuve attendue est celle d'une exécution réelle)");
    ok(sansConstat(refus("https://reseau.exemple/p/881122 (publication réelle, après l'essai à blanc)")), "O22 : « réelle » dit dans la cellule -> PASS");
    // Les instants : AAAA-MM-JJ HH:MM, graphies THH:MM et HHhMM ; une échéance sans heure vaut la fin de son jour.
    ok(sansConstat(o22(un("graphies", "actif", "post-123456", "2026-10-21T18:50", "2026-10-26 18h45"), "--le", REF22)), "O22 : « THH:MM » et « HHhMM » sont lus");
    ok(durs(o22(un("calendrier", "actif", "post-123456", "2026-02-30 10:00", "2026-10-26 18:45"), "--le", REF22))[0]?.msg.includes("illisibles"), "O22 : un 30 février est illisible -> constat");
    ok(sansConstat(o22(un("jour-meme", "actif", "post-123456", "2026-10-25 09:00", "2026-10-25"), "--le", REF22)), "O22 : échéance sans heure = fin du jour : le jour même, pas encore passée");
    ok(o22(un("lendemain", "actif", "post-123456", "2026-10-25 09:00", "2026-10-25"), "--le", "2026-10-26").verdict === "FAIL", "O22 : la même échéance, `--le` du lendemain -> DÉPASSÉE");
    ok(o22(un("limite", "actif", "post-123456", "2026-10-21 18:45", "2026-10-21 18:45"), "--le", REF22).verdict === "FAIL",
      "O22 : lecture à la minute même de l'échéance = pas plus récente que l'échéance -> constat");
    ok(sansConstat(o22(un("limite-apres", "actif", "post-123456", "2026-10-21 18:46", "2026-10-21 18:45"), "--le", REF22)),
      "O22 : lecture une minute après l'échéance -> PASS, la lecture est plus récente que l'échéance");
    // Sans `--le`, l'instant de référence est maintenant.
    ok(sansConstat(o22(un("futur-lointain", "actif", "post-123456", "2026-10-21 18:50", "2099-01-01 08:00"))), "O22 : sans --le, une échéance en 2099 n'est pas passée -> PASS");
    ok(o22(un("passe-lointain", "actif", "post-123456", "1999-12-30 18:50", "2000-01-01 08:00")).verdict === "FAIL", "O22 : sans --le, une échéance en 2000 sans lecture plus récente -> FAIL");
    // Désignation d'une tâche planifiée : titre, colonne Cadence ou colonne Type — jamais le nom seul.
    const ent2 = ["Composant", "Type", "Statut"];
    ok(o22(ecrire("type.md", `## Inventaire\n\n| ${ent2.join(" | ")} |\n|---|---|---|\n| pub-exemple | tâche planifiée | actif |\n`), "--le", REF22).verdict === "FAIL",
      "O22 : une colonne Type « tâche planifiée » désigne la tâche, sans titre ni Cadence -> jugée");
    ok(o22(ecrire("sans-designation.md", `## Inventaire\n\n| ${ent2.join(" | ")} |\n|---|---|---|\n| pub-exemple | application | actif |\n`), "--le", REF22).verdict === "SKIP",
      "O22 : « actif » sans titre, Cadence ni Type de tâche planifiée -> non jugé, SKIP");
    ok(sansConstat(o22(ecrire("sans-accents.md", doc22(["Composant", "Statut", "Premiere execution lue", "Premiere lecture le", "Prochaine echeance"], ["pub-exemple", "actif", "post-123456", "2026-10-21 18:50", "2026-10-26 18:45"])), "--le", REF22)),
      "O22 : en-têtes écrits sans accents -> lus pareil");
    ok(o22(ecrire("sans-statut.md", "## Tâches planifiées\n\n| Composant | Cadence |\n|---|---|\n| pub-exemple | chaque jour |\n"), "--le", REF22).verdict === "FAIL",
      "O22 : table de tâches planifiées sans colonne Statut -> FAIL");
    // Bornes : aucun défaut implicite.
    ok(o22(path.join(tmp22, "absent.md")).verdict === "donnees_insuffisantes", "O22 borne : document introuvable -> donnees_insuffisantes");
    ok(o22(fx22("verte.md"), "--le", "hier").verdict === "donnees_insuffisantes", "O22 borne : --le illisible -> donnees_insuffisantes, jamais un repli silencieux sur maintenant");
    ok(o22(path.join(ici, "..", "fixtures", "o15-statut-composants", "doc-vert.md"), "--le", REF22).verdict === "SKIP",
      "O22 borne : un inventaire sans tâche planifiée désignée (statuts « actif » compris) -> SKIP");
  } finally {
    fs.rmSync(tmp22, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  // Loi n° 1 : la règle est câblée — documentée là où la forge documente les autres.
  const lire22 = (f) => fs.readFileSync(path.join(ici, "..", f), "utf8");
  ok(["README.md", "CLAUDE.md"].every(f => { const t = lire22(f); return t.includes("--mise-en-service") && t.includes("O22") && t.includes("D-108 (b)"); })
      && lire22("README.md").includes("fixtures/o22-mise-en-service-planifiee"),
    "O22 : la règle, son mode et sa décision sont appelés par README.md et CLAUDE.md, fixtures citées (loi n° 1)");
  ok(/O22 --mise-en-service/.test(lire22("oracles/oracle-ops.mjs").split("import fs")[0]), "O22 : la règle figure à l'en-tête d'oracle-ops.mjs, seule source de la liste des règles");
}

// ── O23 + plages-docker (TF-2164, lot Produit-86 20261104a RO-2) : UN RÉSEAU DOCKER POSÉ PAR TERRAFORM RELÈVE ───────
// LES PLAGES PRISES ET NE DÉRIVE PAS ────────────────────────────────────────────────────────────────────────────────
// Le fait du 04/11/2026 : « Pool overlaps » sur 172.30.0.0/24, puis un remplacement du réseau à chaque apply
// (ipam_config complété par le démon) : 3 déploiements en échec. Rejoué le 05/11/2026 avec un vrai Terraform :
// sans ignore_changes, le plan suivant rend « must be replaced » (exit 2) ; avec le gabarit, « No changes » (exit 0).
{
  console.log("");
  const plagesMod = await import("../scripts/plages-docker.mjs");
  const { lireCidr, enTexte, chevauche, plagesDuReleve, choisirPlage } = plagesMod;
  const script23 = path.join(ici, "..", "scripts", "plages-docker.mjs");
  const releve = f => JSON.parse(fs.readFileSync(fx(path.join("plages-docker", f)), "utf8"));
  const cli23 = (args, input) => spawnSync(process.execPath, [script23, ...args], { encoding: "utf8", input });
  // La cause, rouge : la plage écrite à la main du 04/11 chevauche la plage prise ; le relevé, lui, en évite le chevauchement.
  const prises = plagesDuReleve(releve("releve-172-30-pris.json"));
  ok(chevauche(lireCidr("172.30.0.0/24"), prises.find(p => p.nom === "produit_interne")), "plages-docker : 172.30.0.0/24 écrite à la main chevauche la plage prise du produit (la cause de « Pool overlaps »)");
  const choix = choisirPlage({ plages: prises, base: "172.30.0.0/16" });
  ok(choix.subnet === "172.30.2.0/24" && choix.gateway === "172.30.2.1" && choix.source === "libre",
    `plages-docker : le relevé saute 172.30.0.0/24 (prise) et 172.30.1.0/24 (un /25 y est pris : chevauchement, pas égalité) -> 172.30.2.0/24 (obtenu ${choix.subnet})`);
  ok(prises.length === 3 && !prises.some(p => /:/.test(p.texte)), "plages-docker : trois plages IPv4 lues ; l'IPv6 et le réseau sans plage sont écartés");
  // Le réseau déjà posé : sa plage lui revient telle quelle, sinon le plan suivant en choisirait une autre.
  const deja = choisirPlage({ plages: plagesDuReleve(releve("releve-lab-existant.json")), base: "172.30.0.0/16", nom: "lab" });
  ok(deja.subnet === "172.30.2.0/24" && deja.source === "existante", `plages-docker : un réseau déjà posé garde sa plage (source existante, obtenu ${deja.source})`);
  const sansNom = choisirPlage({ plages: plagesDuReleve(releve("releve-lab-existant.json")), base: "172.30.0.0/16" });
  ok(sansNom.subnet === "172.30.1.0/24", `plages-docker : sans le nom du réseau, la plage du lab compte comme prise (obtenu ${sansNom.subnet})`);
  // L'arithmétique, bornes comprises : au-delà de 128.0.0.0 un entier signé de 32 bits fausserait tout.
  ok(lireCidr("192.168.0.0/20").taille === 4096 && enTexte(lireCidr("192.168.230.0/24").debut) === "192.168.230.0" && lireCidr("255.255.255.255/32").taille === 1,
    "plages-docker : arithmétique IPv4 juste au-delà de 128.0.0.0 et en /32");
  ok(lireCidr("172.30.0.9/24").debut === lireCidr("172.30.0.0/24").debut && lireCidr("172.30.0.0/33") === null && lireCidr("300.1.1.1/24") === null && lireCidr("fd00::/64") === null,
    "plages-docker : une adresse hôte se ramène à son réseau ; /33, octet > 255 et IPv6 sont refusés");
  // La CLI : exits du contrat.
  const rel = fx(path.join("plages-docker", "releve-172-30-pris.json"));
  const c1 = cli23(["choisir", "--base", "172.30.0.0/16", "--releve", rel]);
  ok(c1.status === 0 && JSON.parse(c1.stdout).subnet === "172.30.2.0/24", `plages-docker choisir : exit 0 et plage libre (exit ${c1.status})`);
  const c2 = cli23(["choisir", "--base", "172.30.0.0/24", "--releve", rel]);
  ok(c2.status === 1 && /aucune plage \/24 libre dans 172\.30\.0\.0\/24/.test(c2.stderr), `plages-docker choisir : base pleine -> exit 1 qui le dit (exit ${c2.status})`);
  const c3 = cli23(["choisir", "--releve", path.join(base, "absent.json")]);
  ok(c3.status === 2 && /introuvable/.test(c3.stderr), `plages-docker choisir : relevé introuvable -> exit 2, jamais un repli sur une plage devinée (exit ${c3.status})`);
  const c4 = cli23(["--externe", "--releve", rel], JSON.stringify({ nom: "x", base: "172.30.0.0/16", longueur: "24" }));
  const sortieExt = c4.status === 0 ? JSON.parse(c4.stdout) : {};
  ok(c4.status === 0 && Object.values(sortieExt).every(v => typeof v === "string") && sortieExt.subnet === "172.30.2.0/24",
    "plages-docker --externe : la requête de data \"external\" arrive sur l'entrée standard, la réponse ne porte que des chaînes");
  const c5 = cli23(["--externe", "--releve", rel], JSON.stringify({ base: "pas-un-cidr" }));
  ok(c5.status === 1 && /base illisible/.test(c5.stderr), `plages-docker --externe : erreur -> exit 1 et message sur l'erreur standard (Terraform l'affiche) (exit ${c5.status})`);
  ok(cli23(["inconnu"]).status === 2, "plages-docker : verbe inconnu -> exit 2");

  // O23 : paire de fixtures. Le gabarit passe ; chaque rouge échoue pour sa seule raison.
  const o23 = (cible, ...extra) => { try { return JSON.parse(run(oracle, ["--reseau-docker", cible, "--json-only", ...extra])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };
  const fx23 = d => fx(path.join("o23-reseau-docker", d));
  const durs = r => (r.findings || []).filter(f => f.regle === "O23" && (f.sev === "bloquant" || f.sev === "majeur"));
  const gabarit23 = path.join(ici, "..", "gabarits", "reseau-docker.tf");
  const rG = o23(gabarit23);
  ok(rG.verdict === "PASS" && durs(rG).length === 0, `O23 : gabarits/reseau-docker.tf -> PASS (relevé des plages + ignore_changes) (obtenu ${rG.verdict})`);
  const rI = o23(fx23("rouge-sans-ignore"));
  ok(rI.verdict === "FAIL" && durs(rI).length === 1 && durs(rI)[0].sev === "bloquant" && /ignore_changes = \[ipam_config\]/.test(durs(rI)[0].msg) && /Use the ignore_changes argument/.test(durs(rI)[0].msg),
    `O23 : ipam_config sans ignore_changes -> FAIL, ce seul constat, la phrase de la documentation citée (obtenu ${rI.verdict}, ${durs(rI).length})`);
  const rP = o23(fx23("rouge-plage-ecrite"));
  ok(rP.verdict === "FAIL" && durs(rP).length === 1 && /écrit en dur \("172\.30\.0\.0\/24"\)/.test(durs(rP)[0].msg) && /Pool overlaps/.test(durs(rP)[0].msg),
    `O23 : subnet écrit en dur (ignore_changes posé) -> FAIL, ce seul constat (obtenu ${rP.verdict}, ${durs(rP).length})`);
  const rF = o23(fx23("rouge-faux-releve"));
  ok(rF.verdict === "FAIL" && durs(rF).length === 1 && durs(rF)[0].sev === "majeur", `O23 : data "external" qui ne relève aucune plage -> FAIL majeur (obtenu ${rF.verdict}, ${durs(rF).length})`);
  const rV = o23(fx23("variable"));
  ok(rV.verdict === "PASS" && rV.findings.some(f => f.sev === "info" && /var\.plage/.test(f.msg)), "O23 : subnet tiré d'une variable -> PASS, dit non jugé");
  ok(o23(fx23("sans-ipam")).verdict === "SKIP", "O23 : réseau sans ipam_config -> SKIP, jamais un PASS vide");
  ok(o23(path.join(base, "absente")).verdict === "SKIP", "O23 borne : pile introuvable -> SKIP");
  // Jouer le remède que le refus nomme (TF-1013) : chacun doit PASSER.
  const tmp23 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-o23-"));
  try {
    const remede1 = path.join(tmp23, "remede-ignore.tf");
    fs.writeFileSync(remede1, fs.readFileSync(path.join(fx23("rouge-sans-ignore"), "main.tf"), "utf8").replace(/\r\n/g, "\n").replace(/\n  \}\n\}\n$/, "\n  }\n\n  lifecycle {\n    ignore_changes = [ipam_config]\n  }\n}\n"), "utf8");
    ok(o23(remede1).verdict === "PASS", `O23 remède : poser lifecycle { ignore_changes = [ipam_config] } sur le rouge -> PASS (obtenu ${o23(remede1).verdict})`);
    const remede2 = path.join(tmp23, "remede-releve.tf");
    fs.writeFileSync(remede2, fs.readFileSync(gabarit23, "utf8").replace(/\r?\n/g, "\n"), "utf8");
    ok(o23(remede2).verdict === "PASS", "O23 remède : la plage tirée du relevé, comme le gabarit -> PASS");
    // Bornes de lecture : un commentaire ne vaut pas la ligne, ignore_changes = all vaut, un sous-bloc imbriqué ne s'y confond pas.
    const commente = path.join(tmp23, "commente.tf");
    fs.writeFileSync(commente, 'resource "docker_network" "lab" {\n  name = "lab"\n  ipam_config {\n    subnet = var.p\n  }\n  # lifecycle { ignore_changes = [ipam_config] }\n}\n', "utf8");
    ok(o23(commente).verdict === "FAIL", "O23 borne : la ligne ignore_changes en commentaire ne compte pas -> FAIL");
    const tout = path.join(tmp23, "tout.tf");
    fs.writeFileSync(tout, 'resource "docker_network" "lab" {\n  name = "lab"\n  ipam_config {\n    subnet = var.p\n  }\n  lifecycle {\n    ignore_changes = all\n  }\n}\n', "utf8");
    ok(o23(tout).verdict === "PASS", "O23 borne : ignore_changes = all est lu comme couvrant ipam_config -> PASS");
    const deux = path.join(tmp23, "deux.tf");
    fs.writeFileSync(deux, 'resource "docker_network" "a" {\n  ipam_config {\n    subnet = var.p\n  }\n  lifecycle {\n    ignore_changes = [ipam_config]\n  }\n}\nresource "docker_network" "b" {\n  ipam_config {\n    subnet = var.p\n  }\n}\n', "utf8");
    const rD = o23(deux);
    ok(rD.verdict === "FAIL" && durs(rD).length === 1 && /docker_network\.b/.test(durs(rD)[0].msg), "O23 borne : deux réseaux dans un fichier, seul le second sans ignore_changes est nommé");
  } finally {
    fs.rmSync(tmp23, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  // Loi n° 1 : la règle, le gabarit, le script et le référentiel sont appelés ; les faits sont sourcés et datés.
  const lire23 = f => fs.readFileSync(path.join(ici, "..", f), "utf8");
  ok(["README.md", "CLAUDE.md"].every(f => { const t = lire23(f); return t.includes("--reseau-docker") && t.includes("RESEAU-ET-FRONTAL-DOCKER.md") && t.includes("reseau-docker.tf") && t.includes("plages-docker.mjs"); }),
    "O23 : le mode, le référentiel, le gabarit et le script de relevé sont appelés par README.md et CLAUDE.md (loi n° 1)");
  ok(/O23 --reseau-docker/.test(lire23("oracles/oracle-ops.mjs").split("import fs")[0]), "O23 : la règle figure à l'en-tête d'oracle-ops.mjs, seule source de la liste des règles");
  const doc23 = lire23("references/RESEAU-ET-FRONTAL-DOCKER.md");
  const sources23 = [...doc23.matchAll(/^  - url: (https:\/\/\S+)\r?\n    lu_le: (\d{4}-\d{2}-\d{2})\r?$/gm)];
  ok(sources23.length >= 2 && sources23.every(m => m[2] === "2026-11-05"), `O23 : RESEAU-ET-FRONTAL-DOCKER.md porte ses sources, chacune lue le 05/11/2026 (obtenu ${sources23.length})`);
  ok(doc23.replace(/\s+/g, " ").includes("Use the ignore_changes argument when a resource is created with references to data that may change in the future, but should not affect the resource after its creation."),
    "O23 : la phrase de la documentation Terraform qui fonde ignore_changes est citée mot pour mot");
  let verdictDoc23 = "ILLISIBLE";
  try { verdictDoc23 = JSON.parse(run(oracle, [path.join(ici, "..", "references", "RESEAU-ET-FRONTAL-DOCKER.md"), "--json-only"])).verdict; }
  catch (e) { try { verdictDoc23 = JSON.parse(String(e.stdout)).verdict; } catch { /* reste ILLISIBLE */ } }
  ok(verdictDoc23 === "PASS", `O23 : RESEAU-ET-FRONTAL-DOCKER.md passe l'oracle de documents (O9, O12, O13, O16) (obtenu ${verdictDoc23})`);
}

// ── O24 (TF-2165, lot Produit-86 20261104a RO-3) : UN FRONTAL NGINX RÉSOUT SON AMONT À CHAQUE REQUÊTE ──────────────────
// Le fait du 04/11/2026 : `proxy_pass http://app:8000;` résolu une fois ; l'application recréée change d'adresse, le
// frontal rend 502. Rejoué le 05/11/2026 sur nginx 1.30-alpine : littéral 502, gabarit 200 (exercice ci-dessous).
{
  console.log("");
  const o24 = (cible, ...extra) => { try { return JSON.parse(run(oracle, ["--frontal-nginx", cible, "--json-only", ...extra])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };
  const fx24 = f => fx(path.join("o24-frontal-nginx", f));
  const durs = r => (r.findings || []).filter(f => f.regle === "O24" && (f.sev === "bloquant" || f.sev === "majeur"));
  const gabarit24 = path.join(ici, "..", "gabarits", "frontal-nginx.conf");
  const rG = o24(gabarit24);
  ok(rG.verdict === "PASS" && durs(rG).length === 0, `O24 : gabarits/frontal-nginx.conf -> PASS (variable, resolver 127.0.0.11 valid=10s) (obtenu ${rG.verdict})`);
  const rL = o24(fx24("rouge-amont-fige.conf"));
  ok(rL.verdict === "FAIL" && durs(rL).length === 1 && durs(rL)[0].sev === "bloquant" && /résolu UNE fois/.test(durs(rL)[0].msg) && /host not found in upstream/.test(durs(rL)[0].msg),
    `O24 : proxy_pass http://app:8000 littéral -> FAIL, ce seul constat (obtenu ${rL.verdict}, ${durs(rL).length})`);
  const rR = o24(fx24("rouge-sans-resolver.conf"));
  ok(rR.verdict === "FAIL" && durs(rR).length === 1 && durs(rR)[0].sev === "bloquant" && /AUCUN resolver/.test(durs(rR)[0].msg) && /determined using a resolver/.test(durs(rR)[0].msg),
    `O24 : variable sans resolver -> FAIL, la phrase de la documentation citée (obtenu ${rR.verdict}, ${durs(rR).length})`);
  const rV = o24(fx24("rouge-resolver-sans-valid.conf"));
  ok(rV.verdict === "FAIL" && durs(rV).length === 1 && durs(rV)[0].sev === "majeur" && /sans valid=/.test(durs(rV)[0].msg),
    `O24 : resolver sans valid= -> FAIL majeur, ce seul constat (obtenu ${rV.verdict}, ${durs(rV).length})`);
  const rU = o24(fx24("rouge-upstream-fige.conf"));
  ok(rU.verdict === "FAIL" && durs(rU).length === 1 && /sans le paramètre resolve/.test(durs(rU)[0].msg), `O24 : groupe upstream qui nomme son serveur sans resolve -> FAIL (obtenu ${rU.verdict}, ${durs(rU).length})`);
  const rS = o24(fx24("rouge-upstream-resolver-dans-server.conf"));
  ok(rS.verdict === "FAIL" && durs(rS).length === 1 && /un resolver de bloc server ne lui sert pas/.test(durs(rS)[0].msg),
    `O24 : resolve avec un resolver seulement dans server -> FAIL, comme nginx -t (obtenu ${rS.verdict}, ${durs(rS).length})`);
  const rUv = o24(fx24("verte-upstream-resolve.conf"));
  ok(rUv.verdict === "PASS" && durs(rUv).length === 0, `O24 : upstream avec resolve, zone et resolver dans son bloc -> PASS (obtenu ${rUv.verdict})`);
  ok(o24(fx24("sans-nom-d-hote.conf")).verdict === "SKIP", "O24 : IP, socket unix, localhost et proxy_pass en commentaire -> SKIP, jamais un PASS vide");
  ok(o24(path.join(base, "absente.conf")).verdict === "SKIP", "O24 borne : configuration introuvable -> SKIP");
  // TF-2177 : les quatre autres directives d'amont de nginx se jugent comme proxy_pass, une fixture rouge par directive.
  const autres24 = [
    ["fastcgi_pass", "rouge-fastcgi-fige.conf", "app:9000"],
    ["uwsgi_pass", "rouge-uwsgi-fige.conf", "uwsgi://app:3031"],
    ["scgi_pass", "rouge-scgi-fige.conf", "app:4000"],
    ["grpc_pass", "rouge-grpc-fige.conf", "grpc://app:50051"],
  ];
  for (const [directive, fichier, cible] of autres24) {
    const r = o24(fx24(fichier));
    ok(r.verdict === "FAIL" && durs(r).length === 1 && durs(r)[0].sev === "bloquant" && durs(r)[0].msg.startsWith(`${directive} ${cible} :`)
        && /résolu UNE fois/.test(durs(r)[0].msg) && /host not found in upstream/.test(durs(r)[0].msg) && durs(r)[0].msg.includes(`ngx_http_${directive.replace("_pass", "")}_module.html`),
      `O24 TF-2177 : ${directive} ${cible} littéral -> FAIL, ce seul constat, qui nomme la directive et sa page nginx (obtenu ${r.verdict}, ${durs(r).length})`);
  }
  const rFu = o24(fx24("rouge-fastcgi-upstream-fige.conf"));
  ok(rFu.verdict === "FAIL" && durs(rFu).length === 1 && /^fastcgi_pass php :/.test(durs(rFu)[0].msg) && /sans le paramètre resolve/.test(durs(rFu)[0].msg),
    `O24 TF-2177 : fastcgi_pass vers un groupe upstream à serveur nommé sans resolve -> FAIL (obtenu ${rFu.verdict}, ${durs(rFu).length})`);
  const rAv = o24(fx24("verte-autres-passages-variable.conf"));
  ok(rAv.verdict === "PASS" && durs(rAv).length === 0, `O24 TF-2177 : les quatre directives par variable, avec un resolver qui porte valid= -> PASS (obtenu ${rAv.verdict})`);
  ok(o24(fx24("sans-nom-d-hote-autres-passages.conf")).verdict === "SKIP", "O24 TF-2177 : socket unix, IP, localhost, [::1] et grpc_pass unix pour les quatre directives, plus un commentaire -> SKIP, jamais un PASS vide");
  // Jouer le remède que le refus nomme (TF-1013) : le littéral réécrit comme le message le dit doit PASSER.
  const tmp24 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-o24-"));
  try {
    const litteral = fs.readFileSync(fx24("rouge-amont-fige.conf"), "utf8").replace(/\r\n/g, "\n");
    const remede = path.join(tmp24, "remede.conf");
    fs.writeFileSync(remede, litteral.replace("    listen 80;\n", '    listen 80;\n    resolver 127.0.0.11 valid=10s;\n    set $amont "http://app:8000";\n').replace("proxy_pass http://app:8000;", "proxy_pass $amont;"), "utf8");
    ok(o24(remede).verdict === "PASS", `O24 remède : resolver + set $amont + proxy_pass $amont sur le rouge littéral -> PASS (obtenu ${o24(remede).verdict})`);
    // TF-2177, le remède que le refus nomme, joué pour chacune des quatre directives : resolver + set $amont + <directive> $amont -> PASS.
    for (const [directive, fichier, cible] of autres24) {
      const source = fs.readFileSync(fx24(fichier), "utf8").replace(/\r\n/g, "\n");
      const corrige = path.join(tmp24, `remede-${directive}.conf`);
      fs.writeFileSync(corrige, source.replace("    listen 80;\n", `    listen 80;\n    resolver 127.0.0.11 valid=10s;\n    set $amont "${cible}";\n`).replace(`${directive} ${cible};`, `${directive} $amont;`), "utf8");
      const rC = o24(corrige);
      ok(rC.verdict === "PASS", `O24 TF-2177 remède : resolver + set $amont + ${directive} $amont sur le rouge littéral -> PASS (obtenu ${rC.verdict})`);
      // Les deux autres refus de variable valent pour la directive : sans resolver bloquant, sans valid= majeur.
      const sansResolver = path.join(tmp24, `sans-resolver-${directive}.conf`);
      fs.writeFileSync(sansResolver, fs.readFileSync(corrige, "utf8").replace("    resolver 127.0.0.11 valid=10s;\n", ""), "utf8");
      const rSr = o24(sansResolver);
      ok(rSr.verdict === "FAIL" && durs(rSr).length === 1 && durs(rSr)[0].sev === "bloquant" && durs(rSr)[0].msg.startsWith(`${directive} $amont :`) && /AUCUN resolver/.test(durs(rSr)[0].msg),
        `O24 TF-2177 borne : ${directive} par variable sans resolver -> FAIL bloquant, qui nomme la directive (obtenu ${rSr.verdict}, ${durs(rSr).length})`);
      const sansValid = path.join(tmp24, `sans-valid-${directive}.conf`);
      fs.writeFileSync(sansValid, fs.readFileSync(corrige, "utf8").replace("resolver 127.0.0.11 valid=10s;", "resolver 127.0.0.11;"), "utf8");
      const rSv = o24(sansValid);
      ok(rSv.verdict === "FAIL" && durs(rSv).length === 1 && durs(rSv)[0].sev === "majeur" && /sans valid=/.test(durs(rSv)[0].msg),
        `O24 TF-2177 borne : ${directive} par variable, resolver sans valid= -> FAIL majeur (obtenu ${rSv.verdict}, ${durs(rSv).length})`);
    }
    // Le dossier de la configuration : le resolver d'un fichier compte pour le proxy_pass d'un autre.
    fs.mkdirSync(path.join(tmp24, "conf.d"));
    fs.writeFileSync(path.join(tmp24, "nginx.conf"), "http {\n    resolver 127.0.0.11 valid=10s;\n    include /etc/nginx/conf.d/*.conf;\n}\n", "utf8");
    fs.writeFileSync(path.join(tmp24, "conf.d", "front.conf"), fs.readFileSync(fx24("rouge-sans-resolver.conf"), "utf8"), "utf8");
    ok(o24(path.join(tmp24, "conf.d", "front.conf")).verdict === "FAIL", "O24 borne : le même front.conf passé SEUL, sans le resolver de nginx.conf -> FAIL");
    ok(o24(path.join(tmp24, "conf.d")).verdict === "FAIL" && o24(tmp24).verdict === "PASS", "O24 borne : le dossier de la configuration entière, le resolver de http { } compte -> PASS");
    // Un commentaire qui cite le défaut ne compte pas ; une variable en ${…} se lit comme variable.
    const comm = path.join(tmp24, "commentaire.conf");
    fs.writeFileSync(comm, '# proxy_pass http://app:8000;\nserver {\n    resolver 127.0.0.11 valid=10s;\n    location / { proxy_pass http://${AMONT}; }\n}\n', "utf8");
    ok(o24(comm).verdict === "PASS", "O24 borne : le défaut cité en commentaire ne compte pas ; ${AMONT} est lu comme variable");
  } finally {
    fs.rmSync(tmp24, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // EXERCICE RÉEL, à la demande : réseau jetable, application, frontal ; l'application est recréée à une autre adresse.
  // Jamais par défaut (le banc reste hors ligne), jamais de téléchargement (image absente : SKIP dit).
  if (process.env.FORGE_OPS_EXERCICE_DOCKER !== "1") {
    console.log("  [SKIP] TF-2165 · exercice réel non demandé : FORGE_OPS_EXERCICE_DOCKER=1 recrée une application derrière un frontal nginx:1.30-alpine jetable (littéral 502, gabarit 200)");
  } else {
    const IMAGES = ["nginx:1.30-alpine", "python:3.12-slim"];
    const docker = (...a) => spawnSync("docker", a, { encoding: "utf8", timeout: 120000 });
    const absentes = IMAGES.filter(i => docker("image", "inspect", i).status !== 0);
    if (absentes.length) {
      console.log(`  [SKIP] TF-2165 · image(s) ${absentes.join(", ")} absente(s) du poste : l'exercice ne télécharge rien`);
    } else {
      const attendre = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      const suffixe = randomBytes(3).toString("hex");
      const reseau = `forge-ops-tf2165-${suffixe}`;
      const noms = { app: `fo-tf2165-app-${suffixe}`, front: `fo-tf2165-front-${suffixe}`, occupant: `fo-tf2165-occ-${suffixe}` };
      const dossier = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-tf2165-"));
      const nettoyer = () => { for (const n of Object.values(noms)) docker("rm", "-f", n); docker("network", "rm", reseau); };
      const adresse = n => docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${reseau}").IPAddress}}`, n).stdout.trim();
      const monter = conf => `${path.join(dossier, conf).replace(/\\/g, "/")}:/etc/nginx/conf.d/default.conf:ro`;
      const demarrerApp = () => docker("run", "-d", "--name", noms.app, "--network", reseau, "--network-alias", "app", "python:3.12-slim", "python", "-m", "http.server", "8000");
      const statut = () => (docker("exec", noms.front, "wget", "-q", "-S", "-O", "/dev/null", "http://127.0.0.1/").stderr.match(/HTTP\/1\.\d (\d{3})/) || [])[1] ?? "aucune réponse";
      const gabarit = fs.readFileSync(gabarit24, "utf8").replace(/\r\n/g, "\n");
      // Le littéral, tel que le lot le décrit : le gabarit privé de son resolver et de sa variable.
      const litteral = gabarit.replace(/\n\s*resolver [^\n]*\n/, "\n").replace(/\n\s*set \$amont "http:\/\/app:8000";\n/, "\n").replace("proxy_pass $amont;", "proxy_pass http://app:8000;");
      fs.writeFileSync(path.join(dossier, "litteral.conf"), litteral, "utf8");
      fs.writeFileSync(path.join(dossier, "gabarit.conf"), gabarit, "utf8");
      const resultats = {};
      try {
        for (const conf of ["litteral.conf", "gabarit.conf"]) {
          nettoyer();
          docker("network", "create", reseau);
          const t = docker("run", "--rm", "--network", reseau, "-v", monter(conf), "nginx:1.30-alpine", "nginx", "-t");
          const app = demarrerApp(); attendre(2500);
          const avantApp = adresse(noms.app);
          const front = docker("run", "-d", "--name", noms.front, "--network", reseau, "-v", monter(conf), "nginx:1.30-alpine");
          attendre(1500);
          const avant = statut();
          docker("rm", "-f", noms.app);
          docker("run", "-d", "--name", noms.occupant, "--network", reseau, "python:3.12-slim", "sleep", "300");
          demarrerApp(); attendre(2500);
          const apresApp = adresse(noms.app);
          attendre(11000); // plus que valid=10s
          resultats[conf] = { nginxT: t.status, demarre: app.status === 0 && front.status === 0, changee: avantApp !== "" && apresApp !== "" && avantApp !== apresApp, avant, apres: statut() };
        }
      } finally { nettoyer(); fs.rmSync(dossier, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      const L = resultats["litteral.conf"], G = resultats["gabarit.conf"];
      ok(L && G && L.demarre && G.demarre && L.changee && G.changee, "TF-2165 · exercice : l'application recréée a changé d'adresse dans les deux essais");
      ok(L?.nginxT !== 0 && G?.nginxT === 0, `TF-2165 · exercice : nginx -t sans l'amont échoue en littéral (exit ${L?.nginxT}) et passe avec le gabarit (exit ${G?.nginxT})`);
      ok(L?.avant === "200" && L?.apres === "502", `TF-2165 · exercice ROUGE : frontal littéral, 200 avant la recréation puis ${L?.apres} après (attendu 502)`);
      ok(G?.avant === "200" && G?.apres === "200", `TF-2165 · exercice VERT : gabarit, ${G?.avant} avant la recréation puis ${G?.apres} après (attendu 200)`);
      ok(docker("ps", "-a", "-q", "--filter", `name=fo-tf2165-`).stdout.trim() === "" && docker("network", "ls", "-q", "--filter", `name=${reseau}`).stdout.trim() === "",
        "TF-2165 · exercice : conteneurs et réseau jetables retirés");
    }
  }

  // EXERCICE TF-2177, à la demande aussi : `nginx -t` juge les mêmes fixtures que l'oracle, pour les quatre autres directives.
  // Le rouge littéral échoue « host not found in upstream », le remède que l'oracle nomme et le vert passent (sans amont sur le réseau par défaut).
  if (process.env.FORGE_OPS_EXERCICE_DOCKER !== "1") {
    console.log("  [SKIP] TF-2177 · exercice nginx -t non demandé : FORGE_OPS_EXERCICE_DOCKER=1 fait passer les fixtures fastcgi, uwsgi, scgi et grpc à nginx:1.30-alpine");
  } else if (spawnSync("docker", ["image", "inspect", "nginx:1.30-alpine"], { encoding: "utf8", timeout: 120000 }).status !== 0) {
    console.log("  [SKIP] TF-2177 · image nginx:1.30-alpine absente du poste : l'exercice ne télécharge rien");
  } else {
    const dossier77 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-tf2177-"));
    try {
      const nginxT = (nom, contenu) => {
        const p = path.join(dossier77, nom);
        fs.writeFileSync(p, contenu, "utf8");
        const r = spawnSync("docker", ["run", "--rm", "-v", `${p.replace(/\\/g, "/")}:/etc/nginx/conf.d/default.conf:ro`, "nginx:1.30-alpine", "nginx", "-t"], { encoding: "utf8", timeout: 120000 });
        return { status: r.status, sortie: `${r.stdout}${r.stderr}` };
      };
      for (const [directive, fichier, cible] of autres24) {
        const source = fs.readFileSync(fx24(fichier), "utf8").replace(/\r\n/g, "\n");
        const rouge = nginxT(`rouge-${directive}.conf`, source);
        ok(rouge.status !== 0 && /host not found in upstream/.test(rouge.sortie), `TF-2177 · exercice ROUGE : nginx -t refuse ${directive} ${cible} littéral (exit ${rouge.status}, « host not found in upstream »)`);
        const remede = nginxT(`remede-${directive}.conf`, source.replace("    listen 80;\n", `    listen 80;\n    resolver 127.0.0.11 valid=10s;\n    set $amont "${cible}";\n`).replace(`${directive} ${cible};`, `${directive} $amont;`));
        ok(remede.status === 0, `TF-2177 · exercice VERT : nginx -t accepte le remède ${directive} $amont avec resolver (exit ${remede.status})`);
      }
      const vert = nginxT("vert.conf", fs.readFileSync(fx24("verte-autres-passages-variable.conf"), "utf8"));
      ok(vert.status === 0, `TF-2177 · exercice VERT : nginx -t accepte verte-autres-passages-variable.conf (exit ${vert.status})`);
    } finally {
      fs.rmSync(dossier77, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  // Loi n° 1 : la règle, le gabarit et le référentiel sont appelés ; les faits sont sourcés et datés.
  const lire24 = f => fs.readFileSync(path.join(ici, "..", f), "utf8");
  ok(["README.md", "CLAUDE.md"].every(f => { const t = lire24(f); return t.includes("--frontal-nginx") && t.includes("frontal-nginx.conf") && t.includes("RESEAU-ET-FRONTAL-DOCKER.md"); }),
    "O24 : le mode, le gabarit et le référentiel sont appelés par README.md et CLAUDE.md (loi n° 1)");
  ok(/O24 --frontal-nginx/.test(lire24("oracles/oracle-ops.mjs").split("import fs")[0]), "O24 : la règle figure à l'en-tête d'oracle-ops.mjs, seule source de la liste des règles");
  const doc24 = lire24("references/RESEAU-ET-FRONTAL-DOCKER.md");
  const sources24 = [...doc24.matchAll(/^  - url: (https:\/\/nginx\.org\/\S+)\r?\n    lu_le: (\d{4}-\d{2}-\d{2})\r?$/gm)];
  ok(sources24.length === 7 && sources24.every(m => m[2] === "2026-11-05"), `O24 : sept pages nginx.org sourcées (proxy, core, upstream, puis fastcgi, uwsgi, scgi, grpc de TF-2177), chacune lue le 05/11/2026 (obtenu ${sources24.length})`);
  ok(["fastcgi", "uwsgi", "scgi", "grpc"].every(m => sources24.some(s => s[1] === `https://nginx.org/en/docs/http/ngx_http_${m}_module.html`)),
    "O24 TF-2177 : la page nginx.org de chacune des quatre autres directives est sourcée");
  ok(doc24.replace(/\s+/g, " ").includes("Parameter value can contain variables. In this case, if an address is specified as a domain name, the name is searched among the described server groups, and, if not found, is determined using a resolver."),
    "O24 TF-2177 : la phrase des quatre pages (variable, groupes, resolver) est citée mot pour mot");
  const doc24Plie = doc24.replace(/\s+/g, " ");
  ok(doc24Plie.includes("the name is searched among the described server groups, and, if not found, is determined using a resolver.")
      && doc24Plie.includes("By default, nginx caches answers using the TTL value of a response. An optional valid parameter allows overriding it")
      && doc24Plie.includes("Prior to version 1.27.3, this parameter was available only as part of our commercial subscription"),
    "O24 : les trois phrases nginx qui fondent les règles sont citées mot pour mot");
}

// ── O25 + secret-humain (TF-2167, lot Produit-86 20261104b RP-11) : UN SECRET QUE L'HUMAIN RECOPIE SE TIRE SANS SOSIE ───
// NI SIGNE, 20 CARACTÈRES AU MOINS ──────────────────────────────────────────────────────────────────────────────────
// Le fait du 04/11/2026 : `secrets.token_urlsafe` produisait « _ » et des sosies (1, l) ; le porteur a essuyé 2 refus 401
// alors que les mêmes valeurs passaient par httpx et Playwright.
{
  console.log("");
  const lib = await import("../scripts/lib-secret-humain.mjs");
  const { ALPHABET, SOSIES, genererSecret, defautsDuSecret, MINUSCULES, MAJUSCULES, CHIFFRES } = lib;
  const script25 = path.join(ici, "..", "scripts", "tirer-secret-humain.mjs");
  const cli25 = (...a) => spawnSync(process.execPath, [script25, ...a], { encoding: "utf8" });
  ok(ALPHABET.length === 57 && ![...SOSIES].some(c => ALPHABET.includes(c)) && /^[A-Za-z0-9]+$/.test(ALPHABET),
    `secret-humain : alphabet de 57 symboles alphanumériques sans 0, O, 1, l ni I (obtenu ${ALPHABET.length})`);
  const tirages = Array.from({ length: 2000 }, () => genererSecret());
  ok(tirages.every(s => s.length === 20 && [...s].every(c => ALPHABET.includes(c))), "secret-humain : 2000 tirages de 20 caractères, tous dans l'alphabet");
  ok(tirages.every(s => [...MINUSCULES].some(c => s.includes(c)) && [...MAJUSCULES].some(c => s.includes(c)) && [...CHIFFRES].some(c => s.includes(c))),
    "secret-humain : chaque tirage porte une minuscule, une majuscule et un chiffre");
  ok(new Set(tirages).size === 2000 && tirages.every(s => defautsDuSecret(s).length === 0), "secret-humain : 2000 tirages distincts, aucun défaut au jugement");
  const vus = new Set(tirages.join(""));
  ok(vus.size === ALPHABET.length, `secret-humain : les 57 symboles sortent tous sur 40000 tirages, aucun biais qui en écarte (obtenu ${vus.size})`);
  let refus19 = null; try { genererSecret(19); } catch (e) { refus19 = e; }
  ok(refus19 instanceof RangeError && genererSecret(32).length === 32, "secret-humain : 19 caractères refusés (RangeError), 32 admis");
  // La cause, rouge : la forme token_urlsafe du 04/11 est refusée, position par position, sans écrire la valeur.
  const urlsafe = "Qx7_mR2vTz9-WnVb4HcR";
  const dU = defautsDuSecret(urlsafe);
  ok(dU.length === 2 && dU[0].startsWith("position 4 :") && dU[1].startsWith("position 12 :"), `secret-humain : « _ » et « - » nommés par leur position (obtenu ${dU.length} défaut(s))`);
  ok(defautsDuSecret("Kd1mQx3pTz9WnVb4HcOl").length === 3 && defautsDuSecret("Kd7mQx3pTz9W")[0] === "12 caractères, 20 au moins",
    "secret-humain : les sosies 1, O, l sont nommés ; un secret de 12 caractères l'est par sa longueur");
  ok(!dU.join(" ").includes(urlsafe) && !dU.join(" ").includes("_") && !dU.join(" ").includes("-"), "secret-humain : le défaut dit la position, jamais le caractère ni la valeur du secret");
  // La CLI.
  const c1 = cli25("--nombre", "3");
  const lignes = c1.stdout.split(/\r?\n/).filter(Boolean);
  ok(c1.status === 0 && lignes.length === 3 && lignes.every(s => defautsDuSecret(s).length === 0), `secret-humain CLI : 3 secrets valides, un par ligne (exit ${c1.status})`);
  ok(cli25("--longueur", "24").stdout.trim().length === 24, "secret-humain CLI : --longueur 24");
  const c3 = cli25("--longueur", "19");
  ok(c3.status === 2 && /SECRET HORS CONTRAT/.test(c3.stderr) && c3.stdout === "", `secret-humain CLI : 19 caractères -> exit 2, rien sur la sortie (exit ${c3.status})`);
  ok(cli25("--nombre", "0").status === 2 && cli25("--nombre", "abc").status === 2, "secret-humain CLI : --nombre 0 ou illisible -> exit 2");

  // O25 : paire de fixtures.
  const o25 = (cible, ...extra) => { try { return JSON.parse(run(oracle, ["--identifiants-test", cible, "--json-only", ...extra])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };
  const fx25 = f => fx(path.join("o25-identifiants-test", f));
  const durs = r => (r.findings || []).filter(f => f.regle === "O25" && (f.sev === "bloquant" || f.sev === "majeur"));
  const rV = o25(fx25("verte.json"));
  ok(rV.verdict === "PASS" && durs(rV).length === 0, `O25 : trois comptes aux mots de passe tirés par secret-humain -> PASS (obtenu ${rV.verdict})`);
  const rT = o25(fx25("rouge-token-urlsafe.json"));
  ok(rT.verdict === "FAIL" && durs(rT).length === 2 && /admin-fixture.*position 4.*position 12/.test(durs(rT)[0].msg) && /lecteur-fixture.*position 3.*position 19.*position 20/.test(durs(rT)[1].msg),
    `O25 : « _ », « - » et sosies -> FAIL, un constat par compte avec ses positions (obtenu ${rT.verdict}, ${durs(rT).length})`);
  const rC = o25(fx25("rouge-courts.json"));
  ok(rC.verdict === "FAIL" && durs(rC).length === 1 && /12 caractères, 20 au moins/.test(durs(rC)[0].msg), `O25 : 12 caractères -> FAIL, ce seul constat (obtenu ${rC.verdict}, ${durs(rC).length})`);
  const sortieBrute = JSON.stringify([rT, rC]);
  const valeursRouges = [...fs.readFileSync(fx25("rouge-token-urlsafe.json"), "utf8").matchAll(/"mot_de_passe": "([^"]+)"/g)].map(m => m[1]).concat(["Kd7mQx3pTz9W"]);
  ok(valeursRouges.length === 3 && valeursRouges.every(v => !sortieBrute.includes(v)), "O25 : aucune des 3 valeurs refusées n'apparaît dans le verdict (un secret ne transite pas par un rapport)");
  ok(o25(fx25("sans-format.json")).verdict === "SKIP", "O25 : fichier sans le format forge-ops/identifiants-test@1 -> SKIP, il n'est pas de ce contrat");
  const tmp25 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-o25-"));
  try {
    ok(o25(path.join(tmp25, "absent.json")).verdict === "SKIP", "O25 borne : fichier introuvable -> SKIP");
    const casse = path.join(tmp25, "casse.json"); fs.writeFileSync(casse, "{ pas du json", "utf8");
    ok(o25(casse).verdict === "FAIL", "O25 borne : JSON illisible -> FAIL dit, jamais un PASS silencieux");
    const sansMdp = path.join(tmp25, "sans-mdp.json"); fs.writeFileSync(sansMdp, JSON.stringify({ format: "forge-ops/identifiants-test@1", comptes: { admin: {} } }), "utf8");
    ok(o25(sansMdp).verdict === "FAIL", "O25 borne : un compte sans mot de passe -> FAIL");
    const vide = path.join(tmp25, "vide.json"); fs.writeFileSync(vide, JSON.stringify({ format: "forge-ops/identifiants-test@1", comptes: {} }), "utf8");
    ok(o25(vide).verdict === "SKIP", "O25 borne : aucun compte déclaré -> SKIP, jamais un PASS vide");
    // Jouer le remède que le refus nomme (TF-1013) : chaque mot de passe remplacé par la sortie de secret-humain doit PASSER.
    const rouge = JSON.parse(fs.readFileSync(fx25("rouge-token-urlsafe.json"), "utf8"));
    for (const nom of Object.keys(rouge.comptes)) rouge.comptes[nom].mot_de_passe = cli25().stdout.trim();
    const remede = path.join(tmp25, "remede.json"); fs.writeFileSync(remede, JSON.stringify(rouge), "utf8");
    ok(o25(remede).verdict === "PASS", `O25 remède : le rouge dont chaque mot de passe vient de tirer-secret-humain.mjs -> PASS (obtenu ${o25(remede).verdict})`);
  } finally {
    fs.rmSync(tmp25, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  // Loi n° 1 : la règle, le générateur et le référentiel sont appelés ; l'écart à la lettre est déclaré.
  const lire25 = f => fs.readFileSync(path.join(ici, "..", f), "utf8");
  ok(["README.md", "CLAUDE.md"].every(f => { const t = lire25(f); return t.includes("--identifiants-test") && t.includes("tirer-secret-humain.mjs") && t.includes("IDENTIFIANTS-DE-TEST.md"); }),
    "O25 : le mode, le générateur et le référentiel sont appelés par README.md et CLAUDE.md (loi n° 1)");
  ok(/O25 --identifiants-test/.test(lire25("oracles/oracle-ops.mjs").split("import fs")[0]), "O25 : la règle figure à l'en-tête d'oracle-ops.mjs, seule source de la liste des règles");
  const doc25 = lire25("references/IDENTIFIANTS-DE-TEST.md");
  ok(/Écart à la lettre, déclaré\./.test(doc25) && doc25.includes("minuscule, une majuscule et un chiffre"), "O25 : l'écart à la lettre (minuscule, majuscule, chiffre exigés) est déclaré au référentiel");
  let verdictDoc25 = "ILLISIBLE";
  try { verdictDoc25 = JSON.parse(run(oracle, [path.join(ici, "..", "references", "IDENTIFIANTS-DE-TEST.md"), "--json-only"])).verdict; }
  catch (e) { try { verdictDoc25 = JSON.parse(String(e.stdout)).verdict; } catch { /* reste ILLISIBLE */ } }
  ok(verdictDoc25 === "PASS", `O25 : IDENTIFIANTS-DE-TEST.md passe l'oracle de documents (O9, O12, O13, O16) (obtenu ${verdictDoc25})`);
}

// ── identifiants-test + O25 --journal (TF-2166, lot Produit-86 20261104b RP-10) : LES IDENTIFIANTS DE TEST REMIS À L'HUMAIN ─
// RESTENT STABLES D'UN DÉPLOIEMENT À L'AUTRE ────────────────────────────────────────────────────────────────────────────
// La règle du porteur (04/11/2026) : « arrête de changer les mdp à chaque fois que tu déploies une nouvelle version. Et
// remonte cette règle à la Factory. » Quatorze déploiements le 04/11, autant de mots de passe à recopier.
{
  console.log("");
  const { defautsDuSecret: defautsDuSecretT } = await import("../scripts/lib-secret-humain.mjs");
  const script26 = path.join(ici, "..", "scripts", "identifiants-test.mjs");
  const cli26 = (...a) => spawnSync(process.execPath, [script26, ...a], { encoding: "utf8" });
  const tmp26 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-tf2166-"));
  const lire26 = f => JSON.parse(fs.readFileSync(f, "utf8"));
  const journal26 = f => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  const o25 = (fichier, journal) => { try { return JSON.parse(run(oracle, ["--identifiants-test", fichier, ...(journal ? ["--journal", journal] : []), "--json-only"])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };
  const durs = r => (r.findings || []).filter(f => f.regle === "O25" && (f.sev === "bloquant" || f.sev === "majeur"));
  try {
    const f = path.join(tmp26, "identifiants-test.json");
    const j = path.join(tmp26, "identifiants-test.journal.jsonl");
    const okMjs = path.join(tmp26, "connexion-ok.mjs");
    fs.writeFileSync(okMjs, 'process.exit(process.env.FORGE_OPS_COMPTE && (process.env.FORGE_OPS_MOT_DE_PASSE || "").length >= 20 ? 0 : 1);\n', "utf8");
    const refusMjs = path.join(tmp26, "connexion-refus-lecteur.mjs");
    fs.writeFileSync(refusMjs, 'console.log("mot de passe lu : " + process.env.FORGE_OPS_MOT_DE_PASSE);\nprocess.exit(process.env.FORGE_OPS_COMPTE === "lecteur" ? 1 : 0);\n', "utf8");
    const connexion = m => `node "${m}"`;

    // 1. Premier déploiement : le fichier manque, il est créé ; aucune valeur n'est affichée.
    const a1 = cli26("assurer", f, "--comptes", "admin,lecteur");
    const doc1 = lire26(f);
    const valeurs = Object.values(doc1.comptes).map(c => c.mot_de_passe);
    ok(a1.status === 0 && JSON.parse(a1.stdout).crees.join() === "admin,lecteur" && valeurs.length === 2 && valeurs.every(v => defautsDuSecretT(v).length === 0),
      `identifiants-test assurer : fichier absent -> deux comptes créés, mots de passe sans sosie ni signe (exit ${a1.status})`);
    ok(valeurs.every(v => !a1.stdout.includes(v) && !a1.stderr.includes(v)), "identifiants-test assurer : aucune valeur de mot de passe sur la sortie ni sur l'erreur");
    ok(journal26(j)[0].type === "identifiants_crees" && journal26(j)[0].motif === "fichier_absent" && !JSON.stringify(journal26(j)).includes(valeurs[0]), "identifiants-test assurer : le journal dit crees/fichier_absent et ne porte aucune valeur");
    // 2. LE CŒUR DE LA RÈGLE : quatorze déploiements de suite, les mots de passe ne bougent pas d'un octet.
    const avant = fs.readFileSync(f, "utf8");
    let toutConserve = true;
    for (let i = 0; i < 14; i++) { const a = cli26("assurer", f, "--comptes", "admin,lecteur"); const r = a.status === 0 ? JSON.parse(a.stdout) : {}; toutConserve &&= r.crees?.length === 0 && r.conserves?.join() === "admin,lecteur"; }
    ok(toutConserve && fs.readFileSync(f, "utf8") === avant, "identifiants-test : 14 déploiements (assurer) de suite -> le fichier est identique à l'octet, 28 mots de passe conservés");
    ok(journal26(j).filter(e => e.type === "identifiants_conserves").length === 14, "identifiants-test : chaque déploiement laisse une ligne identifiants_conserves au journal");
    // 3. Le défaut du 04/11, rejoué : renouveler à chaque déploiement sans demande est REFUSÉ.
    const r0 = cli26("renouveler", f, "--tous");
    ok(r0.status === 2 && /--demande/.test(r0.stderr) && fs.readFileSync(f, "utf8") === avant, `identifiants-test renouveler : sans --demande -> exit 2, fichier intact (exit ${r0.status})`);
    ok(cli26("renouveler", f, "--tous", "--demande", "   ").status === 2 && fs.readFileSync(f, "utf8") === avant, "identifiants-test renouveler : une demande vide est refusée aussi");
    // 4. Un compte neuf s'ajoute, les existants restent.
    const a4 = cli26("assurer", f, "--comptes", "admin,lecteur,auditeur");
    const doc4 = lire26(f);
    ok(a4.status === 0 && JSON.parse(a4.stdout).crees.join() === "auditeur" && doc4.comptes.admin.mot_de_passe === doc1.comptes.admin.mot_de_passe && doc4.comptes.lecteur.mot_de_passe === doc1.comptes.lecteur.mot_de_passe,
      "identifiants-test assurer : compte neuf ajouté, les deux mots de passe existants inchangés");
    ok(journal26(j).at(-1).type === "identifiants_crees" && journal26(j).at(-1).motif === "compte_absent", "identifiants-test assurer : motif compte_absent au journal");
    // 5. Sur demande, un seul compte change.
    const r5 = cli26("renouveler", f, "--compte", "lecteur", "--demande", "le porteur : renouvelle le mot de passe du lecteur");
    const doc5 = lire26(f);
    ok(r5.status === 0 && doc5.comptes.lecteur.mot_de_passe !== doc4.comptes.lecteur.mot_de_passe && doc5.comptes.admin.mot_de_passe === doc4.comptes.admin.mot_de_passe && doc5.comptes.auditeur.mot_de_passe === doc4.comptes.auditeur.mot_de_passe,
      `identifiants-test renouveler : sur demande, le seul compte désigné change (exit ${r5.status})`);
    ok(journal26(j).at(-1).type === "identifiants_renouveles" && journal26(j).at(-1).motif === "demande" && /le porteur/.test(journal26(j).at(-1).demande), "identifiants-test renouveler : la demande entre au journal");
    ok(!r5.stdout.includes(doc5.comptes.lecteur.mot_de_passe), "identifiants-test renouveler : le nouveau mot de passe n'est pas affiché");
    ok(cli26("renouveler", f, "--compte", "inconnu", "--demande", "x").status === 2, "identifiants-test renouveler : compte absent du fichier -> exit 2");
    // 6. Le fichier manque de nouveau : seul cas, avec le compte absent, où l'on recrée.
    fs.rmSync(f);
    const a6 = cli26("assurer", f, "--comptes", "admin,lecteur");
    ok(a6.status === 0 && JSON.parse(a6.stdout).crees.length === 2 && journal26(j).at(-1).motif === "fichier_absent", "identifiants-test assurer : fichier manquant -> recréé, motif fichier_absent");
    // 7. Un fichier illisible n'est jamais réécrit : ses mots de passe seraient perdus.
    fs.writeFileSync(f, "{ pas du json", "utf8");
    const a7 = cli26("assurer", f, "--comptes", "admin");
    ok(a7.status === 2 && /n'est pas du JSON/.test(a7.stderr) && fs.readFileSync(f, "utf8") === "{ pas du json", `identifiants-test assurer : fichier illisible -> exit 2, fichier intact (exit ${a7.status})`);
    fs.writeFileSync(f, JSON.stringify({ format: "autre", comptes: {} }), "utf8");
    ok(cli26("assurer", f, "--comptes", "admin").status === 2, "identifiants-test assurer : fichier d'un autre format -> exit 2, jamais réécrit");
    ok(cli26("assurer", f).status === 2 && cli26("inconnu", f).status === 2, "identifiants-test : sans --comptes, ou verbe inconnu -> exit 2");

    // 8. verifier : la connexion est jouée par la commande du produit, secrets dans l'environnement, jamais relayés.
    fs.rmSync(f); fs.rmSync(j);
    cli26("assurer", f, "--comptes", "admin,lecteur");
    const v1 = cli26("verifier", f, "--commande", connexion(okMjs));
    ok(v1.status === 0 && JSON.parse(v1.stdout).verdict === "PASS" && JSON.parse(v1.stdout).connectes.join() === "admin,lecteur", `identifiants-test verifier : tous connectés -> exit 0 (exit ${v1.status})`);
    const v2 = cli26("verifier", f, "--commande", connexion(refusMjs));
    const doc8 = lire26(f);
    ok(v2.status === 1 && Object.keys(JSON.parse(v2.stdout).refuses).join() === "lecteur", `identifiants-test verifier : un compte refusé -> exit 1 qui le nomme (exit ${v2.status})`);
    ok(Object.values(doc8.comptes).every(c => !v2.stdout.includes(c.mot_de_passe) && !v2.stderr.includes(c.mot_de_passe)), "identifiants-test verifier : la sortie de la commande de connexion, qui écrit le mot de passe, n'est pas relayée");
    ok(cli26("verifier", f).status === 2 && /sans elle/.test(cli26("verifier", f).stderr), "identifiants-test verifier : sans --commande -> exit 2, la connexion n'est pas prouvée");
    ok(cli26("verifier", f, "--commande", "commande-qui-n-existe-pas-tf2166").status === 1, "identifiants-test verifier : commande introuvable -> refus (exit 1), jamais un PASS");

    // 9. Le journal d'une chaîne réelle est jugé par O25 : la chaîne qui vérifie passe, celle qui oublie échoue.
    fs.rmSync(f); fs.rmSync(j);
    cli26("assurer", f, "--comptes", "admin,lecteur");
    const sansVerif = o25(f, j);
    ok(sansVerif.verdict === "FAIL" && durs(sansVerif).length === 1 && durs(sansVerif)[0].sev === "majeur" && /sans vérification de connexion réussie/.test(durs(sansVerif)[0].msg),
      `O25 --journal : comptes créés sans connexion vérifiée -> FAIL majeur, ce seul constat (obtenu ${sansVerif.verdict}, ${durs(sansVerif).length})`);
    cli26("verifier", f, "--commande", connexion(okMjs));
    for (let i = 0; i < 3; i++) { cli26("assurer", f, "--comptes", "admin,lecteur"); cli26("verifier", f, "--commande", connexion(okMjs)); }
    const rChaine = o25(f, j);
    ok(rChaine.verdict === "PASS" && durs(rChaine).length === 0, `O25 --journal : création vérifiée puis 3 déploiements qui conservent et vérifient -> PASS (obtenu ${rChaine.verdict})`);
    cli26("renouveler", f, "--compte", "admin", "--demande", "demande du porteur");
    ok(o25(f, j).verdict === "FAIL" && durs(o25(f, j))[0]?.sev === "majeur", "O25 --journal : renouvelé sur demande mais pas encore vérifié -> FAIL majeur (la chaîne doit rejouer verifier)");
    cli26("verifier", f, "--commande", connexion(okMjs));
    ok(o25(f, j).verdict === "PASS", "O25 remède : renouvellement sur demande, puis verifier -> PASS (TF-1013)");

    // 10. Les journaux rouges et le vert : le défaut du 04/11 est refusé par sa seule raison.
    const fxJ = n => fx(path.join("o25-identifiants-test", n));
    const verte = fxJ("verte.json");
    ok(o25(verte, fxJ("journal-vert.jsonl")).verdict === "PASS", "O25 --journal : création vérifiée, deux déploiements, renouvellement sur demande vérifié -> PASS");
    const rD = o25(verte, fxJ("journal-rouge-renouvele-au-deploiement.jsonl"));
    ok(rD.verdict === "FAIL" && durs(rD).length === 1 && durs(rD)[0].sev === "bloquant" && /motif « deploiement »/.test(durs(rD)[0].msg) && /arrête de changer les mdp à chaque fois que tu déploies une nouvelle version/.test(durs(rD)[0].msg),
      `O25 --journal : mot de passe renouvelé au déploiement -> FAIL bloquant, la règle du porteur citée mot pour mot (obtenu ${rD.verdict}, ${durs(rD).length})`);
    const rV = o25(verte, fxJ("journal-rouge-sans-verification.jsonl"));
    ok(rV.verdict === "FAIL" && durs(rV).length === 1 && /lecteur-fixture/.test(durs(rV)[0].msg), `O25 --journal : un compte créé jamais vérifié est nommé (obtenu ${rV.verdict}, ${durs(rV).length})`);
    const rR = o25(verte, fxJ("journal-rouge-connexion-refusee.jsonl"));
    ok(rR.verdict === "FAIL" && durs(rR).length === 1 && durs(rR)[0].sev === "bloquant" && /ÉCHEC pour admin-fixture/.test(durs(rR)[0].msg), `O25 --journal : dernière connexion refusée -> FAIL bloquant (obtenu ${rR.verdict}, ${durs(rR).length})`);
    // Bornes du journal.
    ok(o25(verte, path.join(tmp26, "absent.jsonl")).verdict === "FAIL", "O25 --journal borne : journal introuvable -> FAIL dit");
    const vide = path.join(tmp26, "vide.jsonl"); fs.writeFileSync(vide, "", "utf8");
    ok(o25(verte, vide).verdict === "FAIL", "O25 --journal borne : journal vide -> FAIL dit, jamais un PASS vide");
    const seqRompu = path.join(tmp26, "seq.jsonl"); fs.writeFileSync(seqRompu, '{"seq":1,"type":"identifiants_conserves","comptes":["a"]}\n{"seq":3,"type":"identifiants_conserves","comptes":["a"]}\n', "utf8");
    ok(o25(verte, seqRompu).verdict === "FAIL" && /seq 3, attendu 2/.test(durs(o25(verte, seqRompu))[0].msg), "O25 --journal borne : seq rompu -> FAIL");
    const typeInconnu = path.join(tmp26, "type.jsonl"); fs.writeFileSync(typeInconnu, '{"seq":1,"type":"mots_de_passe_changes","comptes":["a"]}\n', "utf8");
    ok(o25(verte, typeInconnu).verdict === "FAIL", "O25 --journal borne : type inconnu -> FAIL (liste fermée)");
    const motifLibre = path.join(tmp26, "motif.jsonl"); fs.writeFileSync(motifLibre, '{"seq":1,"type":"identifiants_crees","comptes":["a"],"motif":"nouvelle_version"}\n{"seq":2,"type":"identifiants_verifies","comptes":["a"],"ok":true,"refuses":[]}\n', "utf8");
    ok(o25(verte, motifLibre).verdict === "FAIL" && /nouvelle_version/.test(durs(o25(verte, motifLibre))[0].msg), "O25 --journal borne : création pour le motif « nouvelle_version » -> FAIL");
    ok(o25(verte).verdict === "PASS", "O25 sans --journal : le fichier seul se juge comme avant (TF-2167), PASS");
  } finally {
    fs.rmSync(tmp26, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  // Loi n° 1 : l'outil et la règle du porteur sont appelés ; la citation est exacte.
  const lire26t = f => fs.readFileSync(path.join(ici, "..", f), "utf8");
  ok(["README.md", "CLAUDE.md"].every(f => { const t = lire26t(f); return t.includes("identifiants-test.mjs") && t.includes("TF-2166"); }), "TF-2166 : l'outil et la règle sont appelés par README.md et CLAUDE.md (loi n° 1)");
  ok(lire26t("references/IDENTIFIANTS-DE-TEST.md").replace(/\s+/g, " ").includes("« arrête de changer les mdp à chaque fois que tu déploies une nouvelle version. Et remonte cette règle à la Factory. »"),
    "TF-2166 : la consigne du porteur est citée mot pour mot au référentiel");
  ok(/identifiants-test\.mjs/.test(lire26t("oracles/oracle-ops.mjs").split("import fs")[0]) && /--journal/.test(lire26t("oracles/oracle-ops.mjs").split("import fs")[0]), "TF-2166 : l'en-tête d'oracle-ops.mjs dit O25 --journal");
  let verdictDoc26 = "ILLISIBLE";
  try { verdictDoc26 = JSON.parse(run(oracle, [path.join(ici, "..", "references", "IDENTIFIANTS-DE-TEST.md"), "--json-only"])).verdict; }
  catch (e) { try { verdictDoc26 = JSON.parse(String(e.stdout)).verdict; } catch { /* reste ILLISIBLE */ } }
  ok(verdictDoc26 === "PASS", `TF-2166 : IDENTIFIANTS-DE-TEST.md passe l'oracle de documents (O9, O12, O13, O16) (obtenu ${verdictDoc26})`);
}

// ── TF-2201 (Produit-86, lot 20261105b RP-21, ledger seq 458) : LA VERSION SERVIE SE LIT, ELLE NE SE RECONSTITUE PAS ─
// Le fait : l'empreinte statique servie (« 23ea38d71963 ») ne correspondait à aucun des 25 derniers commits ; le dossier
// de MEP citait deux commits servis ; seule l'étiquette de l'image disait la version. Décision du 06/11/2026 : le commit
// est passé à l'image et rendu par /healthz ; le dossier de MEP lit la version servie.
{
  console.log("");
  const { spawn } = await import("node:child_process");
  const http = await import("node:http");
  const script27 = path.join(ici, "..", "scripts", "version-servie.mjs");
  const tmp27 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-tf2201-"));
  const git27 = (...a) => execFileSync("git", ["-C", tmp27, "-c", "user.name=essai", "-c", "user.email=essai@example.invalid", ...a], { encoding: "utf8" }).trim();
  const o26 = (...a) => { try { return JSON.parse(run(oracle, [...a, "--json-only"])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };
  const durs = r => (r.findings || []).filter(f => f.regle === "O26" && (f.sev === "bloquant" || f.sev === "majeur"));
  const ecrire27 = (nom, obj) => { const f = path.join(tmp27, nom); fs.writeFileSync(f, typeof obj === "string" ? obj : JSON.stringify(obj), "utf8"); return f; };
  const asynchrone = (args) => new Promise(resolve => {
    const p = spawn(process.execPath, args, { encoding: "utf8" });
    let stdout = "", stderr = "";
    p.stdout.on("data", d => { stdout += d; }); p.stderr.on("data", d => { stderr += d; });
    p.on("close", status => resolve({ status, stdout, stderr }));
  });
  let serveur = null;
  try {
    // Un dépôt jetable de 3 commits : le vrai commit servi en est un, l'empreinte du 05/11 n'en est aucun.
    git27("init", "-q"); for (const m of ["un", "deux", "trois"]) git27("commit", "-q", "--allow-empty", "-m", m);
    const [sha3, sha1] = [git27("rev-parse", "HEAD"), git27("rev-parse", "HEAD~2")];

    // Rouge 1, le défaut du 05/11 : /healthz ne rend aucun commit, seulement une empreinte statique.
    const rStat = o26("--version-servie", ecrire27("statique.json", { statut: "ok", version: "23ea38d71963" }));
    ok(rStat.verdict === "FAIL" && durs(rStat).length === 1 && durs(rStat)[0].sev === "bloquant" && /ne rend aucun commit/.test(durs(rStat)[0].msg),
      `O26 : /healthz sans champ « commit » (empreinte statique) -> FAIL bloquant, seul constat (obtenu ${rStat.verdict}, ${durs(rStat).length})`);
    // Rouge 2 : un commit rendu, mais qui n'est aucun commit du dépôt (l'empreinte de 12 caractères du 05/11).
    const rFaux = o26("--version-servie", ecrire27("faux.json", { commit: "23ea38d71963" }), "--depot", tmp27);
    ok(rFaux.verdict === "FAIL" && durs(rFaux).length === 1 && /23ea38d71963/.test(durs(rFaux)[0].msg) && /aucun commit du dépôt/.test(durs(rFaux)[0].msg),
      `O26 : un commit servi inconnu du dépôt -> FAIL bloquant qui le nomme (obtenu ${rFaux.verdict}, ${durs(rFaux).length})`);
    // Rouge 3 : le commit servi n'est pas celui que le dossier de MEP annonce.
    const rAncien = o26("--version-servie", ecrire27("ancien.json", { commit: sha1 }), "--depot", tmp27, "--attendu", sha3);
    ok(rAncien.verdict === "FAIL" && durs(rAncien).length === 1 && /n'est pas le commit attendu/.test(durs(rAncien)[0].msg),
      `O26 : le commit servi n'est pas celui attendu -> FAIL bloquant (obtenu ${rAncien.verdict}, ${durs(rAncien).length})`);
    // Verts : commit complet, commit abrégé, avec et sans dépôt.
    const vert = ecrire27("vert.json", { statut: "ok", commit: sha3 });
    ok(o26("--version-servie", vert).verdict === "PASS", "O26 : /healthz qui rend un commit complet, sans dépôt -> PASS");
    ok(o26("--version-servie", vert, "--depot", tmp27, "--attendu", sha3).verdict === "PASS", "O26 : commit servi = commit attendu, dans le dépôt -> PASS");
    ok(o26("--version-servie", ecrire27("court.json", { commit: sha3.slice(0, 7) }), "--depot", tmp27, "--attendu", sha3).verdict === "PASS", "O26 : commit abrégé à 7 caractères, même commit -> PASS");
    const rInfo = o26("--version-servie", ecrire27("ancien-ok.json", { commit: sha1 }), "--depot", tmp27);
    ok(rInfo.verdict === "PASS" && (rInfo.findings || []).some(f => f.sev === "info" && /2 commit\(s\) derrière/.test(f.msg)),
      "O26 : sans --attendu, le verdict dit de combien de commits l'instance servie est en retard sur la tête");
    // Bornes.
    ok((r => r.verdict === "FAIL" && durs(r).length === 1)(o26("--version-servie", ecrire27("court3.json", { commit: "abc" }))), "O26 borne : « abc » n'est pas un commit (7 à 40 hexadécimaux) -> FAIL");
    ok((r => r.verdict === "FAIL" && durs(r).length === 1)(o26("--version-servie", ecrire27("casse.json", "{ pas du json"))), "O26 borne : capture illisible -> FAIL dit, jamais un PASS");
    ok((r => r.verdict === "SKIP" && (r.findings || []).some(f => f.regle === "O26"))(o26("--version-servie", path.join(tmp27, "absente.json"))), "O26 borne : capture introuvable -> SKIP");
    ok((r => r.verdict === "FAIL" && durs(r).length === 1)(o26("--version-servie", vert, "--depot", path.join(tmp27, "nulle-part"))), "O26 borne : dépôt illisible -> FAIL dit, jamais un PASS sans l'avoir lu");

    // L'outil de lecture : un vrai serveur HTTP local, GET seul. Le dossier de MEP cite sa sortie.
    serveur = http.createServer((req, rep) => {
      if (req.url === "/healthz") { rep.writeHead(200, { "content-type": "application/json" }); rep.end(JSON.stringify({ statut: "ok", commit: sha3 })); }
      else if (req.url === "/ancien/healthz") { rep.writeHead(200, { "content-type": "application/json" }); rep.end(JSON.stringify({ statut: "ok", commit: sha1 })); }
      else if (req.url === "/statique/healthz") { rep.writeHead(200, { "content-type": "application/json" }); rep.end(JSON.stringify({ statut: "ok", version: "23ea38d71963" })); }
      else { rep.writeHead(404); rep.end("non"); }
    });
    await new Promise(r => serveur.listen(0, "127.0.0.1", r));
    const base27 = `http://127.0.0.1:${serveur.address().port}`;
    const capture = path.join(tmp27, "capture-lue.json");
    const l1 = await asynchrone([script27, "lire", base27, "--sortie", capture]);
    const j1 = (() => { try { return JSON.parse(l1.stdout); } catch { return {}; } })();
    ok(l1.status === 0 && j1.commit === sha3 && j1.source === `${base27}/healthz`, `version-servie lire : GET /healthz -> le commit servi est lu et la source est citée (exit ${l1.status})`);
    ok(fs.existsSync(capture) && o26("--version-servie", capture, "--depot", tmp27, "--attendu", sha3).verdict === "PASS", "version-servie lire --sortie : la capture écrite passe O26 (de la lecture au verdict)");
    const l2 = await asynchrone([script27, "lire", base27, "--attendu", sha3]);
    ok(l2.status === 0, `version-servie lire --attendu : même commit -> exit 0 (exit ${l2.status})`);
    const l3 = await asynchrone([script27, "lire", `${base27}/ancien`, "--attendu", sha3]);
    ok(l3.status === 1, `version-servie lire --attendu : instance en retard -> exit 1 (exit ${l3.status})`);
    const l4 = await asynchrone([script27, "lire", `${base27}/statique`]);
    ok(l4.status === 2 && /aucun commit/.test(l4.stderr), `version-servie lire : /healthz sans commit -> exit 2 qui le dit, la version n'est pas lisible (exit ${l4.status})`);
    const l5 = await asynchrone([script27, "lire", `${base27}/absent`]);
    ok(l5.status === 2 && /404/.test(l5.stderr), `version-servie lire : réponse 404 -> exit 2 qui la cite (exit ${l5.status})`);
    const l6 = await asynchrone([script27, "lire", capture]);
    ok(l6.status === 0 && JSON.parse(l6.stdout).commit === sha3, "version-servie lire : une capture sur disque se lit comme une URL");
    ok((await asynchrone([script27, "lire"])).status === 2 && (await asynchrone([script27, "inconnu", base27])).status === 2, "version-servie : sans source, ou verbe inconnu -> exit 2");
  } finally {
    if (serveur) await new Promise(r => serveur.close(r));
    fs.rmSync(tmp27, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  // Les plans qui construisent une image passent le commit à la construction et le relisent après la bascule.
  const plan27 = c => JSON.parse(run(ops, ["plan", c, "<BUILD>"]));
  for (const c of ["azure", "aws"]) {
    const p = plan27(c);
    const dep = p.phases.deploiement.join("\n"), san = p.phases.healthcheck.join("\n");
    ok(/--build-arg COMMIT_SHA=<COMMIT>/.test(dep) && p.placeholders.includes("<COMMIT>"), `TF-2201 : le plan ${c} passe le commit à l'image (--build-arg COMMIT_SHA=<COMMIT>) et déclare <COMMIT>`);
    ok(/version-servie\.mjs lire <URL[^>]*>\S* --attendu <COMMIT>/.test(san) || /version-servie\.mjs lire \S+ --attendu <COMMIT>/.test(san), `TF-2201 : le plan ${c} relit la version servie après la bascule (version-servie.mjs lire --attendu <COMMIT>)`);
  }
  const dPlan27 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-tf2201-plans-"));
  const pf27 = path.join(dPlan27, "plan-tf2201.json");
  run(ops, ["plan", "azure", fx("app-verte"), "--sortie", pf27]);
  const pAz27 = JSON.parse(fs.readFileSync(pf27, "utf8"));
  const sansArg = JSON.parse(JSON.stringify(pAz27)); sansArg.phases.deploiement = sansArg.phases.deploiement.map(c => c.replace(/ --build-arg COMMIT_SHA=<COMMIT>/, ""));
  const pSansArg = path.join(dPlan27, "plan-tf2201-sans-arg.json"); fs.writeFileSync(pSansArg, JSON.stringify(sansArg), "utf8");
  const rPlan = (() => { try { return JSON.parse(run(oracle, ["--plan", pSansArg, "--json-only"])); } catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } })();
  ok(rPlan.verdict === "FAIL" && rPlan.findings.filter(f => f.sev === "majeur" && /commit/.test(f.msg)).length === 1, `O5 : un plan azure dont la construction ne passe pas le commit -> FAIL majeur, seul constat (obtenu ${rPlan.verdict})`);
  const sansLecture = JSON.parse(JSON.stringify(pAz27)); sansLecture.phases.healthcheck = sansLecture.phases.healthcheck.filter(c => !/version-servie\.mjs/.test(c));
  const pSansLecture = path.join(dPlan27, "plan-tf2201-sans-lecture.json"); fs.writeFileSync(pSansLecture, JSON.stringify(sansLecture), "utf8");
  const rPlan2 = (() => { try { return JSON.parse(run(oracle, ["--plan", pSansLecture, "--json-only"])); } catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } })();
  ok(rPlan2.verdict === "FAIL" && rPlan2.findings.filter(f => f.sev === "majeur" && /version servie/.test(f.msg)).length === 1, `O5 : un plan azure qui ne relit pas la version servie -> FAIL majeur, seul constat (obtenu ${rPlan2.verdict})`);
  fs.rmSync(dPlan27, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  // Loi n° 1 : l'outil et la règle sont appelés ; l'en-tête de l'oracle dit O26.
  const lire27 = f => fs.readFileSync(path.join(ici, "..", f), "utf8");
  ok(["README.md", "CLAUDE.md"].every(f => { const t = lire27(f); return t.includes("--version-servie") && t.includes("version-servie.mjs") && t.includes("TF-2201"); }), "TF-2201 : l'outil et la règle sont appelés par README.md et CLAUDE.md (loi n° 1)");
  ok(/O26 --version-servie/.test(lire27("oracles/oracle-ops.mjs").split("import fs")[0]), "TF-2201 : la règle figure à l'en-tête d'oracle-ops.mjs, seule source de la liste des règles");
}

// ── TF-2209 (Produit-86, lot 20261105e RP-29, ledger seq 538) : L'INVENTAIRE DES COMPOSANTS EST COMPARÉ AUX SORTIES D'ÉTAT ───
// Le fait : COMPOSANTS-OPS.md est resté au texte du premier commit pendant trois déploiements ; ni la machine Azure, ni le
// Docker local, ni Foundry n'y figuraient, et R-20 ne juge que le vocabulaire des statuts. Décision du 06/11/2026 : à la MEP,
// l'inventaire des composants est comparé aux sorties d'état, et « prêt » est refusé sur un composant présent non inventorié.
{
  console.log("");
  const fx27 = f => fx(path.join("o27-inventaire-a-jour", f));
  const o27 = (...a) => { try { return JSON.parse(run(oracle, ["--inventaire-a-jour", ...a, "--json-only"])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };
  const durs = r => (r.findings || []).filter(f => f.regle === "O27" && (f.sev === "bloquant" || f.sev === "majeur"));
  const etats = [`--etat`, `terraform:${fx27("etat-terraform.txt")}`, `--etat`, `docker:${fx27("etat-docker.txt")}`, `--etat`, `azure:${fx27("etat-azure.json")}`];
  const tmp28 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-tf2209-"));
  try {
    // Verte : chaque composant des trois sorties figure au document (module, indice, `data.*` et random_* ne sont pas à inventorier).
    const rV = o27(fx27("doc-vert.md"), ...etats);
    ok(rV.verdict === "PASS" && durs(rV).length === 0, `O27 : inventaire à jour des trois sorties d'état (pile, Docker local, groupe de ressources) -> PASS (obtenu ${rV.verdict}, ${durs(rV).length})`);
    ok((rV.findings || []).some(f => f.sev === "info" && /terraform : 2 ligne\(s\) ignorée\(s\)/.test(f.msg)), "O27 : les lignes ignorées d'une sortie se comptent à côté du verdict, jamais en silence (data.* et random_*)");
    // Rouge : le document du premier commit. Quatre composants nés depuis ne sont nommés nulle part, chacun avec sa sortie d'origine.
    const rR = o27(fx27("doc-perime.md"), ...etats);
    const msgs = durs(rR).map(f => f.msg).join("\n");
    ok(rR.verdict === "FAIL" && durs(rR).length === 4 && durs(rR).every(f => f.sev === "bloquant"), `O27 : inventaire du premier commit -> FAIL, exactement 4 composants présents non inventoriés (obtenu ${rR.verdict}, ${durs(rR).length})`);
    ok(/module\.machine\.azurerm_linux_virtual_machine\.vm.*terraform/.test(msgs) && /azurerm_ai_foundry\.hub.*terraform/.test(msgs) && /exemple-postgres.*docker/.test(msgs) && /vm-exemple-poste.*azure/.test(msgs),
      "O27 : le verdict nomme la machine, le hub d'intelligence artificielle, le conteneur local et la machine du groupe, chacun avec sa sortie d'état");
    ok(/« prêt » est refusé/.test(msgs), "O27 : le constat dit que « prêt » est refusé");
    // Jouer le remède que le refus nomme (TF-1013) : ajouter les quatre lignes au document périmé doit faire PASSER.
    const remede = path.join(tmp28, "doc-remede.md");
    fs.writeFileSync(remede, fs.readFileSync(fx27("doc-perime.md"), "utf8")
      + "\n| Composant | Type | Environnement | Statut |\n|---|---|---|---|\n| azurerm_linux_virtual_machine.vm | machine virtuelle | qualification | actif |\n| azurerm_ai_foundry.hub | hub | qualification | actif |\n| exemple-postgres | conteneur | local | actif |\n| vm-exemple-poste | machine virtuelle | qualification | actif |\n", "utf8");
    ok(o27(remede, ...etats).verdict === "PASS", "O27 remède : les quatre lignes ajoutées au document du premier commit -> PASS");
    // Un nom contenu dans un autre nom ne compte pas comme inventorié.
    const sousChaine = path.join(tmp28, "sous-chaine.md");
    fs.writeFileSync(sousChaine, "| ca-exemple-api | application | qualification | actif |\n", "utf8");
    const dock = path.join(tmp28, "docker.txt"); fs.writeFileSync(dock, "exemple-api\n", "utf8");
    const rS = o27(sousChaine, "--etat", `docker:${dock}`);
    ok(rS.verdict === "FAIL" && durs(rS).length === 1 && /« exemple-api »/.test(durs(rS)[0].msg), "O27 : « exemple-api » contenu dans « ca-exemple-api » n'est pas inventorié (mot entier) -> FAIL");
    // Bornes.
    ok((r => r.verdict === "SKIP" && (r.findings || []).some(f => f.regle === "O27" && /aucune sortie d'état/.test(f.msg)))(o27(fx27("doc-vert.md"))), "O27 borne : aucune sortie d'état donnée -> SKIP qui dit que « prêt » ne peut pas s'appuyer sur l'inventaire");
    ok((r => r.verdict === "SKIP")(o27(path.join(tmp28, "absent.md"), ...etats)), "O27 borne : document introuvable -> SKIP");
    ok((r => r.verdict === "FAIL" && durs(r).length === 1 && /genre inconnu/.test(durs(r)[0].msg))(o27(fx27("doc-vert.md"), "--etat", `kubectl:${dock}`)), "O27 borne : genre inconnu -> FAIL dit");
    ok((r => r.verdict === "FAIL" && durs(r).length === 1 && /introuvable/.test(durs(r)[0].msg))(o27(fx27("doc-vert.md"), "--etat", `docker:${path.join(tmp28, "nulle-part.txt")}`)), "O27 borne : sortie d'état introuvable -> FAIL dit, jamais un PASS");
    const tableDocker = path.join(tmp28, "docker-table.txt"); fs.writeFileSync(tableDocker, "CONTAINER ID   IMAGE   NAMES\nabc123   img   exemple-api\n", "utf8");
    ok((r => r.verdict === "FAIL" && durs(r).length === 1 && /sans aucun composant lisible/.test(durs(r)[0].msg))(o27(fx27("doc-vert.md"), "--etat", `docker:${tableDocker}`)), "O27 borne : `docker ps` en table, avec en-tête -> FAIL qui nomme le format attendu, jamais un PASS");
    const casse = path.join(tmp28, "casse.json"); fs.writeFileSync(casse, "{ pas du json", "utf8");
    ok((r => r.verdict === "FAIL" && durs(r).length === 1 && /illisible/.test(durs(r)[0].msg))(o27(fx27("doc-vert.md"), "--etat", `azure:${casse}`)), "O27 borne : sortie azure illisible -> FAIL dit");
    const noms = path.join(tmp28, "noms.json"); fs.writeFileSync(noms, JSON.stringify({ noms: ["exemple-postgres", "inconnu-au-document"] }), "utf8");
    ok((r => r.verdict === "FAIL" && durs(r).length === 1 && /inconnu-au-document/.test(durs(r)[0].msg))(o27(fx27("doc-vert.md"), "--etat", `noms:${noms}`)), "O27 : l'export au format noms (celui d'O-14) se compare aussi");
    const graphe = path.join(tmp28, "graphe.json"); fs.writeFileSync(graphe, JSON.stringify({ data: [{ name: "vm-exemple-poste" }, { name: "st-exemple-oublie" }] }), "utf8");
    ok((r => r.verdict === "FAIL" && durs(r).length === 1 && /st-exemple-oublie/.test(durs(r)[0].msg))(o27(fx27("doc-vert.md"), "--etat", `azure:${graphe}`)), "O27 : la sortie d'`az graph query` ({ data: [...] }) se compare aussi");
  } finally {
    fs.rmSync(tmp28, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  // Le plan azure rejoue la comparaison à la MEP, après la bascule.
  const san28 = JSON.parse(run(ops, ["plan", "azure", "<BUILD>"])).phases.healthcheck.join("\n");
  ok(/az resource list --resource-group <RG> -o json > etat-composants-<RG>\.json/.test(san28) && /--inventaire-a-jour \S*COMPOSANTS-OPS\.md --etat azure:etat-composants-<RG>\.json/.test(san28),
    "TF-2209 : le plan azure capture `az resource list` et rejoue O-27 contre COMPOSANTS-OPS.md après la bascule");
  // Loi n° 1 : la règle et l'en-tête.
  const lire28 = f => fs.readFileSync(path.join(ici, "..", f), "utf8");
  ok(["README.md", "CLAUDE.md"].every(f => { const t = lire28(f); return t.includes("--inventaire-a-jour") && t.includes("TF-2209"); }), "TF-2209 : la règle est appelée par README.md et CLAUDE.md (loi n° 1)");
  ok(/O27 --inventaire-a-jour/.test(lire28("oracles/oracle-ops.mjs").split("import fs")[0]), "TF-2209 : la règle figure à l'en-tête d'oracle-ops.mjs, seule source de la liste des règles");
}

// ── TF-2244 (reste de TF-2201, campagne du 06/11/2026) : LES PLANS GCP ET RAILWAY PASSENT LE COMMIT À L'IMAGE ─────────────
// Le fait : seuls azure et aws passaient COMMIT_SHA et relisaient la version servie ; `gcloud builds submit --tag` n'accepte
// aucun argument de construction (il faut un fichier de construction et des substitutions), et la variable de service Railway
// n'était pas éprouvée. Décision R-58 du 06/11/2026 : les deux plans passent le commit et relisent la version servie, ou le
// non_juge d'O-26 le dit avec la raison mesurée.
{
  console.log("");
  const { lireYaml } = await import("../scripts/lib-yaml.mjs");
  const tmp44 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-tf2244-"));
  const plan44 = c => JSON.parse(run(ops, ["plan", c, "<BUILD>"]));
  const o5 = (p) => { const f = path.join(tmp44, "plan.json"); fs.writeFileSync(f, JSON.stringify(p), "utf8");
    try { return JSON.parse(run(oracle, ["--plan", f, "--json-only"])); } catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };
  try {
    const gcp = plan44("gcp"), rw = plan44("railway");
    const depGcp = gcp.phases.deploiement.join("\n"), sanGcp = gcp.phases.healthcheck.join("\n");
    // gcp : un fichier de construction et des substitutions, jamais --tag (qui n'accepte pas d'argument de construction).
    ok(/gcloud builds submit <BUILD> --config <FICHIER_CONSTRUCTION> --substitutions _IMAGE=<IMAGE>,_COMMIT_SHA=<COMMIT>/.test(depGcp) && !/builds submit[^\n]*--tag/.test(depGcp),
      "TF-2244 : le plan gcp construit par fichier de construction et substitutions (_COMMIT_SHA=<COMMIT>), sans --tag");
    ok(["<COMMIT>", "<FICHIER_CONSTRUCTION>", "<FORGE_OPS>"].every(j => gcp.placeholders.includes(j)), "TF-2244 : le plan gcp déclare <COMMIT>, <FICHIER_CONSTRUCTION> et <FORGE_OPS>");
    ok(/version-servie\.mjs lire https:\/\/candidat---<SERVICE>-<HASH>\.a\.run\.app --attendu <COMMIT>/.test(sanGcp), "TF-2244 : le plan gcp relit la version servie par la revision candidate, AVANT la bascule");
    ok(/update-traffic[\s\S]*version-servie\.mjs lire https:\/\/<SERVICE>-<HASH>\.a\.run\.app --attendu <COMMIT> --sortie version-servie\.json/.test(sanGcp), "TF-2244 : le plan gcp relit la version servie APRÈS la bascule et en écrit la capture");
    // railway : variable de service lue à la construction par ARG, posée sans redéploiement, avant `railway up`.
    const depRw = rw.phases.deploiement.join("\n"), sanRw = rw.phases.healthcheck.join("\n");
    ok(/railway variable set COMMIT_SHA=<COMMIT> --skip-deploys[\s\S]*railway up --ci/.test(depRw), "TF-2244 : le plan railway pose COMMIT_SHA=<COMMIT> sans redéploiement (--skip-deploys) AVANT `railway up --ci`");
    ok(/ARG COMMIT_SHA/.test(depRw), "TF-2244 : le plan railway dit que le Dockerfile déclare ARG COMMIT_SHA (variable de construction)");
    ok(["<COMMIT>", "<FORGE_OPS>"].every(j => rw.placeholders.includes(j)), "TF-2244 : le plan railway déclare <COMMIT> et <FORGE_OPS>");
    ok(/version-servie\.mjs lire <URL_SERVICE> --attendu <COMMIT> --sortie version-servie\.json/.test(sanRw), "TF-2244 : le plan railway relit la version servie et en écrit la capture");
    // O-5 : fixture verte (le plan généré passe) et rouges (sans l'argument, sans la lecture) pour gcp ET railway.
    for (const [nom, p, retirer] of [["gcp", gcp, c => c.replace(/ --substitutions \S+/, "")], ["railway", rw, c => (/COMMIT_SHA=/.test(c) ? "" : c)]]) {
      const v = o5(p);
      ok(v.verdict === "PASS", `TF-2244 O-5 : le plan ${nom} généré -> PASS (obtenu ${v.verdict})`);
      const sansArg = JSON.parse(JSON.stringify(p)); sansArg.phases.deploiement = sansArg.phases.deploiement.map(retirer).filter(Boolean);
      const r1 = o5(sansArg);
      ok(r1.verdict === "FAIL" && r1.findings.filter(f => f.sev === "majeur" && /passe pas le commit/.test(f.msg)).length === 1, `TF-2244 O-5 : un plan ${nom} dont la construction ne passe pas le commit -> FAIL majeur, seul constat (obtenu ${r1.verdict})`);
      const sansLecture = JSON.parse(JSON.stringify(p)); sansLecture.phases.healthcheck = sansLecture.phases.healthcheck.filter(c => !/version-servie\.mjs/.test(c));
      const r2 = o5(sansLecture);
      ok(r2.verdict === "FAIL" && r2.findings.filter(f => f.sev === "majeur" && /version servie/.test(f.msg)).length === 1, `TF-2244 O-5 : un plan ${nom} qui ne relit pas la version servie -> FAIL majeur, seul constat (obtenu ${r2.verdict})`);
    }
    // Le gabarit de construction : c'est lui que le plan gcp nomme ; il passe le commit à l'image par une substitution propre.
    const cb = lireYaml(fs.readFileSync(path.join(ici, "..", "gabarits", "cloudbuild-commit.yaml"), "utf8")).valeur;
    ok(Array.isArray(cb.steps) && cb.steps[0].args.includes("--build-arg") && cb.steps[0].args.includes("COMMIT_SHA=${_COMMIT_SHA}") && cb.images.includes("${_IMAGE}"),
      "TF-2244 : gabarits/cloudbuild-commit.yaml passe --build-arg COMMIT_SHA=${_COMMIT_SHA} et publie ${_IMAGE}");
    ok(/_COMMIT_SHA/.test(cb.steps[0].args.join(" ")) && !/\$\{COMMIT_SHA\}/.test(fs.readFileSync(path.join(ici, "..", "gabarits", "cloudbuild-commit.yaml"), "utf8").replace(/#.*$/gm, "")),
      "TF-2244 : le gabarit n'emploie pas la variable intégrée COMMIT_SHA (vide hors déclencheur), seulement _COMMIT_SHA");
    // Le non_juge d'O-26 ne dit plus « ne passent pas encore » : il dit ce qui reste non éprouvé, avec sa raison.
    const capt44 = path.join(tmp44, "capture.json"); fs.writeFileSync(capt44, JSON.stringify({ commit: "abcdef1" }), "utf8");
    const nj = JSON.parse(run(oracle, ["--version-servie", capt44, "--json-only"])).non_juge.join("\n");
    ok(!/ne passent pas encore le commit/.test(nj) && /gcp et railway/.test(nj) && /jamais éprouvé/.test(nj), "TF-2244 : le non_juge d'O-26 dit que gcp et railway ne sont pas éprouvés par un déploiement réel, plus qu'ils ne passent pas le commit");
  } finally {
    fs.rmSync(tmp44, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const lire44 = f => fs.readFileSync(path.join(ici, "..", f), "utf8");
  ok(["README.md", "CLAUDE.md"].every(f => { const t = lire44(f); return t.includes("cloudbuild-commit.yaml") && t.includes("TF-2244"); }), "TF-2244 : le gabarit de construction et la règle sont appelés par README.md et CLAUDE.md (loi n° 1)");
}

// ── TF-2271 (Produit-86, lot 20261106a RP-44, ledger seq 609) : UNE CHAÎNE TERRAFORM N'EST RÉUSSIE QUE SI LE PLAN SUIVANT EST VIDE ─
// Le fait : le fournisseur Docker annonçait à chaque plan 5 conteneurs « mis à jour sur place » qu'il n'appliquait jamais ; la
// chaîne rendait PASS après chaque apply. Décision R-58 du 06/11/2026 : la chaîne re-planifie après l'apply et signale un plan
// non vide ; un attribut non modifiable sur place force le remplacement. Les captures reel-* sont sorties de Terraform 1.12.2
// (terraform_data, fournisseur intégré, sans réseau) ; rp44-* reproduit les 5 conteneurs, valeurs écrites à la main.
{
  console.log("");
  const lib29 = await import("../scripts/lib-convergence.mjs");
  const fx29 = f => fx(path.join("o29-convergence", f));
  const o29 = (...a) => { try { return JSON.parse(run(oracle, ["--convergence", ...a, "--json-only"])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };
  const durs = r => (r.findings || []).filter(f => f.regle === "O29" && (f.sev === "bloquant" || f.sev === "majeur"));
  const tmp29 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-tf2271-"));
  try {
    // Verte : le plan suivant l'apply est vide (JSON de `terraform show -json` et sortie texte).
    for (const f of ["reel-plan-vide.json", "reel-plan-vide.txt", "reel-plan-apres-remplacement.json", "reel-plan-apres-remplacement.txt"]) {
      const r = o29(fx29(f));
      ok(r.verdict === "PASS" && durs(r).length === 0, `O29 : ${f} (plan vide, Terraform 1.12.2) -> PASS (obtenu ${r.verdict}, ${durs(r).length})`);
    }
    // Rouge réelle : une ressource change encore après l'apply -> FAIL bloquant qui la nomme, ses attributs et le remède.
    for (const f of ["reel-plan-non-vide.json", "reel-plan-non-vide.txt"]) {
      const r = o29(fx29(f));
      ok(r.verdict === "FAIL" && durs(r).length === 1 && durs(r)[0].sev === "bloquant" && /terraform_data\.conteneur/.test(durs(r)[0].msg), `O29 : ${f} (« 1 to change » après l'apply) -> FAIL bloquant qui nomme terraform_data.conteneur (obtenu ${r.verdict}, ${durs(r).length})`);
      ok(/terraform apply -replace='terraform_data\.conteneur'/.test(durs(r)[0].msg), `O29 : ${f} -> le constat donne la commande de remplacement forcé`);
    }
    ok(/attributs : input, output/.test(durs(o29(fx29("reel-plan-non-vide.json")))[0].msg), "O29 : la capture JSON nomme les attributs qui changent encore (input, output)");
    // Rouge RP-44 : 5 conteneurs, un constat bloquant chacun, jamais un total anonyme.
    for (const f of ["rp44-cinq-conteneurs.json", "rp44-cinq-conteneurs.txt"]) {
      const r = o29(fx29(f));
      ok(r.verdict === "FAIL" && durs(r).length === 5 && durs(r).every(x => x.sev === "bloquant"), `O29 : ${f} (RP-44, 5 conteneurs « update in-place ») -> FAIL, 5 constats bloquants (obtenu ${r.verdict}, ${durs(r).length})`);
      const m = durs(r).map(x => x.msg).join("\n");
      ok(["docker_container.webgoat", "docker_container.zap", "docker_container.juice", "docker_container.frontal", "module.base.docker_container.postgres"].every(a => m.includes(`« ${a} »`)), `O29 : ${f} -> chaque conteneur est nommé`);
    }
    ok(/attributs : healthcheck/.test(durs(o29(fx29("rp44-cinq-conteneurs.json"))).find(x => /webgoat/.test(x.msg)).msg), "O29 : la sonde de WebGoat (healthcheck) est nommée comme attribut qui ne converge pas");
    // Jouer le remède que le refus nomme (TF-1013) : le plan pris APRÈS `apply -replace` est vide -> PASS. Éprouvé avec Terraform 1.12.2 :
    // reel-plan-remplacement.txt est le plan « will be replaced, as requested » de la même ressource, reel-plan-apres-remplacement.* le plan suivant.
    ok(/terraform_data\.conteneur will be replaced, as requested/.test(fs.readFileSync(fx29("reel-plan-remplacement.txt"), "utf8")) && o29(fx29("reel-plan-apres-remplacement.json")).verdict === "PASS",
      "O29 remède : `terraform plan -replace` annonce « will be replaced, as requested » et le plan suivant l'apply -replace est vide -> PASS");
    // Bornes : une capture qu'on ne sait pas lire n'est jamais un PASS.
    const ecrire29 = (nom, t) => { const f = path.join(tmp29, nom); fs.writeFileSync(f, t, "utf8"); return f; };
    ok(o29(path.join(tmp29, "absente.json")).verdict === "SKIP", "O29 borne : capture introuvable -> SKIP");
    const bornes29 = [["vide.json", "", /capture vide/], ["casse.json", "{ pas du json", /JSON invalide/], ["sans-changes.json", "{\"format_version\":\"1.2\"}", /resource_changes/],
      ["pas-un-plan.txt", "Apply complete! Resources: 2 added, 0 changed, 0 destroyed.\n", /ce n'est pas la sortie d'un plan/]];
    for (const [nom, t, motif] of bornes29) {
      const r = o29(ecrire29(nom, t));
      ok(r.verdict === "FAIL" && durs(r).length === 1 && motif.test(durs(r)[0].msg), `O29 borne : ${nom} -> FAIL dit, jamais un PASS (obtenu ${r.verdict})`);
    }
    const sansAdresse = o29(ecrire29("decompte.txt", "Plan: 1 to add, 2 to change, 0 to destroy.\n"));
    ok(sansAdresse.verdict === "FAIL" && durs(sansAdresse).length === 1 && /1 à ajouter, 2 à changer, 0 à détruire/.test(durs(sansAdresse)[0].msg), "O29 : un décompte « Plan: » non nul sans ligne d'adresse -> FAIL qui dit le décompte");
    ok(o29(ecrire29("ansi.txt", "\u001b[1m\u001b[32mNo changes.\u001b[0m Your infrastructure matches the configuration.\n")).verdict === "PASS", "O29 : la sortie colorée (codes ANSI) d'un plan vide -> PASS");

    // La boucle de la chaîne (lib), Terraform injecté : re-planifier, remplacer de force un tour, re-planifier.
    const rp44 = fs.readFileSync(fx29("rp44-cinq-conteneurs.json"), "utf8");
    const faux = (planApres, { applyStatus = 0, showTexte = rp44, planAvant = 2 } = {}) => {
      const appels = []; let nPlan = 0;
      const lancer = a => {
        appels.push(a);
        if (a.includes("plan")) { nPlan++; return { status: nPlan === 1 ? planAvant : planApres, stdout: "", stderr: planAvant === 1 && nPlan === 1 ? "Error: boom" : "" }; }
        if (a.includes("show")) return { status: 0, stdout: showTexte, stderr: "" };
        if (a.includes("apply")) return { status: applyStatus, stdout: "", stderr: applyStatus ? "Error: apply" : "" };
        return { status: 99, stdout: "", stderr: "commande inattendue" };
      };
      return { appels, lancer };
    };
    const etat29 = lib29.imagesAEtatDuReferentiel(path.join(ici, "..", "references", "CONTENEURS-A-ETAT.json"));
    ok(etat29.includes("postgres"), "TF-2271 : le référentiel O-20 des images à état est lu (postgres en fait partie)");
    { // a) plan vide dès la première re-planification : rien n'est appliqué
      const f = faux(0, { planAvant: 0 });
      const r = lib29.converger({ pile: "pile", lancer: f.lancer, executer: true, imagesAEtat: etat29, dossierTemp: tmp29 });
      ok(r.verdict === "converge" && !f.appels.some(a => a.includes("apply")), "TF-2271 converger : plan vide après l'apply -> converge, aucun remplacement joué");
    }
    { // b) plan non vide, sans --executer : la commande est écrite, rien n'est appliqué, le conteneur à état est refusé
      const f = faux(0);
      const r = lib29.converger({ pile: "pile", lancer: f.lancer, executer: false, imagesAEtat: etat29, dossierTemp: tmp29 });
      ok(r.verdict === "non-converge" && !f.appels.some(a => a.includes("apply")), "TF-2271 converger : plan non vide sans --executer -> non-converge, rien n'est appliqué (plan-first)");
      ok(r.commande && ["webgoat", "zap", "juice", "frontal"].every(n => r.commande.includes(`-replace='docker_container.${n}'`)) && !/postgres/.test(r.commande), "TF-2271 converger : la commande de remplacement nomme les 4 conteneurs sans état, pas postgres");
      ok(r.refusees.length === 1 && r.refusees[0].adresse === "module.base.docker_container.postgres" && r.refusees[0].image === "postgres", "TF-2271 converger : le conteneur d'image à état (postgres) est refusé au remplacement automatique, pas silencieusement");
    }
    { // c) --executer : UN apply -replace des 4, puis re-planification vide -> converge
      const f = faux(0);
      const r = lib29.converger({ pile: "pile", lancer: f.lancer, executer: true, imagesAEtat: etat29, dossierTemp: tmp29 });
      const applys = f.appels.filter(a => a.includes("apply"));
      ok(r.verdict === "converge" && applys.length === 1 && applys[0].filter(x => x.startsWith("-replace=")).length === 4 && applys[0].includes("-auto-approve") && !applys[0].some(x => /postgres/.test(x)),
        `TF-2271 converger --executer : un seul apply -replace des 4 ressources sans état, puis plan vide -> converge (appels apply : ${applys.length})`);
      ok(r.remplacees.length === 4 && r.etapes.length === 3, "TF-2271 converger --executer : trois étapes tracées (re-planification, remplacement forcé, re-planification)");
    }
    { // d) le plan reste non vide APRÈS le remplacement : un tour, pas deux
      const f = faux(2);
      const r = lib29.converger({ pile: "pile", lancer: f.lancer, executer: true, imagesAEtat: etat29, dossierTemp: tmp29 });
      ok(r.verdict === "non-converge" && f.appels.filter(a => a.includes("apply")).length === 1, "TF-2271 converger --executer : plan encore non vide après le remplacement -> non-converge, un seul tour joué");
    }
    { // e) Terraform échoue : une erreur dite, jamais une convergence supposée
      const e1 = lib29.converger({ pile: "pile", lancer: faux(0, { planAvant: 1 }).lancer, executer: true, imagesAEtat: etat29, dossierTemp: tmp29 });
      ok(e1.verdict === "erreur" && /exit 1/.test(e1.etapes[0].detail), "TF-2271 converger : `terraform plan` en erreur (exit 1) -> erreur dite, pas converge");
      const e2 = lib29.converger({ pile: "pile", lancer: faux(0, { applyStatus: 1 }).lancer, executer: true, imagesAEtat: etat29, dossierTemp: tmp29 });
      ok(e2.verdict === "erreur" && /apply -replace a échoué/.test(e2.etapes[e2.etapes.length - 1].detail), "TF-2271 converger : `terraform apply -replace` en échec -> erreur dite");
      const e3 = lib29.converger({ pile: "pile", lancer: faux(0, { showTexte: "{ pas du json" }).lancer, executer: true, imagesAEtat: etat29, dossierTemp: tmp29 });
      ok(e3.verdict === "erreur" && /capture illisible/.test(e3.etapes[0].detail), "TF-2271 converger : `show -json` illisible -> erreur dite");
    }
    { // f) une ressource à créer ou détruire n'est pas un « update » : le remplacement forcé ne la concerne pas
      const mixte = JSON.stringify({ resource_changes: [{ address: "docker_container.neuf", change: { actions: ["create"], before: null, after: { image: "nginx:1" } } }, { address: "docker_container.vieux", change: { actions: ["delete"], before: { image: "nginx:1" }, after: null } }] });
      const f = faux(0, { showTexte: mixte });
      const r = lib29.converger({ pile: "pile", lancer: f.lancer, executer: true, imagesAEtat: etat29, dossierTemp: tmp29 });
      ok(r.verdict === "non-converge" && r.autres.length === 2 && !f.appels.some(a => a.includes("apply")), "TF-2271 converger : create et delete ne sont pas remplacés de force -> non-converge, listés hors remplacement");
    }

    // La ligne de commande : usages refusés, Terraform absent dit.
    const cli29 = path.join(ici, "..", "scripts", "convergence-terraform.mjs");
    const sortie29 = (args, env = {}) => { const r = spawnSync(process.execPath, [cli29, ...args], { encoding: "utf8", env: { ...process.env, ...env } }); return { status: r.status, out: String(r.stdout) + String(r.stderr) }; };
    ok(sortie29(["inconnu", tmp29]).status === 2 && /usage/.test(sortie29(["inconnu", tmp29]).out), "convergence-terraform : verbe inconnu -> exit 2 et usage");
    ok(sortie29(["verifier"]).status === 2 && sortie29(["verifier", path.join(tmp29, "nulle-part")]).status === 2, "convergence-terraform : sans pile, ou pile introuvable -> exit 2");
    const absent29 = sortie29(["verifier", tmp29], { FORGE_OPS_TERRAFORM: path.join(tmp29, "terraform-absent") });
    ok(absent29.status === 2 && /terraform-absent/.test(absent29.out), `convergence-terraform : Terraform introuvable -> exit 2 qui le dit, jamais une convergence (exit ${absent29.status})`);

    // L'exercice réel avec Terraform : à la demande (comme Docker), il rejoue toute la chaîne sur la pile terraform_data, sans réseau.
    if (process.env.FORGE_OPS_EXERCICE_TERRAFORM === "1") {
      const pile29 = path.join(tmp29, "pile");
      fs.mkdirSync(pile29);
      fs.writeFileSync(path.join(pile29, "main.tf"), 'variable "valeur" {\n  type    = string\n  default = "a"\n}\nresource "terraform_data" "conteneur" {\n  input = var.valeur\n}\nresource "terraform_data" "autre" {\n  input = "fixe"\n}\n', "utf8");
      const tf = (...a) => spawnSync("terraform", [`-chdir=${pile29}`, ...a, "-input=false", "-no-color"], { encoding: "utf8", timeout: 600000 });
      ok(tf("init").status === 0 && tf("apply", "-auto-approve").status === 0, "EXERCICE Terraform : init et apply de la pile terraform_data");
      const v1 = sortie29(["verifier", pile29, "--sortie", path.join(tmp29, "capture-vide.json")]);
      ok(v1.status === 0 && /la pile converge/.test(v1.out), `EXERCICE Terraform : verifier après l'apply -> exit 0, plan vide (exit ${v1.status})`);
      fs.writeFileSync(path.join(pile29, "terraform.tfvars"), 'valeur = "b"\n', "utf8"); // un changement non appliqué : le plan suivant n'est plus vide
      const v2 = sortie29(["verifier", pile29, "--sortie", path.join(tmp29, "capture-non-vide.json")]);
      ok(v2.status === 1 && /terraform_data\.conteneur/.test(v2.out) && /-replace='terraform_data\.conteneur'/.test(v2.out), `EXERCICE Terraform : verifier avec un plan non vide -> exit 1, la ressource et la commande de remplacement nommées (exit ${v2.status})`);
      ok(o29(path.join(tmp29, "capture-non-vide.json")).verdict === "FAIL" && o29(path.join(tmp29, "capture-vide.json")).verdict === "PASS", "EXERCICE Terraform : la capture non vide écrite par --sortie est refusée par O-29, la vide est acceptée");
      const v3 = sortie29(["converger", pile29]);
      ok(v3.status === 1 && /remède, à jouer sous le GO du run/.test(v3.out), `EXERCICE Terraform : converger sans --executer -> exit 1, la commande écrite, rien appliqué (exit ${v3.status})`);
      const v4 = sortie29(["converger", pile29, "--executer"]);
      ok(v4.status === 0 && /remplacée\(s\) de force, le plan suivant est vide/.test(v4.out), `EXERCICE Terraform : converger --executer -> remplacement forcé puis plan vide, exit 0 (exit ${v4.status})`);
      ok(sortie29(["verifier", pile29]).status === 0, "EXERCICE Terraform : verifier après le remplacement -> exit 0");
    }
  } finally {
    fs.rmSync(tmp29, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  // Loi n° 1 : l'outil et la règle sont appelés ; l'en-tête de l'oracle dit O29.
  const lire29 = f => fs.readFileSync(path.join(ici, "..", f), "utf8");
  ok(["README.md", "CLAUDE.md"].every(f => { const t = lire29(f); return t.includes("--convergence") && t.includes("convergence-terraform.mjs") && t.includes("TF-2271"); }), "TF-2271 : l'outil et la règle sont appelés par README.md et CLAUDE.md (loi n° 1)");
  ok(/O29 --convergence/.test(lire29("oracles/oracle-ops.mjs").split("import fs")[0]), "TF-2271 : la règle figure à l'en-tête d'oracle-ops.mjs, seule source de la liste des règles");
}

// ── TF-2230 (D-178 (a) du 06/11/2026, étude « Sécurité par défaut de bout en bout », pièce 6) : LES RÉGLAGES DE PLATEFORME SE COMPARENT À L'ATTENDU DU REGISTRE ─
// Le fait : le plan O5 lisait ssl-enforcement et network-restrictions de Supabase sans les comparer à un attendu du registre, aucun
// réglage de GitHub ni de Cloudflare ; le même plan prescrit `supabase db push`, connexion directe à Postgres impossible à déclarer
// pour les exécuteurs hébergés de GitHub une fois la restriction d'adresses posée. Décision : un contrôle bloquant avant la MEP
// compare chaque réglage lu à l'attendu du registre du pilot ; un écart décidé se vérifie tel que décidé ; `db push` est déclarée
// incompatible. Le registre de la recette est une COPIE (fixtures/o28-reglages-plateforme/registre.json, les 9 entrées de l'étude),
// jamais le fichier du pilot.
{
  console.log("");
  const lib28 = await import("../scripts/lib-reglages.mjs");
  const fx28 = f => fx(path.join("o28-reglages-plateforme", f));
  const registre28 = fx28("registre.json");
  const o28 = (releve, ...autres) => { try { return JSON.parse(run(oracle, ["--reglages-plateforme", releve, "--registre", registre28, ...autres, "--json-only"])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };
  const durs = r => (r.findings || []).filter(f => f.regle === "O28" && (f.sev === "bloquant" || f.sev === "majeur"));
  const tmp30 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-tf2230-"));
  const vert28 = JSON.parse(fs.readFileSync(fx28("releve-vert.json"), "utf8"));
  const NOM = { ssl: "TLS imposé", reseau: "Restriction des adresses", mfa: "Double vérification", pitr: "Restauration à la minute", push: "Protection des secrets", dependabot: "Alertes Dependabot", ruleset: "Protection de la branche principale", https: "HTTPS imposé", hsts: "En-tête HSTS" };
  // Un relevé dérivé du vert : `modif` change la valeur lue du réglage dont le nom commence par `debut`.
  const variante = (debut, modif, nom) => {
    const r = JSON.parse(JSON.stringify(vert28));
    const l = r.reglages.find(x => x.reglage.startsWith(debut)); modif(l, r);
    const f = path.join(tmp30, `${nom}.json`); fs.writeFileSync(f, JSON.stringify(r), "utf8"); return f;
  };
  try {
    // Verte : les 9 réglages des 3 plateformes sont lus et conformes -> PASS, 9 comparés.
    const rV = o28(fx28("releve-vert.json"));
    ok(rV.verdict === "PASS" && durs(rV).length === 0 && rV.findings.filter(f => /conforme à l'attendu/.test(f.msg)).length === 9, `O28 : 9 réglages (Supabase, GitHub, Cloudflare) lus et conformes -> PASS, 9 comparés (obtenu ${rV.verdict}, ${rV.findings.filter(f => /conforme à l'attendu/.test(f.msg)).length})`);
    // Rouges classées défaut : un écart nu est un constat bloquant qui nomme le réglage, la valeur lue et la commande d'application.
    const rouges = [
      ["ssl", l => { l.lu = false; }, /lu false, attendu true/, /ssl-enforcement/],
      ["reseau-ouvert", l => { l.lu = { v4: ["0.0.0.0/0"], v6: ["::/0"], status: "applied" }; }, /plage ouverte à tous/, /network-restrictions\/apply/],
      ["reseau-vide", l => { l.lu = { v4: [], v6: [], status: "applied" }; }, /une liste vide laisse tout passer/, /network-restrictions\/apply/],
      ["reseau-en-attente", l => { l.lu = { v4: ["203.0.113.0/24"], v6: [], status: "applying" }; }, /status « applying »/, /network-restrictions\/apply/],
      ["dependabot", l => { l.lu = 1; }, /code de sortie 1/, /vulnerability-alerts/],
      ["https", l => { l.lu = "off"; }, /lu "off", attendu « on »/, /always_use_https/],
      ["hsts-court", l => { l.lu = { enabled: true, max_age: 3600, include_subdomains: false, preload: false }; }, /max_age = 3600/, /security_header/],
      ["hsts-sous-domaines", l => { l.lu = { enabled: true, max_age: 31536000, include_subdomains: true, preload: false }; }, /include_subdomains = true/, /security_header/],
    ];
    const debuts = { ssl: "TLS imposé", reseau: "Restriction des adresses", dependabot: "Alertes Dependabot", https: "HTTPS imposé", hsts: "En-tête HSTS" };
    for (const [nom, modif, motif, appliquer] of rouges) {
      const r = o28(variante(debuts[nom.split("-")[0]], l => modif(l), nom));
      ok(r.verdict === "FAIL" && durs(r).length === 1 && durs(r)[0].sev === "bloquant" && motif.test(durs(r)[0].msg) && /écart NU/.test(durs(r)[0].msg) && appliquer.test(durs(r)[0].msg),
        `O28 rouge « ${nom} » : réglage classé défaut hors de son attendu -> FAIL bloquant, écart nu, commande d'application citée (obtenu ${r.verdict}, ${durs(r).length})`);
    }
    // Classé décision : même exigence, et le message renvoie à la décision de l'humain, pas à une commande.
    const rMfa = o28(variante(NOM.mfa, l => { l.lu = false; }, "mfa-faux"));
    ok(rMfa.verdict === "FAIL" && durs(rMfa).length === 1 && /classé decision/.test(durs(rMfa)[0].msg) && /poser la décision de l'humain/.test(durs(rMfa)[0].msg), `O28 rouge « mfa » : réglage classé décision hors de son attendu, sans écart décidé -> FAIL, renvoie à la décision (obtenu ${rMfa.verdict})`);
    const rRs = o28(variante(NOM.ruleset, l => { l.lu = ["deletion", "non_fast_forward"]; }, "ruleset-sans-pr"));
    ok(rRs.verdict === "FAIL" && /manque : pull_request/.test(durs(rRs)[0].msg), "O28 rouge « ruleset » : la demande de fusion n'est pas exigée -> FAIL qui nomme pull_request");
    // L'écart décidé : vérifié TEL QUE DÉCIDÉ.
    const mfaFaux = variante(NOM.mfa, l => { l.lu = false; }, "mfa-faux");
    const rEc = o28(mfaFaux, "--ecarts", fx28("ecarts-mfa.json"));
    ok(rEc.verdict === "PASS" && durs(rEc).length === 0 && rEc.findings.some(f => /écart ACCEPTÉ tel que décidé le 2026-11-06/.test(f.msg)), `O28 : l'écart décidé (mots, date, valeur lue acceptée) est vérifié tel que décidé -> PASS (obtenu ${rEc.verdict})`);
    const ecartsNouveau = (nom, modif) => { const e = JSON.parse(fs.readFileSync(fx28("ecarts-mfa.json"), "utf8")); modif(e); const f = path.join(tmp30, `${nom}.json`); fs.writeFileSync(f, JSON.stringify(e), "utf8"); return f; };
    const rBouge = o28(variante(NOM.mfa, l => { l.lu = [false, true]; }, "mfa-bouge"), "--ecarts", fx28("ecarts-mfa.json"));
    ok(rBouge.verdict === "FAIL" && durs(rBouge).length === 1 && /n'est plus celui qui a été accepté/.test(durs(rBouge)[0].msg), "O28 : l'état lu a bougé depuis la décision -> FAIL, l'écart n'est plus celui qui a été décidé");
    const rSans = o28(mfaFaux, "--ecarts", ecartsNouveau("ecart-sans-mots", e => { e.ecarts[0].decision = "ok"; }));
    ok(rSans.verdict === "FAIL" && /sans décision/.test(durs(rSans)[0].msg), "O28 : un écart sans les mots de l'humain -> FAIL");
    const rDate = o28(mfaFaux, "--ecarts", ecartsNouveau("ecart-sans-date", e => { delete e.ecarts[0].date; }));
    ok(rDate.verdict === "FAIL" && /sans date/.test(durs(rDate)[0].msg), "O28 : un écart non daté -> FAIL");
    const rOrph = o28(fx28("releve-vert.json"), "--ecarts", ecartsNouveau("ecart-orphelin", e => { e.ecarts[0].reglage = "Réglage inventé"; }));
    ok(rOrph.verdict === "FAIL" && durs(rOrph).length === 1 && durs(rOrph)[0].sev === "majeur" && /écart orphelin/.test(durs(rOrph)[0].msg), "O28 : un écart sur un réglage qui n'est pas au registre -> FAIL majeur (écart orphelin)");
    const rSansObjet = o28(fx28("releve-vert.json"), "--ecarts", fx28("ecarts-mfa.json"));
    ok(rSansObjet.verdict === "PASS" && rSansObjet.findings.some(f => /devenu sans objet/.test(f.msg)), "O28 : un écart accepté dont le réglage est redevenu conforme -> PASS, dit « sans objet »");
    // Un réglage non lu, une lecture en échec : jamais un PASS.
    const rNonLu = o28(variante(NOM.hsts, (l, r) => { r.reglages = r.reglages.filter(x => x !== l); }, "hsts-non-lu"));
    ok(rNonLu.verdict === "FAIL" && durs(rNonLu).length === 1 && /NON LU/.test(durs(rNonLu)[0].msg) && /security_header/.test(durs(rNonLu)[0].msg), "O28 : un réglage du registre que le relevé ne porte pas -> FAIL « NON LU » qui donne la commande de lecture");
    const rEchec = o28(variante(NOM.https, l => { delete l.lu; l.erreur = "commande en échec (exit 22)"; }, "https-echec"));
    ok(rEchec.verdict === "FAIL" && /la lecture a échoué/.test(durs(rEchec)[0].msg), "O28 : une lecture en échec -> FAIL, jamais un PASS");
    // Plateformes : seules les déclarées sont exigées ; une plateforme sans entrée au registre est dite, pas jugée.
    const sousEns = JSON.parse(JSON.stringify(vert28)); sousEns.plateformes = ["Cloudflare"];
    const fSous = path.join(tmp30, "cloudflare-seul.json"); fs.writeFileSync(fSous, JSON.stringify(sousEns), "utf8");
    ok(o28(fSous).verdict === "PASS" && o28(fSous).findings.filter(f => /conforme à l'attendu/.test(f.msg)).length === 2, "O28 : seul Cloudflare déclaré -> 2 réglages comparés (HTTPS, HSTS), les autres plateformes ne sont pas exigées");
    const azure = JSON.parse(JSON.stringify(vert28)); azure.plateformes = ["Azure"];
    const fAz = path.join(tmp30, "azure.json"); fs.writeFileSync(fAz, JSON.stringify(azure), "utf8");
    const rAz = o28(fAz);
    ok(rAz.verdict === "SKIP" && rAz.findings.some(f => /plateforme « Azure » : aucun réglage au registre/.test(f.msg)), "O28 : une plateforme sans entrée au registre -> SKIP qui le dit, jamais un PASS");
    // Bornes.
    ok(o28(path.join(tmp30, "absent.json")).verdict === "SKIP", "O28 borne : relevé introuvable -> SKIP");
    const ecrire30 = (nom, t) => { const f = path.join(tmp30, nom); fs.writeFileSync(f, t, "utf8"); return f; };
    ok((r => r.verdict === "FAIL" && /relevé illisible/.test(durs(r)[0].msg))(o28(ecrire30("casse.json", "{ pas du json"))), "O28 borne : relevé illisible -> FAIL dit");
    ok((r => r.verdict === "FAIL" && durs(r).some(f => /sans `plateformes`/.test(f.msg)))(o28(ecrire30("sans-plateformes.json", JSON.stringify({ format: "forge-ops/reglages-plateforme@1", reglages: [] })))), "O28 borne : relevé sans plateformes déclarées -> FAIL (sinon aucun réglage n'est exigé)");
    ok((r => r.verdict === "FAIL" && durs(r).some(f => /de format « forge-ops\/autre@9 »/.test(f.msg)))(o28(ecrire30("format.json", JSON.stringify({ ...vert28, format: "forge-ops/autre@9" })))), "O28 borne : format de relevé inconnu -> FAIL");
    ok((r => r.verdict === "FAIL" && durs(r).length === 1 && /introuvable ou illisible/.test(durs(r)[0].msg))(o28(fx28("releve-vert.json"), "--ecarts", path.join(tmp30, "nulle-part.json"))), "O28 borne : fichier d'écarts introuvable -> FAIL dit");
    const regCasse = ecrire30("registre-casse.json", "[{ \"plateforme\": \"Supabase\" }]");
    const rReg = (() => { try { return JSON.parse(run(oracle, ["--reglages-plateforme", fx28("releve-vert.json"), "--registre", regCasse, "--json-only"])); } catch (e) { return JSON.parse(String(e.stdout)); } })();
    ok(rReg.verdict === "FAIL" && durs(rReg).some(f => /entrée 1 du registre invalide/.test(f.msg)), "O28 borne : une entrée de registre sans clés -> FAIL, un registre illisible ne vaut jamais PASS");
    // Le registre du pilot se trouve par FORGE_ROOT (parc), sous forme de tableau ou d'objet qui le porte sous `reglages`.
    const racine30 = path.join(tmp30, "parc"); fs.mkdirSync(path.join(racine30, "digit-ai-factory", "references"), { recursive: true });
    fs.writeFileSync(path.join(racine30, "digit-ai-factory", "references", "REGLAGES-SURS-PAR-DEFAUT.json"), JSON.stringify({ verifie_le: "2026-11-06", reglages: JSON.parse(fs.readFileSync(registre28, "utf8")) }), "utf8");
    const sansRegistre = (env) => { const r = spawnSync(process.execPath, [oracle, "--reglages-plateforme", fx28("releve-vert.json"), "--json-only"], { encoding: "utf8", env: { ...process.env, ...env } }); try { return JSON.parse(r.stdout); } catch { return { verdict: "ILLISIBLE", findings: [] }; } };
    ok(sansRegistre({ FORGE_ROOT: racine30 }).verdict === "PASS", "O28 : sans --registre, le registre du pilot est lu par FORGE_ROOT (objet à clé `reglages`) -> PASS");
    ok((r => r.verdict === "SKIP" && r.findings.some(f => /registre des réglages introuvable/.test(f.msg)))(sansRegistre({ FORGE_ROOT: path.join(tmp30, "vide") })), "O28 : registre du pilot introuvable -> SKIP qui le dit, jamais un PASS");

    // La comparaison, forme par forme (les attendus du registre).
    const c = lib28.comparer;
    ok(c("contient deletion, non_fast_forward et pull_request", ["deletion", "non_fast_forward", "pull_request", "required_signatures"]).ok && !c("contient deletion, non_fast_forward et pull_request", ["deletion"]).ok, "O28 comparer : « contient a, b et c » exige les trois");
    ok(c("true pour chaque membre (l'obligation elle-même n'est pas lisible par l'API)", "true").ok && !c("true pour chaque membre (…)", "false").ok, "O28 comparer : « true… » lit un booléen, y compris donné en chaîne");
    ok(c("enabled", "enabled").ok && !c("enabled", "disabled").ok && !c("enabled", "").ok, "O28 comparer : chaîne égale à la lettre, une valeur vide n'est jamais conforme");
    ok(c("v4 et v6 égales aux plages déclarées par le produit", { v4: ["203.0.113.0/24"], v6: [], status: "applied" }, { v4: ["203.0.113.0/24"], v6: [] }).ok && !c("v4 et v6 égales aux plages déclarées par le produit", { v4: ["203.0.113.0/24"], v6: [], status: "applied" }, { v4: ["198.51.100.0/24"], v6: [] }).ok, "O28 comparer : avec `declare`, les plages lues doivent être égales à celles que le produit déclare");

    // Le relevé : lecture seule, secrets dans l'environnement, rien d'écrit.
    const entrees28 = lib28.chargerRegistre(fs.readFileSync(registre28, "utf8")).entrees;
    ok(entrees28.length === 9 && entrees28.filter(e => e.classement === "defaut").length === 5 && entrees28.filter(e => e.classement === "decision").length === 4, "O28 : le registre de la recette porte les 9 entrées de l'étude (5 défaut, 4 décision)");
    ok(entrees28.every(e => lib28.estLecture(e.cmd_lire)) && !entrees28.filter(e => /^(curl|gh) /.test(e.cmd_appliquer)).some(e => lib28.estLecture(e.cmd_appliquer)), "O28 relever : les 9 commandes de lecture du registre sont des lectures, aucune commande d'application n'en est une");
    ok(!lib28.estLecture("curl -sS -X POST https://x") && !lib28.estLecture("curl -sS --request PUT https://x") && !lib28.estLecture("curl -d '{}' https://x") && !lib28.estLecture("gh api repos/o/r -f a=b") && lib28.estLecture("gh api repos/o/r --jq '.a'"), "O28 relever : un verbe d'écriture, un corps ou un champ de gh api disqualifient une commande de lecture");
    const valeursParCommande = new Map(vert28.reglages.map(r => [r.commande, r.lu]));
    const env28 = { PROJECT_REF: "ref", SUPABASE_ACCESS_TOKEN: "jeton-secret-fictif", ORG_SLUG: "org", OWNER: "o", REPO: "r", ZONE_ID: "z", CLOUDFLARE_API_TOKEN: "jeton-cf-fictif" };
    const jouees = [];
    const lancer28 = (commande, env) => { jouees.push({ commande, env }); const v = valeursParCommande.get(commande); return { status: 0, stdout: typeof v === "string" ? v + "\n" : JSON.stringify(v), stderr: "" }; };
    const horloge = () => "2026-11-06T12:00:00.000Z";
    const rel = lib28.relever({ entrees: entrees28, plateformes: ["Supabase", "GitHub", "Cloudflare"], env: env28, lancer: lancer28, horloge });
    ok(jouees.length === 9 && jouees.every(j => entrees28.some(e => e.cmd_lire === j.commande)) && !jouees.some(j => entrees28.some(e => e.cmd_appliquer === j.commande || e.cmd_retour === j.commande)), "O28 relever : 9 commandes jouées, toutes des cmd_lire du registre, jamais cmd_appliquer ni cmd_retour");
    ok(!JSON.stringify(rel.releve).includes("jeton-secret-fictif") && !JSON.stringify(rel.releve).includes("jeton-cf-fictif"), "O28 relever : le relevé ne porte aucune valeur de secret (variables non développées)");
    const fRel = path.join(tmp30, "releve-pris.json"); fs.writeFileSync(fRel, JSON.stringify(rel.releve), "utf8");
    ok(o28(fRel).verdict === "PASS", "O28 relever -> comparer : le relevé pris par le script passe l'oracle (de la lecture au verdict)");
    const sansJeton = lib28.relever({ entrees: entrees28, plateformes: ["Cloudflare"], env: { ZONE_ID: "z" }, lancer: lancer28, horloge });
    ok(sansJeton.releve.reglages.every(r => /variable\(s\) d'environnement absente\(s\) : CLOUDFLARE_API_TOKEN/.test(r.erreur)), "O28 relever : une variable d'environnement absente est une lecture en échec qui nomme la variable");
    const fSans = path.join(tmp30, "releve-sans-jeton.json"); fs.writeFileSync(fSans, JSON.stringify({ ...sansJeton.releve }), "utf8");
    ok(o28(fSans).verdict === "FAIL", "O28 relever : le relevé aux lectures en échec est refusé par l'oracle");
    const ecrit = entrees28.map(e => (e.plateforme === "GitHub" ? { ...e, cmd_lire: "gh api -X DELETE repos/$OWNER/$REPO" } : e));
    const nAvant = jouees.length;
    const refusee = lib28.relever({ entrees: ecrit, plateformes: ["GitHub"], env: env28, lancer: lancer28, horloge });
    ok(refusee.refus.length === 3 && jouees.length === nAvant && refusee.releve.reglages.every(r => /refusée : elle écrit/.test(r.erreur)), "O28 relever : une commande de lecture qui écrit n'est jamais jouée (3 refusées, 0 jouée)");
    ok(lib28.relever({ entrees: entrees28, plateformes: ["GitHub"], env: env28, lancer: () => ({ status: 22, stdout: "", stderr: "HTTP 403" }), horloge }).releve.reglages.filter(r => /exit 22/.test(r.erreur)).length === 2, "O28 relever : une commande en échec est dite (exit 22), sauf la lecture dont le code de sortie est la valeur (`echo $?`)");

    // La ligne de commande du relevé : liste sans --executer, refus d'usage.
    const cli30 = path.join(ici, "..", "scripts", "relever-reglages.mjs");
    const sortie30 = (a, env = {}) => { const r = spawnSync(process.execPath, [cli30, ...a], { encoding: "utf8", env: { ...process.env, ...env } }); return { status: r.status, out: String(r.stdout) + String(r.stderr) }; };
    const liste = sortie30(["Supabase", "--registre", registre28]);
    ok(liste.status === 0 && /4 lecture\(s\) à jouer, rien n'est exécuté sans --executer/.test(liste.out) && /\[variables : PROJECT_REF, SUPABASE_ACCESS_TOKEN\]/.test(liste.out), `relever-reglages : sans --executer, les 4 lectures Supabase sont listées avec leurs variables et rien n'est joué (exit ${liste.status})`);
    ok(sortie30([]).status === 2 && sortie30(["Azure", "--registre", registre28]).status === 2 && sortie30(["Supabase", "--registre", path.join(tmp30, "nulle-part.json")]).status === 2, "relever-reglages : sans plateforme, plateforme sans réglage, registre introuvable -> exit 2");

    // Le plan O5 : relève et compare les réglages, déclare `db push` incompatible.
    const plan30 = c => JSON.parse(run(ops, ["plan", c, "<BUILD>"]));
    const o5 = (p) => { const f = path.join(tmp30, "plan.json"); fs.writeFileSync(f, JSON.stringify(p), "utf8");
      try { return JSON.parse(run(oracle, ["--plan", f, "--json-only"])); } catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };
    const planSup = plan30("supabase"), planCf = plan30("cloudflare-workers");
    for (const [nom, p, pf] of [["supabase", planSup, "Supabase"], ["cloudflare-workers", planCf, "Cloudflare"]]) {
      ok(o5(p).verdict === "PASS", `TF-2230 O-5 : le plan ${nom} généré -> PASS`);
      ok(p.placeholders.includes("<FORGE_OPS>") && p.placeholders.includes("<ECARTS_ACCEPTES>"), `TF-2230 : le plan ${nom} déclare <FORGE_OPS> et <ECARTS_ACCEPTES>`);
      ok(new RegExp(`relever-reglages\\.mjs ${pf} --sortie reglages-plateforme\\.json --executer`).test(p.phases.provision.join("\n")) && /oracle-ops\.mjs --reglages-plateforme reglages-plateforme\.json/.test(p.phases.provision.join("\n")), `TF-2230 : le plan ${nom} relève les réglages ${pf} puis les compare (O-28) dans sa phase provision, avant tout déploiement`);
      const sansReleve = JSON.parse(JSON.stringify(p)); sansReleve.phases.provision = sansReleve.phases.provision.filter(l => !/relever-reglages/.test(l));
      const r1 = o5(sansReleve);
      ok(r1.verdict === "FAIL" && r1.findings.filter(f => f.sev === "majeur" && /ne relève pas les réglages/.test(f.msg)).length === 1, `TF-2230 O-5 : un plan ${nom} qui ne relève pas les réglages -> FAIL majeur, seul constat (obtenu ${r1.verdict})`);
      const sansCompare = JSON.parse(JSON.stringify(p)); sansCompare.phases.provision = sansCompare.phases.provision.filter(l => !/--reglages-plateforme/.test(l));
      const r2 = o5(sansCompare);
      ok(r2.verdict === "FAIL" && r2.findings.filter(f => f.sev === "majeur" && /ne compare pas les réglages/.test(f.msg)).length === 1, `TF-2230 O-5 : un plan ${nom} qui ne compare pas les réglages relevés -> FAIL majeur, seul constat (obtenu ${r2.verdict})`);
    }
    const toutSup = Object.values(planSup.phases).flat().join("\n");
    ok(/supabase db push/.test(toutSup) && /INCOMPATIBLE avec la restriction des adresses \(network-restrictions\)/.test(toutSup) && /5 622 plages IPv4/.test(toutSup) && /database\/query/.test(toutSup), "TF-2230 : le plan supabase déclare `supabase db push` INCOMPATIBLE avec la restriction réseau depuis un exécuteur hébergé, mesure à l'appui, et nomme la voie compatible (API de gestion)");
    const sansDecl = JSON.parse(JSON.stringify(planSup));
    sansDecl.phases.provision = sansDecl.phases.provision.filter(l => !/INCOMPATIBLE/.test(l));
    const r3 = o5(sansDecl);
    ok(r3.verdict === "FAIL" && r3.findings.filter(f => f.sev === "majeur" && /INCOMPATIBLE avec la restriction réseau/.test(f.msg)).length === 1, `TF-2230 O-5 : un plan supabase qui pousse par db push sans déclarer l'incompatibilité -> FAIL majeur, seul constat (obtenu ${r3.verdict})`);
    const sansPush = JSON.parse(JSON.stringify(sansDecl));
    for (const ph of Object.keys(sansPush.phases)) sansPush.phases[ph] = sansPush.phases[ph].map(l => l.replace(/supabase db push/g, "migrer par l'API de gestion"));
    ok(o5(sansPush).verdict === "PASS", "TF-2230 O-5 : un plan supabase qui ne pousse pas par db push n'a rien à déclarer -> PASS (la voie compatible n'est pas exigée de qui ne s'en sert pas)");
  } finally {
    fs.rmSync(tmp30, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  // Loi n° 1 : l'outil, la règle et le plan sont appelés ; l'en-tête de l'oracle dit O28.
  const lire30 = f => fs.readFileSync(path.join(ici, "..", f), "utf8");
  ok(["README.md", "CLAUDE.md"].every(f => { const t = lire30(f); return t.includes("--reglages-plateforme") && t.includes("relever-reglages.mjs") && t.includes("TF-2230") && t.includes("db push"); }), "TF-2230 : l'outil, la règle et la voie db push sont appelés par README.md et CLAUDE.md (loi n° 1)");
  ok(/O28 --reglages-plateforme/.test(lire30("oracles/oracle-ops.mjs").split("import fs")[0]), "TF-2230 : la règle figure à l'en-tête d'oracle-ops.mjs, seule source de la liste des règles");
}

// ── TF-2308 (Produit-86, lot 20261109a RP-53, ledger seq 439) : LE TEST DE MISE EN PRODUCTION RELIT L'ÉTAT SERVI À SA FIN ─
// Le fait : un arrêt de mission joué en dernier laissait la passerelle en NO_EXTERNAL_AI pour toutes les missions, sans
// relecture de la santé ; l'instance répondait 200 en mode dégradé. Décision R-58 du 09/11/2026 : le gabarit relit la santé à
// la fin et échoue si l'état servi diffère de celui d'avant. Un faux service local bascule son état sous une épreuve (POST
// /arret) : le test qui ne relit pas, ou qui relit un état changé, est refusé ; celui qui remet l'état en fin passe.
{
  console.log("");
  const { spawn } = await import("node:child_process");
  const http = await import("node:http");
  const gabarit30 = path.join(ici, "..", "gabarits", "smoke-mise-en-production.mjs");
  const lib30 = await import("../scripts/lib-etat-servi.mjs");
  const gab30 = await import("../gabarits/smoke-mise-en-production.mjs");
  const tmp30 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-tf2308-"));
  const o30 = (...a) => { try { return JSON.parse(run(oracle, ["--etat-servi", ...a, "--json-only"])); }
    catch (e) { try { return JSON.parse(String(e.stdout)); } catch { return { verdict: "ILLISIBLE", findings: [] }; } } };
  const durs = r => (r.findings || []).filter(f => f.regle === "O30" && (f.sev === "bloquant" || f.sev === "majeur"));
  const asynchrone = (args) => new Promise(resolve => {
    const p = spawn(process.execPath, args, { encoding: "utf8" });
    let stdout = "", stderr = "";
    p.stdout.on("data", d => { stdout += d; }); p.stderr.on("data", d => { stderr += d; });
    p.on("close", status => resolve({ status, stdout, stderr }));
  });
  // Faux service : l'épreuve POST /arret pose le verrou global (mode NO_EXTERNAL_AI) ET la santé répond encore 200.
  const faux = (chemin, { volatil = false } = {}) => new Promise(resolve => {
    const etat = { mode: "normal", n: 0 };
    const srv = http.createServer((q, r) => {
      if (q.method === "POST" && q.url === "/arret") { etat.mode = "NO_EXTERNAL_AI"; r.writeHead(204); return r.end(); }
      if (q.method === "POST" && q.url === "/reprise") { etat.mode = "normal"; r.writeHead(204); return r.end(); }
      if (q.method === "POST" && q.url === "/couper") { r.writeHead(204); r.end(); return setImmediate(() => { srv.closeAllConnections(); srv.close(); }); }
      if (q.method === "GET" && q.url === chemin) {
        const corps = { statut: "ok", passerelle: { mode: etat.mode } };
        if (volatil) corps.uptime_s = ++etat.n;
        r.writeHead(200, { "content-type": "application/json" }); return r.end(JSON.stringify(corps));
      }
      r.writeHead(404); r.end();
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, etat, url: `http://127.0.0.1:${srv.address().port}` }));
  });
  const epreuve = (nom, source) => { const f = path.join(tmp30, `${nom}.mjs`); fs.writeFileSync(f, source, "utf8"); return `node "${f}"`; };
  const poster = (chemin, code = 0) => `await fetch(process.env.SMOKE_URL + "${chemin}", { method: "POST" }); process.exitCode = ${code};`;
  const creer = epreuve("creer", `process.exitCode = 0;`);
  const arret = epreuve("arret", poster("/arret"));
  const arretEnEchec = epreuve("arret-echec", poster("/arret", 3));
  const reprise = epreuve("reprise", poster("/reprise"));
  const couper = epreuve("couper", poster("/couper"));
  const jouer = async (nom, srvUrl, cfg, extra = []) => {
    const config = path.join(tmp30, `${nom}.config.json`), sortie = path.join(tmp30, `${nom}.etat-servi.json`);
    fs.writeFileSync(config, JSON.stringify({ url: srvUrl, ...cfg }), "utf8");
    const r = await asynchrone([gabarit30, "--config", config, "--sortie", sortie, ...extra]);
    return { ...r, sortie, releve: fs.existsSync(sortie) ? JSON.parse(fs.readFileSync(sortie, "utf8")) : null };
  };
  const serveurs = [];
  const demarrer = async (...a) => { const s = await faux(...a); serveurs.push(s.srv); return s; };
  try {
    // ROUGE · l'épreuve d'arrêt est jouée en dernier : la santé répond 200 dans un autre mode (le cas du 04/11)
    {
      const s = await demarrer("/healthz", { volatil: true });
      const r = await jouer("rouge-arret-en-dernier", s.url, { sante: { ignorer: ["uptime_s"] }, epreuves: [{ nom: "creer", commande: creer }, { nom: "arret", commande: arret }] });
      ok(r.status === 1 && /« passerelle\.mode » : "normal" au départ, "NO_EXTERNAL_AI" à la fin/.test(r.stderr), `TF-2308 rouge : arrêt joué en dernier, santé encore à 200 -> le gabarit échoue (exit 1) et nomme passerelle.mode, normal -> NO_EXTERNAL_AI (obtenu ${r.status})`);
      ok(r.releve && r.releve.avant.status === 200 && r.releve.apres.status === 200 && !/code de santé/.test(r.stderr), "TF-2308 rouge : le code de santé est 200 des deux côtés, donc un contrôle du seul code ne verrait rien");
      ok(r.releve.chemin === "/healthz", "TF-2308 : sans « sante.chemin », la santé se lit à /healthz (défaut du gabarit)");
      const o = o30(r.sortie);
      ok(o.verdict === "FAIL" && durs(o).length === 1 && durs(o)[0].sev === "bloquant" && /passerelle\.mode/.test(durs(o)[0].msg), `O30 : le relevé de cet arrêt en dernier -> FAIL bloquant, seul constat, qui nomme passerelle.mode (obtenu ${o.verdict}, ${durs(o).length})`);
      // Le même test SANS la relecture : on retire l'état de fin du relevé que le gabarit vient de prendre.
      const sans = { ...r.releve, apres: null };
      const fSans = path.join(tmp30, "rouge-meme-run-sans-relecture.json"); fs.writeFileSync(fSans, JSON.stringify(sans), "utf8");
      const oSans = o30(fSans);
      ok(oSans.verdict === "FAIL" && durs(oSans).length === 1 && /n'a pas été RELU/.test(durs(oSans)[0].msg), `O30 rouge : le même run sans relecture finale -> FAIL, « n'a pas été RELU » (obtenu ${oSans.verdict}, ${durs(oSans).length})`);
    }
    // VERT · le remède recommandé : la dernière épreuve remet l'état de départ (reprise de la passerelle)
    {
      const s = await demarrer("/healthz", { volatil: true });
      const r = await jouer("vert-reprise", s.url, { sante: { ignorer: ["uptime_s"] }, epreuves: [{ nom: "creer", commande: creer }, { nom: "arret", commande: arret }, { nom: "reprise", commande: reprise }] });
      ok(r.status === 0 && s.etat.mode === "normal", `TF-2308 vert : arrêt puis reprise -> le gabarit passe (exit 0), l'instance est revenue en normal (obtenu ${r.status}, mode ${s.etat.mode})`);
      const o = o30(r.sortie);
      ok(o.verdict === "PASS" && durs(o).length === 0, `O30 : le relevé du run avec reprise -> PASS (obtenu ${o.verdict}, ${durs(o).length})`);
      ok(r.releve.epreuves.length === 3 && Date.parse(r.releve.apres.lu_a) >= Date.parse(r.releve.epreuves[2].fin), "TF-2308 vert : l'état de fin est lu après la fin de la dernière épreuve");
    }
    // Champ déclaré : « sante.champs » compare le seul état, une durée de fonctionnement volatile ne fait pas échouer
    {
      const s = await demarrer("/healthz", { volatil: true });
      const ok1 = await jouer("champs-reprise", s.url, { sante: { champs: ["passerelle.mode"] }, epreuves: [{ nom: "arret", commande: arret }, { nom: "reprise", commande: reprise }] });
      ok(ok1.status === 0 && o30(ok1.sortie).verdict === "PASS", `TF-2308 : champ déclaré (passerelle.mode), uptime_s qui bouge -> PASS (obtenu ${ok1.status})`);
      const ko = await jouer("champs-arret", s.url, { sante: { champs: ["passerelle.mode"] }, epreuves: [{ nom: "arret", commande: arret }] });
      ok(ko.status === 1 && o30(ko.sortie).verdict === "FAIL", `TF-2308 : champ déclaré, passerelle.mode change -> échec (obtenu ${ko.status})`);
      await fetch(`${s.url}/reprise`, { method: "POST" });
      const nu = await jouer("volatil-non-declare", s.url, { epreuves: [{ nom: "creer", commande: creer }] });
      ok(nu.status === 1 && /« uptime_s »/.test(nu.stderr), `TF-2308 : un champ volatil non déclaré est un écart nommé, jamais ignoré en silence (obtenu ${nu.status})`);
    }
    // Santé qui ne s'expose pas à /healthz : le chemin vient de la configuration du gabarit
    {
      const s = await demarrer("/api/health");
      const r = await jouer("chemin-declare", s.url, { sante: { chemin: "/api/health" }, epreuves: [{ nom: "arret", commande: arret }, { nom: "reprise", commande: reprise }] });
      ok(r.status === 0 && r.releve.chemin === "/api/health" && o30(r.sortie).verdict === "PASS", `TF-2308 : produit dont la santé est à /api/health, chemin déclaré -> PASS, relevé au bon chemin (obtenu ${r.status})`);
      const sans = await jouer("chemin-non-declare", s.url, { epreuves: [{ nom: "arret", commande: arret }] });
      ok(sans.status === 2 && /sante\.chemin/.test(sans.stderr) && sans.releve.epreuves.length === 0 && s.etat.mode === "normal", `TF-2308 : santé introuvable à /healthz -> exit 2 qui nomme « sante.chemin », aucune épreuve jouée, instance intacte (obtenu ${sans.status}, mode ${s.etat.mode})`);
      const parUrl = await jouer("url-en-argument", "http://127.0.0.1:9", { sante: { chemin: "/api/health" }, epreuves: [{ nom: "arret", commande: arret }, { nom: "reprise", commande: reprise }] }, ["--url", s.url]);
      ok(parUrl.status === 0, `TF-2308 : --url l'emporte sur la configuration (obtenu ${parUrl.status})`);
    }
    // Une épreuve en échec n'empêche pas la relecture : c'est elle qui laisse le plus souvent l'instance à part
    {
      const s = await demarrer("/healthz");
      const r = await jouer("epreuve-en-echec", s.url, { epreuves: [{ nom: "arret-en-echec", commande: arretEnEchec }] });
      ok(r.status === 1 && r.releve.apres && r.releve.apres.status === 200 && r.releve.epreuves[0].code === 3 && /passerelle\.mode/.test(r.stderr), `TF-2308 : épreuve en échec (code 3) -> l'état de fin est relu quand même et l'écart nommé (obtenu ${r.status})`);
    }
    // Instance muette à la fin
    {
      const s = await demarrer("/healthz");
      const r = await jouer("instance-coupee", s.url, { epreuves: [{ nom: "couper", commande: couper }] });
      ok(r.status === 1 && r.releve.apres.status === null && /illisible/.test(r.stderr), `TF-2308 : l'instance ne répond plus à la fin -> exit 1, état de fin illisible (obtenu ${r.status})`);
      ok(o30(r.sortie).verdict === "FAIL", "O30 : le relevé d'une instance muette à la fin -> FAIL");
    }
    // Usage
    {
      const sansConfig = await asynchrone([gabarit30, "--config", path.join(tmp30, "nulle-part.json")]);
      ok(sansConfig.status === 2 && /configuration illisible/.test(sansConfig.stderr), "TF-2308 : configuration absente -> exit 2");
      const cfgVide = path.join(tmp30, "vide.config.json"); fs.writeFileSync(cfgVide, JSON.stringify({ url: "http://127.0.0.1:9", epreuves: [] }), "utf8");
      const sansEpreuve = await asynchrone([gabarit30, "--config", cfgVide]);
      ok(sansEpreuve.status === 2 && /au moins une épreuve/.test(sansEpreuve.stderr), "TF-2308 : aucune épreuve déclarée -> exit 2 (rien à encadrer)");
    }
  } finally {
    for (const srv of serveurs) { try { srv.closeAllConnections(); srv.close(); } catch { /* déjà coupé */ } }
  }
  // Fixtures statiques du juge : une verte, cinq rouges, chacune pour sa raison
  const fx30 = f => fx(path.join("o30-etat-servi", f));
  const attendus30 = [
    ["rouge-sans-relecture.json", "bloquant", /n'a pas été RELU/],
    ["rouge-etat-change-en-200.json", "bloquant", /« passerelle\.mode » : "normal" au départ, "NO_EXTERNAL_AI" à la fin/],
    ["rouge-relecture-avant-la-fin.json", "bloquant", /précède la fin de la dernière épreuve/],
    ["rouge-corps-sans-champ.json", "majeur", /aucun champ comparé/],
    ["rouge-instance-muette-a-la-fin.json", "bloquant", /état de fin est illisible/],
  ];
  const vert30 = o30(fx30("verte.json"));
  ok(vert30.verdict === "PASS" && durs(vert30).length === 0, `O30 : verte.json (reprise jouée, uptime_s ignoré) -> PASS (obtenu ${vert30.verdict}, ${durs(vert30).length})`);
  for (const [f, sev, motif] of attendus30) {
    const r = o30(fx30(f));
    ok(r.verdict === "FAIL" && durs(r).length === 1 && durs(r)[0].sev === sev && motif.test(durs(r)[0].msg), `O30 : ${f} -> FAIL ${sev}, seul constat, pour la bonne raison (obtenu ${r.verdict}, ${durs(r).length})`);
  }
  ok(o30(path.join(tmp30, "absent.json")).verdict === "SKIP", "O30 borne : relevé introuvable -> SKIP");
  const illisible = path.join(tmp30, "illisible.json"); fs.writeFileSync(illisible, "{pas du json", "utf8");
  ok(o30(illisible).verdict === "FAIL", "O30 borne : relevé illisible -> FAIL, jamais PASS");
  const autreFormat = path.join(tmp30, "autre-format.json"); fs.writeFileSync(autreFormat, JSON.stringify({ format: "autre@1" }), "utf8");
  ok(o30(autreFormat).verdict === "FAIL", "O30 borne : format inconnu -> FAIL");
  // La comparaison elle-même
  ok(gab30.comparerEtats("OK", "OK").ecarts.length === 0 && gab30.comparerEtats("OK", "DEGRADE").ecarts.length === 1, "TF-2308 : un corps de santé en texte brut se compare tel quel");
  ok(gab30.comparerEtats({ a: { b: 1 } }, { a: { b: 1 } }, { champs: ["x.y"] }).compares === 0, "TF-2308 : un champ déclaré absent des deux côtés ne compte pas comme comparé");
  ok(lib30.jugerEtatServi(JSON.parse(fs.readFileSync(fx30("verte.json"), "utf8"))).constats.every(c => c.sev === "info"), "TF-2308 : le juge de la fixture verte ne rend que de l'information");
  fs.rmSync(tmp30, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  // Loi n° 1 : le gabarit, l'oracle et la règle sont appelés ; l'en-tête de l'oracle dit O30.
  const lire30 = f => fs.readFileSync(path.join(ici, "..", f), "utf8");
  ok(["README.md", "CLAUDE.md"].every(f => { const t = lire30(f); return t.includes("--etat-servi") && t.includes("smoke-mise-en-production.mjs") && t.includes("TF-2308") && t.includes("sante.chemin"); }), "TF-2308 : le gabarit, l'oracle et le chemin de santé configurable sont appelés par README.md et CLAUDE.md (loi n° 1)");
  ok(/O30 --etat-servi/.test(lire30("oracles/oracle-ops.mjs").split("import fs")[0]), "TF-2308 : la règle figure à l'en-tête d'oracle-ops.mjs, seule source de la liste des règles");
}

// ── TF-2312 (Produit-84, lot 20261109b, ledger seq 264) : L'APPLICATION TERRAFORM SONDE LA SANTÉ AVANT D'APPLIQUER ET RELANCE DE FAÇON BORNÉE ─
// Le fait : le 09/11/2026, la pose des limites d'Auth par `supabase_settings` a échoué sur « Project Services Unhealthy … unhealthy
// service realtime » (le fournisseur attend la santé de TOUS les services après chaque modification), puis passé à la relance
// 5 minutes plus tard ; sur le projet de qualification, realtime est UNHEALTHY de façon durable. Décision : l'application relance de
// façon bornée sur cette seule erreur et sonde la santé avant d'appliquer ; désactiver realtime reste au produit.
// Aucun appel à un fournisseur réel : Terraform est injecté (lib) ou joué sur une pile `terraform_data` (exercice à la demande),
// l'API de gestion est un faux serveur sur la boucle locale. Le texte exact de l'erreur n'est cité que par ses mots du ticket.
{
  console.log("");
  console.log("TF-2312 — application Terraform : sonde de santé avant, relance bornée sur l'erreur de santé\n");
  const lib31 = await import("../scripts/lib-application.mjs");
  const http31 = await import("node:http");
  const { spawn: spawn31 } = await import("node:child_process");
  const fx31 = f => fx(path.join("appliquer-terraform", f));
  const lire31 = f => fs.readFileSync(fx31(f), "utf8");
  const msgSante = lire31("erreur-sante.txt"), msgAutre = lire31("erreur-autre.txt");
  const REF = "abcdefghijklmnopqrst", JETON = "jeton-fictif-tf2312";
  const tmp31 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-tf2312-"));
  const BASE = "http://127.0.0.1:1";

  // Terraform injecté : une suite de réponses ({ status, stderr }), la dernière se répète ; chaque appel est gardé.
  const fauxTf = (suite) => { const appels = []; return { appels, lancer: a => { appels.push(a); const r = suite[Math.min(appels.length - 1, suite.length - 1)]; return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }; } }; };
  const OK = { status: 0 }, SANTE = { status: 1, stderr: msgSante }, AUTRE = { status: 1, stderr: msgAutre };
  // Une sonde qui rend, lecture après lecture, les corps de fixtures donnés (la dernière se répète).
  const fauxSonde = (corps) => { const lectures = []; const sonder = () => sonderAvec(corps[Math.min(lectures.length, corps.length - 1)], lectures); return { lectures, sonder }; };
  const sonderAvec = (c, lectures) => { lectures.push(c); return lib31.sonderSante({ projet: REF, jeton: JETON, base: BASE, appeler: async () => (typeof c === "string" ? { status: 200, corps: lire31(c) } : c) }); };
  const dormirFaux = () => { const ms = []; return { ms, dormir: async (x) => { ms.push(x); } }; };
  const SAINE = "sante-saine.json", MALSAIN = "sante-realtime-malsain.json", DEMARRE = "sante-realtime-demarre.json";

  // 1) Le message du fournisseur : reconnu, service nommé ; une autre erreur n'est pas une erreur de santé.
  ok(lib31.erreurDeSante({ stderr: msgSante }) && lib31.erreurDeSante({ stdout: "Error: Project Services Unhealthy" }) && lib31.erreurDeSante({ stderr: "unhealthy service auth" }), "TF-2312 : « Project Services Unhealthy » / « unhealthy service » reconnu, sur stderr comme sur stdout");
  ok(!lib31.erreurDeSante({ stderr: msgAutre }) && !lib31.erreurDeSante({ stderr: "" }) && !lib31.erreurDeSante({}), "TF-2312 ROUGE : une erreur de validation, une sortie vide -> pas une erreur de santé");
  ok(JSON.stringify(lib31.servicesDuMessage(msgSante)) === '["realtime"]' && lib31.servicesDuMessage("unhealthy services: realtime, auth.").join() === "realtime,auth" && lib31.servicesDuMessage(msgAutre).length === 0, "TF-2312 : le service malsain du message est nommé (realtime), plusieurs se lisent, aucun si le message n'en dit pas");

  // 2) La sonde : l'adresse, l'en-tête, les lectures.
  {
    const vues = [];
    const appeler = async (url, entetes) => { vues.push({ url, entetes }); return { status: 200, corps: lire31(SAINE) }; };
    const s = await lib31.sonderSante({ projet: REF, jeton: JETON, base: "https://api.exemple.test/", appeler });
    ok(s.etat === "sain" && s.services.length === 6, "TF-2312 sonde VERTE : six services ACTIVE_HEALTHY -> sain");
    ok(vues[0].url === `https://api.exemple.test/v1/projects/${REF}/health?services=auth&services=db&services=pooler&services=realtime&services=rest&services=storage`, `TF-2312 sonde : GET /v1/projects/<ref>/health?services=… sur l'API de gestion (obtenu ${vues[0].url})`);
    ok(vues[0].entetes.Authorization === `Bearer ${JETON}` && !JSON.stringify(s).includes(JETON), "TF-2312 sonde : le jeton part dans l'en-tête et ne figure dans aucun résultat");
    const m = await sonderAvec(MALSAIN, []);
    ok(m.etat === "malsain" && /realtime \(UNHEALTHY\)/.test(m.detail) && m.services.filter(x => !x.sain).length === 1, "TF-2312 sonde ROUGE : realtime UNHEALTHY (cas du projet de qualification) -> malsain, realtime nommé");
    const d = await sonderAvec(DEMARRE, []);
    ok(d.etat === "malsain" && /realtime \(COMING_UP\)/.test(d.detail), "TF-2312 sonde : COMING_UP n'est pas sain (le service démarre, la relecture dira)");
    const sansStatut = await lib31.sonderSante({ projet: REF, jeton: JETON, base: BASE, appeler: async () => ({ status: 200, corps: JSON.stringify(["auth", "db", "pooler", "realtime", "rest", "storage"].map(name => ({ name, healthy: name !== "db" }))) }) });
    ok(sansStatut.etat === "malsain" && /db/.test(sansStatut.detail), "TF-2312 sonde : sans champ « status », le booléen « healthy » fait foi");
    const refus = [
      ["HTTP 401", async () => ({ status: 401, corps: "{}" }), /HTTP 401/],
      ["tableau vide", async () => ({ status: 200, corps: "[]" }), /vide ou illisible/],
      ["corps non JSON", async () => ({ status: 200, corps: "<html>" }), /vide ou illisible/],
      ["service demandé absent", async () => ({ status: 200, corps: JSON.stringify([{ name: "auth", status: "ACTIVE_HEALTHY" }]) }), /absent\(s\) de la réponse/],
      ["API muette", async () => { throw new Error("ECONNREFUSED"); }, /ne répond pas/],
    ];
    for (const [nom, appelerR, motif] of refus) {
      const r = await lib31.sonderSante({ projet: REF, jeton: JETON, base: BASE, appeler: appelerR });
      ok(r.etat === "erreur" && motif.test(r.detail), `TF-2312 sonde borne : ${nom} -> erreur dite, jamais « sain » (obtenu ${r.etat})`);
    }
    let appele = false;
    const spy = async () => { appele = true; return { status: 200, corps: lire31(SAINE) }; };
    const sansJeton = await lib31.sonderSante({ projet: REF, jeton: "", base: BASE, appeler: spy });
    const mauvaisRef = await lib31.sonderSante({ projet: "../x?y=1", jeton: JETON, base: BASE, appeler: spy });
    const mauvaisSvc = await lib31.sonderSante({ projet: REF, jeton: JETON, base: BASE, services: ["auth&x=1"], appeler: spy });
    ok(sansJeton.etat === "erreur" && /SUPABASE_ACCESS_TOKEN/.test(sansJeton.detail) && mauvaisRef.etat === "erreur" && mauvaisSvc.etat === "erreur" && !appele, "TF-2312 sonde borne : jeton absent, référence ou service qui sort du gabarit d'adresse -> erreur avant tout appel");
  }

  // 3) L'attente bornée : N lectures au plus, espacées, qui s'arrêtent à la première lecture saine ou en erreur.
  {
    const a = fauxSonde([MALSAIN, DEMARRE, SAINE]); const d = dormirFaux();
    const r = await lib31.attendreSante({ sonder: a.sonder, lectures: 4, attenteMs: 7000, dormir: d.dormir });
    ok(r.etat === "sain" && r.lectures === 3 && d.ms.join() === "7000,7000", `TF-2312 attente : malsain, démarre, sain -> 3 lectures, 2 attentes de 7 s (obtenu ${r.lectures} lectures, ${d.ms.join()})`);
    const b = fauxSonde([MALSAIN]); const d2 = dormirFaux();
    const r2 = await lib31.attendreSante({ sonder: b.sonder, lectures: 4, attenteMs: 1, dormir: d2.dormir });
    ok(r2.etat === "malsain" && r2.lectures === 4 && b.lectures.length === 4, `TF-2312 attente ROUGE : realtime durablement UNHEALTHY -> la borne tient, 4 lectures puis malsain (obtenu ${r2.lectures})`);
    const c = fauxSonde([{ status: 500, corps: "" }, SAINE]); const d3 = dormirFaux();
    const r3 = await lib31.attendreSante({ sonder: c.sonder, lectures: 4, attenteMs: 1, dormir: d3.dormir });
    ok(r3.etat === "erreur" && r3.lectures === 1, "TF-2312 attente : une sonde en erreur interrompt à la première lecture, elle ne se rejoue pas jusqu'à obtenir « sain »");
  }

  // 4) L'application : avant (le défaut) puis après.
  {
    // AVANT : l'apply nu de la chaîne, sans relance ni sonde — une seule tentative, échec sur la santé.
    const nu = fauxTf([SANTE, OK]); const r0 = nu.lancer(["-chdir=pile", "apply", "-input=false", "-no-color", "-auto-approve"]);
    ok(r0.status === 1 && lib31.erreurDeSante(r0) && nu.appels.length === 1, "TF-2312 AVANT (état de départ) : l'apply nu échoue sur la santé et la chaîne s'arrête là, le relancer à la main fait passer");
    // a) vert au premier essai
    { const t = fauxTf([OK]), s = fauxSonde([SAINE]), d = dormirFaux();
      const r = await lib31.appliquer({ pile: "pile", lancer: t.lancer, sonder: s.sonder, relances: 3, attenteMs: 5, dormir: d.dormir });
      ok(r.verdict === "applique" && r.code === 0 && r.relances === 0 && t.appels.length === 1 && s.lectures.length === 1 && d.ms.length === 0, "TF-2312 vert : projet sain, apply au premier essai -> appliqué, une sonde, une application, aucune attente"); }
    // b) l'erreur de santé une fois, puis le succès : UNE relance
    { const t = fauxTf([SANTE, OK]), s = fauxSonde([SAINE]), d = dormirFaux();
      const r = await lib31.appliquer({ pile: "pile", lancer: t.lancer, sonder: s.sonder, relances: 3, attenteMs: 5, dormir: d.dormir });
      ok(r.verdict === "applique" && r.relances === 1 && t.appels.length === 2, `TF-2312 APRÈS : erreur de santé puis succès -> appliqué après 1 relance, 2 applications (obtenu ${r.relances} relance(s), ${t.appels.length} apply)`);
      ok(s.lectures.length === 2 && r.etapes.map(e => e.etape).join("|") === "sonde avant l'application|application, essai 1|sonde avant la relance 1|application, essai 2", "TF-2312 : la santé est RELUE entre l'échec et la relance (sonde, apply, sonde, apply)"); }
    // c) l'erreur de santé à chaque essai : la borne tient
    { const t = fauxTf([SANTE]), s = fauxSonde([SAINE]), d = dormirFaux();
      const r = await lib31.appliquer({ pile: "pile", lancer: t.lancer, sonder: s.sonder, relances: 3, attenteMs: 5, dormir: d.dormir });
      ok(r.verdict === "sante-persistante" && r.code === 1 && t.appels.length === 4 && /3 relance\(s\) permise\(s\)/.test(r.constat) && /realtime/.test(r.constat), `TF-2312 ROUGE : l'erreur de santé revient à chaque essai -> 1 + 3 applications puis exit 1 qui nomme realtime (obtenu ${t.appels.length} apply, ${r.verdict})`);
      const z = fauxTf([SANTE]); const rz = await lib31.appliquer({ pile: "pile", lancer: z.lancer, sonder: fauxSonde([SAINE]).sonder, relances: 0, attenteMs: 5, dormir: dormirFaux().dormir });
      ok(rz.verdict === "sante-persistante" && z.appels.length === 1, "TF-2312 borne : --relances 0 -> un seul essai, jamais de relance"); }
    // d) toute autre erreur : aucune relance
    { const t = fauxTf([AUTRE, OK]), s = fauxSonde([SAINE]), d = dormirFaux();
      const r = await lib31.appliquer({ pile: "pile", lancer: t.lancer, sonder: s.sonder, relances: 3, attenteMs: 5, dormir: d.dormir });
      ok(r.verdict === "erreur" && r.code === 2 && t.appels.length === 1 && d.ms.length === 0 && /n'est pas de santé, aucune relance/.test(r.etapes[r.etapes.length - 1].detail), `TF-2312 ROUGE : erreur de validation -> exit 2 au premier essai, aucune relance, aucune attente (obtenu ${t.appels.length} apply)`);
      const e127 = fauxTf([{ status: 127, stderr: "terraform : ENOENT" }, OK]);
      ok((await lib31.appliquer({ pile: "pile", lancer: e127.lancer, sonder: fauxSonde([SAINE]).sonder, relances: 3, attenteMs: 5, dormir: dormirFaux().dormir })).code === 2 && e127.appels.length === 1, "TF-2312 ROUGE : Terraform introuvable -> exit 2, pas de relance"); }
    // e) le projet de qualification : realtime UNHEALTHY durable -> rien n'est appliqué
    { const t = fauxTf([OK]), s = fauxSonde([MALSAIN]), d = dormirFaux();
      const r = await lib31.appliquer({ pile: "pile", lancer: t.lancer, sonder: s.sonder, relances: 2, attenteMs: 9, dormir: d.dormir });
      ok(r.verdict === "sante-refusee" && r.code === 1 && t.appels.length === 0 && s.lectures.length === 3 && d.ms.join() === "9,9", `TF-2312 ROUGE : realtime UNHEALTHY durable avant l'apply -> exit 1, AUCUN apply, 3 lectures puis refus (obtenu ${t.appels.length} apply, ${s.lectures.length} lectures)`);
      ok(/realtime/.test(r.constat) && /SA décision/.test(r.constat) && /la forge ne le fait pas/.test(r.constat), "TF-2312 : le constat nomme realtime et laisse au produit la décision de le désactiver"); }
    // f) le service revient pendant l'attente de la sonde d'ouverture
    { const t = fauxTf([OK]), s = fauxSonde([MALSAIN, DEMARRE, SAINE]), d = dormirFaux();
      const r = await lib31.appliquer({ pile: "pile", lancer: t.lancer, sonder: s.sonder, relances: 3, attenteMs: 5, dormir: d.dormir });
      ok(r.verdict === "applique" && s.lectures.length === 3 && t.appels.length === 1, "TF-2312 VERT : realtime malsain puis démarre puis sain pendant l'attente de la sonde -> l'apply part ensuite, une fois"); }
    // g) la sonde est en erreur : rien n'est appliqué, rien n'est deviné
    { const t = fauxTf([OK]), s = fauxSonde([{ status: 401, corps: "{}" }]);
      const r = await lib31.appliquer({ pile: "pile", lancer: t.lancer, sonder: s.sonder, relances: 3, attenteMs: 5, dormir: dormirFaux().dormir });
      ok(r.verdict === "erreur" && r.code === 2 && t.appels.length === 0 && /HTTP 401/.test(r.constat), "TF-2312 ROUGE : sonde refusée (HTTP 401) -> exit 2, aucun apply : on n'applique pas sur une santé qu'on ne sait pas lire"); }
    // h) la santé se dégrade entre deux essais et ne revient pas : pas de relance à l'aveugle
    { const t = fauxTf([SANTE, OK]), s = fauxSonde([SAINE, MALSAIN]);
      const r = await lib31.appliquer({ pile: "pile", lancer: t.lancer, sonder: s.sonder, relances: 1, attenteMs: 5, dormir: dormirFaux().dormir });
      ok(r.verdict === "sante-persistante" && t.appels.length === 1, "TF-2312 ROUGE : la santé relue après l'échec reste malsaine jusqu'à la borne -> pas de seconde application"); }
    // i) sans sonde : dit, et la relance attend sans lire
    { const t = fauxTf([SANTE, OK]), d = dormirFaux();
      const r = await lib31.appliquer({ pile: "pile", lancer: t.lancer, sonder: null, relances: 3, attenteMs: 4000, dormir: d.dormir });
      ok(r.verdict === "applique" && r.relances === 1 && d.ms.join() === "4000" && r.etapes[0].etat === "non-jouee" && /--sans-sonde/.test(r.etapes[0].detail), "TF-2312 : --sans-sonde -> la sonde non jouée est dite à l'étape 1, la relance attend sans la lire"); }
    // j) l'essai à blanc écrit les gestes
    { const g = lib31.gestesPrevus({ pile: "pile", projet: REF, relances: 3, attenteS: 120, services: lib31.SERVICES_PAR_DEFAUT }).join("\n");
      ok(/GET \/v1\/projects\/abcdefghijklmnopqrst\/health/.test(g) && /terraform -chdir=pile apply/.test(g) && /au plus 3/.test(g) && /rien n'est appliqué/.test(g), "TF-2312 plan-first : les gestes (sonde, apply, relances) sont écrits avec leurs bornes"); }
  }

  // 5) La ligne de commande : usages refusés, plan-first, API locale (jamais un fournisseur réel).
  {
    const cli = path.join(ici, "..", "scripts", "appliquer-terraform.mjs");
    const jouer = (a, env = {}) => new Promise((resolve) => {
      const p = spawn31(process.execPath, [cli, ...a], { env: { ...process.env, SUPABASE_ACCESS_TOKEN: JETON, ...env } });
      let out = ""; p.stdout.on("data", d => out += d); p.stderr.on("data", d => out += d);
      p.on("close", status => resolve({ status, out }));
    });
    const pile31 = path.join(tmp31, "pile"); fs.mkdirSync(pile31);
    const TF_ABSENT = path.join(tmp31, "terraform-absent");
    let reponse = SAINE, hits = 0;
    const serveur = http31.createServer((req, res) => {
      hits++;
      if (!req.url.startsWith(`/v1/projects/${REF}/health`) || req.headers.authorization !== `Bearer ${JETON}`) { res.writeHead(401); res.end("{}"); return; }
      res.writeHead(200, { "content-type": "application/json" }); res.end(lire31(reponse));
    });
    await new Promise(r => serveur.listen(0, "127.0.0.1", r));
    const API = `http://127.0.0.1:${serveur.address().port}`;
    try {
      const u1 = await jouer([]); const u2 = await jouer([pile31]); const u3 = await jouer([pile31, "--projet", REF, "--sans-sonde"]); const u4 = await jouer([path.join(tmp31, "nulle-part"), "--sans-sonde"]);
      ok(u1.status === 2 && /usage/.test(u1.out) && u2.status === 2 && /ni --projet/.test(u2.out) && u3.status === 2 && /se contredisent/.test(u3.out) && u4.status === 2 && /introuvable/.test(u4.out), "TF-2312 CLI : sans pile, sans choix de sonde, avec les deux, pile introuvable -> exit 2");
      const u5 = await jouer([pile31, "--sans-sonde", "--relances", "x"]); const u6 = await jouer([pile31, "--sans-sonde", "--relances", "11"]);
      ok(u5.status === 2 && u6.status === 2 && /borne est de 10/.test(u6.out), "TF-2312 CLI : --relances non entier ou au-delà de 10 -> exit 2");
      const u7 = await jouer([pile31, "--projet", REF, "--executer"], { FORGE_OPS_SUPABASE_API: "http://exemple.test" });
      ok(u7.status === 2 && /https/.test(u7.out), "TF-2312 CLI : une API de gestion en http hors boucle locale est refusée (le jeton ne part pas en clair)");
      const pf = await jouer([pile31, "--projet", REF], { FORGE_OPS_SUPABASE_API: API, FORGE_OPS_TERRAFORM: TF_ABSENT });
      ok(pf.status === 0 && /plan-first/.test(pf.out) && /GET \/v1\/projects/.test(pf.out) && hits === 0, `TF-2312 CLI plan-first : sans --executer, les gestes sont écrits, l'API n'est pas appelée (${hits} appel), Terraform non lancé`);
      // sonde malsaine : exit 1, rien appliqué (Terraform absent : s'il était lancé, ce serait exit 2)
      reponse = MALSAIN; hits = 0;
      const m = await jouer([pile31, "--projet", REF, "--executer", "--relances", "1", "--attente", "0"], { FORGE_OPS_SUPABASE_API: API, FORGE_OPS_TERRAFORM: TF_ABSENT });
      ok(m.status === 1 && /rien n'a été appliqué/.test(m.out) && /realtime/.test(m.out) && hits === 2 && !/terraform-absent/.test(m.out), `TF-2312 CLI ROUGE : realtime UNHEALTHY -> exit 1, rien appliqué, 2 lectures (relances 1 + 1), Terraform non lancé (obtenu exit ${m.status}, ${hits} lectures)`);
      ok(!m.out.includes(JETON), "TF-2312 CLI : le jeton n'apparaît jamais dans la sortie");
      // sonde saine, Terraform absent : l'apply est bien tenté (exit 2 qui nomme l'exécutable), sans relance
      reponse = SAINE;
      const s = await jouer([pile31, "--projet", REF, "--executer", "--attente", "0"], { FORGE_OPS_SUPABASE_API: API, FORGE_OPS_TERRAFORM: TF_ABSENT });
      ok(s.status === 2 && /terraform-absent/.test(s.out) && /aucune relance/.test(s.out), `TF-2312 CLI VERT : projet sain -> l'apply est tenté ; Terraform absent -> exit 2 qui le dit, sans relance (obtenu ${s.status})`);
      const j = await jouer([pile31, "--projet", REF, "--executer", "--attente", "0"], { FORGE_OPS_SUPABASE_API: API, FORGE_OPS_TERRAFORM: TF_ABSENT, SUPABASE_ACCESS_TOKEN: "mauvais" });
      ok(j.status === 2 && /HTTP 401/.test(j.out) && !/terraform-absent/.test(j.out), "TF-2312 CLI ROUGE : jeton refusé par l'API (401) -> exit 2, Terraform non lancé");
      const sj = await jouer([pile31, "--projet", REF, "--executer", "--attente", "0"], { FORGE_OPS_SUPABASE_API: API, FORGE_OPS_TERRAFORM: TF_ABSENT, SUPABASE_ACCESS_TOKEN: "" });
      ok(sj.status === 2 && /SUPABASE_ACCESS_TOKEN/.test(sj.out), "TF-2312 CLI ROUGE : jeton absent de l'environnement -> exit 2 qui nomme la variable");

      // L'exercice réel avec Terraform : à la demande, sur une pile terraform_data dont le provisionneur local échoue N fois avec l'erreur de santé.
      if (process.env.FORGE_OPS_EXERCICE_TERRAFORM === "1") {
        fs.writeFileSync(path.join(pile31, "main.tf"), 'resource "terraform_data" "reglages" {\n  provisioner "local-exec" {\n    command = "node ${path.module}/faux.mjs"\n  }\n}\n', "utf8");
        fs.writeFileSync(path.join(pile31, "faux.mjs"), [
          'import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";',
          'const d = path.dirname(fileURLToPath(import.meta.url)); const lire = (f, v) => { try { return fs.readFileSync(path.join(d, f), "utf8").trim(); } catch { return v; } };',
          'const n = Number(lire("compteur.txt", "0")) + 1; fs.writeFileSync(path.join(d, "compteur.txt"), String(n));',
          'const echecs = Number(lire("echecs.txt", "0")), genre = lire("genre.txt", "sante");',
          'if (n <= echecs) { process.stderr.write(fs.readFileSync(path.join(d, genre === "sante" ? "erreur-sante.txt" : "erreur-autre.txt"), "utf8")); process.exit(1); }', ""].join("\n"), "utf8");
        fs.copyFileSync(fx31("erreur-sante.txt"), path.join(pile31, "erreur-sante.txt")); fs.copyFileSync(fx31("erreur-autre.txt"), path.join(pile31, "erreur-autre.txt"));
        const tf = (...a) => spawnSync("terraform", [`-chdir=${pile31}`, ...a, "-input=false", "-no-color"], { encoding: "utf8", timeout: 600000 });
        const reinit = (echecs, genre = "sante") => { fs.rmSync(path.join(pile31, "terraform.tfstate"), { force: true }); fs.rmSync(path.join(pile31, "terraform.tfstate.backup"), { force: true }); fs.writeFileSync(path.join(pile31, "compteur.txt"), "0"); fs.writeFileSync(path.join(pile31, "echecs.txt"), String(echecs)); fs.writeFileSync(path.join(pile31, "genre.txt"), genre); };
        const compteur = () => Number(fs.readFileSync(path.join(pile31, "compteur.txt"), "utf8"));
        ok(tf("init").status === 0, "EXERCICE Terraform (TF-2312) : init de la pile terraform_data + local-exec");
        reinit(0);
        const nuAvant = (() => { reinit(1); const r = tf("apply", "-auto-approve"); return { status: r.status, sante: lib31.erreurDeSante(r), n: compteur() }; })();
        ok(nuAvant.status !== 0 && nuAvant.sante && nuAvant.n === 1, `EXERCICE Terraform AVANT : l'apply nu échoue avec l'erreur de santé, le message traverse le provisionneur (exit ${nuAvant.status}, ${nuAvant.n} essai)`);
        reinit(2);
        const v = await jouer([pile31, "--sans-sonde", "--executer", "--relances", "3", "--attente", "0"], { FORGE_OPS_SUPABASE_API: API });
        ok(v.status === 0 && compteur() === 3 && /après 2 relance\(s\)/.test(v.out), `EXERCICE Terraform APRÈS : 2 échecs de santé puis le succès -> exit 0 après 2 relances, 3 essais (exit ${v.status}, ${compteur()} essais)`);
        reinit(99);
        const p = await jouer([pile31, "--sans-sonde", "--executer", "--relances", "2", "--attente", "0"], {});
        ok(p.status === 1 && compteur() === 3 && /NON ABOUTIE/.test(p.out) && /realtime/.test(p.out), `EXERCICE Terraform ROUGE : l'erreur de santé ne passe jamais -> la borne tient, 1 + 2 essais, exit 1 qui nomme realtime (exit ${p.status}, ${compteur()} essais)`);
        reinit(99, "autre");
        const a = await jouer([pile31, "--sans-sonde", "--executer", "--relances", "3", "--attente", "0"], {});
        ok(a.status === 2 && compteur() === 1, `EXERCICE Terraform ROUGE : erreur de validation -> exit 2, un seul essai, aucune relance (exit ${a.status}, ${compteur()} essai)`);
        reinit(1); reponse = SAINE;
        const sonde = await jouer([pile31, "--projet", REF, "--executer", "--relances", "3", "--attente", "0"], { FORGE_OPS_SUPABASE_API: API });
        ok(sonde.status === 0 && compteur() === 2 && /sonde avant la relance 1/.test(sonde.out), `EXERCICE Terraform avec sonde : la santé est lue avant l'apply puis entre l'échec et la relance, exit 0 (exit ${sonde.status}, ${compteur()} essais)`);
      }
    } finally { serveur.closeAllConnections?.(); serveur.close(); fs.rmSync(tmp31, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }

  // Loi n° 1 : l'outil et la règle sont appelés depuis la documentation de la forge.
  const lireDoc31 = f => fs.readFileSync(path.join(ici, "..", f), "utf8");
  ok(["README.md", "CLAUDE.md"].every(f => { const t = lireDoc31(f); return t.includes("appliquer-terraform.mjs") && t.includes("TF-2312") && t.includes("--sans-sonde"); }), "TF-2312 : l'outil et la règle sont appelés par README.md et CLAUDE.md (loi n° 1)");
  ok(/appliquer-terraform\.mjs/.test(lireDoc31("references/GESTES-EXPLOITATION.md")) && /G-06/.test(lireDoc31("references/GESTES-EXPLOITATION.md")), "TF-2312 : le geste G-06 de GESTES-EXPLOITATION.md nomme l'outil");
}

// ── TF-2397 (suite de TF-2312, campagne du 12/11/2026) : UNE CHAÎNE QUI POSE supabase_settings PASSE PAR L'OUTIL, ET L'OUTIL ÉCRIT SON RELEVÉ ─
// Le fait : TF-2312 a livré appliquer-terraform.mjs ; une chaîne qui garde son `terraform apply` direct retombe sur « Project Services
// Unhealthy » (chaîne de dev du 09/11/2026), et rien dans la forge ne la voyait. Mesure de départ du 12/11/2026 : l'oracle lisait la
// chaîne comme une cible de release (O1 « COURANT absent ») et l'outil n'écrivait aucun relevé. Décision : l'outil écrit
// `forge-ops/application@1` (--sortie), la règle O-31 refuse l'apply direct et juge le relevé ; les statuts de santé sont rejoués sur
// la référence de l'API de gestion avant d'écrire la règle (fixture api-sante-statuts.json, lue le 12/11/2026).
// Aucun appel à un fournisseur réel : API de gestion simulée sur la boucle locale, Terraform injecté (ou joué sur une pile terraform_data
// avec FORGE_OPS_EXERCICE_TERRAFORM=1).
{
  console.log("");
  console.log("TF-2397 — O-31 : une chaîne qui pose supabase_settings passe par l'outil sondé, et l'outil écrit son relevé\n");
  const lib97 = await import("../scripts/lib-application.mjs");
  const http97 = await import("node:http");
  const { spawn: spawn97 } = await import("node:child_process");
  const F97 = fx("o31-application-terraform");
  const fx97 = f => fx(path.join("appliquer-terraform", f));
  const R97 = n => path.join(F97, "releves", n);
  const REF97 = "abcdefghijklmnopqrst", JETON97 = "jeton-fictif-tf2397";
  const tmp97 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-tf2397-"));
  const o31 = (args) => {
    const r = spawnSync(process.execPath, [oracle, "--application-terraform", ...args, "--json-only"], { encoding: "utf8" });
    let j; try { j = JSON.parse(r.stdout); } catch { j = { verdict: "ILLISIBLE", findings: [] }; }
    return { ...j, exit: r.status };
  };
  const durs97 = r => r.findings.filter(f => f.regle === "O31" && (f.sev === "bloquant" || f.sev === "majeur"));
  const infos97 = r => r.findings.filter(f => f.regle === "O31" && f.sev === "info");

  try {
    // 1) Les statuts de santé, rejoués sur la référence de l'API de gestion avant d'écrire la règle.
    const doc97 = JSON.parse(fs.readFileSync(fx97("api-sante-statuts.json"), "utf8"));
    ok(doc97.lue_le === "2026-11-12" && /v1-get-services-health/.test(doc97.source) && doc97.status.length === 3 && doc97.healthy.deprecated === true, "TF-2397 : l'extrait de la référence de l'API de gestion porte sa source, sa date de lecture (12/11/2026), trois statuts et le booléen déprécié");
    ok(doc97.status.every(s => lib97.etatService({ name: "auth", status: s }).sain === (s === "ACTIVE_HEALTHY")), "TF-2397 statuts : parmi COMING_UP, ACTIVE_HEALTHY et UNHEALTHY, seul ACTIVE_HEALTHY est sain");
    ok([...lib97.SERVICES_CONNUS].sort().join() === [...doc97.name].sort().join() && lib97.SERVICES_PAR_DEFAUT.every(s => doc97.name.includes(s)), "TF-2397 services : les services que l'outil connaît sont exactement ceux de la référence, et ses services par défaut y figurent");
    ok(lib97.etatService({ name: "db", status: "STATUT_INCONNU" }).sain === false && lib97.etatService({ name: "db", healthy: true }).sain === true && lib97.etatService({ name: "db", healthy: true, status: "UNHEALTHY" }).sain === false, "TF-2397 statuts : un statut hors référence n'est jamais lu sain ; le booléen déprécié ne sert que sans `status`, et ne l'emporte jamais sur lui");

    // 2) La chaîne : l'apply direct vers une pile qui pose supabase_settings est refusé, avec sa ligne et son remède.
    const rouges97 = [
      ["rouge-direct-workflow", /\.github\/workflows\/deploy\.yml:11 .*pile « infra » pose supabase_settings/],
      ["rouge-direct-chdir", /\.github\/workflows\/deploy\.yml:12 .*pile « infra » pose supabase_settings/],
      ["rouge-direct-script", /scripts\/deploy\.sh:4 .*pile « infra » pose supabase_settings/],
      ["rouge-direct-module", /\.github\/workflows\/deploy\.yml:10 .*pile « infra » pose supabase_settings/],
      ["rouge-direct-sans-chemin", /\.github\/workflows\/deploy\.yml:10 .*pile visée n'est pas lisible/],
    ];
    for (const [d, motif] of rouges97) {
      const r = o31([path.join(F97, d)]), dd = durs97(r);
      ok(r.verdict === "FAIL" && r.exit === 1 && dd.length === 1 && dd[0].sev === "bloquant" && motif.test(dd[0].msg) && /appliquer-terraform\.mjs/.test(dd[0].msg), `O31 ROUGE ${d} : l'apply direct -> FAIL bloquant, seul constat, avec fichier:ligne et la commande de l'outil (obtenu ${r.verdict}, ${dd.length} constat(s))`);
    }
    const dc97 = durs97(o31([path.join(F97, "rouge-direct-script")]));
    ok(dc97.length === 1 && !/commentaire/.test(dc97[0].msg) && dc97[0].msg.startsWith("scripts/deploy.sh:4 "), "O31 : le `terraform apply` d'un commentaire (ligne 3 du script) n'est pas compté, seule la ligne 4 l'est");
    const v97 = o31([path.join(F97, "verte")]);
    ok(v97.verdict === "PASS" && v97.exit === 0 && durs97(v97).length === 0, "O31 VERT : la chaîne qui appelle l'outil avec --executer --sortie -> PASS");
    const va97 = o31([path.join(F97, "verte-autre-pile")]);
    ok(va97.verdict === "PASS" && durs97(va97).length === 0 && infos97(va97).some(f => /infra-docker/.test(f.msg) && /hors de la règle/.test(f.msg)), "O31 VERT : l'apply direct vers une AUTRE pile (infra-docker, sans supabase_settings) est dit hors de la règle, pas refusé");
    const is97 = o31([path.join(F97, "info-sans-sonde")]);
    ok(is97.verdict === "PASS" && infos97(is97).some(f => /--sans-sonde est un choix écrit/.test(f.msg)), "O31 : --sans-sonde est un choix écrit, dit en information, jamais refusé");
    const so97 = o31([path.join(F97, "sans-objet")]);
    ok(so97.verdict === "SKIP" && so97.exit === 2 && infos97(so97).some(f => /sans objet/.test(f.msg)), "O31 : aucune pile ne pose supabase_settings (apply direct vers une pile de conteneurs) -> SKIP, sans objet");
    const os97 = o31([path.join(F97, "rouge-outil-sans-sortie")]), od97 = durs97(os97);
    ok(os97.verdict === "FAIL" && od97.length === 1 && od97[0].sev === "majeur" && /--sortie/.test(od97[0].msg), "O31 ROUGE : l'outil appelé avec --executer sans --sortie -> FAIL majeur : le relevé ne serait jamais écrit");

    // Le remède que le message propose est joué : la chaîne rouge, corrigée comme il le dit, passe.
    {
      const d = path.join(tmp97, "remede"); fs.cpSync(path.join(F97, "rouge-direct-workflow"), d, { recursive: true });
      const avant = o31([d]), msg = durs97(avant)[0]?.msg ?? "";
      const remede = /Remplacer par : (node .+? --sortie application\.json)/.exec(msg)?.[1] ?? "";
      const cmd = remede.replace("<FORGE_OPS>", "forge-ops").replace("<ref>", "${{ vars.SUPABASE_PROJECT_REF }}");
      const yml = path.join(d, ".github", "workflows", "deploy.yml");
      fs.writeFileSync(yml, fs.readFileSync(yml, "utf8").replace(/ *working-directory: infra\r?\n( *)run: terraform apply -auto-approve/, (m, sp) => `${sp}run: ${cmd}`), "utf8");
      const apres = o31([d]);
      ok(avant.verdict === "FAIL" && /^node forge-ops\/scripts\/appliquer-terraform\.mjs infra --projet / .test(cmd) && apres.verdict === "PASS" && durs97(apres).length === 0, `O31 REMÈDE joué : la commande du message remplace l'apply direct, la même chaîne passe de FAIL à PASS (« ${cmd.slice(0, 80)}… »)`);
    }
    // Un fichier de chaîne seul se juge avec sa racine.
    const fRouge = o31([path.join(F97, "rouge-direct-workflow", ".github", "workflows", "deploy.yml"), "--racine", path.join(F97, "rouge-direct-workflow")]);
    const fVert = o31([path.join(F97, "verte", ".github", "workflows", "deploy.yml"), "--racine", path.join(F97, "verte")]);
    ok(fRouge.verdict === "FAIL" && durs97(fRouge).length === 1 && fVert.verdict === "PASS", "O31 : un fichier de chaîne seul, avec --racine, se juge comme le dépôt entier (rouge FAIL, vert PASS)");

    // 3) Le relevé forge-ops/application@1.
    const relRouges97 = [
      ["rouge-sante-refusee.json", /le projet n'était pas sain avant l'apply et rien n'a été appliqué/],
      ["rouge-sante-persistante.json", /échoué sur la santé à chaque essai permis/],
      ["rouge-erreur.json", /autre erreur de Terraform, ou sonde en erreur/],
      ["rouge-applique-sur-sonde-malsaine.json", /une sonde a lu le projet non sain/],
      ["rouge-applique-sans-apply.json", /sans étape « application, essai N » en succès/],
      ["rouge-horodatage.json", /horodatage illisible/],
      ["rouge-format.json", /format inconnu « forge-ops\/application@0 »/],
      ["rouge-illisible.json", /JSON invalide/],
    ];
    for (const [n, motif] of relRouges97) {
      const r = o31(["--releve", R97(n)]);
      ok(r.verdict === "FAIL" && r.exit === 1 && durs97(r).some(f => f.sev === "bloquant" && motif.test(f.msg)), `O31 ROUGE relevé ${n} : FAIL bloquant (obtenu ${r.verdict}, ${durs97(r).length} constat(s))`);
    }
    const rv97 = o31(["--releve", R97("verte.json")]), rr97 = o31(["--releve", R97("verte-apres-relance.json")]), rs97 = o31(["--releve", R97("verte-sans-sonde.json")]);
    ok(rv97.verdict === "PASS" && durs97(rv97).length === 0, "O31 VERT relevé : apply abouti au premier essai, six services sains lus avant -> PASS");
    ok(rr97.verdict === "PASS" && infos97(rr97).some(f => /1 relance\(s\)/.test(f.msg)) && rs97.verdict === "PASS" && infos97(rs97).some(f => /--sans-sonde/.test(f.msg)), "O31 VERT relevé : appliquée après une relance (dite) et sans sonde (choix dit) -> PASS avec information");
    const mix1 = o31([path.join(F97, "verte"), "--releve", R97("verte.json")]);
    const mix2 = o31([path.join(F97, "rouge-direct-workflow"), "--releve", R97("verte.json")]);
    const mix3 = o31([path.join(F97, "verte"), "--releve", R97("rouge-sante-refusee.json")]);
    ok(mix1.verdict === "PASS" && mix2.verdict === "FAIL" && durs97(mix2).length === 1 && mix3.verdict === "FAIL", "O31 : chaîne et relevé se jugent ensemble — un relevé vert n'absout pas un apply direct, une chaîne verte n'absout pas un relevé refusé");

    // 4) Usage : rien à juger n'est un SKIP, un relevé donné qu'on ne trouve pas est un FAIL.
    const u1 = o31([]), u2 = o31([path.join(tmp97, "nulle-part")]), u3 = o31(["--releve", path.join(tmp97, "nulle-part.json")]), u4 = o31(["--releve"]);
    ok(u1.verdict === "SKIP" && u1.exit === 2 && u2.verdict === "SKIP" && u2.exit === 2, "O31 usage : ni chaîne ni relevé, ou chaîne introuvable -> SKIP (exit 2)");
    ok(u3.verdict === "FAIL" && u3.exit === 1 && u4.verdict === "FAIL" && u4.exit === 1, "O31 usage : un relevé donné introuvable ou sans chemin -> FAIL (un relevé qu'on ne trouve pas ne prouve rien)");

    // 5) L'outil écrit le relevé que la règle juge. D'abord par la bibliothèque, Terraform et la sonde injectés.
    const msgSante97 = fs.readFileSync(fx97("erreur-sante.txt"), "utf8"), msgAutre97 = fs.readFileSync(fx97("erreur-autre.txt"), "utf8");
    const corpsSain97 = fs.readFileSync(fx97("sante-saine.json"), "utf8"), corpsMalsain97 = fs.readFileSync(fx97("sante-realtime-malsain.json"), "utf8");
    const sonderSain97 = () => lib97.sonderSante({ projet: REF97, jeton: JETON97, base: "http://127.0.0.1:1", appeler: async () => ({ status: 200, corps: corpsSain97 }) });
    const tf97 = (suite) => { let n = 0; return () => { const r = suite[Math.min(n++, suite.length - 1)]; return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }; }; };
    const OK97 = { status: 0 }, SANTE97 = { status: 1, stderr: msgSante97 }, AUTRE97 = { status: 1, stderr: msgAutre97 };
    const releve97 = async (nom, { suite, sansSonde = false, relances = 3 }) => {
      const res = await lib97.appliquer({ pile: "infra", lancer: tf97(suite), sonder: sansSonde ? null : sonderSain97, relances, attenteMs: 0, dormir: async () => {} });
      const r = lib97.construireReleve({ pile: "infra", projet: REF97, sansSonde, res, debut: "2026-11-12T09:00:00.000Z", fin: "2026-11-12T09:01:00.000Z" });
      const f = path.join(tmp97, nom); fs.writeFileSync(f, `${JSON.stringify(r, null, 2)}\n`, "utf8");
      return { r, f, texte: JSON.stringify(r) };
    };
    {
      const a = await releve97("a.json", { suite: [OK97] }), oa = o31(["--releve", a.f]);
      ok(a.r.format === "forge-ops/application@1" && a.r.verdict === "applique" && a.r.code === 0 && a.r.sonde === "jouee" && a.r.derniere_sonde.services.length === 6 && oa.verdict === "PASS", "TF-2397 outil : l'apply abouti avec sonde écrit un relevé forge-ops/application@1 (verdict applique, six services lus) que O-31 juge PASS");
      const b = await releve97("b.json", { suite: [SANTE97, OK97] }), ob = o31(["--releve", b.f]);
      ok(b.r.relances === 1 && b.r.etapes.length === 4 && ob.verdict === "PASS" && infos97(ob).some(f => /1 relance/.test(f.msg)), "TF-2397 outil : une erreur de santé puis le succès -> relevé à 1 relance, quatre étapes (sonde, apply, sonde, apply), O-31 PASS avec la relance dite");
      const c = await releve97("c.json", { suite: [OK97], sansSonde: true }), oc = o31(["--releve", c.f]);
      ok(c.r.sonde === "non-jouee" && c.r.projet === null && c.r.derniere_sonde === null && oc.verdict === "PASS" && infos97(oc).some(f => /--sans-sonde/.test(f.msg)), "TF-2397 outil : --sans-sonde écrit un relevé « non-jouee », que O-31 accepte en le disant");
      const d = await releve97("d.json", { suite: [AUTRE97] }), od = o31(["--releve", d.f]);
      ok(d.r.verdict === "erreur" && d.r.code === 2 && od.verdict === "FAIL" && !/jwt_exp|supabase_settings\.projet/.test(d.texte) && /sortie de Terraform non conservée/.test(d.texte), "TF-2397 outil ROUGE : une erreur qui n'est pas de santé -> relevé « erreur », O-31 FAIL ; la sortie de Terraform (qui peut citer des valeurs de la pile) n'est pas conservée dans le relevé");
      const e = await releve97("e.json", { suite: [SANTE97], relances: 2 }), oe = o31(["--releve", e.f]);
      ok(e.r.verdict === "sante-persistante" && e.r.relances === 2 && oe.verdict === "FAIL", "TF-2397 outil ROUGE : l'erreur de santé à chaque essai -> relevé « sante-persistante », O-31 FAIL");
      ok(![a, b, c, d, e].some(x => x.texte.includes(JETON97)), "TF-2397 outil : le jeton ne figure dans aucun relevé");
    }

    // 6) Puis par la ligne de commande, contre une API de gestion simulée : --sortie, ses refus, ses relevés.
    const jouer97 = (a, env = {}) => new Promise((resolve) => {
      const p = spawn97(process.execPath, [path.join(ici, "..", "scripts", "appliquer-terraform.mjs"), ...a], { env: { ...process.env, SUPABASE_ACCESS_TOKEN: JETON97, ...env } });
      let out = ""; p.stdout.on("data", d => out += d); p.stderr.on("data", d => out += d);
      p.on("close", status => resolve({ status, out }));
    });
    const pile97 = path.join(tmp97, "pile"); fs.mkdirSync(pile97);
    const TF_ABSENT97 = path.join(tmp97, "terraform-absent");
    let corps97 = corpsSain97;
    const serveur97 = http97.createServer((req, res) => {
      if (!req.url.startsWith(`/v1/projects/${REF97}/health`) || req.headers.authorization !== `Bearer ${JETON97}`) { res.writeHead(401); res.end("{}"); return; }
      res.writeHead(200, { "content-type": "application/json" }); res.end(corps97);
    });
    await new Promise(r => serveur97.listen(0, "127.0.0.1", r));
    const API97 = `http://127.0.0.1:${serveur97.address().port}`;
    try {
      const sortie97 = path.join(tmp97, "application.json");
      const pf = await jouer97([pile97, "--projet", REF97, "--sortie", sortie97], { FORGE_OPS_SUPABASE_API: API97, FORGE_OPS_TERRAFORM: TF_ABSENT97 });
      ok(pf.status === 0 && /rien n'est écrit sans --executer/.test(pf.out) && !fs.existsSync(sortie97), "TF-2397 CLI plan-first : avec --sortie mais sans --executer, le geste est écrit et aucun relevé n'est écrit");
      const sv = await jouer97([pile97, "--sans-sonde", "--sortie"]);
      ok(sv.status === 2 && /--sortie attend le chemin/.test(sv.out), "TF-2397 CLI : --sortie sans chemin -> exit 2");
      const sd = await jouer97([pile97, "--sans-sonde", "--executer", "--sortie", path.join(tmp97, "nulle", "a.json")], { FORGE_OPS_TERRAFORM: TF_ABSENT97 });
      ok(sd.status === 2 && /n'existe pas, rien n'a été appliqué/.test(sd.out) && !/terraform-absent/.test(sd.out), "TF-2397 CLI ROUGE : dossier du relevé inexistant -> exit 2 AVANT l'apply (Terraform non lancé) : on n'applique pas sans pouvoir dire ce qui a été fait");
      corps97 = corpsMalsain97;
      const m = await jouer97([pile97, "--projet", REF97, "--executer", "--relances", "1", "--attente", "0", "--sortie", sortie97], { FORGE_OPS_SUPABASE_API: API97, FORGE_OPS_TERRAFORM: TF_ABSENT97 });
      const rm = fs.existsSync(sortie97) ? JSON.parse(fs.readFileSync(sortie97, "utf8")) : null;
      ok(m.status === 1 && rm && rm.format === "forge-ops/application@1" && rm.verdict === "sante-refusee" && rm.code === 1 && rm.executer === true && rm.projet === REF97 && rm.derniere_sonde.services.some(s => s.nom === "realtime" && s.statut === "UNHEALTHY" && !s.sain), `TF-2397 CLI : realtime UNHEALTHY -> exit 1 et relevé « sante-refusee » écrit, realtime UNHEALTHY dedans (obtenu exit ${m.status}, relevé ${rm ? rm.verdict : "absent"})`);
      const om = o31(["--releve", sortie97]);
      ok(om.verdict === "FAIL" && durs97(om).some(f => /n'était pas sain avant l'apply/.test(f.msg)) && !fs.readFileSync(sortie97, "utf8").includes(JETON97), "TF-2397 CLI -> O-31 : le relevé de l'outil refusé par la santé est jugé FAIL ; le jeton n'y figure pas");
      fs.rmSync(sortie97);
      const j = await jouer97([pile97, "--projet", REF97, "--executer", "--attente", "0", "--sortie", sortie97], { FORGE_OPS_SUPABASE_API: API97, FORGE_OPS_TERRAFORM: TF_ABSENT97, SUPABASE_ACCESS_TOKEN: "mauvais" });
      const rj = fs.existsSync(sortie97) ? JSON.parse(fs.readFileSync(sortie97, "utf8")) : null;
      ok(j.status === 2 && rj && rj.verdict === "erreur" && rj.code === 2 && o31(["--releve", sortie97]).verdict === "FAIL", "TF-2397 CLI ROUGE : jeton refusé (401) -> exit 2, relevé « erreur » écrit, O-31 FAIL");
      fs.rmSync(sortie97);
      corps97 = corpsSain97;
      const s = await jouer97([pile97, "--projet", REF97, "--executer", "--attente", "0", "--sortie", sortie97], { FORGE_OPS_SUPABASE_API: API97, FORGE_OPS_TERRAFORM: TF_ABSENT97 });
      const rs = fs.existsSync(sortie97) ? JSON.parse(fs.readFileSync(sortie97, "utf8")) : null;
      ok(s.status === 2 && rs && rs.verdict === "erreur" && rs.derniere_sonde.etat === "sain" && /terraform apply a échoué/.test(JSON.stringify(rs.etapes)), "TF-2397 CLI : santé saine puis Terraform absent -> exit 2, relevé « erreur » qui garde la sonde saine et l'échec de l'apply");
      fs.rmSync(sortie97);

      // L'exercice réel : Terraform joue une pile terraform_data, le relevé de l'outil est jugé par l'oracle.
      if (process.env.FORGE_OPS_EXERCICE_TERRAFORM === "1") {
        const reel = path.join(tmp97, "pile-reelle"); fs.mkdirSync(reel);
        fs.writeFileSync(path.join(reel, "main.tf"), 'resource "terraform_data" "reglages" {\n  input = "exemple"\n}\n', "utf8");
        const init = spawnSync("terraform", [`-chdir=${reel}`, "init", "-input=false", "-no-color"], { encoding: "utf8", timeout: 600000 });
        ok(init.status === 0, "EXERCICE Terraform (TF-2397) : init de la pile terraform_data");
        const avecSonde = await jouer97([reel, "--projet", REF97, "--executer", "--attente", "0", "--sortie", sortie97], { FORGE_OPS_SUPABASE_API: API97 });
        const rr = fs.existsSync(sortie97) ? JSON.parse(fs.readFileSync(sortie97, "utf8")) : null;
        ok(avecSonde.status === 0 && rr?.verdict === "applique" && rr?.sonde === "jouee" && o31(["--releve", sortie97]).verdict === "PASS", `EXERCICE Terraform APRÈS : l'outil applique réellement, sonde saine lue avant, relevé « applique » jugé PASS par O-31 (exit ${avecSonde.status})`);
        fs.rmSync(sortie97, { force: true });
        const sans = await jouer97([reel, "--sans-sonde", "--executer", "--attente", "0", "--sortie", sortie97], {});
        ok(sans.status === 0 && o31(["--releve", sortie97]).verdict === "PASS", "EXERCICE Terraform : --sans-sonde applique réellement, relevé « non-jouee » jugé PASS avec information");
      }
    } finally { serveur97.closeAllConnections?.(); serveur97.close(); }
  } finally { fs.rmSync(tmp97, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }

  // Loi n° 1 : la règle, l'option et le relevé sont appelés depuis la documentation de la forge.
  const lireDoc97 = f => fs.readFileSync(path.join(ici, "..", f), "utf8");
  ok(["README.md", "CLAUDE.md"].every(f => { const t = lireDoc97(f); return t.includes("O31") || t.includes("O-31") ? t.includes("--application-terraform") && t.includes("forge-ops/application@1") && t.includes("--sortie") && t.includes("TF-2397") : false; }), "TF-2397 : la règle O-31, --application-terraform, le relevé forge-ops/application@1 et --sortie sont appelés par README.md et CLAUDE.md (loi n° 1)");
  ok(/TF-2397/.test(lireDoc97("references/GESTES-EXPLOITATION.md")) && /--sortie/.test(lireDoc97("references/GESTES-EXPLOITATION.md")), "TF-2397 : le geste G-06 de GESTES-EXPLOITATION.md nomme --sortie et la règle");
}

// ── TF-2412 (Produit-84, lot 20261110a, ledger seq 278) : UNE COPIE pg_dump SE RESTAURE SANS LES PRIVILÈGES PAR DÉFAUT DE supabase_admin ─
// Le fait : `pg_restore --clean --single-transaction` d'une copie échouait sur « permission denied to change default privileges », la
// copie portant les entrées DEFAULT ACL de supabase_admin que postgres ne peut pas rejouer ; le sommaire filtré (--list puis --use-list)
// a rendu une restauration conforme en 52 s. Décision R-58 du 10/11/2026 : le gabarit de restauration filtre ces entrées, et le garde-fou
// de plateforme entre au registre de la forge (G-07). La forge ne restaure rien : le gabarit écrit la liste filtrée et refuse celle qui garde
// une entrée refusée ; le sommaire de la fixture suit la forme de `pg_restore --list` (pg_restore absent du poste de la campagne, dit en G-07).
{
  console.log("");
  const gab12 = path.join(ici, "..", "gabarits", "restauration-supabase.mjs");
  const lib12 = await import("../gabarits/restauration-supabase.mjs");
  const fx12 = f => path.join(fx("restauration-supabase"), f);
  const tmp12 = fs.mkdtempSync(path.join(tmpdir(), "forge-ops-tf2412-"));
  const cli12 = (...a) => { const r = spawnSync(process.execPath, [gab12, ...a], { encoding: "utf8" }); return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), stdout: r.stdout || "" }; };
  const lire12 = f => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  try {
    const sommaire = fx12("sommaire-copie.txt");
    const texte12 = lire12(sommaire);

    // ROUGE : le sommaire d'une copie, tel que pg_restore --list l'écrit, porte 3 entrées que postgres ne peut pas rejouer.
    const rouge = cli12("verifier", sommaire);
    ok(rouge.status === 1 && ["5105", "5106", "5107"].every(id => rouge.out.includes(`« ${id};`)) && /ÉCHEC/.test(rouge.out),
      "TF-2412 ROUGE : le sommaire non filtré d'une copie -> `verifier` exit 1, les 3 entrées DEFAULT ACL de supabase_admin nommées");
    ok(!/« (5104|5120|4292|4302);/.test(rouge.out),
      "TF-2412 ROUGE précis : le privilège par défaut de postgres, l'ACL d'une table et les objets que supabase_admin possède ne sont PAS refusés");

    // VERT : la liste filtrée attendue est conforme, et le remède (liste puis verifier) la rend à l'identique.
    const attendue = fx12("liste-filtree-attendue.txt");
    ok(cli12("verifier", attendue).status === 0 && /PASS/.test(cli12("verifier", attendue).out),
      "TF-2412 VERT : la liste filtrée attendue passe `verifier` (exit 0)");
    const sortie12 = path.join(tmp12, "liste-filtree.txt");
    const liste = cli12("liste", sommaire, "--sortie", sortie12);
    ok(liste.status === 0 && /3 entrée\(s\) DEFAULT ACL retirée\(s\) sur 14 : 5105 \(supabase_admin\), 5106 \(supabase_admin\), 5107 \(supabase_admin\)/.test(liste.out),
      `TF-2412 : \`liste\` nomme les 3 entrées retirées sur 14 (obtenu : ${liste.out.trim().slice(0, 160)})`);
    ok(fs.existsSync(sortie12) && lire12(sortie12) === lire12(attendue),
      "TF-2412 : la liste écrite est celle de la fixture verte, ligne pour ligne");
    const rem = cli12("verifier", sortie12);
    ok(rem.status === 0 && /PASS : aucune entrée DEFAULT ACL de supabase_admin sur 11 entrées/.test(rem.out),
      "TF-2412 remède JOUÉ (TF-1013) : la liste que `liste` écrit passe `verifier`, 11 entrées actives (14 - 3)");

    // Chirurgie : seules les 3 lignes refusées changent, chacune préfixée d'un « ; » ; le reste est identique à l'octet près.
    const avant = texte12.split("\n"), apres = lire12(sortie12).split("\n");
    const diff = avant.map((l, i) => [l, apres[i]]).filter(([a, b]) => a !== b);
    ok(avant.length === apres.length && diff.length === 3 && diff.every(([a, b]) => b === `;${a}` && /DEFAULT ACL .* supabase_admin$/.test(a)),
      "TF-2412 : seules les 3 lignes DEFAULT ACL de supabase_admin changent (préfixe « ; »), le reste est identique");

    // Fins de ligne : un sommaire écrit en CRLF reste en CRLF, sans ligne LF isolée.
    const crlf = lib12.filtrerSommaire(texte12.replace(/\n/g, "\r\n"));
    ok(crlf.retirees.length === 3 && !/[^\r]\n/.test(crlf.texte) && crlf.texte.split("\r\n").length === avant.length,
      "TF-2412 : un sommaire en CRLF est filtré sans mélanger les fins de ligne");

    // Un texte qui n'est pas un sommaire n'est jamais un PASS.
    const vide = fx12("sommaire-vide.txt");
    const v1 = cli12("verifier", vide), v2 = cli12("liste", vide, "--sortie", path.join(tmp12, "x.txt"));
    ok(v1.status === 2 && v2.status === 2 && /aucune entrée numérotée/.test(v1.out) && !fs.existsSync(path.join(tmp12, "x.txt")),
      "TF-2412 ROUGE : un texte sans entrée (sommaire vide) -> exit 2 des deux verbes, aucune liste écrite");
    ok(cli12("verifier", path.join(tmp12, "absent.txt")).status === 2 && cli12("liste", sommaire, "--inconnue").status === 2 && cli12("verifier").status === 2,
      "TF-2412 : fichier absent, option inconnue et fichier non donné -> exit 2");

    // Un autre rôle ne se retire que s'il est nommé : seul supabase_admin a été mesuré.
    const autre = path.join(tmp12, "autre-role.txt");
    fs.writeFileSync(autre, lire12(attendue) + "5108; 826 16604 DEFAULT ACL auth DEFAULT PRIVILEGES FOR TABLES supabase_auth_admin\n", "utf8");
    ok(cli12("verifier", attendue).status === 0 && cli12("verifier", autre).status === 0 && cli12("verifier", autre, "--role", "supabase_auth_admin").status === 1,
      "TF-2412 : un rôle non mesuré n'est refusé que par `--role` (sans lui exit 0, avec lui exit 1)");
    const filtre = lib12.filtrerSommaire(texte12 + "5108; 826 16604 DEFAULT ACL auth DEFAULT PRIVILEGES FOR TABLES supabase_auth_admin\n", [...lib12.ROLES_DEFAUT, "supabase_auth_admin"]);
    ok(filtre.retirees.length === 4 && lib12.verifierListe(filtre.texte, [...lib12.ROLES_DEFAUT, "supabase_auth_admin"]).conforme,
      "TF-2412 : `--role` retire aussi le rôle nommé (4 entrées) et la liste passe");
    ok(lib12.verifierListe(texte12).conforme === false && lib12.verifierListe(lib12.filtrerSommaire(texte12).texte).conforme === true,
      "TF-2412 : verifierListe (bibliothèque) est rouge sur le sommaire, verte sur sa liste filtrée");

    // Les commandes, dans l'ordre : sommaire, filtre, vérification, restauration par la liste ; rien d'exécuté, aucun secret.
    const plan12 = cli12("plan", "copie.dump");
    const cmds = plan12.stdout.trim().split("\n");
    const pos = m => cmds.findIndex(c => c.includes(m));
    ok(plan12.status === 0 && cmds.length === 4 && pos("pg_restore --list copie.dump") === 0 && pos(" liste sommaire.txt") === 1 && pos(" verifier liste-filtree.txt") === 2
        && pos("--use-list liste-filtree.txt") === 3 && /--clean --single-transaction/.test(cmds[3]),
      "TF-2412 plan : sommaire, filtre, vérification, restauration par la liste — dans cet ordre, avec les options mesurées");
    ok(/--dbname "\$SUPABASE_DB_URL"/.test(cmds[3]) && !/postgres(ql)?:\/\//i.test(plan12.stdout) && /GO humain \(R-38\)/.test(cmds[3]),
      "TF-2412 plan : la connexion vient de l'environnement du run (aucune chaîne de connexion écrite), la restauration est dite sous GO humain");
    ok(/<COPIE_PG_DUMP>/.test(cli12("plan").stdout), "TF-2412 plan : sans copie nommée, le jeton <COPIE_PG_DUMP> reste à remplir");

    // Le plan supabase de la forge porte le geste (loi n° 1 : le gabarit est appelé), et le jeton est déclaré.
    const planSup = JSON.parse(run(ops, ["plan", "supabase", "<BUILD>"]));
    const ligne12 = planSup.phases.rollback.find(l => l.includes("restauration-supabase.mjs"));
    ok(ligne12 && /--use-list/.test(ligne12) && /permission denied to change default privileges/.test(ligne12) && /G-07/.test(ligne12) && /GO humain \(R-38\)/.test(ligne12)
        && planSup.placeholders.includes("<COPIE_PG_DUMP>") && jetonsNonDeclares(planSup).length === 0,
      "TF-2412 : le plan supabase (rollback) cite le gabarit, l'erreur, G-07 et le GO humain ; <COPIE_PG_DUMP> est déclaré");
    ok(planSup.phases.rollback.indexOf(ligne12) < planSup.phases.rollback.findIndex(l => l.startsWith("DERNIER RECOURS")),
      "TF-2412 : la restauration d'une copie précède le DERNIER RECOURS (geste humain irréversible) dans le retour arrière");

    // Loi n° 1 : le garde-fou est au registre des gestes et appelé depuis la documentation de la forge.
    const lireDoc12 = f => fs.readFileSync(path.join(ici, "..", f), "utf8");
    const g07 = lireDoc12("references/GESTES-EXPLOITATION.md");
    ok(/## G-07 ·/.test(g07) && g07.includes("restauration-supabase.mjs") && g07.includes("SUPABASE_DB_URL") && g07.includes("42786008105") && /TF-2412/.test(g07)
        && ["CLAUDE.md", "README.md"].every(f => lireDoc12(f).includes("restauration-supabase.mjs") && lireDoc12(f).includes("TF-2412")),
      "TF-2412 : le garde-fou est inscrit au registre (G-07, avec ses exécutions et sa variable) et appelé par CLAUDE.md et README.md");
  } finally { fs.rmSync(tmp12, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

console.log(`\nSelf-test forge-ops : ${pass} PASS, ${echec} FAIL`);
process.exit(echec ? 1 : 0);

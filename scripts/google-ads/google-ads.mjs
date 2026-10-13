#!/usr/bin/env node
/**
 * google-ads.mjs — le kit Google Ads de forge-ops : déployer des campagnes par l'import web, puis
 * relever le compte en lecture seule (TF-1364, décision humaine D-69 (a) du 13/10/2026).
 *
 * Ce script ne parle JAMAIS à Google : il génère des fichiers que l'exploitant dépose, et juge des
 * relevés que `collecter-compte.py` pose en lecture seule. Le dépôt, l'activation et toute dépense
 * restent des gestes de l'exploitant, sur l'aperçu de Google (Outils → Actions groupées →
 * Importations → Aperçu → Appliquer). Mode d'emploi : `scripts/google-ads/README.md`.
 *
 *   node scripts/google-ads/google-ads.mjs import-web --plan <plan.json> --modeles <dossier> --depart AAAA-MM-JJ --sortie <f.csv> [--site <dossier>]
 *   node scripts/google-ads/google-ads.mjs releve     --plan <plan.json> --compte <releve.json>
 *   node scripts/google-ads/google-ads.mjs delta      --plan <plan.json> --compte <releve.json> --modeles <dossier> --sortie <f.csv>
 *   node scripts/google-ads/google-ads.mjs avant-depense --liste <liste.json>
 *   node scripts/google-ads/google-ads.mjs controler-collecteur [<collecteur.py>]
 *   node scripts/google-ads/google-ads.mjs --self-test
 * Option commune : --json (sortie machine). Option de recette : --aujourdhui AAAA-MM-JJ.
 *
 * Codes de sortie :
 *   import-web     0 écrit · 1 refus d'écrire (défauts nommés, aucun fichier) · 2 usage, plan ou modèles illisibles
 *   releve         0 conforme et diffusion constatée ou pas encore jugeable · 1 écart(s) au plan ou à la diffusion · 2 relevé illisible ou fenêtre qui exclut aujourd'hui
 *   delta          0 écrit, ou aucun changement · 2 usage ou relevé illisible · 4 schéma refusé (rien n'est écrit)
 *   avant-depense  0 liste complète · 1 élément manquant · 2 liste illisible
 *   controler-collecteur 0 lecture seule et fenêtre bornée · 1 défaut · 2 fichier illisible
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  VERSION, ICI, lireRegles, lireModeles, lireModele, genererImportWeb, ecrireCsv, lireCsv, validerPlan,
  validerReleve, comparerAuPlan, controlerDiffusion, rendreReleve, calculerChangements,
  verifierAvantDepense, controlerCollecteur, dateLocale,
} from "./lib-google-ads.mjs";

const NON_JUGE = [
  "l'acceptation réelle du fichier par Google : seul l'aperçu de l'écran Importations la donne",
  "l'état réel d'un compte : le kit juge le relevé que le collecteur a posé, pas le compte",
  "les prérequis hors API (validation de l'annonceur, paiement, codes, notifications, limite temporaire de dépenses) : constatés par l'exploitant, à l'écran",
  "la cause d'une diffusion nulle : le relevé la mesure, il ne la diagnostique pas",
];

const arg = (args, nom) => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : undefined; };
const lireJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const sortir = (code, json, objet, texte) => {
  if (json) console.log(JSON.stringify({ outil: "google-ads", version: VERSION, ...objet, non_juge: NON_JUGE }, null, 1));
  else if (texte) console.log(texte);
  process.exit(code);
};

function cmdImportWeb(args, json) {
  const regles = lireRegles();
  const [plan, dossier, sortie] = [arg(args, "--plan"), arg(args, "--modeles"), arg(args, "--sortie")];
  if (!plan || !dossier || !sortie) sortir(2, json, { verdict: "USAGE" }, "usage : import-web --plan <plan.json> --modeles <dossier> --depart AAAA-MM-JJ --sortie <f.csv> [--site <dossier>]");
  let p; try { p = lireJson(plan); } catch (e) { sortir(2, json, { verdict: "ILLISIBLE", motif: e.message }, `plan illisible : ${e.message}`); }
  const { parType, defauts: dm } = lireModeles(dossier, regles.import_web.modeles_attendus.valeur);
  if (dm.length) sortir(2, json, { verdict: "MODELES_ABSENTS", defauts: dm }, `MODÈLES INCOMPLETS — demander à l'exploitant les modèles de l'écran Importations AVANT de générer :\n${dm.map((d) => `  · ${d}`).join("\n")}`);
  const r = genererImportWeb(p, parType, { depart: arg(args, "--depart"), aujourdhui: arg(args, "--aujourdhui") || dateLocale(), site: arg(args, "--site") || null, regles });
  if (r.defauts.length) sortir(1, json, { verdict: "REFUS", defauts: r.defauts, non_juge_local: r.nonJuge }, `REFUS D'ÉCRIRE — ${r.defauts.length} défaut(s) :\n${r.defauts.map((d) => `  · ${d}`).join("\n")}`);
  mkdirSync(path.dirname(path.resolve(sortie)), { recursive: true });
  writeFileSync(sortie, ecrireCsv(r.colonnes, r.lignes), "utf8");
  const b = r.bilan;
  sortir(0, json, { verdict: "ECRIT", sortie, bilan: b, lignes: r.lignes.length, non_juge_local: r.nonJuge },
    [`écrit : ${sortie}`,
      `  ${r.colonnes.length} colonnes, chacune déclarée par le modèle de son type de ligne ; valeurs et colonnes obligatoires confrontées aux modèles`,
      `  ${b.campagnes} campagnes · ${b.groupes} groupes · ${b.mots} mots-clés · ${b.exclusions} exclusions · ${b.annonces} annonces · ${r.lignes.length} lignes`,
      `  budget ${b.budget_mensuel} €/mois · départ ${arg(args, "--depart")} · toutes EN PAUSE : l'activation reste un geste de l'exploitant`,
      ...r.nonJuge.map((n) => `  (non jugé) ${n}`),
      "  Après l'import : relever le compte (collecter-compte.py puis releve) — l'option de zone et les conversions héritées ne se règlent pas par l'import."].join("\n"));
}

function chargerPlanEtReleve(args, json) {
  const regles = lireRegles();
  const [plan, compte] = [arg(args, "--plan"), arg(args, "--compte")];
  if (!plan || !compte) sortir(2, json, { verdict: "USAGE" }, "usage : --plan <plan.json> --compte <releve.json>");
  let p, r;
  try { p = lireJson(plan); r = lireJson(compte); } catch (e) { sortir(2, json, { verdict: "ILLISIBLE", motif: e.message }, `fichier illisible : ${e.message}`); }
  const dp = validerPlan(p);
  if (dp.length) sortir(2, json, { verdict: "PLAN_INVALIDE", defauts: dp }, `PLAN INVALIDE :\n${dp.map((d) => `  · ${d}`).join("\n")}`);
  const dr = validerReleve(r, regles);
  if (dr.length) sortir(2, json, { verdict: "RELEVE_NON_JUGEABLE", defauts: dr }, `RELEVÉ NON JUGEABLE :\n${dr.map((d) => `  · ${d}`).join("\n")}`);
  return { p, r, regles };
}

function cmdReleve(args, json) {
  const { p, r, regles } = chargerPlanEtReleve(args, json);
  const conf = comparerAuPlan(r, p, regles);
  const diff = controlerDiffusion(r, regles);
  const ko = conf.ecarts.length + diff.ecarts.length;
  sortir(ko ? 1 : 0, json, { verdict: ko ? "ECARTS" : "CONFORME", conformite: conf, diffusion: diff }, rendreReleve(r, conf, diff, regles));
}

function cmdDelta(args, json) {
  const { p, r, regles } = chargerPlanEtReleve(args, json);
  const [dossier, sortie] = [arg(args, "--modeles"), arg(args, "--sortie")];
  if (!dossier || !sortie) sortir(2, json, { verdict: "USAGE" }, "usage : delta --plan <plan.json> --compte <releve.json> --modeles <dossier> --sortie <f.csv>");
  const { parType, defauts: dm } = lireModeles(dossier, ["keyword_template.csv", "ad_group_negative_keyword_template.csv"]);
  if (dm.length) sortir(4, json, { verdict: "SCHEMA_REFUSE", defauts: dm }, `REFUS D'ÉCRIRE — modèles :\n${dm.map((d) => `  · ${d}`).join("\n")}`);
  const c = calculerChangements(p, r, parType, regles);
  if (c.defauts.length) sortir(4, json, { verdict: "SCHEMA_REFUSE", defauts: c.defauts }, `REFUS D'ÉCRIRE — ${c.defauts.length} défaut(s) :\n${c.defauts.map((d) => `  · ${d}`).join("\n")}`);
  if (!c.lignes.length) sortir(0, json, { verdict: "AUCUN_CHANGEMENT", lignes: 0 }, "Aucun changement : le compte porte déjà le plan (mots-clés et exclusions).");
  mkdirSync(path.dirname(path.resolve(sortie)), { recursive: true });
  writeFileSync(sortie, ecrireCsv(c.colonnes, c.lignes), "utf8");
  sortir(0, json, { verdict: "ECRIT", sortie, lignes: c.lignes.length },
    [`écrit : ${sortie} — ${c.lignes.length} ligne(s), colonnes déclarées par les modèles`,
      ...c.lignes.map((l) => `  ${l.Action.padEnd(6)} ${l["Row Type"].padEnd(16)} ${l.Campaign} / ${l["Ad group"] || "—"} : ${l.Keyword || l["Negative keyword"]} (${l.Type})`),
      "  À déposer par l'exploitant : Outils → Actions groupées → Importations → Aperçu → Appliquer."].join("\n"));
}

function cmdAvantDepense(args, json) {
  const f = arg(args, "--liste");
  if (!f) sortir(2, json, { verdict: "USAGE" }, "usage : avant-depense --liste <liste.json>");
  let l; try { l = lireJson(f); } catch (e) { sortir(2, json, { verdict: "ILLISIBLE", motif: e.message }, `liste illisible : ${e.message}`); }
  const r = verifierAvantDepense(l, { aujourdhui: arg(args, "--aujourdhui") || dateLocale() });
  if (r.illisible) sortir(2, json, { verdict: "ILLISIBLE", manques: r.manques }, `liste illisible : ${r.manques.join(" ; ")}`);
  sortir(r.manques.length ? 1 : 0, json, { verdict: r.manques.length ? "INCOMPLETE" : "COMPLETE", manques: r.manques },
    r.manques.length ? `AVANT LA PREMIÈRE DÉPENSE — ${r.manques.length} manque(s), ne pas activer :\n${r.manques.map((m) => `  · ${m}`).join("\n")}`
      : "Avant la première dépense : liste complète, chaque élément constaté à l'écran et daté.");
}

function cmdControlerCollecteur(args, json) {
  const f = args.find((a) => !a.startsWith("--") && a !== "controler-collecteur") || path.join(ICI, "collecter-compte.py");
  let s; try { s = readFileSync(f, "utf8"); } catch (e) { sortir(2, json, { verdict: "ILLISIBLE", motif: e.message }, `collecteur illisible : ${e.message}`); }
  const d = controlerCollecteur(s);
  sortir(d.length ? 1 : 0, json, { verdict: d.length ? "FAIL" : "PASS", artefact: f, findings: d },
    d.length ? `COLLECTEUR REFUSÉ (${f}) :\n${d.map((x) => `  · ${x}`).join("\n")}` : `collecteur ${f} : lecture seule, fenêtre bornée à aujourd'hui compris`);
}

// ————————————————————————————————————————————————————————————————— recette, sans réseau
function recette() {
  const FIX = path.resolve(ICI, "..", "..", "fixtures", "google-ads");
  const regles = lireRegles();
  const plan = lireJson(path.join(FIX, "plan-factice.json"));
  const MODELES = path.join(FIX, "modeles");
  const SITE = path.join(FIX, "site");
  const AUJ = "2026-10-12";
  const { parType: modeles } = lireModeles(MODELES, regles.import_web.modeles_attendus.valeur);
  const copie = (o) => JSON.parse(JSON.stringify(o));
  let pass = 0; const echecs = [];
  const cas = (cond, libelle) => { if (cond) { pass++; console.log(`  [PASS] ${libelle}`); } else { echecs.push(libelle); console.log(`  [FAIL] ${libelle}`); } };
  const tmp = mkdtempSync(path.join(tmpdir(), "forge-ops-google-ads-"));
  const moi = fileURLToPath(import.meta.url);
  const lancer = (...a) => spawnSync(process.execPath, [moi, ...a], { encoding: "utf8" });
  try {
    console.log("Générateur de l'import web — confronté aux modèles");
    cas(Object.keys(modeles).length === 5 && modeles["Ad"].colonnes[0] === "Row Type", "les 5 modèles se lisent, commentaires de tête compris (modèle d'annonce)");
    cas(modeles["Campaign"].requisCreation.has("EU political ads") && modeles["Campaign"].vocab["Campaign type"].add.includes("Search"),
      "colonnes obligatoires et vocabulaires LUS dans le modèle, pas recopiés");
    const vert = genererImportWeb(plan, modeles, { depart: "2026-10-20", aujourdhui: AUJ, site: SITE, regles });
    cas(vert.defauts.length === 0, `VERT — plan factice : 0 défaut (obtenu ${vert.defauts.length}${vert.defauts.length ? " : " + vert.defauts[0] : ""})`);
    cas(vert.lignes.length === 20 && vert.bilan.campagnes === 2 && vert.bilan.mots === 6 && vert.bilan.exclusions === 6 && vert.bilan.annonces === 3,
      `un seul fichier, cinq types de lignes : 2 + 6 exclusions + 3 groupes + 6 mots + 3 annonces = 20 (obtenu ${vert.lignes.length})`);
    const camp = vert.lignes.filter((l) => l["Row Type"] === "Campaign");
    cas(camp.every((l) => l["Campaign type"] === "Search" && l.Budget && l["EU political ads"] === "No" && l["Campaign status"] === "Paused" && l.Location),
      "chaque campagne porte TOUS ses réglages sur sa propre ligne, en pause (pas de ligne de continuation à la Editor)");
    cas(camp[0].Budget === "4.93" && camp[1].Budget === "2.50", `budget mensuel ramené au jour sur 30,4 jours (obtenu ${camp.map((c) => c.Budget).join(", ")})`);
    cas(vert.lignes.filter((l) => l["Row Type"] === "Negative keyword").every((l) => l.Level === "Campaign" && l.Type === "Broad match" && !l["Ad group"]),
      "exclusion de campagne : Negative keyword, Level = Campaign, Broad match, sans groupe (exception mesurée au « Required. »)");
    const csv = ecrireCsv(vert.colonnes, vert.lignes);
    cas(csv.startsWith("﻿") && csv.includes("\r\n") && lireCsv(csv).length === 21, "CSV : BOM UTF-8, CRLF, 1 en-tête + 20 lignes relues");

    const sansEu = copie(plan); delete sansEu.eu_political_ads;
    const rEu = genererImportWeb(sansEu, modeles, { depart: "2026-10-20", aujourdhui: AUJ, site: SITE, regles });
    cas(rEu.defauts.filter((d) => /Missing value in "EU political ads"/.test(d)).length === 2,
      "ROUGE — plan sans « EU political ads » : refusé sur chaque campagne, par la colonne « Required on create » du modèle (le refus du 22/09)");
    const modelesSansCol = { ...modeles, Campaign: { ...modeles.Campaign, colonnes: modeles.Campaign.colonnes.filter((c) => c !== "EU political ads") } };
    const rCol = genererImportWeb(plan, modelesSansCol, { depart: "2026-10-20", aujourdhui: AUJ, site: SITE, regles });
    cas(rCol.defauts.some((d) => /« EU political ads » déclarée par aucune/.test(d)), "ROUGE — une colonne écrite que le modèle ne déclare pas : refusée, nommée");
    const passe = genererImportWeb(plan, modeles, { depart: "2026-10-01", aujourdhui: AUJ, site: SITE, regles });
    cas(passe.defauts.some((d) => /dans le passé/.test(d)), "ROUGE — date de début passée : refusée (Google refuse la création)");
    cas(genererImportWeb(plan, modeles, { depart: AUJ, aujourdhui: AUJ, site: SITE, regles }).defauts.length === 0, "REMÈDE JOUÉ — même plan, --depart au jour : accepté");
    const long = copie(plan); long.campagnes[0].groupes[0].titres = ["Un titre factice bien trop long pour Google"];
    cas(genererImportWeb(long, modeles, { depart: "2026-10-20", aujourdhui: AUJ, site: SITE, regles }).defauts.some((d) => /> 30/.test(d)), "ROUGE — titre de plus de 30 caractères : refusé");
    const vocab = copie(plan); vocab.campagnes[0].groupes[0].mots[0][1] = "Campaign Negative Broad";
    cas(genererImportWeb(vocab, modeles, { depart: "2026-10-20", aujourdhui: AUJ, site: SITE, regles }).defauts.some((d) => /hors vocabulaire de la colonne « Type »/.test(d)),
      "ROUGE — valeur hors vocabulaire du modèle (« Campaign Negative Broad ») : refusée");
    const pref = copie(plan); pref.campagnes[1].nom = "Stays EN";
    cas(genererImportWeb(pref, modeles, { depart: "2026-10-20", aujourdhui: AUJ, site: SITE, regles }).defauts.some((d) => /préfixe/.test(d)), "ROUGE — campagne sans le préfixe du plan : refusée (le relevé ne la verrait jamais)");
    const page = copie(plan); page.campagnes[0].groupes[0].url = "/page-absente";
    cas(genererImportWeb(page, modeles, { depart: "2026-10-20", aujourdhui: AUJ, site: SITE, regles }).defauts.some((d) => /page d'arrivée \/page-absente absente/.test(d)), "ROUGE — page d'arrivée absente du site construit : refusée");
    cas(genererImportWeb(plan, modeles, { depart: "2026-10-20", aujourdhui: AUJ, regles }).nonJuge.some((n) => /pages d'arrivée/.test(n)), "sans --site, la présence des pages est DITE non jugée, jamais tue");
    const sortieOk = path.join(tmp, "import.csv");
    const okCli = lancer("import-web", "--plan", path.join(FIX, "plan-factice.json"), "--modeles", MODELES, "--depart", "2026-10-20", "--aujourdhui", AUJ, "--site", SITE, "--sortie", sortieOk);
    cas(okCli.status === 0 && existsSync(sortieOk), `CLI import-web : exit 0, fichier écrit (obtenu exit ${okCli.status})`);
    const sortieKo = path.join(tmp, "refus.csv");
    const koCli = lancer("import-web", "--plan", path.join(FIX, "plan-factice.json"), "--modeles", MODELES, "--depart", "2026-10-01", "--aujourdhui", AUJ, "--sortie", sortieKo);
    cas(koCli.status === 1 && !existsSync(sortieKo), `CLI import-web : refus → exit 1 et AUCUN fichier (obtenu exit ${koCli.status})`);
    const koMod = lancer("import-web", "--plan", path.join(FIX, "plan-factice.json"), "--modeles", path.join(tmp, "pas-de-modeles"), "--depart", "2026-10-20", "--sortie", sortieKo);
    cas(koMod.status === 2 && /AVANT de générer/.test(koMod.stdout), "CLI import-web : modèles absents → exit 2, la demande à l'exploitant est dite");

    console.log("Relevé — conformité au plan");
    const releve = lireJson(path.join(FIX, "releve-factice.json"));
    cas(validerReleve(releve, regles).length === 0, "le relevé factice tient le schéma du collecteur");
    const c0 = comparerAuPlan(releve, plan, regles);
    cas(c0.ecarts.length === 0, `VERT — relevé qui recopie le plan : 0 écart (obtenu ${c0.ecarts.length}${c0.ecarts.length ? " : " + c0.ecarts[0] : ""})`);
    const sab = copie(releve);
    sab.campagnes[0].partenaires = true; sab.campagnes[0].lieux = 0;
    sab.campagnes[0].groupes[0].mots.pop();
    cas(comparerAuPlan(sab, plan, regles).ecarts.length === 3, "ROUGE — 3 sabotages (partenaires, sans zone, mot perdu) : 3 écarts");
    const rempl = copie(releve); rempl.campagnes[0].groupes[0].mots[1] = { texte: "mot substitué", correspondance: "PHRASE", id: "3999" };
    cas(comparerAuPlan(rempl, plan, regles).ecarts.length === 2, "ROUGE — un mot-clé REMPLACÉ (même nombre) : 2 écarts nommés ; compter n'aurait rien vu");
    const zone = copie(releve); zone.campagnes[1].option_zone = "PRESENCE_OR_INTEREST";
    cas(comparerAuPlan(zone, plan, regles).ecarts.some((e) => /option de zone = PRESENCE_OR_INTEREST/.test(e)), "ROUGE — option de zone « Présence ou intérêt » laissée par l'import : écart");
    const conv = copie(releve); conv.conversions.push({ nom: "Ancien objectif hérité", statut: "ENABLED", principale: true });
    cas(comparerAuPlan(conv, plan, regles).ecarts.some((e) => /Ancien objectif hérité/.test(e)), "ROUGE — conversion principale héritée hors plan : écart");

    console.log("Relevé — diffusion (TF-1585, TF-1587)");
    const actif = copie(releve);
    actif.lu_le = "2026-09-25T21:22";
    for (const c of actif.campagnes) { c.debut = "2026-09-23 21:22:00"; c.diffusion = { impressions: 0, clics: 0, cout: 0, parts: { obtenue: null } }; }
    const muet = controlerDiffusion(actif, regles);
    cas(comparerAuPlan(actif, plan, regles).ecarts.length === 0 && muet.ecarts.length === 2,
      "ROUGE — conforme au plan, actif, 0 impression 48 h après le départ : 2 écarts de diffusion (le cas du 24/09)");
    cas(muet.ecarts.every((e) => /Cause NON établie/.test(e)), "diagnostic borné : l'écart dit ce qui est mesuré et que la cause n'est pas établie");
    const texte = rendreReleve(actif, comparerAuPlan(actif, plan, regles), muet, regles);
    cas(/validation de l'annonceur/.test(texte) && /limite de dépenses temporaire/.test(texte) && /n'établit pas une absence d'enchère/.test(texte) && !/absence d'enchère\s*$/m.test(texte),
      "le rendu liste les prérequis que l'API ne voit pas et les diagnostics qui ne concluent pas ; une part absente n'est jamais lue comme absence d'enchère");
    for (const c of actif.campagnes) c.diffusion.impressions = 12;
    cas(controlerDiffusion(actif, regles).ecarts.length === 0, "VERT — le même compte, qui diffuse : 0 écart");
    const jeune = copie(actif); jeune.lu_le = "2026-09-23T23:22";
    for (const c of jeune.campagnes) c.diffusion.impressions = 0;
    const rj = controlerDiffusion(jeune, regles);
    cas(rj.ecarts.length === 0 && rj.nonJugees.length === 2, "partie depuis 2 h : non jugée, et DITE non jugée");
    const silence = copie(actif); delete silence.campagnes[0].diffusion;
    cas(controlerDiffusion(silence, regles).ecarts.some((e) => /un silence n'est pas un zéro/.test(e)), "ROUGE — campagne active sans diffusion posée : écart (un silence n'est pas un zéro)");
    const l30 = copie(releve); l30.fenetre_diffusion = "LAST_30_DAYS";
    cas(validerReleve(l30, regles).some((e) => /LAST_30_DAYS exclut aujourd'hui/.test(e)), "ROUGE — relevé lu sur LAST_30_DAYS : non jugeable");
    const fRel = path.join(FIX, "releve-factice.json"), fPlan = path.join(FIX, "plan-factice.json");
    cas(lancer("releve", "--plan", fPlan, "--compte", fRel).status === 0, "CLI releve : relevé factice conforme et diffusé → exit 0");
    const fMuet = path.join(tmp, "muet.json"); writeFileSync(fMuet, JSON.stringify(Object.assign(copie(actif), { campagnes: actif.campagnes.map((c) => ({ ...c, diffusion: { ...c.diffusion, impressions: 0 } })) })));
    cas(lancer("releve", "--plan", fPlan, "--compte", fMuet).status === 1, "CLI releve : compte conforme et muet → exit 1");
    const fL30 = path.join(tmp, "l30.json"); writeFileSync(fL30, JSON.stringify(l30));
    cas(lancer("releve", "--plan", fPlan, "--compte", fL30).status === 2, "CLI releve : fenêtre LAST_30_DAYS → exit 2");

    console.log("Fichier des changements");
    const d0 = calculerChangements(plan, releve, modeles, regles);
    cas(d0.defauts.length === 0 && d0.lignes.length === 0, "VERT — compte qui porte le plan : aucun changement");
    const ecart = copie(releve);
    ecart.campagnes[0].groupes[0].mots.push({ texte: "mot hors plan", correspondance: "BROAD", id: "3777" });
    ecart.campagnes[1].exclusions = ecart.campagnes[1].exclusions.filter((x) => x.texte !== "hostel");
    const d1 = calculerChangements(plan, ecart, modeles, regles);
    const retrait = d1.lignes.find((l) => l.Action === "Remove");
    cas(d1.defauts.length === 0 && d1.lignes.length === 2 && retrait?.["Keyword ID"] === "3777" && retrait?.["Ad group ID"] === "2001"
      && d1.lignes.some((l) => l.Action === "Add" && l["Negative keyword"] === "hostel" && l.Level === "Campaign"),
      "ROUGE → fichier : un mot hors plan retiré PAR SON IDENTIFIANT LU, une exclusion manquante ajoutée");
    cas(d1.lignes.length === comparerAuPlan(ecart, plan, regles).ecarts.length, "cohérence : autant de lignes de changement que d'écarts du relevé sur mots-clés et exclusions");
    const modSans = { ...modeles, Keyword: { ...modeles.Keyword, colonnes: modeles.Keyword.colonnes.filter((c) => c !== "Keyword ID") } };
    cas(calculerChangements(plan, ecart, modSans, regles).defauts.some((d) => /« Keyword ID »/.test(d)), "ROUGE — colonne hors du modèle de mot-clé : refus d'écrire");
    const fEcart = path.join(tmp, "ecart.json"); writeFileSync(fEcart, JSON.stringify(ecart));
    const fDelta = path.join(tmp, "delta.csv");
    const dCli = lancer("delta", "--plan", fPlan, "--compte", fEcart, "--modeles", MODELES, "--sortie", fDelta);
    cas(dCli.status === 0 && existsSync(fDelta) && lireCsv(readFileSync(fDelta, "utf8")).length === 3, `CLI delta : exit 0, 2 lignes écrites (obtenu exit ${dCli.status})`);

    console.log("Avant la première dépense (TF-1586)");
    const liste = lireJson(path.join(FIX, "avant-depense-complet.json"));
    cas(verifierAvantDepense(liste, { aujourdhui: AUJ, regles }).manques.length === 0, "VERT — liste complète, chaque élément vu à l'écran et daté");
    const l1 = copie(liste); l1.elements.validation_annonceur.fait = false;
    cas(verifierAvantDepense(l1, { aujourdhui: AUJ, regles }).manques.some((m) => /validation_annonceur : non fait/.test(m)), "ROUGE — validation de l'annonceur inachevée : manque");
    const l2 = copie(liste); l2.elements.paiement_valable.valable_jusqu_au = "2026-11-10";
    cas(verifierAvantDepense(l2, { aujourdhui: AUJ, regles }).manques.some((m) => /moins de 60 jours/.test(m)), "ROUGE — paiement valable moins de 60 jours : manque");
    const l3 = copie(liste); l3.elements.notifications_lues.avis_confrontes_a_l_ecran_d_etat = false;
    cas(verifierAvantDepense(l3, { aujourdhui: AUJ, regles }).manques.some((m) => /événement daté/.test(m)), "ROUGE — avis non confrontés à l'écran d'état : manque");
    const l4 = copie(liste); delete l4.elements.codes_promotionnels;
    cas(verifierAvantDepense(l4, { aujourdhui: AUJ, regles }).manques.some((m) => /codes_promotionnels : absent/.test(m)), "ROUGE — élément absent : manque");
    const l5 = copie(liste); l5.elements.noms_alignes_registre.vu_sur = "";
    cas(verifierAvantDepense(l5, { aujourdhui: AUJ, regles }).manques.some((m) => /vu_sur/.test(m)), "ROUGE — constat sans l'écran qui le porte : manque");
    const fListe = path.join(tmp, "l1.json"); writeFileSync(fListe, JSON.stringify(l1));
    cas(lancer("avant-depense", "--liste", fListe, "--aujourdhui", AUJ).status === 1 && lancer("avant-depense", "--liste", path.join(FIX, "avant-depense-complet.json"), "--aujourdhui", AUJ).status === 0,
      "CLI avant-depense : incomplète → exit 1, complète → exit 0");

    console.log("Collecteur — lecture seule et fenêtre bornée");
    const fCollecteur = path.join(ICI, "collecter-compte.py");
    const vertC = controlerCollecteur(readFileSync(fCollecteur, "utf8"));
    cas(vertC.length === 0, `VERT — collecter-compte.py : lecture seule, BETWEEN … aujourd'hui (obtenu ${vertC.length}${vertC.length ? " : " + vertC[0] : ""})`);
    const rougeC = controlerCollecteur(readFileSync(path.join(FIX, "collecteur-fautif.py"), "utf8"));
    cas(rougeC.some((f) => /LAST_30_DAYS/.test(f)) && rougeC.some((f) => /écriture/.test(f)), "ROUGE — collecteur fautif : fenêtre LAST_30_DAYS et appel d'écriture, tous deux refusés");
    cas(lancer("controler-collecteur").status === 0 && lancer("controler-collecteur", path.join(FIX, "collecteur-fautif.py")).status === 1, "CLI controler-collecteur : vrai collecteur exit 0, fautif exit 1");
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  console.log(`\nRecette google-ads : ${pass}/${pass + echecs.length} cas`);
  if (echecs.length) { console.log("Échecs :"); echecs.forEach((e) => console.log(`  · ${e}`)); }
  process.exit(echecs.length ? 1 : 0);
}

const args = process.argv.slice(2);
const json = args.includes("--json");
if (args.includes("--self-test")) recette();
else {
  const cmd = args[0];
  const table = { "import-web": cmdImportWeb, releve: cmdReleve, delta: cmdDelta, "avant-depense": cmdAvantDepense, "controler-collecteur": cmdControlerCollecteur };
  if (!table[cmd]) { console.error("usage : google-ads.mjs (import-web | releve | delta | avant-depense | controler-collecteur | --self-test) [options] [--json]"); process.exit(2); }
  table[cmd](args, json);
}

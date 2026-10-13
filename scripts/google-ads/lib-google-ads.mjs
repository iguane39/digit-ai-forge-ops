/**
 * lib-google-ads.mjs — la logique du kit Google Ads, SANS RÉSEAU (TF-1364, décision humaine D-69 (a)
 * du 13/10/2026). Tout ce qui juge vit ici et se recette sur données factices ; le seul morceau qui
 * parle à Google est `collecter-compte.py`, en lecture seule, et il ne fait que poser un relevé JSON
 * que ces fonctions lisent.
 *
 * Origine : le kit éprouvé chez un produit les 21-22/09/2026 (annexe C du lot de retours du
 * 22/09/2026 : 191 lignes acceptées sur 191, relevé « 0 écart » sur le compte réel, fichier de
 * changements de 31 lignes égal aux 6 écarts du relevé), rendu générique : aucun nom, aucun
 * identifiant de compte, aucun contenu de campagne réel. Les faits qui l'écrivent sont au référentiel
 * du pilot, `references/INTEGRATIONS-FOURNISSEURS.md`, section Google Ads.
 *
 * Cinq juges :
 *   1. `genererImportWeb` — le fichier des Importations du web, confronté aux MODÈLES de l'écran à
 *      chaque génération : colonnes déclarées par le modèle du type de ligne, valeurs à vocabulaire
 *      fermé, colonnes « Required on create » remplies. Ce n'est pas une liste recopiée : elle se
 *      lit dans les modèles, qui sont la seule source (le format web n'est publié nulle part).
 *   2. `comparerAuPlan` — la conformité d'un relevé du compte au plan, par CONTENU (un mot-clé
 *      remplacé par un autre laisse le compte inchangé : compter ne suffit pas).
 *   3. `controlerDiffusion` — le second verdict : une campagne active et en diffusion à 0 impression
 *      24 h après son départ est un écart, même conforme ; et le diagnostic reste borné à sa mesure.
 *   4. `calculerChangements` — le fichier des changements entre le plan et l'état LU du compte.
 *   5. `verifierAvantDepense` — la liste des prérequis que l'API ne lit pas, jouée par l'exploitant.
 * Plus un contrôle statique du collecteur (`controlerCollecteur`) : lecture seule, et aucune fenêtre
 * de métriques qui exclut aujourd'hui.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "1.0.0";
export const ICI = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_RELEVE = "forge-ops/google-ads-releve@1";
export const SCHEMA_AVANT_DEPENSE = "forge-ops/google-ads-avant-depense@1";

export function lireRegles(fichier = path.join(ICI, "regles-google-ads.json")) {
  return JSON.parse(readFileSync(fichier, "utf8"));
}

// ————————————————————————————————————————————————————————————————— CSV
/** Découpe un CSV en enregistrements : guillemets doublés, retours à la ligne DANS un champ cité. */
export function lireCsv(texte) {
  const t = texte.replace(/^﻿/, "");
  const enregistrements = [];
  let champ = "", ligne = [], cite = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (cite) {
      if (c === '"') { if (t[i + 1] === '"') { champ += '"'; i++; } else cite = false; }
      else champ += c;
    } else if (c === '"') cite = true;
    else if (c === ",") { ligne.push(champ); champ = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      ligne.push(champ); enregistrements.push(ligne); ligne = []; champ = "";
    } else champ += c;
  }
  if (champ !== "" || ligne.length) { ligne.push(champ); enregistrements.push(ligne); }
  return enregistrements;
}

const echapper = (v) => {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** Le format que l'écran accepte : BOM UTF-8, fins de ligne CRLF. */
export function ecrireCsv(colonnes, lignes) {
  return "﻿" + [colonnes, ...lignes.map((l) => colonnes.map((c) => l[c] ?? ""))]
    .map((r) => r.map(echapper).join(",")).join("\r\n") + "\r\n";
}

// ————————————————————————————————————————————————————————————————— modèles de l'écran Importations
/**
 * Lit un modèle : la ligne d'en-têtes (premier enregistrement qui commence par « Row Type »), puis la
 * ligne de description qui la suit, cellule par cellule : « Required on create. », « Required. »,
 * « Optional. », et « Supported values (Add): a; b » ou « Supported values: a; b ».
 */
export function lireModele(fichier) {
  const enr = lireCsv(readFileSync(fichier, "utf8"));
  const iTete = enr.findIndex((r) => (r[0] || "").trim() === "Row Type");
  if (iTete < 0) throw new Error(`modèle ${path.basename(fichier)} : aucune ligne d'en-têtes « Row Type »`);
  const colonnes = enr[iTete].map((c) => c.trim());
  const desc = enr[iTete + 1] || [];
  const requisCreation = new Set(), requis = new Set(), vocab = {};
  colonnes.forEach((col, i) => {
    const cellule = (desc[i] || "").replace(/^#\s*/, "");
    const premiere = cellule.split(/\r?\n/)[0].trim();
    if (/^Required on create\./i.test(premiere)) requisCreation.add(col);
    else if (/^Required\./i.test(premiere)) requis.add(col);
    const add = cellule.match(/Supported values \(Add\):\s*([^\r\n]*)/i);
    const tous = cellule.match(/Supported values:\s*([^\r\n]*)/i);
    const liste = (m) => m[1].split(";").map((v) => v.trim()).filter(Boolean);
    if (add || tous) vocab[col] = { add: add ? liste(add) : null, tous: tous ? liste(tous) : null };
  });
  const typeDeLigne = vocab["Row Type"]?.tous?.[0] || vocab["Row Type"]?.add?.[0];
  if (!typeDeLigne) throw new Error(`modèle ${path.basename(fichier)} : type de ligne illisible (cellule « Row Type » sans « Supported values »)`);
  return { fichier: path.basename(fichier), typeDeLigne, colonnes, requisCreation, requis, vocab };
}

/** Les modèles d'un dossier, indexés par type de ligne. Un modèle attendu qui manque est un défaut. */
export function lireModeles(dossier, attendus) {
  const defauts = [], parType = {};
  if (!existsSync(dossier)) return { parType, defauts: [`dossier des modèles introuvable : ${dossier}`] };
  const presents = new Set(readdirSync(dossier));
  for (const nom of attendus) {
    if (!presents.has(nom)) { defauts.push(`modèle ${nom} absent de ${dossier} — il se télécharge depuis l'écran Importations du compte, par l'humain qui y est connecté`); continue; }
    try { const m = lireModele(path.join(dossier, nom)); parType[m.typeDeLigne] = m; }
    catch (e) { defauts.push(e.message); }
  }
  return { parType, defauts };
}

/** Confronte UNE ligne au modèle de son type : colonnes, vocabulaire, colonnes obligatoires. */
export function confronterLigne(ligne, modeles, regles, ou) {
  const defauts = [];
  const type = ligne["Row Type"];
  const m = modeles[type];
  if (!m) return [`${ou} : type de ligne « ${type} » sans modèle`];
  const action = ligne.Action || "";
  for (const [col, val] of Object.entries(ligne)) {
    if (!m.colonnes.includes(col)) { defauts.push(`${ou} : colonne « ${col} » déclarée par aucune colonne du modèle ${m.fichier}`); continue; }
    if (val === "" || val === undefined || val === null) continue;
    const v = m.vocab[col];
    if (!v) continue;
    const permis = (action === "Add" && v.add) ? v.add : (v.tous || v.add);
    if (permis && !permis.includes(String(val))) defauts.push(`${ou} : valeur « ${val} » hors vocabulaire de la colonne « ${col} » (${m.fichier} : ${permis.join("; ")})`);
  }
  const exceptions = (regles.import_web.exceptions_requis.valeur || []).filter((e) => e.type_de_ligne === type
    && Object.entries(e.quand).every(([k, val]) => ligne[k] === val)).map((e) => e.colonne);
  const vide = (col) => ligne[col] === undefined || ligne[col] === null || String(ligne[col]).trim() === "";
  if (action === "Add") for (const col of m.requisCreation) if (vide(col)) defauts.push(`${ou} : Missing value in "${col}" — colonne « Required on create » du modèle ${m.fichier}`);
  for (const col of m.requis) if (vide(col) && !exceptions.includes(col)) defauts.push(`${ou} : Missing value in "${col}" — colonne « Required » du modèle ${m.fichier}`);
  return defauts;
}

// ————————————————————————————————————————————————————————————————— le plan
export function dateLocale(d = new Date()) {
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

/** Contrôles du plan lui-même, avant toute génération ou comparaison. */
export function validerPlan(plan) {
  const d = [];
  if (!plan || typeof plan !== "object") return ["plan illisible"];
  if (typeof plan.prefixe !== "string" || !plan.prefixe.trim()) d.push("plan : « prefixe » absent — le relevé et le collecteur ne lisent que les campagnes qui le portent");
  if (typeof plan.site !== "string" || !/^https?:\/\//.test(plan.site)) d.push("plan : « site » absent ou sans schéma http(s)");
  if (!Array.isArray(plan.campagnes) || !plan.campagnes.length) d.push("plan : aucune campagne");
  const noms = new Set();
  for (const c of plan.campagnes || []) {
    if (!c.nom) { d.push("plan : une campagne sans nom"); continue; }
    if (noms.has(c.nom)) d.push(`plan : campagne « ${c.nom} » en double`);
    noms.add(c.nom);
    if (plan.prefixe && !c.nom.startsWith(plan.prefixe)) d.push(`${c.nom} : le nom ne porte pas le préfixe « ${plan.prefixe} » — le relevé ne la verrait jamais`);
    if (typeof c.budget_mensuel_eur !== "number" || !(c.budget_mensuel_eur > 0)) d.push(`${c.nom} : « budget_mensuel_eur » absent ou nul`);
    if (!Array.isArray(c.groupes) || !c.groupes.length) d.push(`${c.nom} : aucun groupe d'annonces`);
  }
  return d;
}

const MATCH = { Exact: "Exact match", Phrase: "Phrase match", Broad: "Broad match" };
const MATCH_API = { Exact: "EXACT", Phrase: "PHRASE", Broad: "BROAD" };
const LIBELLE_API = { EXACT: "Exact match", PHRASE: "Phrase match", BROAD: "Broad match" };

// L'ordre des colonnes, celui d'un humain qui relit : la campagne, le groupe, ce qui vit dans le groupe.
export const COLONNES_IMPORT = ["Row Type", "Action", "Campaign status", "Campaign", "Campaign type", "Networks",
  "Budget", "Budget type", "Bid strategy type", "Campaign start date", "Language", "Location",
  "EU political ads", "Ad group status", "Ad group", "Ad group type", "Default max. CPC",
  "Keyword status", "Keyword", "Type", "Level", "Negative keyword", "Ad status", "Ad type",
  "Path 1", "Path 2", "Final URL",
  ...Array.from({ length: 15 }, (_, i) => `Headline ${i + 1}`),
  ...Array.from({ length: 4 }, (_, i) => `Description ${i + 1}`)];

const pageExiste = (site, url) => {
  const rel = url.replace(/^\/+/, "").replace(/\/+$/, "");
  return [rel, `${rel}.html`, path.join(rel, "index.html")].some((p) => p && existsSync(path.join(site, p)))
    || (rel === "" && existsSync(path.join(site, "index.html")));
};

/**
 * Le fichier des Importations du web : UN fichier, cinq types de lignes (fait mesuré : accepté), la
 * campagne portant TOUS ses réglages sur sa propre ligne (la ligne de continuation d'Editor est
 * refusée), les exclusions en `Negative keyword` / `Level = Campaign`. Toutes les campagnes sortent
 * EN PAUSE avec une date de début : l'activation reste un geste de l'exploitant.
 */
export function genererImportWeb(plan, modeles, { depart, aujourdhui = dateLocale(), site = null, regles = lireRegles() } = {}) {
  const defauts = [...validerPlan(plan)], nonJuge = [], lignes = [];
  const iw = regles.import_web, a = iw.annonce;
  for (const col of COLONNES_IMPORT) if (!Object.values(modeles).some((m) => m.colonnes.includes(col))) defauts.push(`colonne « ${col} » déclarée par aucun modèle de l'écran d'importation`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(depart || "")) defauts.push(`date de début « ${depart ?? ""} » : format attendu AAAA-MM-JJ (--depart)`);
  else if (depart < aujourdhui) defauts.push(`date de début ${depart} dans le passé (aujourd'hui ${aujourdhui}) : Google refuse la création — rejouer avec --depart`);
  if (!site) nonJuge.push("pages d'arrivée : présence non vérifiée (aucun --site fourni)");
  const pousser = (champs, ou) => { defauts.push(...confronterLigne(champs, modeles, regles, ou)); lignes.push(champs); };
  const borne = (quoi, texte, max) => { if ([...String(texte)].length > max) defauts.push(`${quoi} : « ${texte} » fait ${[...String(texte)].length} caractères (> ${max})`); };
  const bilan = { campagnes: 0, groupes: 0, mots: 0, exclusions: 0, annonces: 0, budget_mensuel: 0 };
  const statut = iw.statut_a_la_creation.valeur;
  for (const c of plan.campagnes || []) {
    if (!c.nom || typeof c.budget_mensuel_eur !== "number") continue;
    bilan.campagnes++; bilan.budget_mensuel += c.budget_mensuel_eur;
    pousser({ "Row Type": "Campaign", Action: "Add", "Campaign status": statut, Campaign: c.nom,
      "Campaign type": "Search", Networks: "Google search",
      Budget: (c.budget_mensuel_eur / iw.jours_par_mois.valeur).toFixed(2), "Budget type": "Daily",
      "Bid strategy type": "Manual CPC", "Campaign start date": depart, Language: c.langue ?? "",
      Location: c.lieu?.nom ?? "", "EU political ads": c.eu_political_ads ?? plan.eu_political_ads ?? "" }, c.nom);
    for (const n of [...(plan.negatifs_communs || []), ...(c.negatifs || [])]) {
      pousser({ "Row Type": "Negative keyword", Action: "Add", "Keyword status": "Enabled", Level: "Campaign",
        Campaign: c.nom, "Negative keyword": n, Type: "Broad match" }, `${c.nom} / exclusion « ${n} »`);
      bilan.exclusions++;
    }
    for (const g of c.groupes || []) {
      const ou = `${c.nom} / ${g.nom}`;
      if (site && !pageExiste(site, g.url || "")) defauts.push(`${ou} : page d'arrivée ${g.url} absente de ${site}`);
      pousser({ "Row Type": "Ad group", Action: "Add", "Ad group status": "Enabled", Campaign: c.nom,
        "Ad group": g.nom, "Ad group type": "Standard", "Default max. CPC": Number(g.cpc_max).toFixed(2) }, ou);
      bilan.groupes++;
      for (const [mot, type] of g.mots || []) {
        pousser({ "Row Type": "Keyword", Action: "Add", "Keyword status": "Enabled", Campaign: c.nom,
          "Ad group": g.nom, Keyword: mot, Type: MATCH[type] ?? type }, `${ou} / mot-clé « ${mot} »`);
        bilan.mots++;
      }
      const titres = [...(g.titres || []), ...(c.titres || [])];
      const descriptions = [...(g.descriptions || []), ...(c.descriptions || [])];
      if (titres.length < a.titres_min || titres.length > a.titres_max) defauts.push(`${ou} : ${titres.length} titres (${a.titres_min} à ${a.titres_max})`);
      if (descriptions.length < a.descriptions_min || descriptions.length > a.descriptions_max) defauts.push(`${ou} : ${descriptions.length} descriptions (${a.descriptions_min} à ${a.descriptions_max})`);
      if (new Set(titres).size !== titres.length) defauts.push(`${ou} : titre en double`);
      titres.forEach((t, i) => borne(`${ou} / titre ${i + 1}`, t, a.titre_max));
      descriptions.forEach((t, i) => borne(`${ou} / description ${i + 1}`, t, a.description_max));
      const chemins = (g.chemins || []).slice(0, 2);
      chemins.forEach((p, i) => borne(`${ou} / chemin ${i + 1}`, p, a.chemin_max));
      const annonce = { "Row Type": "Ad", Action: "Add", "Ad status": "Enabled", Campaign: c.nom, "Ad group": g.nom,
        "Ad type": "Responsive search ad", "Final URL": (plan.site || "") + (g.url || ""),
        "Path 1": chemins[0] || "", "Path 2": chemins[1] || "" };
      titres.slice(0, 15).forEach((t, i) => { annonce[`Headline ${i + 1}`] = t; });
      descriptions.slice(0, 4).forEach((t, i) => { annonce[`Description ${i + 1}`] = t; });
      pousser(annonce, `${ou} / annonce`);
      bilan.annonces++;
    }
  }
  return { colonnes: COLONNES_IMPORT, lignes, defauts, nonJuge, bilan };
}

// ————————————————————————————————————————————————————————————————— le relevé du compte
/** Un relevé illisible, ou lu sur une fenêtre qui exclut aujourd'hui, ne se juge pas : exit 2. */
export function validerReleve(r, regles = lireRegles()) {
  const e = [];
  if (!r || typeof r !== "object") return ["relevé illisible"];
  if (r.schema !== SCHEMA_RELEVE) e.push(`schéma « ${r.schema} » : attendu ${SCHEMA_RELEVE}`);
  const attendue = regles.releve.fenetre_diffusion.valeur;
  if (r.fenetre_diffusion !== attendue) e.push(`fenêtre de diffusion « ${r.fenetre_diffusion ?? "non déclarée"} » : attendu « ${attendue} » — LAST_30_DAYS exclut aujourd'hui et une requête de métriques tait les lignes à 0 impression ; la diffusion ne se juge pas sur cette fenêtre`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(r.lu_le || "")) e.push("« lu_le » absent : l'heure de lecture, dans le fuseau du compte, fonde le délai de diffusion");
  if (!Array.isArray(r.campagnes)) e.push("« campagnes » absent");
  return e;
}

/** « 2026-09-23 21:22:00 » ou « 2026-09-23T21:22 » → minutes depuis l'époque, sans fuseau (les deux dates sont dans celui du compte). */
const minutes = (s) => {
  const m = String(s || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) / 60000;
};

const cleMot = (texte, corr) => `${String(texte).toLowerCase()}|${corr}`;

export function comparerAuPlan(releve, plan, regles = lireRegles()) {
  const ecarts = [], info = [];
  const jpm = regles.import_web.jours_par_mois.valeur;
  const zone = regles.releve.option_zone_attendue.valeur;
  const compte = Object.fromEntries((releve.campagnes || []).map((c) => [c.nom, c]));
  const communs = plan.negatifs_communs || [];
  for (const p of plan.campagnes || []) {
    const c = compte[p.nom];
    if (!c) { ecarts.push(`${p.nom} : campagne absente du compte`); continue; }
    const attendu = { budget_jour: Math.round(p.budget_mensuel_eur / jpm * 100) / 100, enchere: "MANUAL_CPC", partenaires: false, display: false };
    const libelles = { budget_jour: "budget quotidien", enchere: "stratégie d'enchères", partenaires: "partenaires du Réseau de Recherche", display: "Réseau Display" };
    for (const k of Object.keys(attendu)) if (c[k] !== attendu[k]) ecarts.push(`${p.nom} : ${libelles[k]} = ${c[k]}, plan = ${attendu[k]}`);
    if (c.option_zone !== zone) ecarts.push(`${p.nom} : option de zone = ${c.option_zone ?? "non lue"}, attendu ${zone} — l'import laisse « Présence ou intérêt » et aucune colonne ne la règle ; correction à la main, Paramètres → Zones → options`);
    if (!(c.lieux >= 1)) ecarts.push(`${p.nom} : aucune zone géographique — la campagne diffuserait partout`);
    if (!(c.langues >= 1)) ecarts.push(`${p.nom} : aucune langue ciblée`);
    const exclPlan = new Set([...communs, ...(p.negatifs || [])].map((t) => t.toLowerCase()));
    const exclCompte = new Set((c.exclusions || []).map((x) => String(x.texte).toLowerCase()));
    for (const t of exclPlan) if (!exclCompte.has(t)) ecarts.push(`${p.nom} : exclusion « ${t} » absente du compte`);
    for (const t of exclCompte) if (!exclPlan.has(t)) ecarts.push(`${p.nom} : exclusion « ${t} » hors plan`);
    const groupes = Object.fromEntries((c.groupes || []).map((g) => [g.nom, g]));
    for (const pg of p.groupes || []) {
      const cg = groupes[pg.nom];
      if (!cg) { ecarts.push(`${p.nom} / ${pg.nom} : groupe absent`); continue; }
      const cpc = Math.round(pg.cpc_max * 100) / 100;
      if (cg.cpc !== cpc) ecarts.push(`${p.nom} / ${pg.nom} : CPC max = ${cg.cpc}, plan = ${cpc}`);
      const motsPlan = new Map((pg.mots || []).map(([t, ty]) => [cleMot(t, MATCH_API[ty] ?? ty), t]));
      const motsCompte = new Map((cg.mots || []).map((m) => [cleMot(m.texte, m.correspondance), m.texte]));
      for (const [k, t] of motsPlan) if (!motsCompte.has(k)) ecarts.push(`${p.nom} / ${pg.nom} : mot-clé « ${t} » (${k.split("|")[1]}) absent du compte`);
      for (const [k, t] of motsCompte) if (!motsPlan.has(k)) ecarts.push(`${p.nom} / ${pg.nom} : mot-clé « ${t} » (${k.split("|")[1]}) hors plan`);
      const nbAnnonces = (cg.annonces || []).length;
      if (nbAnnonces !== 1) ecarts.push(`${p.nom} / ${pg.nom} : annonces = ${nbAnnonces}, plan = 1`);
      const enExamen = (cg.annonces || []).filter((x) => x.statut_examen && x.statut_examen !== "REVIEWED").length;
      if (enExamen) info.push(`${p.nom} / ${pg.nom} : ${enExamen} annonce(s) pas encore examinée(s) — information, pas un écart`);
    }
    for (const g of Object.keys(groupes)) if (!(p.groupes || []).some((pg) => pg.nom === g)) ecarts.push(`${p.nom} / ${g} : groupe hors plan`);
  }
  for (const nom of Object.keys(compte)) if (!(plan.campagnes || []).some((p) => p.nom === nom)) ecarts.push(`${nom} : campagne hors plan`);
  // Les actions de conversion PRINCIPALES héritées d'une ancienne campagne restent principales après
  // l'import, et l'une peut viser un événement que le site n'envoie jamais (fait du 22/09/2026).
  if (Array.isArray(plan.conversions_principales_attendues)) {
    const attendues = new Set(plan.conversions_principales_attendues);
    for (const cv of releve.conversions || []) {
      if (cv.principale && cv.statut === "ENABLED" && !attendues.has(cv.nom)) ecarts.push(`conversion « ${cv.nom} » : principale et active, absente de conversions_principales_attendues — une action héritée peut viser un événement que le site n'envoie jamais`);
    }
    for (const nom of attendues) if (!(releve.conversions || []).some((cv) => cv.nom === nom && cv.principale && cv.statut === "ENABLED")) ecarts.push(`conversion « ${nom} » : attendue principale et active, absente ou secondaire dans le compte`);
  } else info.push("conversions : non jugées (le plan ne déclare pas conversions_principales_attendues)");
  return { ecarts, info };
}

/**
 * Le second verdict : la DIFFUSION. Une campagne ENABLED et SERVING, partie depuis le délai ou plus,
 * qui reste à 0 impression depuis son départ (aujourd'hui compris) est un écart. Le message dit ce
 * qui est MESURÉ et rien d'autre : la cause d'une diffusion nulle ne se lit pas par l'API, et les
 * prérequis qu'elle ne voit pas sont listés à la place d'une cause inventée (TF-1585, TF-1587).
 */
export function controlerDiffusion(releve, regles = lireRegles()) {
  const ecarts = [], nonJugees = [];
  const delai = regles.releve.delai_diffusion_h.valeur;
  const maintenant = minutes(releve.lu_le);
  for (const c of releve.campagnes || []) {
    if (c.statut !== "ENABLED" || c.service !== "SERVING") { nonJugees.push(`${c.nom} : ${c.statut ?? "?"} / ${c.service ?? "?"} — diffusion non jugée`); continue; }
    const depart = minutes(c.debut);
    if (depart === null || maintenant === null) { ecarts.push(`${c.nom} : date de départ ou heure de lecture illisible (« ${c.debut} ») — diffusion non jugée, et c'est un écart`); continue; }
    const heures = (maintenant - depart) / 60;
    if (!c.diffusion || typeof c.diffusion.impressions !== "number") {
      ecarts.push(`${c.nom} : diffusion non lue — un silence n'est pas un zéro ; le collecteur doit poser la diffusion de chaque campagne, à 0 compris`);
      continue;
    }
    if (heures < delai) { nonJugees.push(`${c.nom} : partie depuis ${Math.max(0, heures).toFixed(0)} h (< ${delai} h) — diffusion pas encore jugeable`); continue; }
    if (c.diffusion.impressions === 0) {
      ecarts.push(`${c.nom} : active et en diffusion depuis ${heures.toFixed(0)} h, 0 impression mesurée depuis son départ, aujourd'hui compris — conforme ne veut pas dire diffusée. Cause NON établie par ce relevé : l'API ne lit pas ${regles.releve.prerequis_hors_api.valeur.length} prérequis (voir « Ce que ce relevé ne voit pas »)`);
    }
  }
  return { ecarts, nonJugees };
}

const pct = (v) => (v === null || v === undefined) ? "— (donnée absente : peut signifier un manque de données, n'établit pas une absence d'enchère)" : `${Math.round(v * 100)} %`;

export function rendreReleve(releve, conformite, diffusion, regles = lireRegles()) {
  const l = [];
  l.push(`Relevé lu le ${releve.lu_le} (fuseau ${releve.fuseau ?? "?"}) — fenêtre : depuis le départ de chaque campagne, aujourd'hui compris`);
  l.push(`Campagnes lues : ${(releve.campagnes || []).length}`);
  for (const c of releve.campagnes || []) {
    const g = c.groupes || [];
    l.push(`  ${c.nom} — ${c.statut}, ${c.service ?? "?"}, ${c.budget_jour} €/jour, ${c.enchere}, zone ${c.option_zone ?? "?"}, ${g.length} groupes, ${g.reduce((s, x) => s + (x.mots || []).length, 0)} mots-clés, ${(c.exclusions || []).length} exclusions`);
    const d = c.diffusion;
    // Imprimée MÊME à 0 : c'est le silence sur une campagne muette qui a laissé passer le 24/09/2026.
    if (d) l.push(`      depuis le départ (${String(c.debut ?? "?").slice(0, 16)}) : ${d.impressions} impr., ${d.clics ?? 0} clics, ${Number(d.cout ?? 0).toFixed(2)} € · part d'impressions ${pct(d.parts?.obtenue)}`);
  }
  l.push(`Conformité au plan : ${conformite.ecarts.length} écart(s)`);
  conformite.ecarts.forEach((e) => l.push(`  · ${e}`));
  conformite.info.forEach((e) => l.push(`  (info) ${e}`));
  l.push(`Diffusion : ${diffusion.ecarts.length} écart(s)`);
  diffusion.ecarts.forEach((e) => l.push(`  · ${e}`));
  diffusion.nonJugees.forEach((e) => l.push(`  (non jugée) ${e}`));
  if (diffusion.ecarts.length) {
    l.push("Ce que ce relevé ne voit pas — à faire constater par l'exploitant, à l'écran du jour :");
    regles.releve.prerequis_hors_api.valeur.forEach((p) => l.push(`  - ${p}`));
    l.push("Diagnostics d'écran qui ne concluent pas :");
    regles.releve.diagnostics_non_concluants.valeur.forEach((p) => l.push(`  - ${p}`));
  }
  return l.join("\n");
}

// ————————————————————————————————————————————————————————————————— le fichier des changements
export const COLONNES_CHANGEMENTS = ["Row Type", "Action", "Keyword status", "Level", "Campaign ID", "Campaign",
  "Ad group ID", "Ad group", "Keyword ID", "Keyword", "Negative keyword", "Type"];

/**
 * Les CHANGEMENTS entre le plan et l'état LU du compte : mots-clés des groupes et exclusions de
 * campagne, ajouts et retraits ; les identifiants des retraits viennent du compte lui-même. Les
 * réglages de campagne, les groupes et les annonces ne sont pas synchronisés ici : le relevé les nomme.
 */
export function calculerChangements(plan, releve, modeles, regles = lireRegles()) {
  const defauts = [], lignes = [];
  for (const col of COLONNES_CHANGEMENTS) if (!Object.values(modeles).some((m) => m.colonnes.includes(col))) defauts.push(`colonne « ${col} » déclarée par aucun modèle`);
  const compte = Object.fromEntries((releve.campagnes || []).map((c) => [c.nom, c]));
  const communs = plan.negatifs_communs || [];
  const pousser = (l, ou) => { defauts.push(...confronterLigne(l, modeles, regles, ou)); lignes.push(l); };
  for (const p of plan.campagnes || []) {
    const c = compte[p.nom];
    if (!c) { defauts.push(`${p.nom} : absente du compte — le fichier des changements ne crée pas de campagne (passer par l'import web)`); continue; }
    const groupes = Object.fromEntries((c.groupes || []).map((g) => [g.nom, g]));
    for (const pg of p.groupes || []) {
      const cg = groupes[pg.nom];
      if (!cg) { defauts.push(`${p.nom} / ${pg.nom} : groupe absent du compte — hors portée du fichier des changements`); continue; }
      const motsPlan = new Map((pg.mots || []).map(([t, ty]) => [cleMot(t, MATCH_API[ty] ?? ty), { texte: t, corr: MATCH_API[ty] ?? ty }]));
      const motsCompte = new Map((cg.mots || []).map((m) => [cleMot(m.texte, m.correspondance), m]));
      for (const [k, m] of [...motsCompte].sort()) if (!motsPlan.has(k)) pousser({ "Row Type": "Keyword", Action: "Remove", "Campaign ID": c.id ?? "", Campaign: p.nom, "Ad group ID": cg.id ?? "", "Ad group": pg.nom, "Keyword ID": m.id ?? "", Keyword: m.texte, Type: LIBELLE_API[m.correspondance] ?? m.correspondance }, `${p.nom} / ${pg.nom} / retrait « ${m.texte} »`);
      for (const [k, m] of [...motsPlan].sort()) if (!motsCompte.has(k)) pousser({ "Row Type": "Keyword", Action: "Add", "Keyword status": "Enabled", Campaign: p.nom, "Ad group": pg.nom, Keyword: m.texte, Type: LIBELLE_API[m.corr] ?? m.corr }, `${p.nom} / ${pg.nom} / ajout « ${m.texte} »`);
    }
    const exclPlan = new Map([...communs, ...(p.negatifs || [])].map((t) => [t.toLowerCase(), t]));
    const exclCompte = new Map((c.exclusions || []).map((x) => [String(x.texte).toLowerCase(), x]));
    for (const [k, t] of [...exclPlan].sort()) if (!exclCompte.has(k)) pousser({ "Row Type": "Negative keyword", Action: "Add", "Keyword status": "Enabled", Level: "Campaign", Campaign: p.nom, "Negative keyword": t, Type: "Broad match" }, `${p.nom} / exclusion « ${t} »`);
    for (const [k, x] of [...exclCompte].sort()) if (!exclPlan.has(k)) pousser({ "Row Type": "Negative keyword", Action: "Remove", Level: "Campaign", "Campaign ID": c.id ?? "", Campaign: p.nom, "Keyword ID": x.id ?? "", "Negative keyword": x.texte, Type: LIBELLE_API[x.correspondance] ?? "Broad match" }, `${p.nom} / retrait d'exclusion « ${x.texte} »`);
  }
  return { colonnes: COLONNES_CHANGEMENTS, lignes, defauts };
}

// ————————————————————————————————————————————————————————————————— avant la première dépense
export function verifierAvantDepense(liste, { aujourdhui = dateLocale(), regles = lireRegles() } = {}) {
  const manques = [];
  if (!liste || liste.schema !== SCHEMA_AVANT_DEPENSE) return { illisible: true, manques: [`schéma attendu ${SCHEMA_AVANT_DEPENSE}`] };
  const el = liste.elements || {};
  const plus = (jours) => { const d = new Date(`${aujourdhui}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + jours); return d.toISOString().slice(0, 10); };
  for (const cle of regles.avant_depense.elements.valeur) {
    const e = el[cle];
    if (!e) { manques.push(`${cle} : absent de la liste`); continue; }
    if (e.fait !== true) manques.push(`${cle} : non fait`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.constate_le || "")) manques.push(`${cle} : « constate_le » absent — un constat porte sa date`);
    else if (e.constate_le > aujourdhui) manques.push(`${cle} : constaté le ${e.constate_le}, dans le futur`);
    if (!String(e.vu_sur || "").trim()) manques.push(`${cle} : « vu_sur » absent — l'écran où l'exploitant l'a constaté, celui du jour, jamais l'aide`);
  }
  const p = el.paiement_valable;
  if (p) {
    const min = plus(regles.avant_depense.paiement_jours_min.valeur);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.valable_jusqu_au || "")) manques.push("paiement_valable : « valable_jusqu_au » absent");
    else if (p.valable_jusqu_au < min) manques.push(`paiement_valable : valable jusqu'au ${p.valable_jusqu_au}, moins de ${regles.avant_depense.paiement_jours_min.valeur} jours (il faut au moins le ${min})`);
  }
  const n = el.notifications_lues;
  if (n && n.avis_confrontes_a_l_ecran_d_etat !== true) manques.push("notifications_lues : avis non confrontés à l'écran qui porte l'état — un avis est un événement daté, pas un état");
  return { illisible: false, manques };
}

// ————————————————————————————————————————————————————————————————— le collecteur, contrôlé à la lecture
/**
 * Contrôle statique du collecteur Python : il ne doit JAMAIS écrire dans le compte, ni lire une
 * fenêtre de métriques qui exclut aujourd'hui. Les commentaires ne sont pas jugés.
 */
export function controlerCollecteur(source) {
  const code = source.split(/\r?\n/).map((l) => l.replace(/#.*$/, "")).join("\n")
    .replace(/"""[\s\S]*?"""/g, "");
  const f = [];
  if (/\bmutate\w*\s*\(|Operation\b/.test(code)) f.push("écriture : un appel de modification (mutate / Operation) — le collecteur est en LECTURE SEULE");
  const services = [...code.matchAll(/get_service\(\s*["'](\w+)["']/g)].map((m) => m[1]).filter((s) => s !== "GoogleAdsService");
  if (services.length) f.push(`écriture possible : service(s) autre(s) que GoogleAdsService : ${[...new Set(services)].join(", ")}`);
  if (/LAST_\d+_DAYS|DURING\s+(TODAY|YESTERDAY|LAST_|THIS_|THIS\b)/.test(code)) f.push("fenêtre : une période nommée (LAST_30_DAYS…) — elle exclut aujourd'hui ; borner par segments.date BETWEEN <départ> AND <aujourd'hui>");
  if (!/BETWEEN/.test(code)) f.push("fenêtre : aucune borne explicite segments.date BETWEEN … AND <aujourd'hui>");
  if (!code.includes("depuis_le_depart_aujourd_hui_compris")) f.push("relevé : la fenêtre de diffusion n'est pas déclarée dans le relevé posé");
  return f;
}

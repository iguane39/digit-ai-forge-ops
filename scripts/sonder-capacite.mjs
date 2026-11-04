#!/usr/bin/env node
/**
 * sonder-capacite.mjs — la sonde de capacité d'une région Azure (TF-2129, G-05).
 *
 * Le fait (lot Produit-86 du 03/11/2026, RO-1) : en northeurope, six tentatives de création d'une
 * machine à deux cœurs ont échoué en 409 `SkuNotAvailable`, alors qu'`az vm list-skus` ne déclarait
 * aucune restriction ; francecentral a répondu. Une taille LISTÉE et SANS RESTRICTION de souscription
 * n'est donc pas une taille DISPONIBLE : la liste dit ce que la région propose et ce que la
 * souscription a le droit de demander, jamais ce que la région peut allouer maintenant. Seul un essai
 * d'allocation le prouve. Un réseau ne se déplaçant pas d'une région à l'autre, la sonde se joue AVANT
 * de créer le premier groupe et le premier réseau.
 *
 * Cet outil n'appelle JAMAIS Azure et n'exécute rien :
 *   plan  --region R --repli R2 --taille S [--taille S2 ...]   imprime les gestes de sonde, par région ;
 *   juger <releve.json>                                         juge les captures rapportées par le run.
 * Le run MEP (environnement authentifié fourni par l'humain, GO humain pour l'essai d'allocation, qui
 * est une dépense) joue les gestes et dépose les captures. L'outil propose la région retenue ; le run
 * l'applique, la forge ne décide rien.
 *
 * Relevé (`forge-ops/capacite@1`) :
 *   { "format": "forge-ops/capacite@1", "tailles": ["Standard_D2s_v5"],
 *     "regions": [ { "role": "principale"|"repli", "region": "northeurope",
 *                    "skus": <sortie de `az vm list-skus --location R --resource-type virtualMachines -o json`>,
 *                    "allocations": { "Standard_D2s_v5": { "resultat": "alloue"|"refuse", "code": "SkuNotAvailable" } } } ] }
 * Une région sans `allocations` pour une taille n'a pas fait l'essai : sa capacité n'est PAS prouvée.
 *
 * Verdict et sortie : 0 = une région est prouvée (la principale d'abord, sinon le repli) ;
 * 1 = aucune région prouvée par un refus de capacité, ou aucun repli déclaré ; 2 = capacité non
 * prouvée (essai manquant, refus d'une autre nature, relevé illisible) : ne rien créer.
 */
import fs from "node:fs";

// Codes d'allocation qui disent « la région n'a pas la capacité » (et non « votre quota est atteint »).
const CODES_CAPACITE = new Set(["skunotavailable", "allocationfailed", "zonalallocationfailed",
  "overconstrainedallocationrequest", "overconstrainedzonalallocationrequest"]);

const cle = (s) => String(s ?? "").toLowerCase();

// État d'UNE taille dans UNE région : ce que la liste dit, puis ce que l'essai d'allocation dit.
export function etatTaille(region, taille, skus, allocation) {
  const ligne = (Array.isArray(skus) ? skus : []).find(s => cle(s?.name) === cle(taille)
    && (s?.locations || []).map(cle).includes(cle(region)));
  const restrictions = ligne?.restrictions || [];
  const liste = !!ligne;
  const restreint = restrictions.length > 0;
  const motifRestriction = restrictions.map(r => `${r.type || "?"}/${r.reasonCode || "?"}`).join(", ");
  if (allocation && allocation.resultat === "alloue") {
    // Une allocation réussie prime sur la liste, mais une liste qui ne connaît pas la taille contredit l'essai.
    if (!liste) return { etat: "INCOHERENT", prouve: false, msg: `allocation réussie alors que ${taille} est absente de la liste de ${region} : captures de deux contextes différents` };
    return { etat: "ALLOUE", prouve: true, msg: `allocation réussie en ${region}` };
  }
  if (allocation && allocation.resultat === "refuse") {
    if (CODES_CAPACITE.has(cle(allocation.code))) {
      const trompeur = liste && !restreint;
      return { etat: "REFUSE_CAPACITE", prouve: false, refus_definitif: true,
        msg: `allocation refusée (${allocation.code})${trompeur ? " alors que la taille est LISTÉE sans restriction : la liste ne prouvait rien (G-05)" : ""}` };
    }
    return { etat: "REFUSE_AUTRE", prouve: false,
      msg: `allocation refusée pour un motif qui n'est pas la capacité (${allocation.code || "code absent"}) : ne pas basculer de région sur ce motif, le lever (quota, droit, paramètre)` };
  }
  if (!liste) return { etat: "ABSENTE", prouve: false, refus_definitif: true, msg: `${taille} absente de la liste de ${region}` };
  if (restreint) return { etat: "RESTREINTE", prouve: false, refus_definitif: true, msg: `${taille} listée mais restreinte pour la souscription (${motifRestriction})` };
  return { etat: "LISTEE_SANS_PREUVE", prouve: false,
    msg: `${taille} listée sans restriction, aucun essai d'allocation rapporté : la capacité n'est PAS prouvée (G-05)` };
}

export function juger(releve) {
  const refus = (msg) => ({ verdict: "NON_PROUVE", code: 2, region_retenue: null, regions: [], findings: [{ sev: "bloquant", msg }], non_juge: NON_JUGE });
  if (!releve || releve.format !== "forge-ops/capacite@1") return refus("relevé illisible : format attendu « forge-ops/capacite@1 »");
  const tailles = releve.tailles;
  if (!Array.isArray(tailles) || !tailles.length) return refus("relevé sans taille à sonder (`tailles` vide)");
  const regions = (releve.regions || []).map(r => {
    const parTaille = tailles.map(t => ({ taille: t, ...etatTaille(r.region, t, r.skus, r.allocations?.[t]) }));
    return { role: r.role, region: r.region, prouvee: parTaille.every(x => x.prouve),
      refusee: parTaille.some(x => x.refus_definitif), tailles: parTaille };
  });
  const principale = regions.find(r => r.role === "principale");
  const repli = regions.find(r => r.role === "repli");
  const findings = [];
  const sortie = (verdict, code, retenue) => ({ verdict, code, region_retenue: retenue, regions, findings, non_juge: NON_JUGE });
  if (!principale) { findings.push({ sev: "bloquant", msg: "aucune région principale dans le relevé" }); return sortie("NON_PROUVE", 2, null); }
  if (!repli) {
    findings.push({ sev: "bloquant", msg: "aucune région de repli déclarée : une région qui manque de capacité n'a alors aucune issue, et le réseau de la principale serait créé pour rien (TF-2129)" });
    return sortie("FAIL", 1, principale.prouvee ? principale.region : null);
  }
  if (principale.prouvee) {
    findings.push({ sev: "info", msg: `${principale.region} : capacité prouvée par allocation, pas de bascule` });
    return sortie("PASS", 0, principale.region);
  }
  // La principale n'est pas prouvée. Si elle n'a pas été refusée (essai manquant ou refus d'une autre nature), on ne bascule pas : on n'a pas essayé.
  if (!principale.refusee) {
    findings.push({ sev: "bloquant", msg: `${principale.region} : capacité non prouvée (${principale.tailles.filter(x => !x.prouve).map(x => `${x.taille} ${x.etat}`).join(", ")}) — jouer l'essai d'allocation avant de créer quoi que ce soit ; ne pas basculer sur le repli sans avoir essayé la région de convention` });
    return sortie("NON_PROUVE", 2, null);
  }
  findings.push({ sev: "majeur", msg: `${principale.region} : ${principale.tailles.filter(x => !x.prouve).map(x => `${x.taille} ${x.etat}`).join(", ")} — bascule vers le repli ${repli.region}, AVANT tout réseau` });
  if (repli.prouvee) return sortie("PASS", 0, repli.region);
  if (repli.refusee) {
    findings.push({ sev: "bloquant", msg: `${repli.region} : ${repli.tailles.filter(x => !x.prouve).map(x => `${x.taille} ${x.etat}`).join(", ")} — ni la principale ni le repli n'ont la capacité` });
    return sortie("FAIL", 1, null);
  }
  findings.push({ sev: "bloquant", msg: `${repli.region} : capacité non prouvée (${repli.tailles.filter(x => !x.prouve).map(x => `${x.taille} ${x.etat}`).join(", ")}) — jouer l'essai d'allocation du repli` });
  return sortie("NON_PROUVE", 2, null);
}

const NON_JUGE = [
  "la capacité future : un essai d'allocation réussi prouve l'instant de l'essai, pas l'heure du déploiement",
  "le format des captures `az vm list-skus` et des codes d'erreur : tel que documenté, jamais rejoué contre Azure par cette forge",
  "le choix de la région de repli (résidence des données, latence, prix) : décision du produit et de l'humain",
  "la suppression du groupe jetable de l'essai : geste distant destructif, à passer par la garde de cibles du run",
];

export function planSonde({ region, repli, tailles }) {
  const L = [];
  L.push(`# Sonde de capacité — ${region} (principale) puis ${repli} (repli), tailles : ${tailles.join(", ")}`);
  L.push("# Rien n'est exécuté ici. Jouer dans le run MEP (environnement authentifié, GO humain : l'essai d'allocation est une dépense).");
  L.push("# Commandes non rejouées contre Azure par la forge : relire leur aide (`az vm create -h`) avant le premier usage.");
  for (const [role, r] of [["principale", region], ["repli", repli]]) {
    L.push("", `## ${role} : ${r}`);
    L.push(`# 1. LISTÉ ? Le SKU existe-t-il, avec quelles restrictions de souscription — ne prouve PAS la capacité`);
    L.push(`az vm list-skus --location ${r} --resource-type virtualMachines -o json > skus-${r}.json`);
    L.push(`# 2. ALLOUABLE ? Un essai d'allocation par taille, dans un groupe jetable (aucun réseau durable)`);
    L.push(`az group create --name sonde-capacite-${r} --location ${r}`);
    for (const t of tailles) {
      L.push(`az vm create --resource-group sonde-capacite-${r} --name sonde-${t.toLowerCase().replace(/[^a-z0-9]/g, "")} --location ${r} --size ${t} --image Ubuntu2204 --admin-username sonde --ssh-key-values <CLE_SSH_PUBLIQUE> --public-ip-address ""   # succès -> "alloue" ; échec -> noter le code (SkuNotAvailable, AllocationFailed...)`);
    }
    L.push(`# 3. retrait du groupe jetable : geste destructif d'une ressource créée dans ce tour, à passer par la garde de cibles du run`);
    L.push(`az group delete --name sonde-capacite-${r} --yes --no-wait`);
  }
  L.push("", "# Consigner les captures dans releve-capacite.json (format forge-ops/capacite@1, voir l'en-tête de sonder-capacite.mjs), puis :");
  L.push("node sonder-capacite.mjs juger releve-capacite.json");
  return L.join("\n");
}

// ---- CLI -------------------------------------------------------------------------------------
if (process.argv[1]?.endsWith("sonder-capacite.mjs")) {
  const args = process.argv.slice(2);
  const valeurs = (nom) => args.flatMap((a, i) => a === nom && args[i + 1] ? [args[i + 1]] : []);
  const mode = args[0];
  if (mode === "plan") {
    const region = valeurs("--region")[0], repli = valeurs("--repli")[0], tailles = valeurs("--taille");
    if (!region || !repli || !tailles.length) {
      console.error("usage : plan --region <R> --repli <R2> --taille <S> [--taille <S2> ...]  (le repli est obligatoire : TF-2129)");
      process.exit(2);
    }
    if (cle(region) === cle(repli)) { console.error("le repli doit différer de la région principale"); process.exit(2); }
    console.log(planSonde({ region, repli, tailles }));
    process.exit(0);
  } else if (mode === "juger") {
    let releve = null;
    try { releve = JSON.parse(fs.readFileSync(args[1], "utf8")); } catch { /* relevé illisible : jugé NON_PROUVE */ }
    const r = juger(releve);
    console.log(JSON.stringify({ outil: "sonder-capacite", verdict: r.verdict, region_retenue: r.region_retenue, regions: r.regions, findings: r.findings, non_juge: r.non_juge }, null, 2));
    process.exit(r.code);
  } else {
    console.error("usage : sonder-capacite.mjs plan --region <R> --repli <R2> --taille <S> | juger <releve.json>");
    process.exit(2);
  }
}

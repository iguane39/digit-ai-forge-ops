#!/usr/bin/env node
// identifiants-test — les identifiants de test remis à l'humain restent STABLES d'un déploiement à l'autre (TF-2166).
//
// LA RÈGLE DU PORTEUR (04/11/2026, citée au lot Produit-86 20261104b RP-10, ledger seq 422 et 425), mot pour mot :
// « arrête de changer les mdp à chaque fois que tu déploies une nouvelle version. Et remonte cette règle à la
// Factory. » La chaîne d'un produit renouvelait les mots de passe de ses comptes de test à chaque déploiement
// (exigence E-091 du produit, posée sur le modèle des runs précédents) : 14 déploiements le 04/11, autant de mots de
// passe à recopier, 2 connexions refusées du porteur.
//
// CE QUE FAIT L'OUTIL, trois verbes sur un fichier `forge-ops/identifiants-test@1` (JSON) :
//   assurer   <fichier> --comptes a,b,c [--journal j.jsonl]
//       Chaque compte demandé qui a déjà un mot de passe le GARDE ; seul un compte absent, ou un fichier absent,
//       reçoit un mot de passe neuf (scripts/lib-secret-humain.mjs : alphabet sans sosie ni signe, 20 caractères
//       au moins — TF-2167). Un fichier illisible n'est jamais réécrit : exit 2, c'est à l'humain de dire.
//   renouveler <fichier> (--compte a | --tous) --demande "<les mots de l'humain ou une référence>" [--journal j.jsonl]
//       Le SEUL geste qui change un mot de passe existant. Il exige la demande, qui entre au journal.
//   verifier  <fichier> --commande "<commande de connexion>" [--journal j.jsonl]
//       Joue la commande de connexion du produit une fois par compte, avec FORGE_OPS_COMPTE et
//       FORGE_OPS_MOT_DE_PASSE dans l'environnement du processus fils (jamais en argument, jamais affichés).
//       exit 0 : tous les comptes se connectent ; exit 1 : au moins un refus ; exit 2 : commande absente.
// Aucune valeur de mot de passe n'est écrite sur la sortie, sur l'erreur ni au journal : le fichier est la remise.
// Le journal (`identifiants-test.journal.jsonl` à côté du fichier, sauf --journal) est ajouté, jamais réécrit ; O-25
// le lit (`--journal`) pour refuser un renouvellement sans demande.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { genererSecret } from "./lib-secret-humain.mjs";

export const FORMAT = "forge-ops/identifiants-test@1";
export const TYPES_JOURNAL = ["identifiants_conserves", "identifiants_crees", "identifiants_renouveles", "identifiants_verifies"];

class HorsContrat extends Error {}

function lireFichier(fichier) {
  if (!fs.existsSync(fichier)) return null;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(fichier, "utf8")); }
  catch { throw new HorsContrat(`${fichier} existe mais n'est pas du JSON : il n'est pas réécrit, ses mots de passe seraient perdus ; le corriger à la main, ou le retirer pour en créer de neufs`); }
  if (doc?.format !== FORMAT || typeof doc.comptes !== "object" || doc.comptes === null) throw new HorsContrat(`${fichier} existe mais n'est pas un fichier ${FORMAT} : il n'est pas réécrit`);
  return doc;
}

function ecrireFichier(fichier, doc) {
  fs.mkdirSync(path.dirname(path.resolve(fichier)), { recursive: true });
  const tmp = `${fichier}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, fichier);
}

// Le fichier porte des secrets : averti, jamais bloquant, s'il se trouve dans un dépôt git qui ne l'ignore pas.
function avertirSiSuivi(fichier) {
  const r = spawnSync("git", ["check-ignore", "-q", path.basename(fichier)], { cwd: path.dirname(path.resolve(fichier)), encoding: "utf8" });
  if (r.status === 1) process.stderr.write(`[IDENTIFIANTS AVERTISSEMENT] ${fichier} est dans un dépôt git qui ne l'ignore pas : l'ajouter au .gitignore avant tout commit, un mot de passe ne s'enregistre pas\n`);
}

function journaliser(fichier, journal, type, champs) {
  const chemin = journal || path.join(path.dirname(path.resolve(fichier)), "identifiants-test.journal.jsonl");
  let seq = 1;
  if (fs.existsSync(chemin)) {
    const lignes = fs.readFileSync(chemin, "utf8").split("\n").filter(Boolean);
    try { seq = (JSON.parse(lignes[lignes.length - 1]).seq ?? lignes.length) + 1; } catch { seq = lignes.length + 1; }
  }
  fs.appendFileSync(chemin, JSON.stringify({ seq, ts: new Date().toISOString(), type, ...champs }) + "\n", "utf8");
}

export function assurer({ fichier, comptes, journal }) {
  if (!comptes?.length) throw new HorsContrat("--comptes a,b,c : au moins un compte à assurer");
  const existant = lireFichier(fichier);
  const doc = existant ?? { format: FORMAT, comptes: {} };
  const conserves = [], crees = [];
  for (const nom of comptes) {
    if (typeof doc.comptes[nom]?.mot_de_passe === "string" && doc.comptes[nom].mot_de_passe) conserves.push(nom);
    else { doc.comptes[nom] = { ...(doc.comptes[nom] ?? {}), mot_de_passe: genererSecret() }; crees.push(nom); }
  }
  if (crees.length) { ecrireFichier(fichier, doc); avertirSiSuivi(fichier); }
  if (conserves.length) journaliser(fichier, journal, "identifiants_conserves", { comptes: conserves });
  if (crees.length) journaliser(fichier, journal, "identifiants_crees", { comptes: crees, motif: existant ? "compte_absent" : "fichier_absent" });
  return { verbe: "assurer", fichier, conserves, crees, mots_de_passe: "non affichés : ils sont dans le fichier" };
}

export function renouveler({ fichier, comptes, tous, demande, journal }) {
  if (!String(demande ?? "").trim()) throw new HorsContrat("--demande \"<les mots de l'humain ou une référence>\" : un mot de passe existant ne change que sur demande, et la demande entre au journal");
  const doc = lireFichier(fichier);
  if (!doc) throw new HorsContrat(`${fichier} n'existe pas : rien à renouveler, \`assurer\` le crée`);
  const cibles = tous ? Object.keys(doc.comptes) : comptes;
  if (!cibles?.length) throw new HorsContrat("--compte <nom> ou --tous : quel compte renouveler ?");
  const inconnus = cibles.filter(n => !doc.comptes[n]);
  if (inconnus.length) throw new HorsContrat(`compte(s) absent(s) du fichier : ${inconnus.join(", ")}`);
  for (const nom of cibles) doc.comptes[nom] = { ...doc.comptes[nom], mot_de_passe: genererSecret() };
  ecrireFichier(fichier, doc);
  journaliser(fichier, journal, "identifiants_renouveles", { comptes: cibles, motif: "demande", demande: String(demande).trim() });
  return { verbe: "renouveler", fichier, renouveles: cibles, mots_de_passe: "non affichés : ils sont dans le fichier" };
}

export function verifier({ fichier, commande, journal }) {
  if (!String(commande ?? "").trim()) throw new HorsContrat("--commande \"<commande de connexion du produit>\" : sans elle, la connexion n'est pas prouvée et l'outil ne rend pas PASS");
  const doc = lireFichier(fichier);
  if (!doc) throw new HorsContrat(`${fichier} n'existe pas : rien à vérifier`);
  const resultats = {};
  for (const [nom, c] of Object.entries(doc.comptes)) {
    const r = spawnSync(commande, { shell: true, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORGE_OPS_COMPTE: nom, FORGE_OPS_MOT_DE_PASSE: String(c?.mot_de_passe ?? "") } });
    resultats[nom] = r.status === 0 ? "connecte" : `refuse (exit ${r.status ?? "aucun : " + (r.error?.code ?? "signal")})`;
  }
  const refuses = Object.keys(resultats).filter(n => resultats[n] !== "connecte");
  const connectes = Object.keys(resultats).filter(n => resultats[n] === "connecte");
  journaliser(fichier, journal, "identifiants_verifies", { comptes: Object.keys(resultats), ok: refuses.length === 0, refuses });
  return { verbe: "verifier", fichier, verdict: refuses.length ? "FAIL" : "PASS", connectes, refuses: Object.fromEntries(refuses.map(n => [n, resultats[n]])) };
}

function option(args, nom) { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : undefined; }

function main(args) {
  const [verbe, fichier] = args;
  try {
    if (!["assurer", "renouveler", "verifier"].includes(verbe) || !fichier || fichier.startsWith("--")) throw new HorsContrat("usage : identifiants-test.mjs assurer|renouveler|verifier <fichier.json> [options] — voir l'en-tête du script");
    const journal = option(args, "--journal");
    let sortie;
    if (verbe === "assurer") sortie = assurer({ fichier, journal, comptes: (option(args, "--comptes") ?? "").split(",").map(s => s.trim()).filter(Boolean) });
    else if (verbe === "renouveler") sortie = renouveler({ fichier, journal, comptes: option(args, "--compte") ? [option(args, "--compte")] : [], tous: args.includes("--tous"), demande: option(args, "--demande") });
    else sortie = verifier({ fichier, journal, commande: option(args, "--commande") });
    process.stdout.write(JSON.stringify(sortie) + "\n");
    return sortie.verdict === "FAIL" ? 1 : 0;
  } catch (e) {
    if (e instanceof HorsContrat) { process.stderr.write(`[IDENTIFIANTS HORS CONTRAT] ${e.message}\n`); return 2; }
    throw e;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));

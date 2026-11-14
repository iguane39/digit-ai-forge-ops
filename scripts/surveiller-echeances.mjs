#!/usr/bin/env node
// surveiller-echeances.mjs — une échéance de publication DÉPASSÉE sans publication lue rend une alerte nommée (TF-2560, décision humaine
// D-108 (b) du 14/11/2026, option (a), deuxième membre ; le fait du 21/10/2026 : tâche déclarée « en service », 0 publication du 20 au 25/10).
//
//   node scripts/surveiller-echeances.mjs controler <echeancier.json> <releve.json> --lance-par <planificateur du contrôle> [--le <ISO 8601>] [--sortie verdict.json]
//
// L'échéancier `forge-ops/echeancier@1` dit ce que les tâches doivent publier et où elles tournent ; le relevé `forge-ops/publications-lues@1`
// dit ce que le run a LU sur la plateforme (forme et champs : lib-echeances.mjs). L'outil ne se connecte à rien : aucun appel à une
// plateforme, aucune lecture de l'environnement. Il ne s'exécute pas dans la tâche qu'il contrôle : `--lance-par` est obligatoire, et
// refusé (exit 2) s'il désigne le planificateur d'une tâche de l'échéancier — une tâche arrêtée n'exécute plus sa propre surveillance.
// `--le` fixe l'instant de référence (ISO 8601 avec fuseau) ; sans lui, maintenant.
// Sortie standard : un objet JSON { verdict, code, raison, alertes, non_jugeables, … } ; une ligne par alerte va sur la sortie d'erreur.
// Exit 0 : a-jour · 1 : alerte (au moins une échéance dépassée sans publication lue) · 2 : entrée illisible ou usage, dont une surveillance
// lancée dans la tâche surveillée · 3 : relevé antérieur à une échéance dépassée, non jugeable (ce n'est pas un « à jour »).
import fs from "node:fs";
import path from "node:path";
import { jugerEcheances, instant } from "./lib-echeances.mjs";

const args = process.argv.slice(2);
const fail = m => { process.stderr.write(`[ECHEANCES] ${m}\n`); process.exit(2); };
const valeur = nom => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : undefined; };
const USAGE = "usage : controler <echeancier.json> <releve.json> --lance-par <planificateur> [--le <ISO 8601>] [--sortie <fichier>]";

if (args[0] !== "controler") fail(`${USAGE} (verbe reçu : ${args[0] ?? "aucun"})`);
const [sourceEch, sourceRel] = [args[1], args[2]];
if (!sourceEch || sourceEch.startsWith("--") || !sourceRel || sourceRel.startsWith("--")) fail(`${USAGE} — échéancier ou relevé non donné`);
const connues = ["--lance-par", "--le", "--sortie"];
const inconnue = args.slice(3).find(a => a.startsWith("--") && !connues.includes(a));
if (inconnue) fail(`option inconnue « ${inconnue} »`);
for (const o of connues) if (args.includes(o) && (!valeur(o) || valeur(o).startsWith("--"))) fail(`${USAGE} — ${o} sans valeur`);
if (!args.includes("--lance-par")) fail(`${USAGE} — --lance-par est obligatoire : le contrôle déclare le planificateur qui le lance, pour prouver qu'il ne tourne pas dans la tâche surveillée`);

let reference = Date.now();
if (args.includes("--le")) {
  const r = instant(valeur("--le"));
  if (r === null) fail(`--le « ${valeur("--le")} » illisible (attendu ISO 8601 avec fuseau) — aucun repli silencieux sur maintenant`);
  reference = r;
}
const lire = (source, nom) => {
  const chemin = path.resolve(source);
  if (!fs.existsSync(chemin)) fail(`${nom} introuvable : ${chemin}`);
  try { return JSON.parse(fs.readFileSync(chemin, "utf8")); } catch { fail(`${chemin} ne contient pas du JSON`); }
};
const echeancier = lire(sourceEch, "échéancier");
const releve = lire(sourceRel, "relevé");

const verdict = jugerEcheances(echeancier, releve, { lance_par: valeur("--lance-par"), reference });
const texte = JSON.stringify(verdict, null, 2);
if (valeur("--sortie")) fs.writeFileSync(path.resolve(valeur("--sortie")), texte + "\n", "utf8");
process.stdout.write(texte + "\n");
for (const a of verdict.alertes || []) process.stderr.write(`[ECHEANCES] ALERTE ${a.nom} : ${a.raison}\n`);
for (const a of verdict.non_jugeables || []) process.stderr.write(`[ECHEANCES] NON JUGEABLE ${a.nom} : ${a.raison}\n`);
process.stderr.write(`[ECHEANCES] ${verdict.verdict} : ${verdict.raison}\n`);
process.exit(verdict.code);

#!/usr/bin/env node
// relever-reglages — lit les réglages de plateforme du registre du pilot, chacun par sa `cmd_lire`, EN LECTURE SEULE, et écrit le
// relevé que `oracle-ops.mjs --reglages-plateforme` compare à l'attendu (TF-2230, décision D-178 (a) du 06/11/2026).
//
//   node scripts/relever-reglages.mjs <Plateforme>[,<Plateforme>…] [--registre <fichier>] [--sortie releve.json] [--executer]
//
// Sans `--executer`, le script liste les commandes de lecture qu'il jouerait et rien d'autre (plan-first). Avec lui, chaque commande
// est jouée par `sh -c` avec l'environnement du run : les secrets (SUPABASE_ACCESS_TOKEN, CLOUDFLARE_API_TOKEN, GH_TOKEN…) y restent,
// le relevé ne porte que la commande telle que le registre l'écrit (variables non développées) et la valeur lue. Une commande qui
// écrit (verbe PUT/POST/PATCH/DELETE, corps, champ de `gh api`) n'est jamais jouée, une variable absente est une lecture en échec :
// le relevé le dit, et l'oracle refuse.
// Registre : `--registre`, sinon `references/REGLAGES-SURS-PAR-DEFAUT.json` du pilot (`$FORGE_ROOT`, sinon le parent de ce dépôt).
// Exit 0 : relevé écrit (ou commandes listées) · 2 : usage, registre illisible ou plateforme sans réglage.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chargerRegistre, cheminRegistreDuPilot, relever, variablesDe } from "./lib-reglages.mjs";

const args = process.argv.slice(2);
const fail = (m) => { process.stderr.write(`[RELEVER-REGLAGES] ${m}\n`); process.exit(2); };
const valeur = (nom) => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : undefined; };

const plateformes = (args[0] && !args[0].startsWith("--") ? args[0] : "").split(",").map(s => s.trim()).filter(Boolean);
if (!plateformes.length) fail("usage : <Plateforme>[,<Plateforme>…] [--registre <fichier>] [--sortie releve.json] [--executer] — aucune plateforme donnée");

const ici = path.dirname(fileURLToPath(import.meta.url));
const chemin = valeur("--registre") ?? cheminRegistreDuPilot(process.env, path.resolve(ici, ".."));
if (!chemin || !fs.existsSync(chemin)) fail(`registre des réglages introuvable : ${chemin ?? "(aucun chemin)"} — le donner par --registre, ou poser FORGE_ROOT sur la racine du parc`);
const { entrees, constats } = chargerRegistre(fs.readFileSync(chemin, "utf8"));
if (constats.length) fail(`registre ${chemin} : ${constats.join(" ; ")}`);
const choisies = entrees.filter(e => plateformes.some(p => p.toLowerCase() === e.plateforme.toLowerCase()));
if (!choisies.length) fail(`aucun réglage au registre pour ${plateformes.join(", ")} (il couvre ${[...new Set(entrees.map(e => e.plateforme))].join(", ")})`);

if (!args.includes("--executer")) {
  process.stdout.write(`[RELEVER-REGLAGES] ${choisies.length} lecture(s) à jouer, rien n'est exécuté sans --executer :\n`);
  for (const e of choisies) process.stdout.write(`  - ${e.plateforme} · ${e.reglage} (${e.classement}) : ${e.cmd_lire}   [variables : ${variablesDe(e.cmd_lire).join(", ") || "aucune"}]\n`);
  process.exit(0);
}

const lancer = (commande, env) => {
  const r = spawnSync("sh", ["-c", commande], { env, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return { status: 127, stdout: "", stderr: `sh : ${r.error.code ?? r.error.message}` };
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
};
const { releve, refus } = relever({ entrees, plateformes, lancer });
const sortie = valeur("--sortie");
const texte = JSON.stringify(releve, null, 2) + "\n";
if (sortie) fs.writeFileSync(path.resolve(sortie), texte, "utf8"); else process.stdout.write(texte);
const enEchec = releve.reglages.filter(r => r.erreur);
process.stderr.write(`[RELEVER-REGLAGES] ${releve.reglages.length - enEchec.length} réglage(s) lu(s), ${enEchec.length} lecture(s) en échec${refus.length ? `, ${refus.length} commande(s) refusée(s) (écriture)` : ""}${sortie ? ` — relevé : ${sortie}` : ""}\n`);
for (const r of enEchec) process.stderr.write(`  - ${r.reglage} : ${r.erreur}\n`);

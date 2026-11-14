#!/usr/bin/env node
// rattraper-railway.mjs — un déploiement Railway sauté par « Wait for CI » n'est pas rattrapé quand les contrôles relancés passent
// au vert : l'outil le juge sur un relevé et ÉCRIT le geste de rattrapage (TF-2519, Produit-02, lot 20261105a RT-148, ledger seq 693).
//
//   node scripts/rattraper-railway.mjs juger <releve.json> [--sortie verdict.json]
//
// Le relevé `forge-ops/rattrapage-railway@1` est écrit par le run depuis ses lectures (forme et champs : lib-rattrapage-railway.mjs).
// L'outil ne se connecte à rien : aucun appel à Railway ni à GitHub, aucun jeton lu. Le geste qu'il écrit change la production
// (un déploiement neuf du même commit) : il se joue sous le GO du run (R-38), jamais par la forge.
// Sortie standard : un objet JSON { verdict, code, raison, commit, deploiement, controles, geste? } ; la raison va aussi sur la
// sortie d'erreur. `--sortie` écrit ce même objet dans un fichier.
// Exit 0 : rien à rattraper (garde tenue, version déjà servie ou en route) · 1 : rattrapage requis, geste écrit ·
// 2 : relevé illisible ou usage · 3 : dernier déploiement en échec (FAILED, CRASHED), autre diagnostic.
import fs from "node:fs";
import path from "node:path";
import { jugerRattrapage } from "./lib-rattrapage-railway.mjs";

const args = process.argv.slice(2);
const fail = m => { process.stderr.write(`[RATTRAPAGE-RAILWAY] ${m}\n`); process.exit(2); };
const valeur = nom => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : undefined; };

if (args[0] !== "juger") fail(`usage : juger <releve.json> [--sortie verdict.json] (verbe reçu : ${args[0] ?? "aucun"})`);
const source = args[1] && !args[1].startsWith("--") ? args[1] : null;
if (!source) fail("usage : juger <releve.json> — aucun relevé donné");
const inconnue = args.slice(2).find(a => a.startsWith("--") && a !== "--sortie");
if (inconnue) fail(`option inconnue « ${inconnue} »`);
if (args.includes("--sortie") && (!valeur("--sortie") || valeur("--sortie").startsWith("--"))) fail("usage : --sortie <fichier>");

const chemin = path.resolve(source);
if (!fs.existsSync(chemin)) fail(`relevé introuvable : ${chemin}`);
let releve;
try { releve = JSON.parse(fs.readFileSync(chemin, "utf8")); } catch { fail(`${chemin} ne contient pas du JSON`); }

const verdict = jugerRattrapage(releve);
const texte = JSON.stringify(verdict, null, 2);
const sortie = valeur("--sortie");
if (sortie) fs.writeFileSync(path.resolve(sortie), texte + "\n", "utf8");
process.stdout.write(texte + "\n");
process.stderr.write(`[RATTRAPAGE-RAILWAY] ${verdict.verdict} : ${verdict.raison}\n`);
if (verdict.geste) process.stderr.write("[RATTRAPAGE-RAILWAY] geste écrit, non joué : un déploiement neuf du commit change la production, sous GO humain (R-38)\n");
process.exit(verdict.code);

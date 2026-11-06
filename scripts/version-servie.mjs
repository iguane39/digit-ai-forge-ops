#!/usr/bin/env node
// version-servie.mjs — lire le commit qu'une instance SERT, pour que le dossier de MEP le cite au lieu de le
// reconstituer (TF-2201, Produit-86, lot 20261105b RP-21).
//
//   node scripts/version-servie.mjs lire <url ou capture.json> [--chemin /healthz] [--sortie capture.json] [--attendu <commit>]
//
// Une URL reçoit UN GET sur `<url><chemin>` (chemin par défaut `/healthz`) : aucune écriture distante, aucun en-tête
// d'authentification, aucun secret. Un fichier est lu tel quel (capture d'un GET fait ailleurs).
// Sortie standard : un objet JSON { source, commit, attendu? } que le dossier de MEP cite. `--sortie` écrit le corps
// reçu, que `oracle-ops.mjs --version-servie` juge ensuite.
// Exit 0 : commit lu (et égal à `--attendu` s'il est donné) · 1 : commit lu mais différent de `--attendu` ·
// 2 : version illisible (réponse en erreur, corps sans JSON, aucun commit) ou usage.
import fs from "node:fs";
import path from "node:path";
import { commitDuCorps, jugerVersionServie } from "./lib-version-servie.mjs";

const args = process.argv.slice(2);
const fail = (m) => { process.stderr.write(`[VERSION-SERVIE] ${m}\n`); process.exit(2); };
const valeur = (nom) => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : undefined; };

const verbe = args[0];
if (verbe !== "lire") fail(`usage : lire <url ou capture.json> [--chemin /healthz] [--sortie capture.json] [--attendu <commit>] (verbe reçu : ${verbe ?? "aucun"})`);
const source = args[1] && !args[1].startsWith("--") ? args[1] : null;
if (!source) fail("usage : lire <url ou capture.json> — aucune source donnée");

let texte, origine;
if (/^https?:\/\//i.test(source)) {
  const chemin = valeur("--chemin") ?? "/healthz";
  origine = source.replace(/\/+$/, "") + chemin;
  let rep;
  try { rep = await fetch(origine, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(15000) }); }
  catch (e) { fail(`${origine} injoignable : ${e.cause?.code ?? e.message}`); }
  if (!rep.ok) fail(`${origine} a répondu ${rep.status} — la version servie n'est pas lisible`);
  texte = await rep.text();
} else {
  origine = path.resolve(source);
  if (!fs.existsSync(origine)) fail(`capture introuvable : ${origine}`);
  texte = fs.readFileSync(origine, "utf8");
}

let corps;
try { corps = JSON.parse(texte); } catch { fail(`${origine} ne rend pas du JSON — la version servie n'est pas lisible`); }
if (!commitDuCorps(corps)) fail(`${origine} ne rend aucun commit (champ « commit » absent) — la version servie n'est pas lisible ; l'image doit recevoir COMMIT_SHA à sa construction et /healthz le rendre (TF-2201)`);

const forme = jugerVersionServie(corps).constats.find(c => c.sev === "bloquant");
if (forme) fail(forme.msg);

const sortie = valeur("--sortie");
if (sortie) fs.writeFileSync(path.resolve(sortie), JSON.stringify(corps, null, 2) + "\n", "utf8");

const attendu = valeur("--attendu");
const jugement = jugerVersionServie(corps, { attendu });
const dur = jugement.constats.find(c => c.sev === "bloquant");
process.stdout.write(JSON.stringify({ source: origine, commit: jugement.commit, ...(attendu ? { attendu, egal: !dur } : {}) }) + "\n");
if (dur) { process.stderr.write(`[VERSION-SERVIE] ${dur.msg}\n`); process.exit(1); }

#!/usr/bin/env node
// convergence-terraform — la chaîne re-planifie APRÈS l'apply et signale un plan non vide ; ce que le fournisseur ne
// change pas sur place est remplacé de force (TF-2271, Produit-86, lot 20261106a RP-44, ledger seq 609).
//
//   node scripts/convergence-terraform.mjs verifier  <pile> [--sortie capture.json]
//   node scripts/convergence-terraform.mjs converger <pile> [--executer] [--sortie capture.json]
//
// verifier   `terraform plan -detailed-exitcode` en lecture seule, puis `terraform show -json` : la capture du plan
//            suivant l'apply, que `oracle-ops.mjs --convergence <capture>` juge (O-29). Exit 0 : plan vide, la pile
//            converge · 1 : le plan n'est pas vide (chaque ressource est nommée, avec ses attributs et la commande de
//            remplacement) · 2 : Terraform a échoué ou la capture est illisible. À placer juste après `terraform apply`.
// converger  `verifier`, puis, si le plan n'est pas vide, le remède : `terraform apply -replace=<adresse>` pour chaque
//            ressource que le plan dit « update ». Sans `--executer`, la commande est écrite et rien n'est appliqué
//            (plan-first) ; avec `--executer`, UN tour de remplacement est joué, puis la pile est re-planifiée. Une
//            ressource d'image à état (references/CONTENEURS-A-ETAT.json) n'est jamais remplacée par la chaîne : le
//            remplacement d'un conteneur sans volume perd ses données, c'est un geste humain, écrit en refus.
//            Exit 0 : la pile converge · 1 : elle ne converge pas · 2 : Terraform a échoué.
//
// Terraform se trouve par la variable FORGE_OPS_TERRAFORM (chemin de l'exécutable), sinon `terraform` dans le PATH.
// Aucun secret ne transite ici : les variables de la pile restent celles de l'environnement du run.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { converger, replanifier, imagesAEtatDuReferentiel, commandeRemplacement, partagerRemplacements } from "./lib-convergence.mjs";

const args = process.argv.slice(2);
const fail = (m) => { process.stderr.write(`[CONVERGENCE] ${m}\n`); process.exit(2); };
const valeur = (nom) => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : undefined; };

const verbe = args[0];
if (!["verifier", "converger"].includes(verbe)) fail(`usage : verifier|converger <pile> [--executer] [--sortie capture.json] (verbe reçu : ${verbe ?? "aucun"})`);
const pile = args[1] && !args[1].startsWith("--") ? path.resolve(args[1]) : null;
if (!pile) fail(`usage : ${verbe} <pile> — aucune pile donnée`);
if (!fs.existsSync(pile) || !fs.statSync(pile).isDirectory()) fail(`pile introuvable ou ce n'est pas un dossier : ${pile}`);

const binaire = process.env.FORGE_OPS_TERRAFORM || "terraform";
const lancer = (a) => {
  const r = spawnSync(binaire, a, { encoding: "utf8", timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { status: 127, stdout: "", stderr: `${binaire} : ${r.error.code ?? r.error.message}` };
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
};
const referentiel = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "references", "CONTENEURS-A-ETAT.json");
const sortie = valeur("--sortie");
const ecrireCapture = (capture) => { if (sortie && capture) fs.writeFileSync(path.resolve(sortie), capture, "utf8"); };

const dire = (m) => process.stdout.write(`${m}\n`);
function decrire(ressources) {
  for (const r of ressources)
    dire(`  - ${r.adresse} : ${r.actions.join("+")}${r.attributs.length ? ` (attributs : ${r.attributs.join(", ")})` : ""}`);
}

if (verbe === "verifier") {
  const r = replanifier(lancer, pile);
  if (r.etat === "erreur") fail(r.detail);
  ecrireCapture(r.capture);
  if (r.etat === "converge") { dire("[CONVERGENCE OK] le plan après l'apply est vide : la pile converge"); process.exit(0); }
  dire(`[CONVERGENCE REFUSÉE] le plan après l'apply n'est pas vide : ${r.detail}`);
  decrire(r.lecture.ressources);
  const { remplacables } = partagerRemplacements(r.lecture.ressources, imagesAEtatDuReferentiel(referentiel));
  if (remplacables.length) dire(`remède, ressource qui ne change pas sur place : ${commandeRemplacement(remplacables.map(x => x.adresse))}   (ou : converger ${path.basename(pile)} --executer)`);
  process.exit(1);
}

const res = converger({ pile, lancer, executer: args.includes("--executer"), imagesAEtat: imagesAEtatDuReferentiel(referentiel) });
for (const e of res.etapes) dire(`  [${e.etat}] ${e.etape} : ${e.detail}`);
ecrireCapture(res.capture);
if (res.verdict === "erreur") fail(res.etapes[res.etapes.length - 1].detail);
if (res.verdict === "converge") {
  dire(res.remplacees.length ? `[CONVERGENCE OK] ${res.remplacees.length} ressource(s) remplacée(s) de force, le plan suivant est vide : ${res.remplacees.map(x => x.adresse).join(", ")}` : "[CONVERGENCE OK] le plan après l'apply est vide : la pile converge");
  process.exit(0);
}
dire("[CONVERGENCE REFUSÉE] le plan après l'apply n'est pas vide");
decrire(res.ressources ?? []);
for (const r of res.refusees) dire(`  remplacement REFUSÉ pour ${r.adresse} : image à état (${r.image}), geste humain — un conteneur remplacé sans volume perd ses données`);
for (const r of res.autres) dire(`  hors remplacement : ${r.adresse} (${r.actions.join("+")}) — ni « update » ni remplaçable par ce geste, apply à rejouer ou geste humain`);
if (res.commande && !res.remplacees.length) dire(`remède, à jouer sous le GO du run : ${res.commande}   (ou rejouer avec --executer)`);
else if (res.remplacees.length) dire(`le plan reste non vide APRÈS le remplacement de ${res.remplacees.map(x => x.adresse).join(", ")} : un seul tour est joué, la cause est à chercher dans la configuration ou le fournisseur`);
process.exit(1);

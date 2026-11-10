#!/usr/bin/env node
// appliquer-terraform — l'apply d'une pile Terraform qui pose des réglages d'un projet Supabase : la santé du projet est
// sondée AVANT, et l'erreur de santé du fournisseur est relancée de façon bornée (TF-2312, Produit-84, lot 20261109b).
//
//   node scripts/appliquer-terraform.mjs <pile> --projet <ref> [--executer] [--relances N] [--attente S] [--services a,b,c]
//   node scripts/appliquer-terraform.mjs <pile> --sans-sonde  [--executer] [--relances N] [--attente S]
//
// Sans --executer (plan-first) : les gestes sont écrits, rien n'est appelé ni appliqué. L'application d'une pile sur un
// service hébergé est une publication : elle se joue sous le GO du run (R-38).
// Avec --executer : 1) la sonde lit GET /v1/projects/<ref>/health (API de gestion, HTTPS, lecture seule) et attend, au plus
// N+1 lectures espacées de S secondes, que tous les services soient sains ; un projet malsain après la borne n'est PAS
// appliqué ; 2) `terraform apply -auto-approve` ; 3) sur « Project Services Unhealthy » seulement, au plus N relances
// (défaut 3), la santé relue entre deux essais (S secondes d'attente sans sonde). Toute autre erreur s'arrête au premier essai.
// Exit 0 : appliqué · 1 : projet malsain (avant l'apply, ou à chaque essai permis), état dit · 2 : usage, sonde en erreur
// ou autre échec de Terraform.
//
// Désactiver un service inutilisé (realtime) reste la décision du produit : la sortie le dit, l'outil ne le fait jamais.
// Le jeton se lit dans SUPABASE_ACCESS_TOKEN (environnement du run), jamais en argument ni dans la sortie.
// Terraform se trouve par FORGE_OPS_TERRAFORM, sinon `terraform` du PATH. L'adresse de l'API de gestion est
// https://api.supabase.com, surchargeable par FORGE_OPS_SUPABASE_API (https, ou http sur la boucle locale pour la recette).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as attendre } from "node:timers/promises";
import { appliquer, sonderSante, appelHttp, gestesPrevus, SERVICES_PAR_DEFAUT, RELANCES_PAR_DEFAUT, ATTENTE_PAR_DEFAUT_S } from "./lib-application.mjs";

const args = process.argv.slice(2);
const fail = (m) => { process.stderr.write(`[APPLICATION] ${m}\n`); process.exit(2); };
const valeur = (nom) => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : undefined; };
const dire = (m) => process.stdout.write(`${m}\n`);
const entier = (nom, defaut) => {
  const v = valeur(nom);
  if (v === undefined) return defaut;
  if (!/^\d+$/.test(v)) fail(`${nom} attend un entier positif ou nul (reçu : ${v})`);
  return Number(v);
};

const pile = args[0] && !args[0].startsWith("--") ? path.resolve(args[0]) : null;
if (!pile) fail("usage : <pile> (--projet <ref> | --sans-sonde) [--executer] [--relances N] [--attente S] [--services a,b] — aucune pile donnée");
if (!fs.existsSync(pile) || !fs.statSync(pile).isDirectory()) fail(`pile introuvable ou ce n'est pas un dossier : ${pile}`);
const projet = valeur("--projet");
const sansSonde = args.includes("--sans-sonde");
if (!projet && !sansSonde) fail("ni --projet <ref> ni --sans-sonde : la sonde de santé ne se contourne que par un choix écrit");
if (projet && sansSonde) fail("--projet et --sans-sonde se contredisent");
const relances = entier("--relances", RELANCES_PAR_DEFAUT);
if (relances > 10) fail(`--relances ${relances} : la borne est de 10 au plus (une relance n'est pas une boucle)`);
const attenteS = entier("--attente", ATTENTE_PAR_DEFAUT_S);
const services = valeur("--services") ? valeur("--services").split(",").map(s => s.trim()).filter(Boolean) : SERVICES_PAR_DEFAUT;

const base = process.env.FORGE_OPS_SUPABASE_API || "https://api.supabase.com";
if (!/^https:\/\//.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(base)) fail(`FORGE_OPS_SUPABASE_API doit être https (ou http sur la boucle locale) : ${base}`);

if (!args.includes("--executer")) {
  dire("[APPLICATION, plan-first] rien n'est appelé ni appliqué ; gestes que --executer jouerait, sous le GO du run :");
  for (const g of gestesPrevus({ pile, projet, relances, attenteS, services })) dire(`  - ${g}`);
  process.exit(0);
}

const binaire = process.env.FORGE_OPS_TERRAFORM || "terraform";
const lancer = (a) => {
  const r = spawnSync(binaire, a, { encoding: "utf8", timeout: 1800000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { status: 127, stdout: "", stderr: `${binaire} : ${r.error.code ?? r.error.message}` };
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
};
const sonder = sansSonde ? null : () => sonderSante({ projet, jeton: process.env.SUPABASE_ACCESS_TOKEN, base, services, appeler: appelHttp });

const res = await appliquer({ pile, lancer, sonder, relances, attenteMs: attenteS * 1000, dormir: (ms) => attendre(ms) });
for (const e of res.etapes) dire(`  [${e.etat}] ${e.etape} : ${e.detail}`);
if (res.verdict === "applique") {
  dire(`[APPLICATION OK] la pile est appliquée${res.relances ? ` après ${res.relances} relance(s) sur l'erreur de santé` : " au premier essai"}`);
  process.exit(0);
}
if (res.verdict === "sante-refusee") { dire(`[APPLICATION REFUSÉE] le projet n'est pas sain, rien n'a été appliqué : ${res.constat}`); process.exit(1); }
if (res.verdict === "sante-persistante") { dire(`[APPLICATION NON ABOUTIE] ${res.constat}`); process.exit(1); }
fail(res.constat ?? res.etapes[res.etapes.length - 1].detail);

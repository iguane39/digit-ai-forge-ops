#!/usr/bin/env node
// Gabarit forge-ops (TF-2308) : test de mise en production qui RELIT l'état servi à sa fin.
//
// LE FAIT (Produit-86, lot 20261109a RP-53, ledger seq 439, mesure du 04/11/2026 à 16:50). Le test de mise en
// production jouait un arrêt de mission en dernier. Le socle posait alors le verrou global de la passerelle, et
// l'instance restait en NO_EXTERNAL_AI pour toutes les missions jusqu'au redémarrage suivant. Aucun contrôle ne
// relisait la santé après ce test : trois exigences sont passées en FAIL au second passage. L'instance répondait 200
// en mode dégradé, donc un code 200 ne prouve rien : ce gabarit compare le CORPS de la réponse de santé.
//
// CE QUE FAIT LE GABARIT. Il lit la santé (état de départ), joue chaque épreuve déclarée, relit la santé (état de
// fin) quoi qu'il soit arrivé aux épreuves, et échoue (exit 1) si l'état servi diffère. Il écrit un relevé
// `forge-ops/etat-servi@1` que l'oracle O-30 rejuge sans croire le gabarit :
//   node <forge-ops>/oracles/oracle-ops.mjs --etat-servi etat-servi.json
//
// USAGE (à copier chez le produit avec son fichier de configuration ; il n'importe rien de forge-ops) :
//   node smoke-mise-en-production.mjs [--config smoke.config.json] [--url <adresse>] [--sortie etat-servi.json]
//
// CONFIGURATION (JSON, chemin donné par --config, `smoke.config.json` du dossier courant par défaut) :
//   url                 adresse de l'instance servie (ou --url) ;
//   sante.chemin        chemin de la réponse de santé, "/healthz" par défaut : un produit dont la santé ne s'expose
//                       pas à /healthz le dit ici (ex. "/sante", "/api/health") ;
//   sante.champs        facultatif : champs (chemins pointés, ex. "passerelle.mode") qui font l'état servi. Absent ou
//                       vide, tout le corps de la réponse est comparé ;
//   sante.ignorer       facultatif : champs volatils exclus de la comparaison (horodatage, durée de fonctionnement) ;
//   sante.delai_ms      délai d'une lecture, 15000 par défaut ;
//   epreuves            liste de { nom, commande, delai_ms? } jouées dans l'ordre ; la commande reçoit l'adresse dans
//                       la variable d'environnement SMOKE_URL.
// Le corps de la réponse de santé est copié tel quel dans le relevé : il ne porte donc aucun secret.
//
// EXIT : 0 état de fin égal à l'état de départ et épreuves réussies · 1 état servi changé, instance muette à la fin
// ou épreuve en échec · 2 usage, configuration ou état de départ illisible (aucune épreuve n'est alors jouée : on
// ne change pas l'état d'une instance dont on n'a pas lu le départ).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const FORMAT = "forge-ops/etat-servi@1";
export const CHEMIN_SANTE_DEFAUT = "/healthz";
const ABSENT = "(absent)";

const estObjet = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sousChemin = (chemin, parent) => chemin === parent || chemin.startsWith(parent + ".");

function aplatir(valeur, prefixe, sortie) {
  if (estObjet(valeur)) { for (const [k, v] of Object.entries(valeur)) aplatir(v, prefixe ? `${prefixe}.${k}` : k, sortie); }
  else sortie[prefixe] = valeur;
}

function valeurAuChemin(corps, chemin) {
  let courant = corps;
  for (const part of chemin.split(".")) {
    if (!estObjet(courant) || !(part in courant)) return ABSENT;
    courant = courant[part];
  }
  return courant;
}

// Ce qui fait l'état servi dans un corps de santé : { chemin: valeur }. Un corps qui n'est pas un objet JSON
// (texte brut) est un état à lui seul, sous le nom « (corps) ».
export function projeter(corps, { champs = [], ignorer = [] } = {}) {
  if (!estObjet(corps)) return { "(corps)": corps };
  const brut = {};
  if (champs.length) for (const c of champs) brut[c] = valeurAuChemin(corps, c);
  else aplatir(corps, "", brut);
  return Object.fromEntries(Object.entries(brut).filter(([c]) => !ignorer.some(i => sousChemin(c, i))));
}

// Compare deux corps de santé. Rend { compares, ecarts: [{ champ, avant, apres }] } : `compares` est le nombre de
// champs présents d'un côté au moins (0 = la comparaison ne compare rien, et l'appelant doit le dire).
export function comparerEtats(avant, apres, options = {}) {
  const a = projeter(avant, options), b = projeter(apres, options);
  const champs = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const ecarts = [];
  let compares = 0;
  for (const champ of champs) {
    const va = champ in a ? a[champ] : ABSENT, vb = champ in b ? b[champ] : ABSENT;
    if (va !== ABSENT || vb !== ABSENT) compares++;   // un champ déclaré absent des deux côtés ne compare rien
    if (JSON.stringify(va) !== JSON.stringify(vb)) ecarts.push({ champ, avant: va, apres: vb });
  }
  return { compares, ecarts };
}

const montrer = (v) => { const s = JSON.stringify(v); return s === undefined ? String(v) : (s.length > 80 ? s.slice(0, 77) + "..." : s); };
export const dire = (e) => `« ${e.champ} » : ${montrer(e.avant)} au départ, ${montrer(e.apres)} à la fin`;

async function lire(adresse, delai) {
  const lu_a = new Date().toISOString();
  try {
    const rep = await fetch(adresse, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(delai) });
    const texte = await rep.text();
    let corps; try { corps = JSON.parse(texte); } catch { corps = texte; }
    return { lu_a, status: rep.status, corps };
  } catch (e) { return { lu_a, status: null, erreur: String(e.cause?.code ?? e.message) }; }
}

async function principal() {
  const args = process.argv.slice(2);
  const valeur = (nom) => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : undefined; };
  const dit = (m) => process.stdout.write(`[SMOKE-MEP] ${m}\n`);
  const refuse = (m) => { process.stderr.write(`[SMOKE-MEP] ${m}\n`); process.exitCode = 2; };

  const fichierConfig = path.resolve(valeur("--config") ?? "smoke.config.json");
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(fichierConfig, "utf8")); }
  catch (e) { return refuse(`configuration illisible (${fichierConfig}) : ${e.message}`); }
  const base = String(valeur("--url") ?? cfg.url ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) return refuse("aucune adresse d'instance (clé « url » de la configuration ou --url http://…)");
  const sante = cfg.sante ?? {};
  const chemin = sante.chemin ?? CHEMIN_SANTE_DEFAUT;
  const options = { champs: sante.champs ?? [], ignorer: sante.ignorer ?? [] };
  const delai = sante.delai_ms ?? 15000;
  const epreuves = cfg.epreuves;
  if (!Array.isArray(epreuves) || !epreuves.length || epreuves.some(e => !e || typeof e.nom !== "string" || typeof e.commande !== "string"))
    return refuse("« epreuves » doit lister au moins une épreuve { nom, commande } : sans épreuve, il n'y a rien à encadrer");

  const adresse = base + chemin;
  const releve = { format: FORMAT, url: base, chemin, champs: options.champs, ignorer: options.ignorer, avant: null, epreuves: [], apres: null };
  const ecrire = () => fs.writeFileSync(path.resolve(valeur("--sortie") ?? "etat-servi.json"), JSON.stringify(releve, null, 2) + "\n", "utf8");

  releve.avant = await lire(adresse, delai);
  if (!(releve.avant.status >= 200 && releve.avant.status < 300)) {
    ecrire();
    return refuse(`état de départ illisible : ${adresse} ${releve.avant.status === null ? `injoignable (${releve.avant.erreur})` : `a répondu ${releve.avant.status}`}. `
      + `Aucune épreuve n'est jouée. Si la santé de ce produit ne s'expose pas à ${CHEMIN_SANTE_DEFAUT}, déclarer son chemin dans « sante.chemin » de ${path.basename(fichierConfig)}`);
  }
  dit(`état de départ lu sur ${adresse} (${releve.avant.status})`);

  for (const e of epreuves) {
    const debut = new Date().toISOString();
    const r = spawnSync(e.commande, { shell: true, stdio: "inherit", env: { ...process.env, SMOKE_URL: base }, timeout: e.delai_ms ?? 120000 });
    const code = r.status ?? -1;
    releve.epreuves.push({ nom: e.nom, code, debut, fin: new Date().toISOString() });
    dit(`épreuve « ${e.nom} » : ${code === 0 ? "réussie" : `en échec (code ${code})`}`);
  }

  // La relecture a lieu quoi qu'il soit arrivé aux épreuves : une épreuve en échec est celle qui laisse le plus
  // souvent l'instance dans un état à part.
  releve.apres = await lire(adresse, delai);
  ecrire();

  const defauts = [];
  const echecs = releve.epreuves.filter(e => e.code !== 0);
  if (echecs.length) defauts.push(`${echecs.length} épreuve(s) en échec : ${echecs.map(e => e.nom).join(", ")}`);
  if (!(releve.apres.status >= 200 && releve.apres.status < 300))
    defauts.push(`état de fin illisible : ${releve.apres.status === null ? `instance injoignable (${releve.apres.erreur})` : `réponse ${releve.apres.status}`}`);
  else {
    if (releve.apres.status !== releve.avant.status) defauts.push(`le code de santé est passé de ${releve.avant.status} à ${releve.apres.status}`);
    const cmp = comparerEtats(releve.avant.corps, releve.apres.corps, options);
    if (cmp.compares === 0) defauts.push("la réponse de santé ne porte aucun champ à comparer : seul le code serait comparé, et une instance en mode dégradé répond 200 (déclarer « sante.champs »)");
    for (const e of cmp.ecarts) defauts.push(`état servi changé, ${dire(e)}`);
  }
  if (defauts.length) {
    for (const d of defauts) process.stderr.write(`[SMOKE-MEP] ${d}\n`);
    process.stderr.write("[SMOKE-MEP] ÉCHEC : l'instance n'est pas laissée dans l'état où le test l'a trouvée (TF-2308)\n");
    process.exitCode = 1;
  } else dit("état servi identique au départ : PASS");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await principal();

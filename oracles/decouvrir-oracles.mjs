#!/usr/bin/env node
/**
 * decouvrir-oracles.mjs — les oracles de forge-ops, LUS SUR LE DISQUE, jamais recopiés d'une
 * liste (TF-1319, 23/09/2026 : temps 2 du verdict O3 de l'étude du pilot du 19/08/2026 sur le
 * méta-oracle d'enclenchement).
 *
 * POURQUOI. Un run consigne au ledger une entrée `oracles_verdict` par oracle qui a tourné (forme
 * canonique TF-0385). Pour dire lesquels MANQUENT, le juge du pilot doit savoir ce que chaque forge
 * mobilisée porte. Mesuré le 23/09/2026 : cette forge porte UN oracle, `oracles/oracle-ops.mjs`,
 * dont les règles (O-1 à O-17) se jouent par mode (`--plan`, `--drift`, `--empreinte`…). Un seul
 * fichier ne justifie pas un lanceur ; il justifie que la forge DISE ce qu'elle porte par le même
 * contrat que les autres, pour que le juge n'ait pas à le savoir par cœur — et qu'un second oracle
 * déposé demain soit vu sans que personne ne l'annonce.
 *
 * LE CONTRAT, COMMUN AU PARC (`digit-ai/decouverte-oracles@1`, CONTRAT-INTERFACE.md §3 du pilot) :
 *   node oracles/decouvrir-oracles.mjs [--racine <dossier>]
 *   stdout : { contrat, forge, racine, regle, oracles: [{ nom, chemin }], non_juge: [] }
 *   exit 0 : découverte faite — une liste vide est un résultat, et elle se lit comme telle ;
 *   exit 2 : racine illisible, motif dit. Jamais d'exit 1 : découvrir n'est pas juger.
 * Ce script ne lance aucun oracle ni aucun déploiement, et n'écrit rien. Le juge du pilot
 * (`oracles/oracle-enclenchement.mjs`) l'appelle pour chaque forge mobilisée par un run.
 *
 * LA RÈGLE : tout fichier nommé `oracle-<nom>.mjs|.cjs|.js` ou `oracle[-_]<nom>.py`, où qu'il vive
 * dans le dépôt, hors des dossiers qui ne portent pas d'oracle EN SERVICE — dépendances, caches,
 * archives `Old`/`old`, `fixtures`, entrants `input`. `scripts/ops.mjs` n'est pas un oracle : il
 * DÉPLOIE et RESTAURE, et c'est `oracle-ops` qui juge ce qu'il a fait.
 *
 * Recette à double sens : `oracles/self-test.mjs`, bloc « TF-1319 ».
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRAT = "digit-ai/decouverte-oracles@1";
export const FORGE = "digit-ai-forge-ops";
export const REGLE = "tout fichier `oracle-<nom>.(mjs|cjs|js)` ou `oracle[-_]<nom>.py` du dépôt, "
  + "hors dépendances, caches, `Old`/`old`, `fixtures` et `input` — lu sur le disque à chaque appel";

//: Les dossiers où un fichier nommé comme un oracle n'est pas un oracle en service. Nommés un par
//: un : un motif large écarterait aussi ce qu'on cherche, et une exclusion qui ne se lit pas ne se
//: conteste pas.
export const ECARTES = new Set([".git", "node_modules", ".venv", "venv", "__pycache__",
  ".pytest_cache", ".ruff_cache", ".mypy_cache", ".oracles", "Old", "old", "fixtures", "vendor",
  "input"]);

//: Le nom EST la déclaration. Une recette `*.test.mjs` n'est pas un oracle : le motif s'arrête au
//: premier point, donc `oracle-x.test.mjs` n'y entre pas.
export const EST_UN_ORACLE = (nom) => /^oracle-[\w-]+\.(?:mjs|cjs|js)$/.test(nom) || /^oracle[-_]\w[\w-]*\.py$/.test(nom);

const PROFONDEUR_MAX = 12;

function parcourir(dossier, trouves, profondeur) {
  if (profondeur > PROFONDEUR_MAX) return;
  let entrees;
  try { entrees = readdirSync(dossier, { withFileTypes: true }); } catch { return; }
  for (const e of entrees) {
    const p = join(dossier, e.name);
    if (e.isDirectory()) { if (!ECARTES.has(e.name)) parcourir(p, trouves, profondeur + 1); }
    else if (e.isFile() && EST_UN_ORACLE(e.name)) trouves.push(p);
  }
}

/** La découverte elle-même, importable par une recette ou un lanceur. */
export function decouvrirOracles(racine) {
  const base = { contrat: CONTRAT, forge: FORGE, racine, regle: REGLE, oracles: [] };
  let estDossier = false;
  try { estDossier = existsSync(racine) && statSync(racine).isDirectory(); } catch { estDossier = false; }
  if (!estDossier) {
    return { ...base, motif: `racine introuvable ou illisible : ${racine} — rien n'a été découvert`, non_juge: [] };
  }
  const trouves = [];
  parcourir(racine, trouves, 0);
  const oracles = trouves
    .map((p) => ({ nom: basename(p, extname(p)), chemin: relative(racine, p).split("\\").join("/") }))
    .sort((a, b) => (a.chemin < b.chemin ? -1 : a.chemin > b.chemin ? 1 : 0));
  const parNom = new Map();
  for (const o of oracles) parNom.set(o.nom, [...(parNom.get(o.nom) || []), o.chemin]);
  const doublons = [...parNom.entries()].filter(([, c]) => c.length > 1);
  return {
    ...base,
    oracles,
    non_juge: [
      "la règle lit le NOM du fichier : un contrôle exécutable nommé autrement n'est pas découvert ici",
      "découvrir n'est pas lancer : cette liste ne dit ni qu'un oracle a tourné, ni sur quel artefact il s'applique (granularité retenue : la forge, étude du 19/08 §5)",
      "les MODES d'un oracle (`--plan`, `--drift`, `--empreinte`… d'oracle-ops) ne sont pas découverts séparément : un verdict qui nomme l'oracle le sert, quel que soit le mode joué",
      ...doublons.map(([nom, chemins]) => `nom porté par ${chemins.length} fichiers (${chemins.join(", ")}) : un verdict qui le nomme ne dit pas lequel a tourné`),
    ],
  };
}

// ---- CLI -------------------------------------------------------------------------------------
const lanceEnDirect = process.argv[1]
  && fileURLToPath(import.meta.url).toLowerCase().split("\\").join("/")
     === resolve(process.argv[1]).toLowerCase().split("\\").join("/");
if (lanceEnDirect) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--racine");
  const racine = resolve(i >= 0 && args[i + 1] ? args[i + 1] : join(dirname(fileURLToPath(import.meta.url)), ".."));
  const r = decouvrirOracles(racine);
  console.log(JSON.stringify(r, null, 1));
  process.exit(r.motif ? 2 : 0);
}

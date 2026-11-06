// lib-version-servie.mjs — la version servie par une instance se LIT dans sa réponse /healthz, elle ne se
// reconstitue pas (TF-2201, Produit-86, lot 20261105b RP-21, décision du 06/11/2026).
//
// LE CONTRAT. `/healthz` rend un objet JSON qui porte `commit` : le commit git que l'image a reçu à sa
// construction (`--build-arg COMMIT_SHA=<commit>` des plans azure et aws, substitution `_COMMIT_SHA` de gcp, variable `COMMIT_SHA` de railway). Un commit se dit en 7 à 40
// caractères hexadécimaux. Une empreinte calculée dans le code, une étiquette d'image ou un numéro tenu à la
// main ne sont pas un commit : le 05/11/2026, l'empreinte servie (`23ea38d71963`) ne correspondait à aucun
// des 25 derniers commits, et le dossier de MEP citait deux commits servis.
//
// Ce module ne fait aucun appel réseau : il lit un corps déjà obtenu (scripts/version-servie.mjs) ou un fichier.
import { spawnSync } from "node:child_process";

export const CHAMP_COMMIT = "commit";
const FORME_COMMIT = /^[0-9a-f]{7,40}$/i;

// Le commit d'un corps /healthz, ou null si le corps n'en porte pas.
export function commitDuCorps(corps) {
  const v = corps && typeof corps === "object" ? corps[CHAMP_COMMIT] : null;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

const git = (depot, ...a) => spawnSync("git", ["-C", depot, ...a], { encoding: "utf8", timeout: 30000 });

// Résout un commit (complet ou abrégé) dans un dépôt : le commit complet, ou null s'il n'y est pas.
function resoudre(depot, ref) {
  const r = git(depot, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  return r.status === 0 ? r.stdout.trim() : null;
}

// Juge un corps /healthz. `depot` et `attendu` sont facultatifs. Rend { commit, constats: [{ sev, msg }] }.
export function jugerVersionServie(corps, { depot = null, attendu = null } = {}) {
  const constats = [];
  const commit = commitDuCorps(corps);
  if (!commit) {
    constats.push({ sev: "bloquant", msg: `la version servie n'est pas lisible : /healthz ne rend aucun commit (champ « ${CHAMP_COMMIT} » absent ou vide) — une empreinte statique ou une étiquette d'image se reconstitue, un commit se lit ; passer COMMIT_SHA à la construction de l'image (--build-arg) et le rendre dans /healthz (TF-2201)` });
    return { commit: null, constats };
  }
  if (!FORME_COMMIT.test(commit)) {
    constats.push({ sev: "bloquant", msg: `« ${commit} » n'est pas un commit (7 à 40 caractères hexadécimaux attendus) — la valeur servie ne peut pas être rapprochée de l'historique (TF-2201)` });
    return { commit, constats };
  }
  if (depot) {
    if (git(depot, "rev-parse", "--git-dir").status !== 0) {
      constats.push({ sev: "bloquant", msg: `le dépôt « ${depot} » est illisible : sans lui, le commit servi ne se rapproche pas de l'historique, et l'oracle ne rend pas PASS sur une lecture qu'il n'a pas faite` });
      return { commit, constats };
    }
    const complet = resoudre(depot, commit);
    if (!complet) {
      constats.push({ sev: "bloquant", msg: `le commit servi « ${commit} » n'est aucun commit du dépôt « ${depot} » (ou son abréviation est ambiguë) — une empreinte calculée hors de tout commit ne dit pas ce qui est en ligne (TF-2201, Produit-86 : 23ea38d71963 absent des 25 derniers commits)` });
      return { commit, constats };
    }
    if (attendu) {
      const complet2 = resoudre(depot, attendu);
      if (!complet2) constats.push({ sev: "bloquant", msg: `le commit attendu « ${attendu} » n'est aucun commit du dépôt « ${depot} »` });
      else if (complet2 !== complet) constats.push({ sev: "bloquant", msg: `le commit servi ${complet.slice(0, 12)} n'est pas le commit attendu ${complet2.slice(0, 12)} — l'instance sert une autre version que celle que le dossier de MEP annonce (TF-2201)` });
    } else {
      const ecart = git(depot, "rev-list", "--count", `${complet}..HEAD`);
      if (ecart.status === 0) constats.push({ sev: "info", msg: `commit servi ${complet.slice(0, 12)} : ${ecart.stdout.trim()} commit(s) derrière la tête du dépôt` });
    }
    return { commit: complet, constats };
  }
  if (attendu) {
    const a = String(attendu).trim().toLowerCase(), c = commit.toLowerCase();
    if (!FORME_COMMIT.test(a)) constats.push({ sev: "bloquant", msg: `le commit attendu « ${attendu} » n'est pas un commit (7 à 40 caractères hexadécimaux)` });
    else if (!(a.startsWith(c) || c.startsWith(a))) constats.push({ sev: "bloquant", msg: `le commit servi ${c.slice(0, 12)} n'est pas le commit attendu ${a.slice(0, 12)} — l'instance sert une autre version que celle que le dossier de MEP annonce (TF-2201)` });
  }
  return { commit, constats };
}

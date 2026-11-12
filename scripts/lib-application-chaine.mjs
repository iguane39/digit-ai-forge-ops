// lib-application-chaine.mjs — juge qu'une chaîne qui pose des réglages Supabase par `supabase_settings` passe par l'outil
// scripts/appliquer-terraform.mjs, et non par un `terraform apply` direct (O-31, TF-2397, suite de TF-2312).
//
// LE FAIT. TF-2312 a livré l'outil qui sonde la santé du projet avant l'apply et relance de façon bornée sur « Project Services
// Unhealthy ». Rien n'empêchait une chaîne de garder son `terraform apply` direct : elle retombait sur l'échec du 09/11/2026
// (chaîne de dev 42685313136, service realtime), sans qu'aucun contrôle de la forge le voie. Mesure de départ du 12/11/2026 :
// `oracle-ops.mjs --application-terraform <chaîne>` n'existait pas, l'oracle lisait la chaîne comme une cible de release et
// la refusait pour COURANT absent (O1), jamais pour l'apply direct ; l'outil n'écrivait aucun relevé de ce qu'il avait fait.
//
// DEUX CHOSES SONT JUGÉES (aucun appel réseau, aucun appel à Terraform) :
//   la CHAÎNE (jugerChaineApplication) : les fichiers qu'une chaîne exécute (workflows .yml/.yaml, scripts .sh/.ps1/.cmd,
//     Makefile) sous une racine. Si une pile de cette racine pose `supabase_settings` (directement, ou par un module local), chaque
//     `terraform apply` / `tofu apply` / `terragrunt apply` écrit en direct vers cette pile est un constat bloquant, avec le
//     fichier, la ligne et la commande de remplacement. La pile visée se lit à `-chdir=`, à `cd <dossier> &&`, à
//     `working-directory:` de l'étape ou des `defaults.run` du workflow ; une pile qu'on ne sait pas lire est tenue pour
//     concernée (un faux négatif de sécurité coûte plus qu'un faux positif qu'on lève en nommant la pile). Un appel de l'outil
//     avec `--executer` sans `--sortie` est un constat majeur : le relevé n'existerait jamais, et la règle suivante n'aurait
//     rien à juger ;
//   le RELEVÉ `forge-ops/application@1` (jugerReleveApplication) que l'outil écrit par `--sortie` : l'apply a abouti, la santé
//     a été lue saine avant l'apply (ou le choix `--sans-sonde` est dit), les étapes sont cohérentes avec le verdict.
//
// LES STATUTS DE SANTÉ, REJOUÉS le 12/11/2026 sur la référence de l'API de gestion (https://api.supabase.com/api/v1-json,
// opération `v1-get-services-health`, lecture seule, sans jeton) : `status` ∈ { COMING_UP, ACTIVE_HEALTHY, UNHEALTHY } ;
// `healthy` (booléen) est marqué déprécié (« Use `status` instead ») ; `name` ∈ { auth, db, db_postgres_user, pooler, realtime,
// rest, storage, pg_bouncer } ; la liste `services` s'accepte en tableau (`services=a&services=b`, la forme de l'outil) ou séparée
// par des virgules ; réponses 200 (tableau), 401, 403, 429, 500. L'extrait est gardé en fixture :
// fixtures/appliquer-terraform/api-sante-statuts.json, que la recette rejoue contre `etatService`.
import fs from "node:fs";
import path from "node:path";
import { FORMAT_RELEVE } from "./lib-application.mjs";

const IGNORES = new Set([".git", "node_modules", ".terraform"]);
const TAILLE_MAX = 2 * 1024 * 1024;
const EXT_CHAINE = /\.(ya?ml|sh|bash|ps1|cmd|bat|mk)$/i;
const NOM_CHAINE = /^(Makefile|GNUmakefile|Jenkinsfile)$/;

const RE_SETTINGS = /^\s*resource\s+"supabase_settings"\s+"[^"]+"/m;
const RE_SOURCE_LOCALE = /\bsource\s*=\s*"(\.{1,2}(?:\/[^"]*)?)"/g;
// Un apply direct : le binaire, ses options (`-chdir=…`), puis `apply` (terragrunt : `run-all apply`).
const RE_APPLY = /(?:^|[\s;&|(`'"=:])(?:terraform|tofu|terragrunt)(?:\.exe)?\s+((?:--?[\w-]+(?:=\S+|\s+(?!apply\b|run-all\b|run\b)[^-\s]\S*)?\s+)*)(?:run-all\s+|run\s+--all\s+)?apply\b/;
const RE_APPLY_VARIABLE = /\$\{?(?:TF|TERRAFORM|TOFU)[A-Z_]*\}?"?\s+(?:-\S+\s+)*apply\b/;
const RE_APPLY_ACTION = /\buses\s*:\s*\S*terraform-apply\S*/;
const RE_OUTIL = /appliquer-terraform\.mjs/;

const sansCommentairesHcl = (t) => String(t).replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/).filter(l => !/^\s*(#|\/\/)/.test(l)).join("\n");
const rel = (racine, p) => (path.relative(racine, p) || ".").split(path.sep).join("/");

function parcourir(dossier, retenir, sortie = []) {
  let entrees = [];
  try { entrees = fs.readdirSync(dossier, { withFileTypes: true }); } catch { return sortie; }
  for (const e of entrees.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dossier, e.name);
    if (e.isDirectory()) { if (!IGNORES.has(e.name)) parcourir(p, retenir, sortie); }
    else if (e.isFile() && retenir(e.name)) sortie.push(p);
  }
  return sortie;
}

// Les dossiers qui portent des .tf : pour chacun, pose-t-il supabase_settings, et quels modules locaux appelle-t-il ?
export function lirePiles(racine) {
  const piles = new Map();
  for (const f of parcourir(racine, n => n.endsWith(".tf"))) {
    const dir = path.dirname(f);
    const p = piles.get(dir) ?? { propre: false, modules: new Set() };
    let texte = "";
    try { if (fs.statSync(f).size <= TAILLE_MAX) texte = sansCommentairesHcl(fs.readFileSync(f, "utf8")); } catch { /* illisible : la pile se tait */ }
    if (RE_SETTINGS.test(texte)) p.propre = true;
    for (const m of texte.matchAll(RE_SOURCE_LOCALE)) p.modules.add(path.resolve(dir, m[1]));
    piles.set(dir, p);
  }
  return piles;
}

export function poseSupabaseSettings(piles, dir, vus = new Set()) {
  const d = path.resolve(dir);
  if (vus.has(d)) return false;
  vus.add(d);
  const p = piles.get(d);
  if (!p) return false;
  if (p.propre) return true;
  return [...p.modules].some(m => poseSupabaseSettings(piles, m, vus));
}

// Les lignes logiques d'un fichier de chaîne : continuation par `\`, `` ` `` ou `^`, commentaire `#` ôté.
function lignesLogiques(texte) {
  const brut = String(texte).split(/\r?\n/), sortie = [];
  for (let i = 0; i < brut.length; i++) {
    let courant = brut[i], debut = i;
    while (/[\\`^]\s*$/.test(courant) && i + 1 < brut.length) { courant = courant.replace(/[\\`^]\s*$/, " ") + brut[++i].trim(); }
    const sans = /^\s*#/.test(courant) ? "" : courant.replace(/(^|\s)#.*$/, "$1");
    sortie.push({ ligne: debut + 1, brut: debut, texte: sans });
  }
  return sortie;
}

const valeurChemin = (v) => { const s = String(v ?? "").trim().replace(/^["']|["']$/g, ""); return s && !/[$`]/.test(s) ? s : null; };

// La pile visée par un apply direct : { dossier } (absolu) ou { dossier: null } si on ne sait pas la lire.
function pileVisee({ racine, texte, lignes, i, options, commande, yaml }) {
  const chdir = /-chdir[= ]\s*(\S+)/.exec(options) ?? /--terragrunt-working-dir[= ]\s*(\S+)/.exec(options);
  let dir = chdir ? valeurChemin(chdir[1]) : null;
  if (!dir) { const cd = /\bcd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)/.exec(commande); if (cd) dir = valeurChemin(cd[1]); }
  if (!dir && yaml) {
    const L = String(texte).split(/\r?\n/), idx = lignes[i].brut;
    const indent = (s) => s.length - s.trimStart().length;
    let cle = idx;
    while (cle >= 0 && !/^\s*(?:-\s+)?run\s*:/.test(L[cle])) cle--;
    if (cle >= 0) {
      const k = indent(L[cle].replace(/^(\s*)-\s+/, "$1  "));
      let debut = cle;
      while (debut >= 0 && !(/^\s*-\s/.test(L[debut]) && indent(L[debut]) < k)) debut--;
      if (debut < 0) debut = cle;
      const marge = indent(L[debut]);
      let fin = debut + 1;
      while (fin < L.length && (L[fin].trim() === "" || indent(L[fin]) > marge || (indent(L[fin]) === marge && !/^\s*-\s/.test(L[fin])))) fin++;
      for (let n = debut; n < fin; n++) { const m = /^\s*(?:-\s+)?working-directory\s*:\s*(\S+)/.exec(L[n]); if (m) { dir = valeurChemin(m[1]); break; } }
    }
    if (!dir) { const d = /\bdefaults\s*:\s*\n\s+run\s*:\s*\n\s+working-directory\s*:\s*(\S+)/.exec(texte); if (d) dir = valeurChemin(d[1]); }
  }
  if (!dir && !yaml) { for (let n = i - 1; n >= 0; n--) { const cd = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*$/.exec(lignes[n].texte); if (cd) { dir = valeurChemin(cd[1]); break; } } }
  return { dossier: dir ? path.resolve(racine, dir) : null, ecrit: dir };
}

// Rend { piles, fichiers, directs, outils, constats: [{ sev, msg }] }.
// `racineDonnee` est la racine du dépôt de la chaîne, ou UN fichier de chaîne ; pour un fichier, la racine est `options.racine`,
// sinon le plus proche dossier parent qui porte `.git`, sinon le dossier du fichier.
export function jugerChaineApplication(racineDonnee, options = {}) {
  const constats = [];
  let racine = path.resolve(racineDonnee), seul = null;
  try { if (fs.statSync(racine).isFile()) { seul = racine; racine = options.racine ? path.resolve(options.racine) : racineDepot(path.dirname(racine)); } } catch { /* introuvable : l'appelant le dit */ }
  const piles = lirePiles(racine);
  const posent = [...piles.keys()].filter(d => poseSupabaseSettings(piles, d)).sort();
  const fichiers = seul ? [seul] : parcourir(racine, n => EXT_CHAINE.test(n) || NOM_CHAINE.test(n));
  const res = { racine, piles: posent.map(d => rel(racine, d)), fichiers: fichiers.length, directs: [], outils: [], constats };
  if (!posent.length) return res;

  for (const f of fichiers) {
    let texte = "";
    try { if (fs.statSync(f).size > TAILLE_MAX) { constats.push({ sev: "info", msg: `${rel(racine, f)} dépasse ${TAILLE_MAX / 1024 / 1024} Mo : non lu` }); continue; } texte = fs.readFileSync(f, "utf8"); } catch { continue; }
    const yaml = /\.ya?ml$/i.test(f), lignes = lignesLogiques(texte);
    lignes.forEach((l, i) => {
      const t = l.texte;
      if (!t.trim() || /^\s*(?:-\s+)?(?:name|description|if)\s*:/.test(t) || /^\s*(?:echo|printf|Write-Host)\b/.test(t)) return;
      const ou = `${rel(racine, f)}:${l.ligne}`;
      if (RE_OUTIL.test(t)) {
        const o = { ou, executer: /--executer\b/.test(t), sortie: /--sortie\b/.test(t), sansSonde: /--sans-sonde\b/.test(t) };
        res.outils.push(o);
        if (o.executer && !o.sortie) constats.push({ sev: "majeur", msg: `${ou} : appliquer-terraform.mjs est appelé avec --executer sans --sortie <fichier> : l'outil n'écrit pas son relevé forge-ops/application@1, et la MEP n'a rien à juger de ce qu'il a fait (jouer \`--sortie application.json\`, TF-2397)` });
        if (o.sansSonde) constats.push({ sev: "info", msg: `${ou} : --sans-sonde est un choix écrit, la santé du projet n'est pas lue avant l'apply (la relance bornée reste jouée) ; il ne se refuse pas, il se dit` });
        if (!o.executer) constats.push({ sev: "info", msg: `${ou} : appliquer-terraform.mjs sans --executer écrit ses gestes et n'applique rien` });
        return;
      }
      const m = RE_APPLY.exec(t) ?? (RE_APPLY_VARIABLE.test(t) ? ["", ""] : null) ?? (RE_APPLY_ACTION.test(t) ? ["", ""] : null);
      if (!m) return;
      const visee = pileVisee({ racine, texte, lignes, i, options: m[1] ?? "", commande: t, yaml });
      const connue = visee.dossier && piles.has(visee.dossier);
      const concernee = !connue || poseSupabaseSettings(piles, visee.dossier);
      const d = { ou, commande: t.trim().replace(/^(?:-\s+)?run\s*:\s*/, "").replace(/\s+/g, " ").slice(0, 160), pile: visee.ecrit, concernee };
      res.directs.push(d);
      if (concernee) {
        const cible = connue ? `la pile « ${rel(racine, visee.dossier)} » pose supabase_settings` : visee.dossier
          ? `la pile « ${visee.ecrit} » n'est pas lue dans cette racine et la racine pose supabase_settings (${res.piles.join(", ")})`
          : `la pile visée n'est pas lisible (ni -chdir=, ni cd, ni working-directory) et la racine pose supabase_settings (${res.piles.join(", ")})`;
        const pileRemede = connue ? rel(racine, visee.dossier) : res.piles[0];
        constats.push({ sev: "bloquant", msg: `${ou} : \`${d.commande}\` applique en direct — ${cible}. Le fournisseur attend la santé de TOUS les services après chaque modification et échoue sur « Project Services Unhealthy » (chaîne de dev du 09/11/2026, service realtime) ; l'outil sonde la santé avant l'apply et ne relance que sur cette erreur. Remplacer par : node <FORGE_OPS>/scripts/appliquer-terraform.mjs ${pileRemede} --projet <ref> --executer --sortie application.json (TF-2312, TF-2397)` });
      } else {
        constats.push({ sev: "info", msg: `${ou} : apply direct vers « ${rel(racine, visee.dossier)} », qui ne pose pas supabase_settings : hors de la règle` });
      }
    });
  }
  if (!res.directs.length && !res.outils.length)
    constats.push({ sev: "info", msg: `aucune chaîne sous la racine n'applique la pile qui pose supabase_settings (${res.piles.join(", ")}) : ${fichiers.length} fichier(s) de chaîne lu(s), aucun apply trouvé` });
  return res;
}

function racineDepot(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return path.resolve(dir);
  }
}

// ── Le relevé forge-ops/application@1 ───────────────────────────────────────────────────────────
// Rend { constats: [{ sev, msg }] }. Un relevé qu'on ne sait pas lire ne vaut jamais PASS.
export function jugerReleveApplication(releve) {
  const constats = [];
  const bloquant = (msg) => constats.push({ sev: "bloquant", msg });
  if (!releve || typeof releve !== "object" || Array.isArray(releve) || releve.format !== FORMAT_RELEVE) {
    bloquant(`format inconnu « ${releve?.format} » (attendu ${FORMAT_RELEVE}) : le relevé s'écrit par scripts/appliquer-terraform.mjs --sortie`);
    return { constats };
  }
  if (releve.executer !== true) bloquant("le relevé n'est pas celui d'une application jouée (`executer` n'est pas vrai) : un essai à blanc n'a rien appliqué");
  const debut = Date.parse(releve.debut), fin = Date.parse(releve.fin);
  if (Number.isNaN(debut) || Number.isNaN(fin) || fin < debut) bloquant("horodatage illisible dans le relevé (debut, fin) : l'ordre de l'application ne se vérifie pas");
  const etapes = Array.isArray(releve.etapes) ? releve.etapes : [];
  if (!etapes.length) bloquant("le relevé ne porte aucune étape : ce qui a été fait ne se lit pas");

  if (releve.verdict !== "applique") {
    const dit = {
      "sante-refusee": "le projet n'était pas sain avant l'apply et rien n'a été appliqué",
      "sante-persistante": "l'application a échoué sur la santé à chaque essai permis",
      erreur: "l'application a échoué (autre erreur de Terraform, ou sonde en erreur)",
    }[releve.verdict] ?? `verdict inconnu « ${releve.verdict} »`;
    bloquant(`l'outil n'a pas abouti : ${dit} (verdict ${releve.verdict}, exit ${releve.code})${releve.constat ? ` — ${releve.constat}` : ""}`);
    return { constats };
  }
  if (releve.code !== 0) bloquant(`incohérence : verdict « applique » mais exit ${releve.code}`);

  const applications = etapes.filter(e => /^application, essai \d+$/.test(String(e?.etape)));
  if (!applications.length || applications[applications.length - 1].etat !== "ok")
    bloquant("incohérence : verdict « applique » sans étape « application, essai N » en succès");
  if (!Number.isInteger(releve.relances) || releve.relances < 0 || releve.relances > 10)
    bloquant(`nombre de relances illisible ou hors de la borne de l'outil (0 à 10) : ${releve.relances}`);
  else if (applications.length && releve.relances !== applications.length - 1)
    bloquant(`incohérence : ${releve.relances} relance(s) déclarée(s) pour ${applications.length} application(s) lues aux étapes`);
  else if (releve.relances > 0)
    constats.push({ sev: "info", msg: `appliquée après ${releve.relances} relance(s) sur l'erreur de santé du fournisseur : la santé a été relue entre les essais` });

  if (releve.sonde === "non-jouee")
    constats.push({ sev: "info", msg: "--sans-sonde : la santé du projet n'a pas été lue avant d'appliquer ; choix écrit de la chaîne (la relance bornée a été jouée), non refusé" });
  else if (releve.sonde === "jouee") {
    const premiere = etapes[0];
    if (premiere?.etape !== "sonde avant l'application" || premiere?.etat !== "sain")
      bloquant("la santé n'a pas été lue saine avant l'apply (première étape absente ou non « sain ») : l'outil est joué sans que sa sonde le prouve");
    const malsaines = etapes.filter(e => /^sonde avant/.test(String(e?.etape)) && e.etat !== "sain");
    if (malsaines.length) bloquant(`l'application a abouti alors qu'une sonde a lu le projet non sain (${malsaines.map(e => `« ${e.etape} » : ${e.etat}`).join(" ; ")}) : relevé incohérent`);
    const d = releve.derniere_sonde;
    if (!d || d.etat !== "sain" || !Array.isArray(d.services) || !d.services.length || d.services.some(s => s?.sain !== true))
      bloquant("la dernière sonde du relevé ne lit pas tous les services sains : l'application a abouti sur une santé non prouvée");
  } else bloquant(`champ \`sonde\` illisible (« ${releve.sonde} », attendu jouee ou non-jouee)`);
  return { constats };
}

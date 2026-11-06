// lib-reglages.mjs — les réglages de plateforme lus se comparent à l'attendu du registre du pilot (TF-2230, décision humaine
// D-178 (a) du 06/11/2026 : « réglage admissible appliqué à la création, vérifié à chaque livraison, exception décidée »).
//
// LE REGISTRE. `references/REGLAGES-SURS-PAR-DEFAUT.json` du pilot (donnée volatile, datée et sourcée, loi n° 4) ; la forge le
// LIT, elle ne le copie pas : sa recette porte une copie de fixture (fixtures/o28-reglages-plateforme/registre.json). Un tableau
// d'entrées { plateforme, reglage, source_url, source_lue_le, criteres, cmd_appliquer, cmd_lire, attendu, cmd_retour, classement },
// `classement` valant `defaut` (appliqué à la création) ou `decision` (l'humain choisit : option et coût). Un objet qui porte ce
// tableau sous `reglages` ou `entrees` est lu de même.
//
// LE RELEVÉ (`forge-ops/reglages-plateforme@1`), écrit par scripts/relever-reglages.mjs : { format, releve_le, plateformes: [...],
// reglages: [{ reglage, commande, lu } | { reglage, commande, erreur }] }. `reglage` est le texte du registre, mot pour mot.
//
// LES ÉCARTS ACCEPTÉS (`forge-ops/ecarts-acceptes@1`), écrits à la main sur décision humaine : { format, ecarts: [{ reglage,
// decision, date, lu }] }. Un écart se constate avec la valeur lue qu'il accepte : si l'état lu bouge depuis la décision, l'écart
// n'est plus celui qui a été décidé. Pas d'écart nu : ni appliqué, ni décidé.
//
// Ce module ne fait aucun appel réseau : il compare un relevé déjà pris.

export const CLASSEMENTS = ["defaut", "decision"];
const CLES_ENTREE = ["plateforme", "reglage", "attendu", "cmd_lire", "classement"];
const brut = (v) => (typeof v === "string" ? v.trim() : v);
const egal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// La valeur lue, rendue comparable : une chaîne qui est du JSON valide (« true », « [1] », « {"a":1} ») est lue comme JSON.
export function normaliser(lu) {
  if (typeof lu !== "string") return lu;
  const t = lu.trim();
  if (!t) return t;
  try { return JSON.parse(t); } catch { return t; }
}

// Lit le registre (texte) : { entrees, constats }.
export function chargerRegistre(texte) {
  const constats = [];
  let json = null;
  try { json = JSON.parse(String(texte).replace(/^﻿/, "")); } catch (e) { return { entrees: [], constats: [`registre illisible (JSON invalide : ${String(e.message).slice(0, 80)})`] }; }
  const liste = Array.isArray(json) ? json : Array.isArray(json?.reglages) ? json.reglages : Array.isArray(json?.entrees) ? json.entrees : null;
  if (!liste) return { entrees: [], constats: ["registre sans liste d'entrées : attendu un tableau, ou un objet qui le porte sous `reglages` ou `entrees`"] };
  if (!liste.length) return { entrees: [], constats: ["registre vide : aucun réglage à comparer"] };
  const entrees = [];
  liste.forEach((e, i) => {
    const manque = CLES_ENTREE.filter(k => typeof e?.[k] !== "string" || !e[k].trim());
    if (manque.length) { constats.push(`entrée ${i + 1} du registre invalide : clé(s) absente(s) ou vide(s) : ${manque.join(", ")}`); return; }
    if (!CLASSEMENTS.includes(e.classement)) { constats.push(`entrée ${i + 1} du registre (« ${e.reglage} ») : classement « ${e.classement} » inconnu (attendu defaut ou decision)`); return; }
    entrees.push(e);
  });
  return { entrees, constats };
}

// Compare la valeur lue à l'attendu du registre. Rend { ok, motif }.
// Les formes de l'attendu sont celles du registre du 06/11/2026 ; une forme inconnue se compare à la lettre (chaîne égale).
export function comparer(attendu, luBrut, declare = null) {
  const att = String(attendu).trim();
  const lu = normaliser(luBrut);
  if (lu === undefined || lu === null || lu === "") return { ok: false, motif: "aucune valeur lue" };
  // Restriction des adresses : v4 et v6 non vides ensemble (une liste vide laisse tout passer), sans plage ouverte, status applied.
  if (/^v4 et v6 /.test(att)) {
    if (typeof lu !== "object") return { ok: false, motif: "valeur lue non structurée (attendu { v4, v6, status })" };
    const v4 = Array.isArray(lu.v4) ? lu.v4.map(String) : [], v6 = Array.isArray(lu.v6) ? lu.v6.map(String) : [];
    if (!v4.length && !v6.length) return { ok: false, motif: "aucune plage déclarée (v4 et v6 vides) : une liste vide laisse tout passer" };
    const ouvertes = [...v4, ...v6].filter(p => p === "0.0.0.0/0" || p === "::/0");
    if (ouvertes.length) return { ok: false, motif: `plage ouverte à tous : ${ouvertes.join(", ")}` };
    if (lu.status !== "applied") return { ok: false, motif: `status « ${lu.status} » au lieu de « applied »` };
    if (declare) {
      const d4 = [...(declare.v4 ?? [])].sort(), d6 = [...(declare.v6 ?? [])].sort();
      if (!egal([...v4].sort(), d4) || !egal([...v6].sort(), d6)) return { ok: false, motif: `plages lues (${v4.join(",")} ; ${v6.join(",")}) différentes de celles que le produit déclare (${d4.join(",")} ; ${d6.join(",")})` };
    }
    return { ok: true };
  }
  // « contient a, b et c » : chaque élément figure dans la valeur lue (liste, ou chaîne).
  const contient = /^contient\s+(.+)$/.exec(att);
  if (contient) {
    const elements = contient[1].split(/,\s*|\s+et\s+/).map(s => s.trim()).filter(Boolean);
    const manquants = elements.filter(e => (Array.isArray(lu) ? !lu.map(String).includes(e) : !String(typeof lu === "object" ? JSON.stringify(lu) : lu).includes(e)));
    return manquants.length ? { ok: false, motif: `manque : ${manquants.join(", ")}` } : { ok: true };
  }
  // « k = v, k >= n » : des conditions sur un objet.
  if (/\s(=|>=)\s/.test(att)) {
    if (typeof lu !== "object" || Array.isArray(lu)) return { ok: false, motif: "valeur lue non structurée (attendu un objet)" };
    for (const c of att.split(/,\s*/)) {
      const m = /^(\w+)\s*(=|>=)\s*(.+)$/.exec(c.trim());
      if (!m) return { ok: false, motif: `condition « ${c} » illisible` };
      const [, cle, op, val] = m;
      const v = val === "true" ? true : val === "false" ? false : /^-?\d+(\.\d+)?$/.test(val) ? Number(val) : val;
      if (op === "=" ? !egal(lu[cle], v) : !(Number(lu[cle]) >= Number(v))) return { ok: false, motif: `${cle} = ${JSON.stringify(lu[cle])}, attendu ${op} ${val}` };
    }
    return { ok: true };
  }
  // « true… » / « false… » (suivi d'une glose entre parenthèses) : un booléen.
  const booleen = /^(true|false)\b/.exec(att);
  if (booleen) return lu === (booleen[1] === "true") ? { ok: true } : { ok: false, motif: `lu ${JSON.stringify(lu)}, attendu ${booleen[1]}` };
  // « 0 (réponse 204) » : le code de sortie de la lecture.
  if (/^0\b/.test(att)) return String(lu).trim() === "0" ? { ok: true } : { ok: false, motif: `code de sortie ${JSON.stringify(lu)}, attendu 0` };
  return String(lu).trim() === att ? { ok: true } : { ok: false, motif: `lu ${JSON.stringify(lu)}, attendu « ${att} »` };
}

const AAAA_MM_JJ = /^\d{4}-\d{2}-\d{2}$/;

// Juge un relevé contre le registre. Rend { constats: [{ sev, msg }], compares }.
//   registre : entrées déjà validées ; releve : l'objet du relevé ; ecarts : liste des écarts acceptés ([] si aucun).
export function jugerReglages({ entrees, releve, ecarts = [] }) {
  const constats = [];
  const plateformes = (Array.isArray(releve?.plateformes) ? releve.plateformes : []).map(p => String(p).trim()).filter(Boolean);
  if (releve?.format !== "forge-ops/reglages-plateforme@1") constats.push({ sev: "bloquant", msg: `relevé de format « ${releve?.format} » (attendu forge-ops/reglages-plateforme@1)` });
  if (!plateformes.length) { constats.push({ sev: "bloquant", msg: "relevé sans `plateformes` : le produit doit dire sur quelles plateformes il s'appuie, sinon aucun réglage n'est exigé" }); return { constats, compares: 0 }; }
  const connues = [...new Set(entrees.map(e => e.plateforme))];
  const bas = (s) => s.toLowerCase();
  for (const p of plateformes)
    if (!connues.some(c => bas(c) === bas(p))) constats.push({ sev: "info", msg: `plateforme « ${p} » : aucun réglage au registre (il couvre ${connues.join(", ")}) — rien n'y est comparé` });
  const lus = new Map((Array.isArray(releve.reglages) ? releve.reglages : []).map(r => [brut(r?.reglage), r]));
  const parReglage = new Map((Array.isArray(ecarts) ? ecarts : []).map(e => [brut(e?.reglage), e]));
  const vus = new Set();
  let compares = 0;
  for (const e of entrees) {
    if (!plateformes.some(p => bas(p) === bas(e.plateforme))) continue;
    const nom = `${e.plateforme} · ${e.reglage}`;
    vus.add(e.reglage);
    const lecture = lus.get(e.reglage);
    if (!lecture) { constats.push({ sev: "bloquant", msg: `réglage « ${nom} » (classé ${e.classement}) NON LU : le relevé ne le porte pas — ${e.classement === "defaut" ? "un réglage par défaut non relu n'est pas vérifié à la livraison" : "la décision n'est pas vérifiée telle que prise"} ; relire par sa commande : ${e.cmd_lire}` }); continue; }
    if (lecture.erreur) { constats.push({ sev: "bloquant", msg: `réglage « ${nom} » : la lecture a échoué (${String(lecture.erreur).slice(0, 160)}) — une lecture en échec ne vaut jamais PASS` }); continue; }
    compares++;
    const verdict = comparer(e.attendu, lecture.lu, lecture.declare ?? null);
    const ecart = parReglage.get(e.reglage);
    if (verdict.ok) {
      constats.push({ sev: "info", msg: `réglage « ${nom} » (${e.classement}) conforme à l'attendu « ${e.attendu} »` });
      if (ecart) constats.push({ sev: "info", msg: `écart accepté pour « ${nom} » devenu sans objet : le réglage est conforme` });
      continue;
    }
    if (!ecart) {
      constats.push({ sev: "bloquant", msg: `réglage « ${nom} » (classé ${e.classement}) hors de son attendu « ${e.attendu} » : ${verdict.motif} — écart NU, ni appliqué ni décidé ; ${e.classement === "defaut" ? `appliquer : ${e.cmd_appliquer}` : "poser la décision de l'humain (écart accepté avec ses mots et sa date) ou appliquer le réglage"}` });
      continue;
    }
    const decision = String(ecart.decision ?? "").trim();
    if (decision.length < 10) { constats.push({ sev: "bloquant", msg: `écart accepté pour « ${nom} » sans décision : le champ \`decision\` doit citer les mots de l'humain (au moins 10 caractères), pas « ${decision} »` }); continue; }
    if (!AAAA_MM_JJ.test(String(ecart.date ?? ""))) { constats.push({ sev: "bloquant", msg: `écart accepté pour « ${nom} » sans date (AAAA-MM-JJ) : une décision non datée ne se rejoue pas` }); continue; }
    if (!egal(normaliser(ecart.lu), normaliser(lecture.lu))) {
      constats.push({ sev: "bloquant", msg: `écart accepté pour « ${nom} » (décision du ${ecart.date}) : l'état lu ${JSON.stringify(normaliser(lecture.lu))} n'est plus celui qui a été accepté ${JSON.stringify(normaliser(ecart.lu))} — l'écart n'est plus celui qui a été décidé, à décider de nouveau` });
      continue;
    }
    constats.push({ sev: "info", msg: `réglage « ${nom} » hors de son attendu (${verdict.motif}), écart ACCEPTÉ tel que décidé le ${ecart.date} : « ${decision.slice(0, 120)} »` });
  }
  for (const [reglage] of parReglage)
    if (!vus.has(reglage)) constats.push({ sev: "majeur", msg: `écart accepté pour « ${reglage} » : ce réglage n'est dans le registre d'aucune des plateformes déclarées (${plateformes.join(", ")}) — un écart orphelin ne couvre rien` });
  return { constats, compares };
}

// ── Le relevé : lire chaque réglage par sa `cmd_lire`, en lecture seule ──────────────────────────────────────────────────────
// Une commande de lecture ne modifie rien : un verbe d'écriture HTTP (-X PUT|POST|PATCH|DELETE), un corps (-d, --data, --input) ou
// un champ de `gh api` (-f, -F, qui font passer l'appel en POST) la disqualifie. Le registre est la donnée du pilot, mais une
// commande de lecture qui écrirait n'est jamais jouée.
const ECRITURE = /(?:^|\s)(?:-X|--request|--method)\s*=?\s*['"]?(?:PUT|POST|PATCH|DELETE)\b|(?:^|\s)(?:-d|--data(?:-\w+)?|--json|--input|-f|-F|--field|--raw-field)(?:\s|=|$)/i;
export const estLecture = (commande) => !ECRITURE.test(String(commande));

// Les variables d'environnement que la commande lit (`$NOM` ou `${NOM}`, majuscules) : le secret reste dans l'environnement du run.
export function variablesDe(commande) {
  return [...new Set([...String(commande).matchAll(/\$\{?([A-Z][A-Z0-9_]*)\}?/g)].map(m => m[1]))];
}

// Le registre du pilot : `$FORGE_ROOT`, sinon le parent de ce dépôt (le parc `C:\dev`), puis `digit-ai-factory/references/`.
export function cheminRegistreDuPilot(env = process.env, dossierForge = null) {
  const racine = env.FORGE_ROOT || (dossierForge ? dossierForge.replace(/[\\/]+[^\\/]+[\\/]*$/, "") : null);
  return racine ? `${racine.replace(/[\\/]+$/, "")}/digit-ai-factory/references/REGLAGES-SURS-PAR-DEFAUT.json` : null;
}

// Relève les réglages des plateformes données. `lancer(commande, env)` rend { status, stdout, stderr } (shell injecté).
// Rend { releve, refus } : le relevé (forme forge-ops/reglages-plateforme@1) et les commandes jamais jouées avec leur motif.
export function relever({ entrees, plateformes, env = process.env, lancer, horloge = () => new Date().toISOString() }) {
  const bas = (s) => String(s).toLowerCase();
  const choisies = entrees.filter(e => plateformes.some(p => bas(p) === bas(e.plateforme)));
  const reglages = [], refus = [];
  for (const e of choisies) {
    const base = { reglage: e.reglage, commande: e.cmd_lire };
    if (!estLecture(e.cmd_lire)) { reglages.push({ ...base, erreur: "commande de lecture refusée : elle écrit (verbe d'écriture, corps ou champ)" }); refus.push({ reglage: e.reglage, motif: "écriture" }); continue; }
    const absentes = variablesDe(e.cmd_lire).filter(v => !(v in env) || env[v] === "");
    if (absentes.length) { reglages.push({ ...base, erreur: `variable(s) d'environnement absente(s) : ${absentes.join(", ")}` }); continue; }
    const r = lancer(e.cmd_lire, env);
    if (r.status !== 0 && !/echo \$\?/.test(e.cmd_lire)) reglages.push({ ...base, erreur: `commande en échec (exit ${r.status}) : ${String(r.stderr || r.stdout).trim().slice(0, 160)}` });
    else reglages.push({ ...base, lu: normaliser(String(r.stdout ?? "").trim()) });
  }
  return { releve: { format: "forge-ops/reglages-plateforme@1", releve_le: horloge(), plateformes: [...plateformes], reglages }, refus };
}

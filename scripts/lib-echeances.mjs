// lib-echeances.mjs — juge un échéancier déclaré contre le relevé des publications lues : une échéance DÉPASSÉE sans publication lue
// est une alerte nommée (TF-2560, décision humaine D-108 (b) du 14/11/2026, option (a), deuxième membre).
//
// LE FAIT (œil critique du 29/10/2026, DESKTOP-ULTRA7). Une tâche planifiée de publication sur un réseau social est déclarée « C'est en
// service » le 21/10/2026 à 04:56 ; aucune publication du 20 au 25/10 ; la vérification armée à 18:45 n'a pas eu lieu. Quatre jours
// d'exposition. O-22 (`--mise-en-service`) juge un DOCUMENT quand on le rejoue : il ne tourne pas à l'échéance, et la vérification qui
// la surveillait était posée DANS la tâche qu'elle surveillait — une tâche arrêtée n'exécute plus rien, surveillance comprise.
//
// CE QUE FAIT LA BIBLIOTHÈQUE. Elle lit deux fichiers que le run écrit depuis ses lectures, rien d'autre :
//   l'échéancier `forge-ops/echeancier@1` — ce que les tâches DOIVENT publier, et où elles tournent :
//     { "format": "forge-ops/echeancier@1",
//       "taches": [ { "nom": "…", "planificateur": "<identifiant de ce qui exécute la tâche>",
//                     "delai_min": 60,                       (minutes de tolérance autour de l'échéance, obligatoire, aucun défaut)
//                     "echeances": [ "<instant ISO 8601 avec fuseau>", … ] } ] }
//   le relevé `forge-ops/publications-lues@1` — ce que le run a LU sur la plateforme (la forge ne la lit pas) :
//     { "format": "forge-ops/publications-lues@1", "releve_le": "<instant ISO 8601 avec fuseau>",
//       "lectures": [ { "tache": "…", "identifiant": "<id ou URL de la publication>", "publie_le": "<instant>", "lu_le": "<instant>" } ] }
//
// Une échéance E de délai d est DÉPASSÉE quand E + d est avant l'instant de référence. Elle est HONORÉE par une lecture valide de la
// même tâche dont `publie_le` tombe dans [E − d, E + d]. Une lecture n'est valide que si son identifiant en est un (ni un mot, ni une
// date, ni un essai) et si elle a été lue avant le relevé. Une échéance dépassée non honorée est une ALERTE `ECHEANCE-DEPASSEE`, une
// par échéance et par tâche ; si le relevé est antérieur à la fin de sa fenêtre, il ne peut pas dire qu'elle a été manquée :
// `RELEVE-ANTERIEUR` (non jugeable), jamais un « à jour » par défaut.
//
// L'INDÉPENDANCE. Le contrôle ne s'exécute pas dans la tâche qu'il contrôle : l'appelant déclare `lance_par`, l'identifiant du
// planificateur qui le lance ; s'il est absent, ou s'il est celui d'une tâche de l'échéancier, le contrôle est refusé (illisible, 2).
// L'identifiant est une déclaration : la forge ne voit pas le planificateur du run (limite dite, G-09).
//
// Verdicts (code de sortie de l'outil) : `a-jour` (0) aucune échéance dépassée sans lecture · `alerte` (1) au moins une ·
// `releve-anterieur` (3) aucune alerte, mais une échéance dépassée que le relevé ne peut pas juger · `illisible` (2) entrée qu'on ne
// sait pas juger, dont une surveillance lancée dans la tâche surveillée — jamais un verdict inventé.

export const FORMAT_ECHEANCIER = "forge-ops/echeancier@1";
export const FORMAT_RELEVE = "forge-ops/publications-lues@1";
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ESSAI = /\b(essais?|a blanc|dry-?run|simul\w*|mock|factice|fictif)\b/;
const MIN = 60 * 1000;

const illisible = raison => ({ verdict: "illisible", code: 2, raison });
const sansAccents = s => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// Un instant ISO 8601 AVEC fuseau → ms, ou null. Sans fuseau, la même chaîne ne désigne pas le même instant d'un poste à l'autre.
export function instant(valeur) {
  if (typeof valeur !== "string" || !INSTANT.test(valeur)) return null;
  const ms = Date.parse(valeur);
  return Number.isNaN(ms) ? null : ms;
}

// L'identifiant d'une publication lue → null s'il en est un, sinon le motif du refus (mêmes mots que O-22 : id ou URL, jamais un essai).
export function refusIdentifiant(id) {
  if (typeof id !== "string" || !id.trim()) return "identifiant absent";
  const s = id.trim();
  const essai = ESSAI.test(sansAccents(s)) && !/\breel(le)?s?\b/.test(sansAccents(s));
  const aUrl = /https?:\/\/[^\s)>\]]+/i.test(s);
  const aId = s.split(/[\s,;()]+/).some(w => w.length >= 6 && /\d/.test(w) && /^[\w:.\-\/]+$/.test(w) && !/^\d{4}-\d{2}-\d{2}/.test(w) && !/^\d{1,2}[:hH]\d{2}$/.test(w));
  if (!aUrl && !aId) return `« ${s.slice(0, 40)} » n'est ni un identifiant ni une URL de publication`;
  if (essai) return `« ${s.slice(0, 40)} » cite un essai : la preuve est celle d'une publication réelle`;
  return null;
}

export function jugerEcheances(echeancier, releve, { lance_par, reference }) {
  if (typeof lance_par !== "string" || !lance_par.trim()) return illisible("lance_par absent : le contrôle déclare le planificateur qui le lance, pour prouver qu'il ne tourne pas dans la tâche qu'il surveille");
  if (typeof reference !== "number" || Number.isNaN(reference)) return illisible("instant de référence illisible");
  if (!echeancier || typeof echeancier !== "object" || Array.isArray(echeancier)) return illisible("l'échéancier n'est pas un objet JSON");
  if (echeancier.format !== FORMAT_ECHEANCIER) return illisible(`échéancier : format « ${echeancier.format ?? "absent"} », ${FORMAT_ECHEANCIER} attendu`);
  if (!Array.isArray(echeancier.taches) || echeancier.taches.length === 0) return illisible("échéancier : aucune tâche (taches) — un échéancier vide ne surveille rien");
  const noms = new Set();
  const taches = [];
  for (const [i, t] of echeancier.taches.entries()) {
    const n = `tâche n°${i + 1}`;
    if (!t || typeof t.nom !== "string" || !t.nom.trim()) return illisible(`échéancier : ${n} sans nom`);
    if (noms.has(t.nom)) return illisible(`échéancier : la tâche « ${t.nom} » figure deux fois`);
    noms.add(t.nom);
    if (typeof t.planificateur !== "string" || !t.planificateur.trim()) return illisible(`échéancier : tâche « ${t.nom} » sans planificateur — sans lui, l'indépendance du contrôle ne se prouve pas`);
    if (t.planificateur.trim() === lance_par.trim()) return illisible(`le contrôle est lancé par « ${lance_par} », le planificateur de la tâche « ${t.nom} » : une surveillance posée dans la tâche qu'elle surveille s'arrête avec elle (le fait du 21/10/2026) ; la lancer d'un autre planificateur`);
    if (!Number.isInteger(t.delai_min) || t.delai_min <= 0) return illisible(`échéancier : tâche « ${t.nom} », delai_min doit être un entier de minutes strictement positif (aucun défaut implicite)`);
    if (!Array.isArray(t.echeances) || t.echeances.length === 0) return illisible(`échéancier : tâche « ${t.nom} » sans échéances`);
    const ech = [];
    for (const e of t.echeances) {
      const ms = instant(e);
      if (ms === null) return illisible(`échéancier : tâche « ${t.nom} », échéance « ${String(e).slice(0, 40)} » illisible — attendu ISO 8601 avec fuseau (2026-10-21T09:00:00Z ou +02:00)`);
      ech.push(ms);
    }
    ech.sort((a, b) => a - b);
    const d = t.delai_min * MIN;
    for (let k = 1; k < ech.length; k++)
      if (ech[k] - ech[k - 1] < 2 * d) return illisible(`échéancier : tâche « ${t.nom} », les fenêtres de deux échéances se chevauchent (écart < 2 × delai_min) : une lecture honorerait les deux`);
    taches.push({ nom: t.nom, planificateur: t.planificateur.trim(), d, ech });
  }
  if (!releve || typeof releve !== "object" || Array.isArray(releve)) return illisible("le relevé n'est pas un objet JSON");
  if (releve.format !== FORMAT_RELEVE) return illisible(`relevé : format « ${releve.format ?? "absent"} », ${FORMAT_RELEVE} attendu`);
  const releveLe = instant(releve.releve_le);
  if (releveLe === null) return illisible("relevé : releve_le absent ou illisible (ISO 8601 avec fuseau) — sans lui, on ne sait pas jusqu'où le relevé voit");
  if (releveLe > reference) return illisible("relevé : releve_le est postérieur à l'instant de référence — un relevé daté du futur n'en est pas un");
  if (!Array.isArray(releve.lectures)) return illisible("relevé : lectures absentes (tableau, vide si rien n'a été lu)");
  const lectures = [];
  const ignorees = [];
  for (const [i, l] of releve.lectures.entries()) {
    if (!l || typeof l.tache !== "string") return illisible(`relevé : lecture n°${i + 1} sans tâche`);
    const publie = instant(l.publie_le), lu = instant(l.lu_le);
    if (publie === null || lu === null) return illisible(`relevé : lecture n°${i + 1} (${l.tache}), publie_le ou lu_le illisible — attendu ISO 8601 avec fuseau`);
    if (lu > releveLe) return illisible(`relevé : lecture n°${i + 1} (${l.tache}) lue après le relevé (lu_le > releve_le)`);
    if (lu < publie) return illisible(`relevé : lecture n°${i + 1} (${l.tache}) lue avant d'être publiée (lu_le < publie_le)`);
    const refus = refusIdentifiant(l.identifiant);
    if (refus) { ignorees.push({ tache: l.tache, identifiant: String(l.identifiant ?? ""), motif: refus }); continue; }
    lectures.push({ tache: l.tache, identifiant: l.identifiant.trim(), publie });
  }
  const iso = ms => new Date(ms).toISOString();
  const alertes = [], nonJugeables = [];
  let aVenir = 0, honorees = 0;
  for (const t of taches) {
    const siennes = lectures.filter(l => l.tache === t.nom);
    const derniere = siennes.length ? siennes.reduce((a, b) => (b.publie >= a.publie ? b : a)) : null;
    for (const e of t.ech) {
      const fin = e + t.d;
      if (fin >= reference) { aVenir++; continue; }
      if (siennes.some(l => l.publie >= e - t.d && l.publie <= fin)) { honorees++; continue; }
      const base = { tache: t.nom, planificateur: t.planificateur, echeance: iso(e), fenetre_jusqu_a: iso(fin) };
      if (fin > releveLe)
        nonJugeables.push({ nom: "RELEVE-ANTERIEUR", ...base, releve_le: iso(releveLe), raison: `la fenêtre de l'échéance du ${iso(e)} se ferme à ${iso(fin)}, après le relevé (${iso(releveLe)}) : il ne peut pas dire qu'elle a été manquée ; relire la plateforme et refaire le relevé` });
      else
        alertes.push({ nom: "ECHEANCE-DEPASSEE", ...base, depassee_depuis_min: Math.round((reference - fin) / MIN), derniere_lecture: derniere ? { identifiant: derniere.identifiant, publie_le: iso(derniere.publie) } : null,
          raison: `l'échéance de « ${t.nom} » du ${iso(e)} est dépassée de ${Math.round((reference - fin) / MIN)} min (fenêtre close à ${iso(fin)}) sans publication lue ; ${derniere ? `la dernière publication lue date du ${iso(derniere.publie)}` : "aucune publication valide lue pour cette tâche"}` });
    }
  }
  const base = { lance_par: lance_par.trim(), reference: iso(reference), releve_le: iso(releveLe), taches: taches.length, echeances_honorees: honorees, echeances_a_venir: aVenir, alertes, non_jugeables: nonJugeables, lectures_ignorees: ignorees };
  if (alertes.length)
    return { ...base, verdict: "alerte", code: 1, raison: `${alertes.length} échéance(s) dépassée(s) sans publication lue (${[...new Set(alertes.map(a => a.tache))].join(", ")})${nonJugeables.length ? `, et ${nonJugeables.length} que le relevé ne peut pas juger` : ""}` };
  if (nonJugeables.length)
    return { ...base, verdict: "releve-anterieur", code: 3, raison: `${nonJugeables.length} échéance(s) dépassée(s) que le relevé, antérieur à leur fenêtre, ne peut pas juger : refaire le relevé, ce n'est pas un « à jour »` };
  return { ...base, verdict: "a-jour", code: 0, raison: `aucune échéance dépassée sans publication lue (${honorees} honorée(s), ${aVenir} à venir)` };
}

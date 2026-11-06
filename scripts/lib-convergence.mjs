// lib-convergence.mjs — une chaîne Terraform n'est réussie que si le plan SUIVANT son apply est vide (TF-2271,
// lot Produit-86 20261106a RP-44, ledger seq 609, décision R-58 du 06/11/2026).
//
// LE FAIT. À chaque plan, le fournisseur Terraform Docker annonçait 5 conteneurs « mis à jour sur place » (sondes de
// santé, memory_swap) qu'il n'appliquait jamais. La sonde de WebGoat, désactivée au code depuis le 04/11, n'a jamais
// atteint le conteneur, « unhealthy » depuis 47 h. La chaîne rendait PASS après chaque apply sans vérifier que l'état
// convergeait : « Plan: 0 to add, 5 to change, 0 to destroy » sur une préproduction déployée la veille par elle.
//
// CE QUE FAIT CE MODULE (aucun appel réseau, aucune écriture ; il lit une capture déjà obtenue) :
//   lireCapture(texte)   juge la capture d'un plan pris APRÈS l'apply, sous deux formes : `terraform show -json <plan>`
//                        (resource_changes) ou la sortie texte de `terraform plan -no-color` ;
//   converger(…)         la boucle de la chaîne, le lancement de Terraform étant injecté (`lancer`) : re-planifier, et si le
//                        plan n'est pas vide, forcer le remplacement (`-replace`) de ce que le fournisseur ne change pas sur
//                        place, puis re-planifier. Un tour de remplacement, pas deux : ce qui résiste après lui est un
//                        constat, jamais une boucle.
// Le remède est éprouvé avec Terraform 1.12.2 le 06/11/2026 : `terraform plan -replace=<adresse>` annonce « will be
// replaced, as requested », `terraform apply -replace=<adresse>` l'applique, le plan suivant est vide (exit 0).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ANSI = /\u001b\[[0-9;]*m/g;
const SANS_CHANGEMENT = [["no-op"], ["read"]];
const memeActions = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const egal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Les attributs dont la valeur change entre l'état et le plan, ou n'est connue qu'à l'apply.
function attributsChanges(change) {
  const avant = change?.before && typeof change.before === "object" ? change.before : {};
  const apres = change?.after && typeof change.after === "object" ? change.after : {};
  const inconnu = change?.after_unknown && typeof change.after_unknown === "object" ? change.after_unknown : {};
  const cles = new Set([...Object.keys(avant), ...Object.keys(apres), ...Object.keys(inconnu)]);
  return [...cles].filter(k => inconnu[k] === true || !egal(avant[k], apres[k])).sort();
}

// L'image d'une ressource, pour reconnaître un conteneur à état (nom du dépôt sans registre ni étiquette).
export function imageDe(change) {
  const brut = change?.after?.image ?? change?.before?.image;
  if (typeof brut !== "string" || !brut.trim()) return null;
  const sansEtiquette = brut.trim().replace(/@sha256:[0-9a-f]+$/i, "").replace(/:[^/:]+$/, "");
  return sansEtiquette.split("/").pop().toLowerCase();
}

// Juge la capture d'un plan pris après l'apply.
// Rend { genre, vide, ressources: [{ adresse, actions, attributs, image }], erreur }.
//   vide === true  : le plan est vide, l'infrastructure converge ;
//   vide === false : au moins une ressource change encore (ou un décompte « Plan: » non nul) ;
//   vide === null  : la capture n'est pas lisible, `erreur` le dit — jamais un PASS.
export function lireCapture(texte) {
  const brut = String(texte ?? "").replace(/^﻿/, "");
  if (!brut.trim()) return { genre: null, vide: null, ressources: [], erreur: "capture vide" };
  if (/^\s*[{[]/.test(brut)) {
    let json = null;
    try { json = JSON.parse(brut); } catch (e) { return { genre: "json", vide: null, ressources: [], erreur: `JSON invalide (${String(e.message).slice(0, 80)})` }; }
    if (!json || !Array.isArray(json.resource_changes))
      return { genre: "json", vide: null, ressources: [], erreur: "pas de `resource_changes` : attendu la sortie de `terraform show -json <fichier de plan>`" };
    const ressources = [];
    for (const rc of json.resource_changes) {
      const actions = Array.isArray(rc?.change?.actions) ? rc.change.actions.map(String) : [];
      if (!actions.length || SANS_CHANGEMENT.some(s => memeActions(actions, s))) continue;
      ressources.push({ adresse: String(rc.address ?? `${rc.type}.${rc.name}`), actions, attributs: attributsChanges(rc.change), image: imageDe(rc.change) });
    }
    return { genre: "json", vide: ressources.length === 0, ressources, erreur: null };
  }
  const texteNu = brut.replace(ANSI, "");
  const decompte = /Plan:\s+(\d+) to add,\s+(\d+) to change,\s+(\d+) to destroy/.exec(texteNu);
  const adresses = [...texteNu.matchAll(/^\s*#\s+(\S+)\s+(?:will be|must be)\s+([^\n]+?)\s*$/gm)].map(m => ({ adresse: m[1], actions: [m[2]], attributs: [], image: null }));
  if (decompte) {
    const total = Number(decompte[1]) + Number(decompte[2]) + Number(decompte[3]);
    return { genre: "texte", vide: total === 0, ressources: adresses, erreur: null, decompte: decompte.slice(1, 4).map(Number) };
  }
  if (/No changes\.|Your infrastructure matches the configuration/.test(texteNu)) return { genre: "texte", vide: true, ressources: [], erreur: null };
  return { genre: "texte", vide: null, ressources: [], erreur: "ni « No changes. » ni « Plan: N to add, N to change, N to destroy. » : ce n'est pas la sortie d'un plan" };
}

// La commande du remède, à jouer par un shell POSIX (les adresses portent des crochets et des guillemets).
export const commandeRemplacement = (adresses) => `terraform apply ${adresses.map(a => `-replace='${a}'`).join(" ")}`;

// Les ressources qu'un `-replace` peut corriger : celles que le plan dit « update ». Un conteneur à état (image du
// référentiel O-20) n'est jamais remplacé par la chaîne : son remplacement perd ses données si le volume manque.
export function partagerRemplacements(ressources, imagesAEtat = []) {
  const a = new Set(imagesAEtat.map(i => String(i).toLowerCase()));
  const remplacables = [], refusees = [], autres = [];
  for (const r of ressources) {
    const enPlace = r.actions.length === 1 && (r.actions[0] === "update" || /updated in-place/.test(r.actions[0]));
    if (!enPlace) autres.push(r);
    else if (r.image && a.has(r.image)) refusees.push(r);
    else remplacables.push(r);
  }
  return { remplacables, refusees, autres };
}

// Le référentiel O-20 des images à état (noms de dépôt), ou [] s'il est illisible.
export function imagesAEtatDuReferentiel(fichier) {
  try { return [...new Set(JSON.parse(fs.readFileSync(fichier, "utf8")).images.map(i => String(i.image).toLowerCase()))]; }
  catch { return []; }
}

// Re-planifie la pile. `lancer(args)` rend { status, stdout, stderr } (Terraform, injecté).
// Rend { etat: "converge" | "non-converge" | "erreur", lecture, capture, detail }.
export function replanifier(lancer, pile, { dossierTemp = os.tmpdir() } = {}) {
  const fichierPlan = path.join(dossierTemp, `forge-ops-convergence-${process.pid}-${Date.now()}.tfplan`);
  const plan = lancer([`-chdir=${pile}`, "plan", "-input=false", "-no-color", "-detailed-exitcode", `-out=${fichierPlan}`]);
  try {
    if (plan.status === 0) {
      // Plan vide (exit 0) : la capture JSON, quand Terraform la rend, est gardée pour le dossier de MEP et pour O-29.
      const vide = lancer([`-chdir=${pile}`, "show", "-json", "-no-color", fichierPlan]);
      return { etat: "converge", lecture: { genre: "texte", vide: true, ressources: [], erreur: null }, capture: vide.status === 0 ? vide.stdout : null, detail: "plan vide (exit 0)" };
    }
    if (plan.status !== 2) return { etat: "erreur", lecture: null, capture: null, detail: `terraform plan a échoué (exit ${plan.status}) : ${String(plan.stderr || plan.stdout).trim().slice(0, 300)}` };
    const montre = lancer([`-chdir=${pile}`, "show", "-json", "-no-color", fichierPlan]);
    if (montre.status !== 0) return { etat: "erreur", lecture: null, capture: null, detail: `terraform show -json a échoué (exit ${montre.status}) : ${String(montre.stderr || montre.stdout).trim().slice(0, 300)}` };
    const lecture = lireCapture(montre.stdout);
    if (lecture.vide === null) return { etat: "erreur", lecture, capture: montre.stdout, detail: `capture illisible : ${lecture.erreur}` };
    return { etat: lecture.vide ? "converge" : "non-converge", lecture, capture: montre.stdout, detail: lecture.vide ? "plan vide" : `${lecture.ressources.length} ressource(s) changent encore` };
  } finally {
    try { fs.rmSync(fichierPlan, { force: true }); } catch { /* le plan temporaire se perd avec le dossier temporaire */ }
  }
}

// La boucle de la chaîne, APRÈS l'apply : re-planifier ; si le plan n'est pas vide, nommer ce qui résiste et le commande
// de remplacement ; avec `executer`, appliquer ce remplacement (un tour) puis re-planifier.
// Rend { verdict: "converge" | "non-converge" | "erreur", etapes: [...], remplacees, refusees, autres, commande }.
export function converger({ pile, lancer, executer = false, imagesAEtat = [], dossierTemp }) {
  const etapes = [];
  let r = replanifier(lancer, pile, { dossierTemp });
  etapes.push({ etape: "re-planification après l'apply", etat: r.etat, detail: r.detail });
  if (r.etat !== "non-converge") return { verdict: r.etat, etapes, remplacees: [], refusees: [], autres: [], commande: null, capture: r.capture };
  const { remplacables, refusees, autres } = partagerRemplacements(r.lecture.ressources, imagesAEtat);
  const commande = remplacables.length ? commandeRemplacement(remplacables.map(x => x.adresse)) : null;
  if (!executer || !remplacables.length)
    return { verdict: "non-converge", etapes, remplacees: [], refusees, autres, commande, capture: r.capture, ressources: r.lecture.ressources };
  const applique = lancer([`-chdir=${pile}`, "apply", "-input=false", "-no-color", "-auto-approve", ...remplacables.map(x => `-replace=${x.adresse}`)]);
  etapes.push({ etape: "remplacement forcé", etat: applique.status === 0 ? "ok" : "erreur", detail: applique.status === 0 ? `${remplacables.length} ressource(s) remplacée(s)` : `terraform apply -replace a échoué (exit ${applique.status}) : ${String(applique.stderr || applique.stdout).trim().slice(0, 300)}` });
  if (applique.status !== 0) return { verdict: "erreur", etapes, remplacees: [], refusees, autres, commande, capture: r.capture };
  r = replanifier(lancer, pile, { dossierTemp });
  etapes.push({ etape: "re-planification après le remplacement", etat: r.etat, detail: r.detail });
  return { verdict: r.etat, etapes, remplacees: remplacables, refusees, autres, commande, capture: r.capture, ressources: r.lecture?.ressources ?? [] };
}

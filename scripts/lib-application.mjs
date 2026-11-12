// lib-application.mjs — l'application Terraform sonde la santé du projet avant d'appliquer, et relance de façon bornée
// sur l'erreur de santé du fournisseur (TF-2312, lot Produit-84 20261109b, ledger seq 264, décision R-58 du 10/11/2026).
//
// LE FAIT. Le 09/11/2026, la chaîne de dev 42685313136 a posé les limites d'Auth par `supabase_settings` et reçu
// « Project Services Unhealthy … unhealthy service realtime » : le fournisseur attend la santé de TOUS les services du
// projet après chaque modification, y compris d'un service que le produit n'utilise pas. Cinq minutes plus tard, les
// cinq services étaient sains et la relance a passé. Sur le projet de qualification, realtime est UNHEALTHY de façon
// durable (GET /v1/projects/{ref}/health) : sans sonde, la qualification échoue au même endroit, après avoir modifié
// des réglages à moitié.
//
// CE QUE FAIT CE MODULE (le lancement de Terraform, l'appel de santé et l'attente sont injectés : aucun réseau ici) :
//   sonderSante(…)        lit la santé des services du projet (API de gestion, HTTPS, jeton dans l'environnement du run) ;
//   attendreSante(…)      relit la santé, un nombre BORNÉ de fois, jusqu'à ce que tous les services soient sains ;
//   appliquer(…)          sonde AVANT d'appliquer (projet malsain après la borne : rien n'est appliqué), applique, et
//                         relance sur l'erreur de santé seulement, au plus `relances` fois, en relisant la santé entre
//                         deux essais. Toute autre erreur de Terraform s'arrête au premier essai : une relance n'est
//                         jamais un remède à une erreur dont on ignore la cause.
//   construireReleve(…)   le relevé `forge-ops/application@1` que `--sortie` écrit et qu'oracle-ops.mjs --application-terraform
//                         (O-31, scripts/lib-application-chaine.mjs) juge à la MEP (TF-2397).
// Désactiver un service inutilisé (realtime) reste une décision du produit, qui l'utilise ou non : la forge la nomme dans
// son constat, elle ne la prend pas.
import { Buffer } from "node:buffer";
import http from "node:http";
import https from "node:https";

// Le message du fournisseur quand un service du projet n'est pas sain à la fin d'une modification.
export const MOTIF_SANTE = /Project Services Unhealthy|unhealthy service/i;
export const SERVICES_PAR_DEFAUT = ["auth", "db", "pooler", "realtime", "rest", "storage"];
export const RELANCES_PAR_DEFAUT = 3;
export const ATTENTE_PAR_DEFAUT_S = 120;

const REF_PROJET = /^[a-z0-9-]{3,64}$/;
const NOM_SERVICE = /^[a-z_]{2,32}$/;
// Les services dont l'API de gestion rend la santé, relus dans sa référence publique sans jeton (aucun appel ici).
// Rejoués le 12/11/2026 sur la référence (opération v1-get-services-health) : même liste (TF-2397) ; fixtures/appliquer-terraform/api-sante-statuts.json.
export const SERVICES_CONNUS = new Set(["auth", "db", "db_postgres_user", "pooler", "pg_bouncer", "realtime", "rest", "storage"]);
// Le format du relevé que l'outil écrit par --sortie et que l'oracle O-31 juge (TF-2397).
export const FORMAT_RELEVE = "forge-ops/application@1";

// Le ou les services que le message d'erreur dit malsains (« unhealthy service realtime »), pour le constat.
export function servicesDuMessage(texte) {
  const m = /unhealthy services?\s*:?\s*([a-z_,\s]+?)(?:\.|\n|$|\s{2,})/i.exec(String(texte ?? ""));
  return m ? m[1].split(/[,\s]+/).map(s => s.trim()).filter(s => SERVICES_CONNUS.has(s)) : [];
}

export const erreurDeSante = (sortie) => MOTIF_SANTE.test(`${sortie?.stderr ?? ""}\n${sortie?.stdout ?? ""}`);

// Un service est sain quand son statut est ACTIVE_HEALTHY ; faute de statut, quand `healthy` vaut true. COMING_UP n'est
// PAS sain : le service démarre, la relecture suivante dira. Les trois statuts (COMING_UP, ACTIVE_HEALTHY, UNHEALTHY) et le
// booléen `healthy` (déprécié, « Use `status` instead ») sont ceux de la référence de l'API de gestion, relue le 12/11/2026.
export function etatService(s) {
  const nom = String(s?.name ?? "?");
  const statut = typeof s?.status === "string" ? s.status : null;
  const sain = statut ? statut === "ACTIVE_HEALTHY" : s?.healthy === true;
  return { nom, statut: statut ?? (s?.healthy === true ? "healthy" : "inconnu"), sain };
}

// Lit la santé du projet. `appeler(url, entetes)` rend { status, corps } (injecté). Rend
// { etat: "sain" | "malsain" | "erreur", services: [{ nom, statut, sain }], detail }.
// Jamais « sain » sur une réponse illisible, vide ou en erreur : une sonde muette est une erreur dite.
export async function sonderSante({ projet, jeton, base, services = SERVICES_PAR_DEFAUT, appeler }) {
  if (!REF_PROJET.test(String(projet ?? ""))) return { etat: "erreur", services: [], detail: "référence de projet absente ou illisible" };
  if (!jeton) return { etat: "erreur", services: [], detail: "SUPABASE_ACCESS_TOKEN absent de l'environnement du run : la santé ne peut pas être lue" };
  if (!services.length || !services.every(s => NOM_SERVICE.test(s))) return { etat: "erreur", services: [], detail: "liste de services illisible" };
  const url = `${String(base).replace(/\/+$/, "")}/v1/projects/${projet}/health?${services.map(s => `services=${s}`).join("&")}`;
  let r;
  try { r = await appeler(url, { Authorization: `Bearer ${jeton}`, Accept: "application/json" }); }
  catch (e) { return { etat: "erreur", services: [], detail: `l'API de gestion ne répond pas : ${String(e?.message ?? e).slice(0, 120)}` }; }
  if (r.status !== 200) return { etat: "erreur", services: [], detail: `l'API de gestion répond HTTP ${r.status} à la lecture de santé` };
  let corps;
  try { corps = typeof r.corps === "string" ? JSON.parse(r.corps) : r.corps; } catch { corps = null; }
  if (!Array.isArray(corps) || !corps.length) return { etat: "erreur", services: [], detail: "réponse de santé vide ou illisible : attendu un tableau de services" };
  const lus = corps.map(etatService);
  const manquants = services.filter(s => !lus.some(l => l.nom === s));
  if (manquants.length) return { etat: "erreur", services: lus, detail: `service(s) demandé(s) absent(s) de la réponse : ${manquants.join(", ")}` };
  const malsains = lus.filter(l => !l.sain);
  return malsains.length
    ? { etat: "malsain", services: lus, detail: `service(s) non sain(s) : ${malsains.map(l => `${l.nom} (${l.statut})`).join(", ")}` }
    : { etat: "sain", services: lus, detail: `${lus.length} service(s) sain(s)` };
}

// Relit la santé jusqu'à ce qu'elle soit saine, au plus `lectures` fois, en attendant `attenteMs` entre deux lectures.
// Rend la dernière sonde, avec le nombre de lectures faites. Une erreur de sonde interrompt : on ne devine pas.
export async function attendreSante({ sonder, lectures, attenteMs, dormir }) {
  let derniere = null, n = 0;
  while (n < Math.max(1, lectures)) {
    if (n > 0) await dormir(attenteMs);
    derniere = await sonder();
    n++;
    if (derniere.etat !== "malsain") break;
  }
  return { ...derniere, lectures: n };
}

// Le texte du constat quand un projet reste malsain : ce qui est mesuré, ce qui est à décider, par qui.
export function constatMalsain(services) {
  const noms = services.filter(s => !s.sain).map(s => s.nom);
  return `${noms.join(", ")} : la sonde le lit non sain après toutes les lectures permises. Le fournisseur attend la santé de tous les services après chaque modification : l'application échouerait au même endroit. Si le produit n'utilise pas ${noms.length > 1 ? "ces services" : "ce service"}, le désactiver est SA décision (réglage du projet), la forge ne le fait pas ; sinon, attendre le retour à la santé ou ouvrir un ticket auprès du fournisseur.`;
}

// La boucle. `lancer(args)` rend { status, stdout, stderr } (Terraform) ; `sonder()` rend la sonde (ou null : --sans-sonde) ;
// `dormir(ms)` attend. Rend { verdict, code, etapes: [{ etape, etat, detail }], relances, constat }.
//   verdict « applique »            exit 0 : l'apply a réussi (après `relances` relances) ;
//   verdict « sante-refusee »       exit 1 : projet malsain avant l'apply, rien n'a été appliqué ;
//   verdict « sante-persistante »   exit 1 : l'apply a échoué sur la santé à chaque essai permis ;
//   verdict « erreur »              exit 2 : autre erreur de Terraform, ou sonde en erreur ; jamais relancée.
export async function appliquer({ pile, lancer, sonder = null, relances = RELANCES_PAR_DEFAUT, attenteMs = ATTENTE_PAR_DEFAUT_S * 1000, dormir }) {
  const etapes = [];
  let derniereSonde = null;   // la dernière lecture de santé, pour le relevé (TF-2397)
  const fin = (verdict, code, constat = null, nbRelances = 0) => ({ verdict, code, etapes, relances: nbRelances, constat, sonde: derniereSonde });
  const attendre = async () => { const s = await attendreSante({ sonder, lectures: relances + 1, attenteMs, dormir }); derniereSonde = s; return s; };

  if (sonder) {
    const s = await attendre();
    etapes.push({ etape: "sonde avant l'application", etat: s.etat, detail: `${s.detail} (${s.lectures} lecture(s))` });
    if (s.etat === "erreur") return fin("erreur", 2, s.detail);
    if (s.etat === "malsain") return fin("sante-refusee", 1, constatMalsain(s.services));
  } else {
    etapes.push({ etape: "sonde avant l'application", etat: "non-jouee", detail: "--sans-sonde : la santé du projet n'a pas été lue avant d'appliquer" });
  }

  const args = [`-chdir=${pile}`, "apply", "-input=false", "-no-color", "-auto-approve"];
  for (let essai = 0; essai <= relances; essai++) {
    const r = lancer(args);
    if (r.status === 0) {
      etapes.push({ etape: `application, essai ${essai + 1}`, etat: "ok", detail: "terraform apply : exit 0" });
      return fin("applique", 0, null, essai);
    }
    const sortie = `${r.stderr || ""}\n${r.stdout || ""}`;
    if (!erreurDeSante(r)) {
      etapes.push({ etape: `application, essai ${essai + 1}`, etat: "erreur", detail: `terraform apply a échoué (exit ${r.status}) sur une erreur qui n'est pas de santé, aucune relance : ${sortie.trim().slice(0, 300)}` });
      return fin("erreur", 2, null, essai);
    }
    const noms = servicesDuMessage(sortie);
    etapes.push({ etape: `application, essai ${essai + 1}`, etat: "sante", detail: `erreur de santé du fournisseur${noms.length ? ` (service : ${noms.join(", ")})` : ""}, exit ${r.status}` });
    if (essai === relances) {
      return fin("sante-persistante", 1,
        `${relances} relance(s) permise(s) toutes jouées, l'application échoue encore sur la santé${noms.length ? ` de ${noms.join(", ")}` : ""}. Les modifications déjà acceptées par le fournisseur restent posées : relire l'état avant de rejouer.`, essai);
    }
    if (sonder) {
      const s = await attendre();
      etapes.push({ etape: `sonde avant la relance ${essai + 1}`, etat: s.etat, detail: `${s.detail} (${s.lectures} lecture(s))` });
      if (s.etat === "erreur") return fin("erreur", 2, s.detail, essai);
      if (s.etat === "malsain") return fin("sante-persistante", 1, constatMalsain(s.services), essai);
    } else {
      await dormir(attenteMs);
      etapes.push({ etape: `attente avant la relance ${essai + 1}`, etat: "ok", detail: `${Math.round(attenteMs / 1000)} s, sans sonde` });
    }
  }
  return fin("erreur", 2, "boucle épuisée sans verdict", relances); // inatteignable : la boucle rend toujours
}

// Le relevé `forge-ops/application@1` de ce que l'outil a fait, écrit par `--sortie` et jugé par l'oracle O-31 (TF-2397) :
// la pile, le choix de sonde, les étapes, le verdict, la dernière lecture de santé. Il ne conserve jamais la sortie de
// Terraform (elle peut citer des valeurs de la pile) ni le jeton : l'erreur « qui n'est pas de santé » est tronquée avant elle.
export function construireReleve({ pile, projet, sansSonde, res, debut, fin }) {
  const coupe = (d) => String(d).replace(/( aucune relance) : [\s\S]*$/, "$1 (sortie de Terraform non conservée dans le relevé)");
  return {
    format: FORMAT_RELEVE,
    pile,
    projet: sansSonde ? null : projet,
    executer: true,
    sonde: sansSonde ? "non-jouee" : "jouee",
    debut, fin,
    verdict: res.verdict,
    code: res.code,
    relances: res.relances,
    constat: res.constat ?? null,
    derniere_sonde: res.sonde ? { etat: res.sonde.etat, lectures: res.sonde.lectures, services: (res.sonde.services ?? []).map(s => ({ nom: s.nom, statut: s.statut, sain: s.sain })) } : null,
    etapes: res.etapes.map(e => ({ etape: e.etape, etat: e.etat, detail: coupe(e.detail) })),
  };
}

// Les gestes que la commande jouerait, pour l'essai à blanc (sans --executer, rien n'est appelé ni appliqué).
export function gestesPrevus({ pile, projet, relances, attenteS, services }) {
  return [
    projet ? `sonde : GET /v1/projects/${projet}/health?${services.map(s => `services=${s}`).join("&")} (API de gestion, HTTPS, lecture seule), jusqu'à ${relances + 1} lecture(s) espacées de ${attenteS} s ; projet malsain après la borne : rien n'est appliqué`
           : "sonde : NON JOUÉE (--sans-sonde)",
    `application : terraform -chdir=${pile} apply -input=false -no-color -auto-approve`,
    `relance : au plus ${relances}, seulement sur « Project Services Unhealthy » / « unhealthy service », ${attenteS} s d'attente${projet ? " et relecture de la santé" : ""} entre deux essais ; toute autre erreur s'arrête au premier essai`,
  ];
}

// Une lecture HTTPS (ou http sur la boucle locale pour la recette), sans connexion persistante : le processus n'attend
// aucun socket à sa sortie. Le jeton ne figure jamais dans une erreur rendue.
export function appelHttp(url, entetes) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const demande = (u.protocol === "https:" ? https : http).request(u, { method: "GET", headers: { ...entetes, Connection: "close" }, agent: false, timeout: 30000 }, (reponse) => {
      const morceaux = [];
      reponse.on("data", c => morceaux.push(c));
      reponse.on("end", () => resolve({ status: reponse.statusCode, corps: Buffer.concat(morceaux).toString("utf8") }));
      reponse.on("error", e => reject(new Error(e.code ?? e.message)));
    });
    demande.on("timeout", () => demande.destroy(new Error("délai de 30 s dépassé")));
    demande.on("error", e => reject(new Error(e.code ?? e.message)));
    demande.end();
  });
}

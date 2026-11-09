// lib-etat-servi.mjs — juge le relevé `forge-ops/etat-servi@1` que prend gabarits/smoke-mise-en-production.mjs :
// l'état servi par l'instance a-t-il été RELU à la fin des épreuves, et est-il celui d'avant ? (TF-2308, Produit-86,
// lot 20261109a RP-53). Classe : etat-servi-non-relu-apres-epreuve.
//
// Ce module ne fait aucun appel réseau : il lit un relevé déjà pris. Il refait la comparaison à partir des deux corps
// de santé que le relevé conserve, avec la fonction du gabarit (une seule source), et ne croit pas le verdict du
// gabarit. La comparaison porte sur le CORPS de la réponse, pas sur son code : l'instance du cas fondateur répondait
// 200 en mode dégradé.
import { FORMAT, comparerEtats, dire, CHEMIN_SANTE_DEFAUT } from "../gabarits/smoke-mise-en-production.mjs";

const reussi = (lecture) => lecture && typeof lecture.status === "number" && lecture.status >= 200 && lecture.status < 300;
const instant = (iso) => Date.parse(iso);

// Rend { compares, constats: [{ sev, msg }] }.
export function jugerEtatServi(releve) {
  const constats = [];
  const bloquant = (msg) => constats.push({ sev: "bloquant", msg });
  if (!releve || typeof releve !== "object" || releve.format !== FORMAT) {
    bloquant(`format inconnu « ${releve?.format} » (attendu ${FORMAT}) : le relevé se prend par gabarits/smoke-mise-en-production.mjs`);
    return { compares: 0, constats };
  }
  const { avant, apres } = releve;
  const epreuves = Array.isArray(releve.epreuves) ? releve.epreuves : [];
  const chemin = releve.chemin ?? CHEMIN_SANTE_DEFAUT;

  if (!reussi(avant)) {
    bloquant(`l'état de départ n'a pas été lu sur ${chemin} (${avant?.status ?? "aucune lecture"}) : sans lui, rien ne se compare, et le test ne prouve pas que l'instance est laissée comme il l'a trouvée (TF-2308)`);
    return { compares: 0, constats };
  }
  if (!apres) {
    bloquant(`l'état servi n'a pas été RELU à la fin des épreuves : le test laisse l'instance dans l'état de sa dernière épreuve, au porteur de le découvrir (TF-2308, Produit-86 : arrêt de mission joué en dernier, passerelle laissée en NO_EXTERNAL_AI pour toutes les missions). Relire ${chemin} après la dernière épreuve et comparer au départ`);
    return { compares: 0, constats };
  }

  // Une relecture faite avant la dernière épreuve ne relit rien de ce que cette épreuve a changé.
  const fins = epreuves.map(e => instant(e.fin)), debuts = epreuves.map(e => instant(e.debut));
  if ([...fins, ...debuts, instant(avant.lu_a), instant(apres.lu_a)].some(Number.isNaN))
    bloquant("horodatage illisible dans le relevé (lu_a, debut ou fin) : l'ordre départ, épreuves, relecture ne se vérifie pas");
  else {
    if (fins.length && instant(apres.lu_a) < Math.max(...fins))
      bloquant("la relecture de l'état servi précède la fin de la dernière épreuve : elle ne voit pas ce que cette épreuve a changé (TF-2308)");
    if (debuts.length && instant(avant.lu_a) > Math.min(...debuts))
      bloquant("l'état de départ est lu après le début des épreuves : ce n'est plus l'état d'avant (TF-2308)");
  }

  if (!reussi(apres)) {
    bloquant(`l'état de fin est illisible (${apres.status === null || apres.status === undefined ? `instance injoignable${apres.erreur ? ` : ${apres.erreur}` : ""}` : `réponse ${apres.status}`}) : une instance qui ne répond plus ou répond en erreur n'est pas dans l'état de départ`);
    return { compares: 0, constats };
  }
  if (apres.status !== avant.status) bloquant(`le code de santé est passé de ${avant.status} à ${apres.status}`);

  const options = { champs: Array.isArray(releve.champs) ? releve.champs : [], ignorer: Array.isArray(releve.ignorer) ? releve.ignorer : [] };
  const cmp = comparerEtats(avant.corps, apres.corps, options);
  if (cmp.compares === 0)
    constats.push({ sev: "majeur", msg: `la réponse de santé ne porte aucun champ comparé${options.champs.length ? ` (champs déclarés : ${options.champs.join(", ")}, tous absents)` : ""} : seul le code est comparable, et le cas fondateur répondait 200 en mode dégradé. Déclarer dans « sante.champs » le ou les champs qui disent l'état servi` });
  for (const e of cmp.ecarts) bloquant(`l'état servi a changé pendant les épreuves, ${dire(e)} — l'instance n'est pas laissée dans l'état où le test l'a trouvée (TF-2308)`);
  const echecs = epreuves.filter(e => e.code !== 0);
  if (echecs.length) constats.push({ sev: "info", msg: `${echecs.length} épreuve(s) en échec (${echecs.map(e => e.nom).join(", ")}) : l'état de fin est jugé quand même` });
  if (options.ignorer.length || options.champs.length)
    constats.push({ sev: "info", msg: `comparaison restreinte déclarée par le test${options.champs.length ? ` : champs ${options.champs.join(", ")}` : ""}${options.ignorer.length ? ` ; exclus : ${options.ignorer.join(", ")}` : ""} — les autres champs de la réponse ne sont pas jugés` });
  return { compares: cmp.compares, constats };
}

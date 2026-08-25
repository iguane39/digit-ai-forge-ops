/**
 * lib-empreinte.mjs — le hachage des fichiers d'une release, en un seul endroit (TF-0615, 25/08).
 *
 * POURQUOI CE FICHIER EXISTE. `forge-ops/empreinte@1` est le format de RÉFÉRENCE de l'écosystème :
 * c'est celui que la convention du pilot (`references/EMPREINTES.md`) a promu parce qu'il était le
 * seul déclaré ET versionné. Et il hachait les OCTETS BRUTS de chaque fichier scellé.
 *
 * LE DÉFAUT QUE ÇA PRODUIT. Avec `core.autocrlf`, git repose un fichier TEXTE en CRLF au checkout
 * d'un poste et en LF sur un autre, sans qu'un octet de contenu ait bougé. Une release scellée
 * depuis un poste Windows puis vérifiée depuis un clone Linux voit donc chacun de ses fichiers
 * texte déclaré « modifié après scellement » — un O7 rouge sur un déploiement parfaitement intact.
 * La classe a été payée CINQ fois dans l'écosystème (TF-0072, TF-0253, TF-0359, TF-0474, TF-0615),
 * et la première fois c'était déjà pour un sceau de grille.
 *
 * CE QUI REND CE SITE DIFFÉRENT DES AUTRES, et pourquoi la correction n'est pas une ligne : un
 * répertoire de release contient TOUT ce qui a été construit — images, polices, archives, actifs
 * compilés. Normaliser un binaire serait un DÉFAUT, pas un correctif : cela hacherait des octets
 * mutilés, et deux binaires ne différant que par une paire CR-LF deviendraient indiscernables.
 * La décision se prend donc FICHIER PAR FICHIER.
 *
 * LA MIGRATION EST DÉCLARÉE, JAMAIS SILENCIEUSE. Les releases scellées AVANT ce changement portent
 * le haché brut de leurs fichiers texte. La vérification accepte donc les DEUX formes pour un
 * fichier texte — la normalisée et la brute — exactement comme la boîte d'entrée du pilot le fait
 * depuis TF-0253. Sans cette tolérance, la correction ferait échouer d'un coup toutes les releases
 * déjà scellées : on échangerait un faux rouge contre un autre.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";

/**
 * Un fichier est tenu pour BINAIRE s'il porte un octet nul — qui n'apparaît pas dans du texte
 * UTF-8. Heuristique volontairement simple : un faux « binaire » garde son haché brut, ce qui est
 * le comportement d'avant, donc sans régression ; un faux « texte » n'existe pas, un binaire réel
 * portant presque toujours un octet nul.
 */
export const estBinaire = (octets) => octets.includes(0);

/** Le texte, fins de ligne ramenées en LF. La seule normalisation admise. */
export const normaliserLignes = (texte) => texte.split("\r\n").join("\n");

/**
 * Le haché d'un fichier de release : normalisé s'il est texte, brut s'il est binaire.
 * C'est la forme ÉCRITE au scellement à partir du 25/08/2026.
 */
export function hacherFichier(p) {
  const octets = fs.readFileSync(p);
  if (estBinaire(octets)) return createHash("sha256").update(octets).digest("hex");   // empreinte-brute-ok : binaire
  return createHash("sha256").update(normaliserLignes(octets.toString("utf8"))).digest("hex");
}

/**
 * Le haché BRUT, sans normalisation. Sert UNIQUEMENT à la compatibilité : reconnaître une release
 * scellée avant le 25/08, dont les fichiers texte portent leur haché brut.
 */
export function hacherFichierBrut(p) {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");   // empreinte-brute-ok : forme de compatibilité
}

/**
 * Le fichier correspond-il à son haché scellé ? Vrai si la forme COURANTE correspond, ou si la
 * forme BRUTE correspond (release scellée avant la migration). Une vraie modification ne
 * correspond ni à l'une ni à l'autre.
 */
export const correspond = (p, hachAttendu) =>
  hacherFichier(p) === hachAttendu || hacherFichierBrut(p) === hachAttendu;

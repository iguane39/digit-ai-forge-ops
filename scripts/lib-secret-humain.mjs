// lib-secret-humain — le générateur commun des secrets qu'un HUMAIN recopie (TF-2167), repris par
// scripts/identifiants-test.mjs (TF-2166) et jugé par O-25.
//
// LE FAIT (Produit-86, lot 20261104b RP-11, ledger seq 421, 04/11/2026). Le porteur n'a pas pu se connecter avec les
// mots de passe du fichier des comptes de test : 2 refus 401 (Chrome à 14:59, Firefox à 15:01), alors que les mêmes
// valeurs passaient par httpx et Playwright. `secrets.token_urlsafe` produisait « _ » et des sosies (1, l) : une
// machine recopie sans erreur, un humain lit « l » pour « 1 » et ne trouve pas « _ » à la dictée.
//
// LA RÈGLE (demandée par le lot) : tout secret qu'un humain recopie se tire dans un alphabet SANS SOSIE (0 O 1 l I) ni
// signe, de 20 caractères au moins. Au-delà de la lettre : au moins une minuscule, une majuscule et un chiffre,
// parce que la plupart des politiques de mot de passe l'exigent et que supprimer les signes retire l'autre moyen
// d'y satisfaire (écart déclaré au rapport, jamais adouci).
//
// Le tirage emploie crypto.randomInt, sans biais de modulo. 57 symboles sur 20 positions : environ 117 bits.
import { randomInt } from "node:crypto";

export const SOSIES = "01OlI";
export const LONGUEUR_MIN = 20;
const sans = (jeu) => [...jeu].filter(c => !SOSIES.includes(c)).join("");
export const MINUSCULES = sans("abcdefghijklmnopqrstuvwxyz");
export const MAJUSCULES = sans("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
export const CHIFFRES = sans("0123456789");
export const ALPHABET = MINUSCULES + MAJUSCULES + CHIFFRES;

// Les défauts d'un secret, positions comprises (1 = premier caractère), sans jamais écrire le secret lui-même :
// un rapport de défaut ne doit pas faire transiter la valeur.
export function defautsDuSecret(secret, longueurMin = LONGUEUR_MIN) {
  const s = String(secret ?? "");
  const defauts = [];
  if ([...s].length < longueurMin) defauts.push(`${[...s].length} caractères, ${longueurMin} au moins`);
  [...s].forEach((c, i) => {
    if (SOSIES.includes(c)) defauts.push(`position ${i + 1} : sosie (0, O, 1, l ou I)`);
    else if (!/^[A-Za-z0-9]$/.test(c)) defauts.push(`position ${i + 1} : signe ou caractère hors alphabet`);
  });
  return defauts;
}

export function genererSecret(longueur = LONGUEUR_MIN) {
  if (!Number.isInteger(longueur) || longueur < LONGUEUR_MIN) throw new RangeError(`longueur ${longueur} : ${LONGUEUR_MIN} caractères au moins pour un secret recopié par un humain`);
  for (let essai = 0; essai < 1000; essai++) {
    let s = "";
    for (let i = 0; i < longueur; i++) s += ALPHABET[randomInt(ALPHABET.length)];
    if ([...MINUSCULES].some(c => s.includes(c)) && [...MAJUSCULES].some(c => s.includes(c)) && [...CHIFFRES].some(c => s.includes(c))) return s;
  }
  throw new Error("tirage sans minuscule, majuscule et chiffre après 1000 essais : générateur défaillant");
}

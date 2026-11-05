#!/usr/bin/env node
// secret-humain — tire un secret qu'un humain recopie : alphabet sans sosie (0 O 1 l I) ni signe, 20 caractères au
// moins (TF-2167, lot Produit-86 20261104b RP-11). Le remède que nomme O-25 quand il refuse un secret.
//   node scripts/tirer-secret-humain.mjs [--longueur 20] [--nombre 1]   : un secret par ligne sur la sortie standard.
// exit 0 · exit 2 [SECRET HORS CONTRAT] : longueur sous 20 ou nombre illisible. Rien n'est écrit sur disque.
import { genererSecret, LONGUEUR_MIN } from "./lib-secret-humain.mjs";

const args = process.argv.slice(2);
const option = (nom, defaut) => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : defaut; };
const longueur = Number(option("--longueur", LONGUEUR_MIN));
const nombre = Number(option("--nombre", 1));
if (!Number.isInteger(nombre) || nombre < 1 || nombre > 1000) { process.stderr.write("[SECRET HORS CONTRAT] --nombre : un entier de 1 à 1000\n"); process.exit(2); }
try {
  for (let i = 0; i < nombre; i++) process.stdout.write(genererSecret(longueur) + "\n");
} catch (e) {
  process.stderr.write(`[SECRET HORS CONTRAT] ${e.message}\n`);
  process.exit(2);
}

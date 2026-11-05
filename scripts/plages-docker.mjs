#!/usr/bin/env node
// plages-docker — relève les plages IPv4 déjà prises par les réseaux Docker du démon, puis en choisit une
// libre (TF-2164). C'est le « relever avant de choisir » du gabarit gabarits/reseau-docker.tf.
//
// LE FAIT (Produit-86, lot 20261104a RO-2, ledger seq 380). Un réseau Docker posé par Terraform avec une
// plage écrite à la main (172.30.0.0/24) a été refusé (« Pool overlaps ») parce qu'un autre réseau du démon
// l'occupait déjà ; 3 déploiements en échec le 04/11/2026 entre 10:12 et 10:18.
//
// COMMANDES (rien n'est créé, rien n'est supprimé : le script lit le démon et rend une plage) :
//   node scripts/plages-docker.mjs choisir [--nom <réseau>] [--base 10.200.0.0/16] [--longueur 24] [--releve <fichier.json>]
//       stdout : {"subnet":"…/24","gateway":"…","source":"libre"|"existante"} ; exit 0 ;
//       exit 1 : aucune plage libre dans la base ; exit 2 : démon injoignable ou relevé illisible.
//   node scripts/plages-docker.mjs lister [--releve <fichier.json>]   : les plages prises, une par ligne.
//   node scripts/plages-docker.mjs --externe   : forme `data "external"` de Terraform — la requête JSON
//       {"nom","base","longueur"} (toutes en chaînes) arrive sur l'entrée standard, la réponse sort en
//       chaînes seules ; une erreur sort sur l'erreur standard avec exit 1 (Terraform l'affiche).
//
// LE RÉSEAU DÉJÀ POSÉ. Si `--nom` désigne un réseau qui existe déjà au relevé, sa plage est rendue telle
// quelle (source « existante ») : sans cela, le prochain `terraform plan` choisirait une autre plage, parce
// que la sienne serait devenue « prise » par lui-même, et réclamerait son remplacement.
//
// `--releve` lit la sortie de `docker network inspect $(docker network ls -q)` enregistrée dans un fichier
// (fixtures et rejeu) ; sans lui, le script interroge le démon.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Hors des réservoirs par défaut de Docker (172.17.0.0/12 en /16, 192.168.0.0/16 en /20) : le démon y puise seul.
// Mesuré le 05/11/2026 sur ce poste : 172.17 à 172.30 y sont déjà tous pris par des réseaux de projets.
const BASE_DEFAUT = "10.200.0.0/16";
const LONGUEUR_DEFAUT = 24;

// ── Arithmétique IPv4 (sans opérateur binaire : les entiers JS signés fausseraient 128.0.0.0 et au-delà) ──
export function lireCidr(texte) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(texte ?? "").trim());
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  const longueur = Number(m[5]);
  if (octets.some(o => o > 255) || longueur > 32) return null;
  const adresse = ((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3];
  const taille = 2 ** (32 - longueur);
  const debut = adresse - (adresse % taille);
  return { debut, fin: debut + taille, taille, longueur };
}

export function enTexte(entier) {
  const o = [];
  for (let i = 0; i < 4; i++) { o.unshift(entier % 256); entier = Math.floor(entier / 256); }
  return o.join(".");
}

export const chevauche = (a, b) => a.debut < b.fin && b.debut < a.fin;

// ── Lecture d'un relevé `docker network inspect` : [{Name, IPAM:{Config:[{Subnet}]}}] ──
// Les plages IPv6 (« fe80::/64 ») ne sont pas lues : le gabarit choisit une plage IPv4.
export function plagesDuReleve(releve) {
  if (!Array.isArray(releve)) throw new Error("le relevé n'est pas un tableau de réseaux (attendu : sortie de `docker network inspect`)");
  const plages = [];
  for (const r of releve) {
    const nom = String(r?.Name ?? r?.nom ?? "");
    const config = r?.IPAM?.Config ?? r?.plages ?? [];
    for (const c of Array.isArray(config) ? config : []) {
      const texte = typeof c === "string" ? c : c?.Subnet;
      const cidr = lireCidr(texte);
      if (cidr) plages.push({ nom, texte: String(texte), ...cidr });
    }
  }
  return plages;
}

// ── Le choix : le premier bloc de la base qui ne chevauche aucune plage prise ──
export function choisirPlage({ plages, base = BASE_DEFAUT, longueur = LONGUEUR_DEFAUT, nom = "" }) {
  const zone = lireCidr(base);
  if (!zone) throw new Error(`base illisible : « ${base} » (attendu a.b.c.d/n)`);
  const l = Number(longueur);
  if (!Number.isInteger(l) || l < zone.longueur || l > 30) throw new Error(`longueur ${longueur} hors de la base ${base} (attendu un entier de ${zone.longueur} à 30)`);
  if (nom) {
    const propre = plages.find(p => p.nom === nom);
    if (propre) return { subnet: propre.texte, gateway: enTexte(propre.debut + 1), source: "existante" };
  }
  const taille = 2 ** (32 - l);
  for (let debut = zone.debut; debut + taille <= zone.fin; debut += taille) {
    const candidat = { debut, fin: debut + taille };
    if (!plages.some(p => chevauche(candidat, p))) {
      return { subnet: `${enTexte(debut)}/${l}`, gateway: enTexte(debut + 1), source: "libre" };
    }
  }
  return null;
}

// ── Le relevé réel : le démon, jamais deviné ──
function releverDuDemon() {
  const liste = spawnSync("docker", ["network", "ls", "-q"], { encoding: "utf8", timeout: 30000 });
  if (liste.error || liste.status !== 0) throw new Error(`démon Docker injoignable (docker network ls : ${liste.error?.message ?? (liste.stderr || "").trim().slice(0, 160)})`);
  const ids = liste.stdout.split(/\s+/).filter(Boolean);
  if (!ids.length) return [];
  const inspect = spawnSync("docker", ["network", "inspect", ...ids], { encoding: "utf8", timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (inspect.error || inspect.status !== 0) throw new Error(`docker network inspect en échec (${(inspect.stderr || inspect.error?.message || "").trim().slice(0, 160)})`);
  return JSON.parse(inspect.stdout);
}

function lireReleve(fichier) {
  if (fichier) {
    if (!fs.existsSync(fichier)) throw new Error(`relevé introuvable : ${fichier}`);
    return JSON.parse(fs.readFileSync(fichier, "utf8"));
  }
  return releverDuDemon();
}

function option(args, nom, defaut = null) {
  const i = args.indexOf(nom);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : defaut;
}

function main(args) {
  const externe = args.includes("--externe");
  const verbe = externe ? "choisir" : args[0];
  try {
    if (verbe === "lister") {
      for (const p of plagesDuReleve(lireReleve(option(args, "--releve")))) process.stdout.write(`${p.texte}\t${p.nom}\n`);
      return 0;
    }
    if (verbe !== "choisir") {
      process.stderr.write("[PLAGES HORS CONTRAT] usage : plages-docker.mjs choisir|lister [--nom N] [--base CIDR] [--longueur N] [--releve fichier.json] | --externe\n");
      return 2;
    }
    let requete = {};
    if (externe) {
      const entree = fs.readFileSync(0, "utf8").trim();
      requete = entree ? JSON.parse(entree) : {};
    } else {
      requete = { nom: option(args, "--nom", ""), base: option(args, "--base", BASE_DEFAUT), longueur: option(args, "--longueur", String(LONGUEUR_DEFAUT)) };
    }
    const plages = plagesDuReleve(lireReleve(option(args, "--releve")));
    const choix = choisirPlage({ plages, base: requete.base || BASE_DEFAUT, longueur: requete.longueur || LONGUEUR_DEFAUT, nom: requete.nom || "" });
    if (!choix) {
      process.stderr.write(`[PLAGES REFUS] aucune plage /${requete.longueur || LONGUEUR_DEFAUT} libre dans ${requete.base || BASE_DEFAUT} : ${plages.length} plage(s) prise(s) au relevé ; élargir la base ou retirer un réseau inutile\n`);
      return 1;
    }
    process.stdout.write(JSON.stringify(choix) + "\n");
    return 0;
  } catch (e) {
    process.stderr.write(`[PLAGES HORS CONTRAT] ${e.message}\n`);
    return externe ? 1 : 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));

#!/usr/bin/env node
// Gabarit forge-ops (TF-2412) : restaurer une copie pg_dump dans un projet Supabase sans l'échec des privilèges
// par défaut de supabase_admin.
//
// LE FAIT (Produit-84, lot 20261110a, ledger seq 278, exécution du 10/11/2026). `pg_restore --clean
// --single-transaction` d'une copie pg_dump échoue sur « permission denied to change default privileges » : la copie
// porte les privilèges par défaut de supabase_admin sur public (entrées « DEFAULT ACL » de son sommaire), que le rôle
// postgres, celui de la connexion, ne peut pas rejouer. Filtrer ces entrées du sommaire (`pg_restore --list`, puis
// `--use-list`) a rendu une restauration conforme en 52 s (exécution 42786008105). Mesures rapportées par le lot : cette
// forge n'a restauré aucune base.
//
// CE QUE FAIT LE GABARIT. Il ne se connecte à rien et n'exécute pas pg_restore : il (1) retire du sommaire les entrées
// « DEFAULT ACL » des rôles que postgres ne peut pas rejouer (supabase_admin par défaut), en les COMMENTANT d'un « ; »
// — la liste reste lisible et comparable au sommaire, et pg_restore ignore une ligne commentée —, (2) refuse une liste
// où il en reste, (3) écrit les commandes dans l'ordre. La restauration elle-même, qui supprime avant de recréer
// (`--clean`) sur un service hébergé, se joue sous le GO du run (R-38) ; la chaîne de connexion de la base cible vient
// de l'environnement du run (variable SUPABASE_DB_URL), jamais d'un argument ni d'un fichier.
//
// USAGE (à copier chez le produit ; il n'importe rien de forge-ops) :
//   node restauration-supabase.mjs plan [<copie.dump>]
//   node restauration-supabase.mjs liste <sommaire.txt> [--sortie liste-filtree.txt] [--role <role>]...
//   node restauration-supabase.mjs verifier <liste.txt> [--role <role>]...
// `--role` s'ajoute à supabase_admin : un autre rôle que postgres ne peut pas rejouer ses privilèges par défaut non plus,
// mais seul supabase_admin a été mesuré.
//
// EXIT : 0 liste écrite ou conforme · 1 `verifier` : des entrées « DEFAULT ACL » refusées restent (elles sont nommées) ·
// 2 usage, fichier absent ou texte qui n'est pas un sommaire de pg_restore --list (aucune entrée numérotée) : un PASS
// sur un texte vide serait un faux vert.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROLES_DEFAUT = ["supabase_admin"];

// Une entrée du sommaire : « <id>; <oid> <oid> <TYPE> <schéma> <étiquette> <propriétaire> » ; une ligne qui commence par
// « ; » est un commentaire, que pg_restore ignore (c'est ainsi qu'on retire une entrée d'un sommaire).
const estEntree = l => /^\d+;\s/.test(l);
const defautAcl = l => /^\d+;.*\sDEFAULT ACL\s/.test(l);
const proprietaire = l => l.trim().split(/\s+/).at(-1);

function lignesDe(texte) {
  const eol = texte.includes("\r\n") ? "\r\n" : "\n";
  return { eol, lignes: texte.split(/\r?\n/) };
}

export function lireSommaire(texte, roles = ROLES_DEFAUT) {
  const { eol, lignes } = lignesDe(texte);
  const entrees = lignes.filter(estEntree);
  if (entrees.length === 0) throw new Error("aucune entrée numérotée : ce texte n'est pas un sommaire de `pg_restore --list` (ou il est vide)");
  const refusees = lignes
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => estEntree(l) && defautAcl(l) && roles.includes(proprietaire(l)))
    .map(({ l, i }) => ({ ligne: i + 1, id: Number(l.split(";")[0]), proprietaire: proprietaire(l), texte: l.trim() }));
  return { eol, lignes, entrees: entrees.length, refusees };
}

// Retire (commente) les entrées refusées ; le reste du sommaire reste identique à l'octet près.
export function filtrerSommaire(texte, roles = ROLES_DEFAUT) {
  const s = lireSommaire(texte, roles);
  const numeros = new Set(s.refusees.map(r => r.ligne - 1));
  const lignes = s.lignes.map((l, i) => numeros.has(i) ? `;${l}` : l);
  return { texte: lignes.join(s.eol), retirees: s.refusees, entrees: s.entrees };
}

export function verifierListe(texte, roles = ROLES_DEFAUT) {
  const s = lireSommaire(texte, roles);
  return { conforme: s.refusees.length === 0, restantes: s.refusees, entrees: s.entrees };
}

export function ecrirePlan(copie = "<COPIE_PG_DUMP>") {
  return [
    `pg_restore --list ${copie} > sommaire.txt   # le sommaire de la copie`,
    "node restauration-supabase.mjs liste sommaire.txt --sortie liste-filtree.txt   # TF-2412 : les privilèges par défaut de supabase_admin sont commentés, le reste du sommaire est intact",
    "node restauration-supabase.mjs verifier liste-filtree.txt   # exit 0 exigé avant la restauration : une entrée DEFAULT ACL de supabase_admin qui reste refait échouer pg_restore",
    `pg_restore --clean --single-transaction --use-list liste-filtree.txt --dbname "$SUPABASE_DB_URL" ${copie}   # --clean supprime avant de recréer : GO humain (R-38), cible nommée au dossier de MEP ; SUPABASE_DB_URL vient de l'environnement du run`,
  ];
}

const dit = m => process.stdout.write(`${m}\n`);
const fail = m => { process.stderr.write(`[RESTAURATION-SUPABASE] ${m}\n`); process.exit(2); };

function principal() {
  const args = process.argv.slice(2);
  const roles = [...ROLES_DEFAUT];
  const positionnels = [];
  let sortie;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--role") { const r = args[++i]; if (!r || r.startsWith("--")) fail("usage : --role <role>"); roles.push(r); }
    else if (args[i] === "--sortie") { sortie = args[++i]; if (!sortie || sortie.startsWith("--")) fail("usage : --sortie <fichier>"); }
    else if (args[i].startsWith("--")) fail(`option inconnue « ${args[i]} »`);
    else positionnels.push(args[i]);
  }
  const [verbe, fichier] = positionnels;
  if (verbe === "plan") { for (const c of ecrirePlan(fichier)) dit(c); return; }
  if (verbe !== "liste" && verbe !== "verifier") fail(`usage : plan | liste <sommaire.txt> | verifier <liste.txt> (verbe reçu : ${verbe ?? "aucun"})`);
  if (!fichier) fail(`usage : ${verbe} <fichier> — aucun fichier donné`);
  const chemin = path.resolve(fichier);
  if (!fs.existsSync(chemin)) fail(`fichier introuvable : ${chemin}`);
  const texte = fs.readFileSync(chemin, "utf8");
  try {
    if (verbe === "liste") {
      const r = filtrerSommaire(texte, roles);
      if (sortie) fs.writeFileSync(path.resolve(sortie), r.texte, "utf8"); else process.stdout.write(r.texte);
      process.stderr.write(`[RESTAURATION-SUPABASE] ${r.retirees.length} entrée(s) DEFAULT ACL retirée(s) sur ${r.entrees}${r.retirees.length ? ` : ${r.retirees.map(x => `${x.id} (${x.proprietaire})`).join(", ")}` : " — rien à retirer, le sommaire se restaure tel quel"}\n`);
    } else {
      const r = verifierListe(texte, roles);
      if (r.conforme) { dit(`[RESTAURATION-SUPABASE] PASS : aucune entrée DEFAULT ACL de ${roles.join(", ")} sur ${r.entrees} entrées`); return; }
      for (const x of r.restantes) process.stderr.write(`[RESTAURATION-SUPABASE] ligne ${x.ligne} : « ${x.texte} » — postgres ne peut pas rejouer les privilèges par défaut de ${x.proprietaire}\n`);
      process.stderr.write("[RESTAURATION-SUPABASE] ÉCHEC : passer le sommaire par `liste` avant `pg_restore --use-list` (TF-2412)\n");
      process.exitCode = 1;
    }
  } catch (e) { fail(`${chemin} : ${e.message}`); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) principal();

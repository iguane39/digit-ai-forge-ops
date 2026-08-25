#!/usr/bin/env node
/**
 * verifier-migration-dns.mjs — les deux juges de la migration DNS (G-03).
 *
 * ============================================================================================
 * POURQUOI (TF-0611, TF-0613, TF-0610 — lot auxportesdelabaie du 25/08/2026)
 * ============================================================================================
 *
 * LE FAIT MESURÉ. Quatre zones ajoutées par API chez un fournisseur : le scan automatique a
 * importé ZÉRO enregistrement, QUARANTE-SEPT manquaient — dont les 12 `MX`, les 4 `SPF`, les 2 clés
 * `DKIM` et les 3 `SRV`. Aucune erreur, aucun avertissement : les zones s'affichaient prêtes à
 * basculer. Changer les serveurs de noms dans cet état COUPE LA MESSAGERIE INSTANTANÉMENT, et les
 * courriels perdus pendant la coupure sont irrécupérables.
 *
 * POURQUOI UN ORACLE ET NON UNE RELECTURE. 47 lignes se relisent mal, et UNE SEULE qui manque
 * suffit à couper le courrier. L'étape 3 de la procédure — différer la cible contre l'origine — est
 * donc un contrôle exécuté, pas un regard. C'est ce que le produit a demandé mot pour mot :
 * « l'étape 3 est un oracle, pas une relecture humaine ».
 *
 * CE QUI REND LA PARADE POSSIBLE, et qui n'est écrit nulle part : une zone au statut *pending* ne
 * sert RIEN tant que les serveurs de noms pointent ailleurs. Toute la préparation est donc inerte
 * et réversible — on construit et on vérifie AVANT que rien ne change pour les utilisateurs.
 *
 * ============================================================================================
 * CE QUI EST JUGÉ
 * ============================================================================================
 *
 *   D1 · AUCUN enregistrement de l'origine ne manque à la cible. Comparaison par (type, nom,
 *        valeur normalisée) — jamais par un compte : deux relevés de 47 lignes peuvent avoir le
 *        même total et pas le même contenu.
 *   D2 · les enregistrements de MESSAGERIE ne sont pas PROXIFIÉS. `MX`, `SRV`, les `CNAME` de
 *        messagerie et les clés `DKIM` proxifiés cassent le courrier AUSSI SÛREMENT que s'ils
 *        manquaient. C'est le garde-fou d'après bascule, et son mode de défaillance est silencieux.
 *   D3 · les ARTEFACTS DE FOURNISSEUR ne sont pas migrés. Une zone parquée porte des `TXT` de la
 *        forme `<chiffre>|<valeur>` et des `A` vers l'infrastructure de redirection HTTP seule du
 *        fournisseur d'origine. Copiés tels quels, les premiers polluent la RACINE du domaine — là
 *        où vivent SPF, DMARC et les jetons de vérification — et le second RÉINTRODUIT le défaut
 *        qu'on migre pour corriger.
 *
 * NON JUGÉ, et déclaré :
 *   · ce qui est EN PLUS dans la cible : ajouter un enregistrement peut être voulu (un `TXT` de
 *     vérification du nouveau fournisseur, par exemple). D1 juge les MANQUES, et signale les ajouts
 *     sans les refuser — accuser ferait crier l'oracle sur une migration correcte ;
 *   · la JUSTESSE d'une valeur : que le `MX` pointe vers le bon serveur relève de l'exploitant.
 *     Cet oracle vérifie qu'il est ARRIVÉ, pas qu'il est bon ;
 *   · la PROPAGATION : un enregistrement présent chez le fournisseur n'est pas encore résolu
 *     partout. Le vérifier demanderait d'interroger des résolveurs tiers, hors de portée d'ici.
 *
 * Usage :
 *   node scripts\verifier-migration-dns.mjs --diff <origine.json> <cible.json> [--json]
 *   node scripts\verifier-migration-dns.mjs --proxifies <cible.json> [--json]
 *   node scripts\verifier-migration-dns.mjs --self-test
 *
 * Format d'un relevé : un tableau JSON d'objets `{type, name, content, proxied?}` — celui que
 * rendent les API des fournisseurs usuels, sans transformation.
 * Exit : 0 = PASS · 1 = FAIL · 2 = usage ou relevé illisible.
 */
import { readFileSync, existsSync } from "node:fs";

export const VERSION = "1.0.0";

/** Les types qui portent le courrier. Les proxifier le casse comme les oublier (TF-0613). */
export const TYPES_MESSAGERIE = new Set(["MX", "SRV"]);

//: Un nom d'hôte de messagerie : ce qui, sous un CNAME ou un TXT, sert le courrier.
const NOM_DE_MESSAGERIE = /(^|\.)(mail|smtp|imap|pop|mx|autodiscover|autoconfig|_dmarc|_domainkey)(\.|$)/i;
//: Une clé DKIM se reconnaît à son sélecteur, jamais à son type — c'est un TXT ordinaire.
const CLE_DKIM = /\._domainkey(\.|$)/i;

/** Un artefact de parking OVH : `TXT` en `<chiffre>|…`, ou `A` vers son hôte de redirection. */
export const ARTEFACT_DE_PARKING = (r) =>
  (String(r.type).toUpperCase() === "TXT" && /^"?\d+\|/.test(String(r.content || "").trim()))
  || (String(r.type).toUpperCase() === "A" && String(r.content || "").trim() === "213.186.33.5");

/**
 * La CLÉ d'un enregistrement, pour comparer deux relevés. Le nom est normalisé (casse, point
 * final), et la valeur aussi — sans quoi `"v=spf1 …"` et `v=spf1 …` compteraient pour deux, et le
 * contrôle crierait sur une migration juste.
 */
export const cle = (r) => [
  String(r.type || "").toUpperCase(),
  String(r.name || "").toLowerCase().replace(/\.$/, ""),
  String(r.content || "").trim().replace(/^"|"$/g, "").replace(/\s+/g, " ").toLowerCase(),
].join("|");

const lire = (chemin) => {
  if (!existsSync(chemin)) return { erreur: `relevé introuvable : ${chemin}` };
  try {
    const v = JSON.parse(readFileSync(chemin, "utf8"));
    const liste = Array.isArray(v) ? v : (Array.isArray(v.result) ? v.result : (Array.isArray(v.records) ? v.records : null));
    if (!liste) return { erreur: `relevé illisible : ni tableau, ni champ \`result\`/\`records\` — ${chemin}` };
    return { liste };
  } catch (e) { return { erreur: `relevé illisible (${e.message}) : ${chemin}` }; }
};

/** D1 et D3 : la cible porte-t-elle tout ce que l'origine avait, et rien du parking ? */
export function differer(origine, cible) {
  const F = [];
  const ok = (regle, message) => F.push({ regle, statut: "PASS", message });
  const ko = (regle, message) => F.push({ regle, statut: "FAIL", message });

  const utiles = origine.filter((r) => !ARTEFACT_DE_PARKING(r));
  const ecartes = origine.filter(ARTEFACT_DE_PARKING);
  const clesCible = new Set(cible.map(cle));
  const manquants = utiles.filter((r) => !clesCible.has(cle(r)));

  if (manquants.length) {
    const parType = {};
    for (const r of manquants) parType[String(r.type).toUpperCase()] = (parType[String(r.type).toUpperCase()] || 0) + 1;
    ko("D1", `${manquants.length} enregistrement(s) de l'origine MANQUE(NT) à la cible `
      + `(${Object.entries(parType).map(([t, n]) => `${n} ${t}`).join(", ")}). `
      + "Basculer les serveurs de noms dans cet état COUPE ce que ces enregistrements servaient, "
      + "instantanément et sans avertissement — et pour la messagerie, les courriels perdus pendant "
      + "la coupure sont irrécupérables. Mesuré le 25/08 : un scan automatique a importé 0 sur 47. "
      + `Premiers manquants : ${manquants.slice(0, 6).map((r) => `${r.type} ${r.name}`).join(" · ")}`);
  } else {
    ok("D1", `les ${utiles.length} enregistrement(s) utile(s) de l'origine sont présents dans la cible`);
  }

  // D3 — les artefacts de parking ne doivent pas avoir été migrés.
  const clesEcartees = new Set(ecartes.map(cle));
  const migres = cible.filter((r) => clesEcartees.has(cle(r)) || ARTEFACT_DE_PARKING(r));
  if (ecartes.length) {
    F.push({ regle: "D3 bis", statut: "SANS_OBJET",
      message: `${ecartes.length} artefact(s) de parking écarté(s) de la comparaison : ils n'ont aucun sens `
        + "hors de chez le fournisseur d'origine, et les EXIGER dans la cible serait un faux positif." });
  }
  if (migres.length) {
    ko("D3", `${migres.length} artefact(s) de parking MIGRÉ(S) dans la cible : `
      + `${migres.slice(0, 6).map((r) => `${r.type} ${r.name} = ${String(r.content).slice(0, 30)}`).join(" · ")}. `
      + "Un `TXT` en `<chiffre>|…` copié aveuglément devient un parasite À LA RACINE du domaine, là où "
      + "vivent le SPF, le DMARC et les jetons de vérification de propriété. Un `A` vers l'hôte de "
      + "redirection du fournisseur d'origine RÉINTRODUIT le défaut qu'on migre pour corriger.");
  } else ok("D3", "aucun artefact de parking n'a été migré");

  // Les ajouts sont SIGNALÉS et jamais refusés : ajouter peut être voulu.
  const clesOrigine = new Set(utiles.map(cle));
  const ajouts = cible.filter((r) => !clesOrigine.has(cle(r)) && !ARTEFACT_DE_PARKING(r));
  if (ajouts.length) {
    F.push({ regle: "D1 bis", statut: "AVERTISSEMENT",
      message: `${ajouts.length} enregistrement(s) présent(s) dans la cible et absent(s) de l'origine : `
        + `${ajouts.slice(0, 6).map((r) => `${r.type} ${r.name}`).join(" · ")}. Ce n'est pas un défaut — un `
        + "`TXT` de vérification du nouveau fournisseur est légitime — c'est signalé pour être lu." });
  }
  return { verdict: F.some((f) => f.statut === "FAIL") ? "FAIL" : "PASS", findings: F };
}

/** D2 : aucun enregistrement de messagerie n'est proxifié. Deux lignes, un défaut silencieux. */
export function proxifies(cible) {
  const F = [];
  const fautifs = cible.filter((r) => {
    if (r.proxied !== true) return false;
    const type = String(r.type || "").toUpperCase();
    const nom = String(r.name || "");
    if (TYPES_MESSAGERIE.has(type)) return true;
    if (type === "CNAME" && NOM_DE_MESSAGERIE.test(nom)) return true;
    if (type === "TXT" && CLE_DKIM.test(nom)) return true;
    return false;
  });
  if (!fautifs.length) {
    F.push({ regle: "D2", statut: "PASS",
      message: `aucun des ${cible.length} enregistrement(s) de messagerie n'est proxifié` });
  } else {
    F.push({ regle: "D2", statut: "FAIL",
      message: `${fautifs.length} enregistrement(s) de messagerie PROXIFIÉ(S) : `
        + `${fautifs.map((r) => `${r.type} ${r.name}`).join(" · ")}. Proxifier un \`MX\`, un \`SRV\`, un `
        + "`CNAME` de messagerie ou une clé `DKIM` casse le courrier AUSSI SÛREMENT que de les oublier — "
        + "et le mode de défaillance est silencieux : rien ne le signale, le courrier cesse simplement "
        + "d'arriver. Le proxy ne doit servir que ce qui est HTTP." });
  }
  return { verdict: F.some((f) => f.statut === "FAIL") ? "FAIL" : "PASS", findings: F };
}

export const NON_JUGE = [
  "ce qui est EN PLUS dans la cible : ajouter un enregistrement peut être voulu (un `TXT` de vérification du nouveau fournisseur). D1 juge les MANQUES et SIGNALE les ajouts, sans les refuser",
  "la JUSTESSE d'une valeur : que le `MX` pointe vers le bon serveur relève de l'exploitant. Cet oracle vérifie qu'il est ARRIVÉ, pas qu'il est bon",
  "la PROPAGATION : un enregistrement présent chez le fournisseur n'est pas encore résolu partout. Le vérifier demanderait d'interroger des résolveurs tiers, hors de portée d'ici",
  "les artefacts de parking d'un fournisseur AUTRE que celui mesuré : la liste des motifs est FERMÉE (`TXT` en `<chiffre>|…`, `A` vers l'hôte de redirection OVH). Un autre fournisseur aura d'autres marqueurs, et les deviner produirait des faux positifs",
];

// ---- CLI + recette ----------------------------------------------------------------------------
const args = process.argv.slice(2);
const sortir = (r) => {
  if (args.includes("--json")) console.log(JSON.stringify({ outil: "verifier-migration-dns", version: VERSION, ...r, non_juge: NON_JUGE }, null, 1));
  else {
    console.log(`verifier-migration-dns ${VERSION} — verdict : ${r.verdict}`);
    for (const f of r.findings) console.log(`  [${f.statut}] ${f.regle} — ${f.message}`);
  }
  process.exit(r.verdict === "FAIL" ? 1 : 0);
};

if (args.includes("--self-test")) {
  let pass = 0; const echecs = [];
  const att = (quoi, cond) => { if (cond) { pass++; console.log(`  [OK  ] ${quoi}`); } else { echecs.push(quoi); console.log(`  [ECHEC] ${quoi}`); } };

  const MX = { type: "MX", name: "exemple.fr", content: "10 mail.exemple.fr" };
  const SPF = { type: "TXT", name: "exemple.fr", content: '"v=spf1 include:_spf.exemple.fr ~all"' };
  const DKIM = { type: "TXT", name: "sel._domainkey.exemple.fr", content: "v=DKIM1; k=rsa; p=AAA" };
  const SRV = { type: "SRV", name: "_sip._tcp.exemple.fr", content: "10 5 5060 sip.exemple.fr" };
  const WWW = { type: "A", name: "www.exemple.fr", content: "203.0.113.7" };
  const PARK_TXT = { type: "TXT", name: "exemple.fr", content: '"1|www.exemple.fr"' };
  const PARK_A = { type: "A", name: "exemple.fr", content: "213.186.33.5" };

  // ---- D1 : le sens ROUGE, qui est le cas fondateur ----
  att("D1 rouge — la cible VIDE face à une origine peuplée est refusée (le cas mesuré : 0 sur 47)",
    differer([MX, SPF, DKIM, SRV, WWW], []).verdict === "FAIL");
  att("D1 rouge — le message COMPTE par type : 47 lignes ne se relisent pas, un total ne dit rien",
    /1 MX/.test(differer([MX, SPF], [SPF]).findings.find((f) => f.regle === "D1").message));
  att("D1 rouge — un SEUL MX manquant suffit à refuser : c'est la fixture demandée par le produit",
    differer([MX, SPF, WWW], [SPF, WWW]).verdict === "FAIL");
  att("D1 vert — une cible complète passe",
    differer([MX, SPF, WWW], [WWW, SPF, MX]).verdict === "PASS");
  att("D1 vert — la comparaison NORMALISE : guillemets, casse et espaces ne créent pas de faux manque",
    differer([SPF], [{ type: "txt", name: "Exemple.fr.", content: "v=spf1  include:_spf.exemple.fr   ~all" }]).verdict === "PASS");
  att("D1 — un AJOUT dans la cible est signalé, JAMAIS refusé : ajouter peut être voulu",
    differer([WWW], [WWW, { type: "TXT", name: "exemple.fr", content: "verif-nouveau-fournisseur" }]).verdict === "PASS");

  // ---- D3 : les artefacts de parking ----
  att("D3 — un artefact de parking de l'origine n'est PAS exigé dans la cible",
    differer([WWW, PARK_TXT, PARK_A], [WWW]).verdict === "PASS");
  att("D3 rouge — le même artefact MIGRÉ dans la cible est refusé",
    differer([WWW, PARK_TXT], [WWW, PARK_TXT]).verdict === "FAIL");
  att("D3 rouge — le `A` vers l'hôte de redirection HTTP seule est refusé aussi",
    differer([WWW], [WWW, PARK_A]).verdict === "FAIL");
  att("D3 — un TXT ordinaire commençant par un chiffre SANS barre n'est pas un artefact",
    differer([{ type: "TXT", name: "exemple.fr", content: "2026 vérification" }], []).findings.find((f) => f.regle === "D1").statut === "FAIL");

  // ---- D2 : les proxifiés ----
  att("D2 rouge — un MX proxifié est refusé",
    proxifies([{ ...MX, proxied: true }]).verdict === "FAIL");
  att("D2 rouge — un SRV proxifié est refusé",
    proxifies([{ ...SRV, proxied: true }]).verdict === "FAIL");
  att("D2 rouge — une clé DKIM proxifiée est refusée, alors que c'est un TXT ordinaire",
    proxifies([{ ...DKIM, proxied: true }]).verdict === "FAIL");
  att("D2 rouge — un CNAME de messagerie proxifié est refusé",
    proxifies([{ type: "CNAME", name: "autodiscover.exemple.fr", content: "cible.tld", proxied: true }]).verdict === "FAIL");
  att("D2 vert — un A de site web PROXIFIÉ est légitime : c'est le seul cas où le proxy sert",
    proxifies([{ ...WWW, proxied: true }]).verdict === "PASS");
  att("D2 vert — un MX NON proxifié passe",
    proxifies([MX, SPF, DKIM, SRV]).verdict === "PASS");
  att("D2 — un TXT ordinaire proxifié n'est pas accusé : seules les clés DKIM le sont",
    proxifies([{ ...SPF, proxied: true }]).verdict === "PASS");

  console.log(`\nRecette verifier-migration-dns : ${pass}/${pass + echecs.length} cas`);
  process.exit(echecs.length ? 1 : 0);
}

if (args.includes("--diff")) {
  const [o, c] = args.filter((a) => !a.startsWith("--"));
  if (!o || !c) { console.error("usage : --diff <origine.json> <cible.json>"); process.exit(2); }
  const a = lire(o), b = lire(c);
  if (a.erreur || b.erreur) { console.error(a.erreur || b.erreur); process.exit(2); }
  sortir(differer(a.liste, b.liste));
} else if (args.includes("--proxifies")) {
  const [c] = args.filter((a) => !a.startsWith("--"));
  if (!c) { console.error("usage : --proxifies <cible.json>"); process.exit(2); }
  const b = lire(c);
  if (b.erreur) { console.error(b.erreur); process.exit(2); }
  sortir(proxifies(b.liste));
} else {
  console.error("usage : verifier-migration-dns.mjs (--diff <origine> <cible> | --proxifies <cible> | --self-test) [--json]");
  process.exit(2);
}

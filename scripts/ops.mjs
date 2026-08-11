#!/usr/bin/env node
// ops.mjs — les trois verbes de forge-ops : deployer · restaurer · etat.
// Zéro dépendance, portable Windows/Unix. Règle dure : jamais de bascule sur
// release malade — le healthcheck s'exécute AVANT tout repointage de COURANT.
//
// Usage :
//   node ops.mjs deployer <dossier-build> <cible>
//   node ops.mjs restaurer <cible>
//   node ops.mjs etat <cible>
//
// Contrat de la cible : releases/<ts>/ + COURANT (pointeur texte) + journal.jsonl
// (append-only, contrat ledger forge-agents : seq strictement croissant depuis 1).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TYPES = ["deploiement", "deploiement_refuse", "restauration"];

function fail(msg) { console.error(`[OPS REFUS] ${msg}`); process.exit(1); }

function journalAppend(cible, type, detail) {
  const jp = path.join(cible, "journal.jsonl");
  let seq = 0;
  if (fs.existsSync(jp)) {
    const lignes = fs.readFileSync(jp, "utf8").split("\n").filter(Boolean);
    if (lignes.length) seq = JSON.parse(lignes[lignes.length - 1]).seq;
  }
  const entree = { seq: seq + 1, ts: new Date().toISOString(), type, ...detail };
  fs.appendFileSync(jp, JSON.stringify(entree) + "\n", "utf8");
  return entree;
}

function lireCourant(cible) {
  const cp = path.join(cible, "COURANT");
  return fs.existsSync(cp) ? fs.readFileSync(cp, "utf8").trim() : null;
}

function ecrireCourant(cible, release) {
  // écriture atomique : tmp puis rename (même volume)
  const cp = path.join(cible, "COURANT");
  const tmp = cp + ".tmp";
  fs.writeFileSync(tmp, release, "utf8");
  fs.renameSync(tmp, cp);
}

function healthcheck(releaseDir) {
  const sante = path.join(releaseDir, "sante.mjs");
  if (!fs.existsSync(sante))
    return { ok: false, raison: "sante.mjs absent — une app sans contrat de santé n'est pas exploitable" };
  const r = spawnSync(process.execPath, [sante], { cwd: releaseDir, encoding: "utf8", timeout: 30000 });
  return r.status === 0
    ? { ok: true }
    : { ok: false, raison: `healthcheck exit ${r.status}${r.stderr ? " — " + r.stderr.trim().slice(0, 120) : ""}` };
}

function releasesTriees(cible) {
  const rd = path.join(cible, "releases");
  if (!fs.existsSync(rd)) return [];
  return fs.readdirSync(rd).filter(n => fs.statSync(path.join(rd, n)).isDirectory()).sort();
}

function deployer(build, cible) {
  if (!build || !fs.existsSync(build)) fail(`build introuvable : ${build}`);
  fs.mkdirSync(path.join(cible, "releases"), { recursive: true });
  const nom = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "T");
  // suffixe anti-collision si deux déploiements dans la même seconde
  let release = nom, i = 0;
  while (fs.existsSync(path.join(cible, "releases", release))) release = `${nom}-${++i}`;
  const dest = path.join(cible, "releases", release);
  fs.cpSync(build, dest, { recursive: true });

  const santé = healthcheck(dest);
  if (!santé.ok) {
    journalAppend(cible, "deploiement_refuse", { release, raison: santé.raison });
    // la release malade ne reste pas basculable : on la retire, COURANT est intact
    fs.rmSync(dest, { recursive: true, force: true });
    fail(`healthcheck en échec — COURANT inchangé : ${santé.raison}`);
  }
  const precedent = lireCourant(cible);
  ecrireCourant(cible, release);
  journalAppend(cible, "deploiement", { release, precedent });
  console.log(`[OPS OK] déployé : ${release}${precedent ? ` (précédent : ${precedent})` : ""}`);
}

function restaurer(cible) {
  const courant = lireCourant(cible);
  if (!courant) fail("aucun COURANT — rien à restaurer");
  const releases = releasesTriees(cible);
  const idx = releases.indexOf(courant);
  const precedente = idx > 0 ? releases[idx - 1] : null;
  if (!precedente) fail("aucune release précédente — restauration impossible");
  const santé = healthcheck(path.join(cible, "releases", precedente));
  if (!santé.ok) fail(`la release précédente ${precedente} ne passe plus son healthcheck : ${santé.raison}`);
  ecrireCourant(cible, precedente);
  journalAppend(cible, "restauration", { release: precedente, depuis: courant });
  console.log(`[OPS OK] restauré : ${precedente} (depuis ${courant})`);
}

function etat(cible) {
  const courant = lireCourant(cible);
  const releases = releasesTriees(cible);
  const jp = path.join(cible, "journal.jsonl");
  const lignes = fs.existsSync(jp) ? fs.readFileSync(jp, "utf8").split("\n").filter(Boolean) : [];
  const dernier = lignes.length ? JSON.parse(lignes[lignes.length - 1]) : null;
  console.log(JSON.stringify({ courant, releases, evenements: lignes.length, dernier }, null, 2));
}

const [verbe, a, b] = process.argv.slice(2);
if (verbe === "deployer") { if (!b) fail("usage : deployer <build> <cible>"); deployer(a, b); }
else if (verbe === "restaurer") { if (!a) fail("usage : restaurer <cible>"); restaurer(a); }
else if (verbe === "etat") { if (!a) fail("usage : etat <cible>"); etat(a); }
else fail("verbe inconnu — deployer | restaurer | etat");

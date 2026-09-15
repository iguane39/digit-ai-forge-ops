#!/usr/bin/env node
// oracle-ops — Domaine « Exploitation : cible déployée saine et restaurable » (déterministe).
// Quatre règles O1-O4 sur une CIBLE d'exploitation réelle (jamais sur le code générateur) :
//   O1  COURANT existe et pointe une release présente sur disque ;
//       (SANS_OBJET si la cible porte un fichier PLATEFORME — pointeur tenu par une
//       plateforme externe, ex. railway ; jamais déduit du nom du dossier, TF-0844) ;
//   O2  la release courante repasse son healthcheck (exécution réelle de sante.mjs) ;
//   O3  journal.jsonl intègre : JSON valide, seq strictement croissant depuis 1, types connus ;
//       (même SANS_OBJET que O1 si PLATEFORME est déclaré — l'historique aussi est tenu
//       par la plateforme, TF-0844) ;
//   O4  rollback prouvable : s'il existe une release antérieure à la courante, elle est
//       toujours présente (capacité de restauration réelle) ET le dernier événement du
//       journal désigne la release courante (cohérence pointeur ↔ histoire).
//   O5  --plan <fichier>       : plan cloud complet (TF-0081, cf. plus bas).
//   O6  --drift <fichier> <cible> : état déclaré (`ops.mjs etat --sortie`) vs constaté
//       maintenant — troncature/réécriture du journal, déploiement furtif (TF-0107).
//   O7  --empreinte <cible> : fichiers de la release COURANTE vs empreinte scellée par
//       `ops.mjs deployer` OU `ops.mjs canary` (TF-0298, sha256 par fichier) — fichier
//       modifié/supprimé/ajouté en place après coup ; SKIP motivé si aucune empreinte
//       (déploiement antérieur au contrôle ou passé hors ops.mjs) (TF-0288).
//   O8  --planifie <racine>   : toute définition PLANIFIÉE du dépôt porte un mode d'exercice à
//       la demande, CÂBLÉ et distinct de sa cadence (TF-0527) — un travail qu'on ne peut
//       déclencher qu'à sa prochaine échéance se découvre cassé au moment où l'on compte dessus.
//   O10 --manifeste-servi <fichier> : chaque paquet épinglé par version (`==`) dans un
//       requirements.txt SERVI (image finale) porte au moins une empreinte `--hash=` (TF-1042) —
//       une version republiée sous le même numéro entre sinon sans être vue.
//   O11 --sonde-disponibilite <racine> : une sonde de disponibilité Terraform (web_test/
//       availability) ne vise jamais l'origine (`.ingress[0].fqdn`) sans variable de repli
//       (TF-1121) — sinon elle mesure une adresse que l'utilisateur n'ouvre jamais.
//   O12 (implicite, cible .md à `remediation_securite:` déclaré) : la fiche liste les
//       ENVIRONNEMENTS où elle a été rejouée (TF-1115) — sans quoi « appliquée » ne dit rien
//       de son périmètre réel.
//   O13 (implicite, toute cible .md) : un item de liste portant un verbe destructif à
//       l'infinitif (supprimer/retirer/fermer/purger/détruire) porte sa MATURITÉ (éprouvé/
//       déduit, TF-1116) et sa MESURE DE NON-RÉGRESSION (TF-1118) — jugées indépendamment.
//   O14 --inventaire-composants <export.json> <doc.md> : chaque nom d'un export machine du
//       parc figure LITTÉRALEMENT dans le document d'inventaire (TF-1114) — un « idem » ou
//       une accolade {a,b} n'est jamais un nom.
//   O15 --statut-composants <export.json> <doc.md> : sens inverse d'O14 (TF-1113 + TF-1117) —
//       un composant de Statut « actif » ou « partagé » figure dans l'export ; tout Statut est
//       pris au vocabulaire fermé ; une ligne « supprimable » de la section « Composants
//       inutilisés » dit ce qui cesse de fonctionner si on la supprime (« rien » exige une mesure).
//   R   --verdict-rollback <mesures> --seuils <fichier> : RECOMMANDATION seule (pas un
//       oracle de conformité) — seuils SLO humains vs mesures post-bascule (TF-0107).
// Contrat : JSON {oracle,domaine,artefact,verdict,findings,non_juge} · exit 0/1/2.
// Usage : node oracle-ops.mjs <cible> [--json-only]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { correspond, hacherFichier } from "../scripts/lib-empreinte.mjs";

const DOM = "Exploitation : cible déployée saine et restaurable";
const NON_JUGE = [
  "santé applicative au-delà du healthcheck déclaré par la release (parcours réels, charge)",
  "GO de mise en production — décision humaine, jamais un verdict d'oracle",
  "supervision continue / alerting (hors périmètre v0)",
  "secrets et configuration d'environnement — jamais transportés par la forge",
  "cible dont pointeur/historique sont tenus par une plateforme externe (fichier PLATEFORME) : preuve d'exécution laissée à O-5 (plan) et aux verdicts propres de la plateforme (TF-0844)",
];
const TYPES = ["deploiement", "deploiement_refuse", "restauration", "canary_etape", "canary_promotion", "canary_annulation"];

const args = process.argv.slice(2);
// TF-0281 (propagation de TF-0245) : la cible est résolue en absolu ICI, une seule fois.
// O2 exécute sante.mjs avec cwd=releaseDir : une cible restée relative rend le chemin du
// script relatif lui aussi, résolu par node contre ce NOUVEAU cwd — chemin doublé,
// « Cannot find module », exit 1 rapporté comme « healthcheck en échec » : un faux échec
// sur une release saine. Les autres chemins d'argument (--plan, --drift, --seuils,
// --verdict-rollback) ne sont lus que par fs depuis le cwd du process, jamais sous un cwd
// changé : ils restent tels quels, pas de rustine par usage.
const cibleArg = args.find(a => !a.startsWith("--"));
const cible = cibleArg ? path.resolve(cibleArg) : cibleArg;
const jsonOnly = args.includes("--json-only");
const iPlan = args.indexOf("--plan");
const planPath = iPlan >= 0 ? args[iPlan + 1] : null;
const F = [];
const add = (sev, regle, msg, where) => F.push({ sev, regle, msg, where });

// ── O5 · mode plan : un plan cloud est complet et cohérent (TF-0081) ────────
// Vérifie un fichier produit par `ops.mjs plan` : 4 phases non vides, rollback réel,
// commandes cohérentes avec la CLI de la cible, aucun credential en clair.
if (planPath) {
  const DOM5 = "Exploitation : plan de déploiement cloud complet (O-5)";
  const NJ5 = [
    "exécution réelle du plan (run MEP, environnement authentifié fourni par l'humain, GO humain)",
    "validité des valeurs substituées aux placeholders <...> au moment du run",
    "coûts réels de la cible — ordres de grandeur documentés par la fiche expert",
  ];
  const fin5 = (verdict, code) => {
    process.stdout.write(JSON.stringify({ oracle: "oracle-ops", domaine: DOM5, artefact: planPath, verdict, findings: F.length ? F : [{ sev: "info", regle: "O5", msg: "plan complet — 4 phases, rollback présent, CLI cohérente", where: planPath }], non_juge: NJ5 }, null, jsonOnly ? 0 : 2));
    process.exit(code);
  };
  if (!fs.existsSync(planPath)) { add("info", "O5", "plan introuvable", String(planPath)); fin5("SKIP", 2); }
  let p = null;
  try { p = JSON.parse(fs.readFileSync(planPath, "utf8")); } catch { add("bloquant", "O5", "JSON invalide", planPath); fin5("FAIL", 1); }
  // TF-0865 : deux cibles de produit data — bundle déclaratif Databricks (CLI `databricks bundle`)
  // et espace de travail Power BI alimenté par un projet PBIP (CLI Fabric `fab`).
  const CLI = { railway: "railway", gcp: "gcloud", azure: "az ", aws: "aws ", "databricks-bundle": "databricks bundle", "powerbi-workspace": "fab " };
  if (p.format !== "forge-ops/plan@1") add("bloquant", "O5", `format inconnu « ${p.format} » (attendu forge-ops/plan@1)`, planPath);
  if (!CLI[p.cible]) add("bloquant", "O5", `cible inconnue « ${p.cible} »`, planPath);
  for (const ph of ["provision", "deploiement", "healthcheck", "rollback"]) {
    const l = p.phases?.[ph];
    if (!Array.isArray(l) || l.length === 0)
      add("bloquant", "O5", `phase « ${ph} » absente ou vide — un plan sans ${ph === "rollback" ? "retour arrière n'est pas un plan MEP" : "cette phase est incomplet"}`, planPath);
  }
  if (CLI[p.cible] && Array.isArray(p.phases?.deploiement) && !p.phases.deploiement.some(c => String(c).includes(CLI[p.cible])))
    add("bloquant", "O5", `aucune commande de déploiement n'utilise la CLI attendue « ${CLI[p.cible].trim()} » pour la cible ${p.cible}`, planPath);
  if (Array.isArray(p.phases?.healthcheck) && !p.phases.healthcheck.some(c => /sante|health/i.test(String(c))))
    add("majeur", "O5", "la phase healthcheck ne référence aucun contrôle de santé (/sante attendu)", planPath);
  const brut = JSON.stringify(p);
  if (/AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|sk-[a-zA-Z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY/.test(brut))
    add("bloquant", "O5", "motif de credential détecté dans le plan — un plan ne transporte jamais de secret", planPath);
  const durs5 = F.filter(f => f.sev === "bloquant" || f.sev === "majeur");
  fin5(durs5.length ? "FAIL" : "PASS", durs5.length ? 1 : 0);
}

// ── O6 · dérive état déclaré ↔ état constaté (TF-0107) ──────────────────────────────
// Compare un instantané DÉCLARÉ (produit par `ops.mjs etat <cible> --sortie fichier.json`,
// hash du journal inclus) à l'état RÉEL de la cible maintenant. Comble un angle mort d'O1-O4
// (self-cohérence interne du journal courant, jamais vérifiée contre un témoin extérieur) :
//   - journal tronqué/purgé après la déclaration (moins d'événements que déclaré) ;
//   - historique réécrit en conservant seq/types valides (hash du segment déclaré altéré) ;
//   - déploiement furtif : release présente sur disque, absente de tout événement journal.
// La correction de la dérive n'est jamais automatique — c'est un constat, pas un geste.
const iDrift = args.indexOf("--drift");
const driftPath = iDrift >= 0 ? args[iDrift + 1] : null;
if (driftPath) {
  const DOM6 = "Exploitation : dérive entre état déclaré et état constaté (O-6)";
  const NJ6 = [
    "cause du changement manuel (accès disque direct, script tiers...) — hors périmètre",
    "état déclaré issu d'un plan cloud jamais exécuté réellement — O-6 juge une cible réelle",
    "correction de la dérive — un constat, jamais un geste automatique",
  ];
  const fin6 = (verdict, code) => {
    process.stdout.write(JSON.stringify({ oracle: "oracle-ops", domaine: DOM6, artefact: cible || null, verdict, findings: F.length ? F : [{ sev: "info", regle: "O6", msg: "aucune dérive : état constaté conforme à l'état déclaré", where: cible }], non_juge: NJ6 }, null, jsonOnly ? 0 : 2));
    process.exit(code);
  };
  if (!cible || !fs.existsSync(cible)) { add("info", "O6", "cible introuvable", String(cible)); fin6("SKIP", 2); }
  if (!fs.existsSync(driftPath)) { add("bloquant", "O6", "état déclaré introuvable", driftPath); fin6("FAIL", 1); }
  let declare = null;
  try { declare = JSON.parse(fs.readFileSync(driftPath, "utf8")); } catch { add("bloquant", "O6", "état déclaré illisible (JSON invalide)", driftPath); fin6("FAIL", 1); }

  const jp6 = path.join(cible, "journal.jsonl");
  const contenuNow = fs.existsSync(jp6) ? fs.readFileSync(jp6, "utf8") : "";
  const lignesNow = contenuNow.split("\n").filter(Boolean);
  const declEven = declare.evenements ?? 0;

  if (lignesNow.length < declEven) {
    add("bloquant", "O6", `journal régressé : ${lignesNow.length} événement(s) constaté(s) contre ${declEven} déclaré(s) — troncature ou purge`, "journal.jsonl");
  } else if (declare.journal_sha256) {
    const prefixe = declEven ? lignesNow.slice(0, declEven).join("\n") + "\n" : "";
    if (createHash("sha256").update(prefixe).digest("hex") !== declare.journal_sha256)
      add("bloquant", "O6", "historique du journal modifié après la déclaration (segment déclaré altéré)", "journal.jsonl");
  }

  const releasesDisque = fs.existsSync(path.join(cible, "releases")) ? fs.readdirSync(path.join(cible, "releases")) : [];
  const releasesJournalisees = new Set(lignesNow.map(l => { try { return JSON.parse(l).release; } catch { return null; } }).filter(Boolean));
  for (const r of releasesDisque)
    if (!releasesJournalisees.has(r))
      add("majeur", "O6", `release « ${r} » présente sur disque mais absente de tout le journal — déploiement furtif (hors ops.mjs)`, "releases/" + r);

  const durs6 = F.filter(f => f.sev === "bloquant" || f.sev === "majeur");
  fin6(durs6.length ? "FAIL" : "PASS", durs6.length ? 1 : 0);
}

// ── O7 · empreinte de déploiement : le servi correspond au scellé (TF-0288, étendu TF-0298) ─
// Compare les fichiers de la release COURANTE, maintenant, à l'empreinte scellée par
// `ops.mjs deployer` OU `ops.mjs canary` au moment de la promotion (`empreintes/<release>.json`,
// sha256 par fichier). Comble le volet PRÉVENTION resté ouvert par O-6 (qui juge le journal,
// jamais le CONTENU d'une release déjà journalisée) : un fichier édité en place dans
// releases/<release>/ après coup — sans nouveau déploiement, sans trace au journal — est
// invisible à O1-O4 et à O-6, visible ici. SKIP (jamais FAIL rétroactif) si la release
// n'a pas d'empreinte : déploiement antérieur au contrôle, ou passé hors `ops.mjs` (les deux
// voies de promotion scellent désormais — TF-0298 a fermé le trou canary déclaré par TF-0288).
if (args.includes("--empreinte")) {
  const DOM7 = "Exploitation : empreinte de déploiement — servi conforme au scellé (O-7)";
  const NJ7 = [
    "déploiement passé hors `ops.mjs` (deployer et canary scellent tous deux — TF-0298) — aucune empreinte n'y est scellée",
    "cause de la modification en place (accès disque direct, script tiers...) — hors périmètre",
    "correction de l'écart — un constat, jamais un geste automatique",
  ];
  const fin7 = (verdict, code) => {
    process.stdout.write(JSON.stringify({ oracle: "oracle-ops", domaine: DOM7, artefact: cible || null, verdict, findings: F.length ? F : [{ sev: "info", regle: "O7", msg: "aucune dérive : fichiers de la release conformes à l'empreinte scellée", where: cible }], non_juge: NJ7 }, null, jsonOnly ? 0 : 2));
    process.exit(code);
  };
  if (!cible || !fs.existsSync(cible)) { add("info", "O7", "cible introuvable", String(cible)); fin7("SKIP", 2); }
  const cp7 = path.join(cible, "COURANT");
  const courant7 = fs.existsSync(cp7) ? fs.readFileSync(cp7, "utf8").trim() : null;
  if (!courant7) { add("info", "O7", "aucun COURANT — rien à comparer", "COURANT"); fin7("SKIP", 2); }
  const releaseDir7 = path.join(cible, "releases", courant7);
  if (!fs.existsSync(releaseDir7)) { add("bloquant", "O7", `COURANT pointe une release inexistante : ${courant7}`, "COURANT"); fin7("FAIL", 1); }
  const empreintePath = path.join(cible, "empreintes", `${courant7}.json`);
  if (!fs.existsSync(empreintePath)) {
    add("info", "O7", `aucune empreinte scellée pour la release ${courant7} — déploiement antérieur au contrôle ou passé hors ops.mjs (deployer/canary)`, empreintePath);
    fin7("SKIP", 2);
  }
  let empreinte = null;
  try { empreinte = JSON.parse(fs.readFileSync(empreintePath, "utf8")); }
  catch { add("bloquant", "O7", "empreinte illisible (JSON invalide)", empreintePath); fin7("FAIL", 1); }
  const attendus = empreinte.fichiers || {};
  const surDisque = new Set();
  (function lister(dir, base) {
    for (const nom of fs.readdirSync(dir)) {
      const p = path.join(dir, nom);
      if (fs.statSync(p).isDirectory()) lister(p, base);
      else surDisque.add(path.relative(base, p).split(path.sep).join("/"));
    }
  })(releaseDir7, releaseDir7);
  for (const [rel, hachAttendu] of Object.entries(attendus)) {
    const p = path.join(releaseDir7, rel);
    if (!fs.existsSync(p)) { add("bloquant", "O7", `fichier supprimé après scellement : ${rel}`, rel); continue; }
    // TF-0615 : `correspond` accepte la forme NORMALISEE (celle ecrite depuis le 25/08) ET la
    // forme BRUTE (releases scellees avant). Sans cette tolerance, la correction ferait echouer
    // d'un coup toutes les releases deja scellees : un faux rouge echange contre un autre. Une
    // VRAIE modification ne correspond ni a l'une ni a l'autre, donc O7 garde ses dents.
    if (!correspond(p, hachAttendu)) add("bloquant", "O7", `fichier modifié après scellement : ${rel} (haché actuel ≠ empreinte)`, rel);
  }
  for (const rel of surDisque)
    if (!(rel in attendus)) add("majeur", "O7", `fichier présent mais absent de l'empreinte scellée : ${rel}`, rel);
  const durs7 = F.filter(f => f.sev === "bloquant" || f.sev === "majeur");
  fin7(durs7.length ? "FAIL" : "PASS", durs7.length ? 1 : 0);
}

// ── O8 · un travail PLANIFIÉ porte un MODE D'EXERCICE à la demande (TF-0527, 23/08/2026) ──
//
// MESURE QUI A FAIT NAÎTRE LE CONTRÔLE. Une définition de veille mensuelle venait d'être créée et
// enregistrée ; le relevé remis à l'humain annonçait « la veille est en place ». Son premier
// passage a rendu « Pas le premier lundi du mois — rien à faire » et s'est terminé EN SUCCÈS. Le
// script n'avait donc JAMAIS tourné sur un agent : ni ses dépendances, ni son accès réseau, ni la
// présence de son interpréteur n'avaient été éprouvés. Le premier passage réel aurait eu lieu
// QUINZE JOURS plus tard — au moment précis où l'on compte dessus. Après ajout d'un paramètre
// d'exécution forcée, distinct de la cadence, le script a tourné pour de vrai : trois contrôles
// rendus, tous verts, en 40 secondes, dont un qui a réellement interrogé le registre de paquets.
//
// C'est le pendant exact de « un ✓ sans oracle exécuté n'est pas un ✓ », appliqué aux traitements
// différés : UN MÉCANISME QUI N'A JAMAIS TOURNÉ N'EST PAS UN MÉCANISME, c'est une intention
// planifiée. Et la première loi transverse le dit déjà d'une autre manière — une affordance est
// câblée ou elle n'existe pas : c'est pourquoi un paramètre DÉCLARÉ MAIS JAMAIS LU est jugé ici
// aussi durement qu'un paramètre absent. Il donne la même impression et ne fait rien.
//
// Ce que l'oracle voit, et ce qu'il ne verra jamais : il lit des DÉFINITIONS, pas un historique
// de passages. Il peut donc prouver que le mode d'exercice EXISTE et qu'il est CÂBLÉ ; il ne peut
// pas prouver qu'on s'en est servi. La déclaration `# exerce_le: AAAA-MM-JJ` comble cette moitié
// par un fait daté dans le fichier (loi n° 4 : une donnée volatile est une donnée, datée, sourcée)
// et reste un AVERTISSEMENT — un fichier antérieur au contrôle n'a rien fait de mal.
if (args.includes("--planifie")) {
  const DOM8 = "Exploitation : un travail planifié est exerçable à la demande (O-8)";
  const NJ8 = [
    "l'EXERCICE lui-même — l'oracle lit des définitions, jamais un historique de passages ; la déclaration `# exerce_le:` est un fait déclaré, pas un fait mesuré (l'historique du système d'intégration reste la source)",
    "la JUSTESSE de la cadence (le bon jour, la bonne heure) — un choix humain, jamais un verdict",
    "les définitions hors des emplacements connus (.github/workflows/, azure-pipelines*.yml, pipelines/) — une définition rangée ailleurs reste invisible",
    "les planifications posées HORS dépôt (interface web du système d'intégration, tâche planifiée d'un serveur, cron d'une machine) : elles ne laissent aucun fichier à lire",
  ];
  const fin8 = (verdict, code) => {
    process.stdout.write(JSON.stringify({ oracle: "oracle-ops", domaine: DOM8, artefact: cible || null, verdict, findings: F.length ? F : [{ sev: "info", regle: "O8", msg: "aucune définition planifiée trouvée aux emplacements connus — rien à juger", where: cible }], non_juge: NJ8 }, null, jsonOnly ? 0 : 2));
    process.exit(code);
  };
  if (!cible || !fs.existsSync(cible)) { add("info", "O8", "racine introuvable", String(cible)); fin8("SKIP", 2); }

  // Emplacements connus. Bornés par choix : une descente libre sur un dépôt produit lirait des
  // milliers de fichiers pour trouver ce qui vit toujours aux deux ou trois mêmes endroits.
  const candidats = [];
  const ajouterDossier = (dir, prof = 0) => {
    if (prof > 2 || !fs.existsSync(dir)) return;
    for (const nom of fs.readdirSync(dir)) {
      const q = path.join(dir, nom);
      if (fs.statSync(q).isDirectory()) ajouterDossier(q, prof + 1);
      else if (/\.ya?ml$/i.test(nom)) candidats.push(q);
    }
  };
  ajouterDossier(path.join(cible, ".github", "workflows"));
  ajouterDossier(path.join(cible, "pipelines"));
  ajouterDossier(path.join(cible, ".azuredevops"));
  if (fs.statSync(cible).isDirectory()) {
    for (const nom of fs.readdirSync(cible)) {
      // Les deux graphies de racine rencontrées dans le parc : la convention du système
      // d'intégration (`azure-pipelines*.yml`) et le fichier nommé d'après son travail
      // (`…veille.yml`, `…planifie.yml`). Ce qui est rangé ailleurs est déclaré au non_juge.
      if (/^azure-pipelines.*\.ya?ml$/i.test(nom)
        || /^[a-z0-9._-]*(veille|planifie|scheduled|cron)[a-z0-9._-]*\.ya?ml$/i.test(nom))
        candidats.push(path.join(cible, nom));
    }
  }

  let planifiees = 0;
  for (const f of candidats) {
    const texte = fs.readFileSync(f, "utf8");
    const ou = path.relative(cible, f).split(path.sep).join("/");
    // Une planification se reconnaît à son cron. Les deux dialectes du parc l'écrivent pareil :
    // `- cron: "..."` sous `schedules:` (Azure) ou sous `on: schedule:` (GitHub).
    if (!/^\s*-?\s*cron\s*:/m.test(texte)) continue;
    planifiees++;
    const dispatch = /^\s*workflow_dispatch\s*:/m.test(texte);
    // Un paramètre n'est un mode d'exercice que s'il est LU. Déclaré et jamais lu, il donne la
    // même impression qu'un vrai bouton et ne fait rien : c'est la première loi transverse.
    const declares = [...texte.matchAll(/^\s*-\s*name\s*:\s*([A-Za-z0-9_]+)\s*$/gm)].map((m) => m[1]);
    const lus = declares.filter((n) => new RegExp("parameters\\." + n + "\\b").test(texte));
    if (dispatch || lus.length) {
      // La cadence reste la cadence : un mode d'exercice qui la REMPLACE n'exerce pas le même
      // travail. On ne le juge pas — on ne saurait pas le lire — mais on le dit au non_juge.
      const exerce = /^\s*#\s*exerce_le\s*:\s*(\d{4}-\d{2}-\d{2})/m.exec(texte);
      if (!exerce)
        add("info", "O8", `mode d'exercice câblé, mais AUCUN exercice déclaré : ajouter « # exerce_le: AAAA-MM-JJ » le jour où le passage forcé a réellement tourné. Sans lui, « en place » reste une intention — le premier passage réel aura lieu à la prochaine cadence, au moment précis où l'on compte dessus`, ou);
      else
        add("info", "O8", `mode d'exercice câblé et exercé le ${exerce[1]}`, ou);
      continue;
    }
    if (declares.length && !lus.length)
      add("bloquant", "O8", `définition planifiée dont le seul paramètre déclaré n'est JAMAIS LU (${declares.join(", ")}) : l'affordance existe à l'écran et ne fait rien — une affordance est câblée ou elle n'existe pas (loi n° 1). Lire le paramètre dans la garde de cadence, sinon le passage forcé ne fera rien de plus que le passage hors cadence`, ou);
    else
      add("bloquant", "O8", `définition planifiée SANS mode d'exercice à la demande : elle ne peut être éprouvée qu'à sa prochaine cadence, donc elle se découvrira cassée au moment où l'on compte dessus. Ajouter un déclencheur manuel (workflow_dispatch) ou un paramètre d'exécution forcée LU dans la garde de cadence — distinct de la cadence, qui ne change pas`, ou);
  }
  if (!planifiees) { add("info", "O8", `aucune définition planifiée parmi ${candidats.length} fichier(s) aux emplacements connus — rien à juger`, path.basename(String(cible))); fin8("SKIP", 2); }
  const durs8 = F.filter(f => f.sev === "bloquant" || f.sev === "majeur");
  fin8(durs8.length ? "FAIL" : "PASS", durs8.length ? 1 : 0);
}

// ── O10 · manifeste de dépendances SERVI épinglé à l'EMPREINTE (TF-1042, mesure Produit-11
// du 11/09/2026) ─────────────────────────────────────────────────────────────────────────
//
// LE FAIT. Le manifeste qui composait l'image SERVIE (requirements.txt copié par le
// Dockerfile) épinglait chaque paquet à une VERSION (`paquet==x.y.z`) mais AUCUN à une
// EMPREINTE de contenu (`--hash=sha256:...`) — 37 paquets, zéro hash. Un numéro de version
// ne verrouille rien sur un registre qui permet la republication sous le même numéro : seule
// l'empreinte du contenu le fait. C'est le même principe qu'O-7 (déployé = scellé),
// appliqué un cran plus tôt — au manifeste qui construit l'image, avant même le déploiement.
//
// CE QUI EST JUGÉ : la PRÉSENCE d'au moins une empreinte `--hash=` sur chaque ligne déjà
// épinglée par version exacte (`==`). Une ligne sans `==` (URL, plage, `-r`, `-e`,
// commentaire, vide) n'épingle rien : hors périmètre, rien à verrouiller. Périmètre v0
// borné au format `requirements.txt` (pip) — c'est le format de la mesure fondatrice ;
// poetry.lock/uv.lock/package-lock.json ont leurs propres mécanismes de verrou, non jugés ici.
if (args.includes("--manifeste-servi")) {
  const manifestePath = args[args.indexOf("--manifeste-servi") + 1];
  const DOM10 = "Exploitation : manifeste de dépendances SERVI épinglé à l'empreinte (O-10)";
  const NJ10 = [
    "l'intégrité réelle contre le registre de paquets (PyPI...) — l'oracle vérifie la PRÉSENCE d'une empreinte dans le manifeste, jamais sa validité cryptographique face au paquet publié",
    "les formats de verrou hors requirements.txt (poetry.lock, uv.lock, package-lock.json...) — périmètre v0 borné au format de la mesure fondatrice (Produit-11)",
  ];
  const fin10 = (verdict, code) => {
    process.stdout.write(JSON.stringify({ oracle: "oracle-ops", domaine: DOM10, artefact: manifestePath || null, verdict, findings: F.length ? F : [{ sev: "info", regle: "O10", msg: "tous les paquets épinglés par version portent une empreinte", where: manifestePath }], non_juge: NJ10 }, null, jsonOnly ? 0 : 2));
    process.exit(code);
  };
  if (!manifestePath || !fs.existsSync(manifestePath)) { add("bloquant", "O10", "manifeste introuvable", String(manifestePath)); fin10("donnees_insuffisantes", 2); }
  const lignes = fs.readFileSync(manifestePath, "utf8").split(/\r?\n/);
  let paquetsEpingles = 0;
  for (const ligneBrute of lignes) {
    const ligne = ligneBrute.trim();
    if (!ligne || ligne.startsWith("#") || ligne.startsWith("-")) continue; // commentaire, -r/-e/--index-url...
    const m = /^([A-Za-z0-9._-]+)\s*==\s*[^\s;]+/.exec(ligne);
    if (!m) continue; // pas un épinglage de version exacte : hors périmètre (URL, plage, extra sans version...)
    paquetsEpingles++;
    if (!/--hash=(sha256|sha512):[0-9a-f]{16,}/i.test(ligne))
      add("bloquant", "O10", `paquet épinglé par version SANS empreinte : '${m[1]}' — une version republiée sous le même numéro entrerait sans être vue`, m[1]);
  }
  if (!paquetsEpingles) { add("info", "O10", "aucun paquet épinglé par version (==) dans ce manifeste — rien à contrôler", path.basename(String(manifestePath))); fin10("SKIP", 2); }
  const durs10 = F.filter(f => f.sev === "bloquant" || f.sev === "majeur");
  fin10(durs10.length ? "FAIL" : "PASS", durs10.length ? 1 : 0);
}

// ── O11 · une sonde de disponibilité vise l'adresse SERVIE, jamais l'origine (TF-1121,
// mesure Produit-11 du 14/09/2026) ──────────────────────────────────────────────────────
//
// LE FAIT. `infra-tf/monitoring.tf` posait `url = "https://${azurerm_container_app.front.
// ingress[0].fqdn}/"` — le nom de domaine de l'ORIGINE. En qualification, l'environnement
// d'exécution porte `publicNetworkAccess=Disabled` : cette adresse n'est joignable par
// personne, la sonde était pourtant `Enabled` et son alerte (sévérité 1) s'est déclenchée
// dans la semaine. En production, seul le préfixe AzureFrontDoor.Backend est autorisé en
// entrée : la même sonde y serait refusée pour la même raison. Le défaut produit du BRUIT DE
// SÉVÉRITÉ 1 sur deux environnements sur trois — il désensibilise au lieu d'informer.
//
// CE QUI EST JUGÉ, contrôle STATIQUE (coïncidence de motif Terraform, aucune exécution) :
// dans un bloc de ressource dont le type évoque une sonde de disponibilité (`web_test`,
// `availability`), l'attribut `url` ne référence jamais directement l'origine
// (`.ingress[0].fqdn`, `.default_hostname`) SANS passer par une variable (`var.*`) — la
// variable est le point où une adresse SERVIE (front door, domaine public) peut remplacer
// l'origine quand un frontal existe. Même doctrine que le paramètre O-8 : une sonde qui vise
// l'origine sans variable de repli est câblée sur ce qui n'est jamais ouvert à l'utilisateur.
if (args.includes("--sonde-disponibilite")) {
  const racineSonde = args[args.indexOf("--sonde-disponibilite") + 1];
  const DOM11 = "Exploitation : une sonde de disponibilité vise l'adresse SERVIE, jamais l'origine (O-11)";
  const NJ11 = [
    "la joignabilité RÉELLE de l'adresse — l'oracle lit du texte Terraform, jamais un appel réseau",
    "les formats de sonde hors azurerm_*web_test*/azurerm_*availability* — périmètre v0 borné aux types de la mesure fondatrice",
    "la justesse de la variable substituée (nom, valeur) — l'oracle juge sa PRÉSENCE dans l'expression, jamais son contenu",
  ];
  const fin11 = (verdict, code) => {
    process.stdout.write(JSON.stringify({ oracle: "oracle-ops", domaine: DOM11, artefact: racineSonde || null, verdict, findings: F.length ? F : [{ sev: "info", regle: "O11", msg: "aucune sonde ne vise l'origine sans variable de repli", where: racineSonde }], non_juge: NJ11 }, null, jsonOnly ? 0 : 2));
    process.exit(code);
  };
  if (!racineSonde || !fs.existsSync(racineSonde)) { add("info", "O11", "racine introuvable", String(racineSonde)); fin11("SKIP", 2); }
  const fichiersTf = [];
  (function lister(dir, prof = 0) {
    if (prof > 3 || !fs.existsSync(dir)) return;
    for (const nom of fs.readdirSync(dir)) {
      if (nom === ".terraform" || nom === "node_modules" || nom === ".git") continue;
      const p = path.join(dir, nom);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) lister(p, prof + 1);
      else if (/\.tf$/i.test(nom)) fichiersTf.push(p);
    }
  })(racineSonde);
  const BLOC_SONDE = /resource\s+"(\w*(?:web_test|availability)\w*)"\s+"([^"]+)"\s*\{([\s\S]*?)\n\}/gi;
  let sondesTrouvees = 0;
  for (const f of fichiersTf) {
    const texte = fs.readFileSync(f, "utf8");
    const ou = path.relative(racineSonde, f).split(path.sep).join("/");
    let m;
    BLOC_SONDE.lastIndex = 0;
    while ((m = BLOC_SONDE.exec(texte))) {
      const [, typeRes, nomRes, corps] = m;
      // Capture le reste de la ligne après `url =` telle quelle (jamais seulement une chaîne
      // simple entre guillemets) : une adresse SERVIE s'écrit souvent en ternaire
      // (`var.x != "" ? "..." : "..."`), et la variable de repli doit rester visible.
      const urlM = /^[ \t]*url\s*=\s*(.+)$/m.exec(corps);
      if (!urlM) continue;
      sondesTrouvees++;
      const urlExpr = urlM[1];
      const viseOrigine = /\.ingress\[0\]\.fqdn|\.default_hostname/.test(urlExpr);
      const passeParVariable = /var\./.test(urlExpr);
      if (viseOrigine && !passeParVariable)
        add("bloquant", "O11", `sonde ${typeRes}.${nomRes} : url vise l'origine (${urlExpr}) sans variable de repli — mesure une adresse que l'utilisateur n'ouvre jamais, refusée par le même pare-feu que le vrai trafic`, ou);
    }
  }
  if (!sondesTrouvees) { add("info", "O11", `aucune sonde de disponibilité (web_test/availability) parmi ${fichiersTf.length} fichier(s) .tf — rien à juger`, racineSonde); fin11("SKIP", 2); }
  const durs11 = F.filter(f => f.sev === "bloquant" || f.sev === "majeur");
  fin11(durs11.length ? "FAIL" : "PASS", durs11.length ? 1 : 0);
}

// ── O14 · l'inventaire documenté contient chaque nom de l'export RÉEL (TF-1114, mesure
// Produit-11 du 14/09/2026) ─────────────────────────────────────────────────────────────
//
// LE FAIT. `docs/projet/COMPOSANTS-OPS.md` portait `verifie_le: 2026-08-11` alors qu'entre
// temps 2 comptes de stockage, 2 tâches planifiées, 16 ressources de supervision et les 35
// ressources d'un second groupe de ressources sont nées — un oracle de présence de sections
// (R-20, côté pilot) rendait PASS sans jamais confronter le document au parc réel. Contrôle
// joué à la main en 40 lignes le 14/09 : export du parc, chaque nom cherché LITTÉRALEMENT
// dans le document → 7 absents (dont cinq alertes écrites « idem », un nom entre accolades) ;
// 0 après correction.
//
// CE QUI EST JUGÉ, sur le modèle d'O-6 (état déclaré vs constaté, jamais un appel réseau) :
// chaque nom d'un EXPORT MACHINE (produit hors de cet oracle — `az graph query`, `ops.mjs
// etat --sortie`) figure LITTÉRALEMENT dans le document d'inventaire. Un « idem » ou une
// accolade `{a,b}` n'est jamais lu comme un nom — coïncidence de sous-chaîne stricte.
if (args.includes("--inventaire-composants")) {
  const iInv = args.indexOf("--inventaire-composants");
  const exportPath = args[iInv + 1];
  const docPath = args[iInv + 2];
  const DOM14 = "Exploitation : l'inventaire documenté contient chaque nom de l'export réel (O-14)";
  const NJ14 = [
    "la fraîcheur de l'EXPORT lui-même — l'oracle confronte deux fichiers, jamais le parc cloud en direct",
    "la nature de la correspondance — une coïncidence de sous-chaîne stricte, jamais une correspondance structurelle (tableau, section)",
  ];
  const fin14 = (verdict, code) => {
    process.stdout.write(JSON.stringify({ oracle: "oracle-ops", domaine: DOM14, artefact: docPath || null, verdict, findings: F.length ? F : [{ sev: "info", regle: "O14", msg: "chaque nom de l'export figure dans le document d'inventaire", where: docPath }], non_juge: NJ14 }, null, jsonOnly ? 0 : 2));
    process.exit(code);
  };
  if (!exportPath || !fs.existsSync(exportPath)) { add("bloquant", "O14", "export introuvable", String(exportPath)); fin14("donnees_insuffisantes", 2); }
  if (!docPath || !fs.existsSync(docPath)) { add("bloquant", "O14", "document d'inventaire introuvable", String(docPath)); fin14("donnees_insuffisantes", 2); }
  let exportData = null;
  try { exportData = JSON.parse(fs.readFileSync(exportPath, "utf8")); } catch { add("bloquant", "O14", "export illisible (JSON invalide)", exportPath); fin14("FAIL", 1); }
  const noms = Array.isArray(exportData?.noms) ? exportData.noms : [];
  if (!noms.length) { add("info", "O14", "export sans aucun nom — rien à confronter", exportPath); fin14("SKIP", 2); }
  const docTexte = fs.readFileSync(docPath, "utf8");
  for (const nom of noms) {
    if (!docTexte.includes(nom))
      add("bloquant", "O14", `ressource « ${nom} » présente dans l'export réel mais ABSENTE, littéralement, du document d'inventaire — un « idem » ou une accolade {a,b} n'est pas un nom`, nom);
  }
  const durs14 = F.filter(f => f.sev === "bloquant" || f.sev === "majeur");
  fin14(durs14.length ? "FAIL" : "PASS", durs14.length ? 1 : 0);
}

// ── Lecture partagée O15-O17 : tables markdown, graphies accentuées OU non ─────────────────
// Les documents des produits s'écrivent souvent sans accents (« partage », « inutilises ») :
// toute comparaison de vocabulaire ou d'en-tête passe par `_norm`, qui retire les accents, la
// casse, les marques de code et de gras, et unifie l'apostrophe. Un NOM de composant, lui, ne
// se normalise jamais au-delà des marques markdown : `_valeurCellule`.
const _valeurCellule = s => String(s ?? "").replace(/`/g, "").replace(/\*\*/g, "").trim().replace(/\.$/, "").trim();
const _sansAccents = s => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’‘]/g, "'").toLowerCase().replace(/\s+/g, " ").trim();
const _norm = s => _sansAccents(_valeurCellule(s));
// Une cellule VIDE au sens du contrôle : rien, un tiret, un point d'interrogation, « n/a »,
// « à compléter » ou un marqueur de gabarit `{…}` non instancié.
const _vide = s => { const n = _norm(s); return !n || /^[-—–?]+$/.test(n) || n === "n/a" || n === "a completer" || /^\{.*\}$/.test(n); };
// Tables markdown d'un texte, chacune avec la pile des titres sous lesquels elle vit. Les blocs
// de code (```) sont sautés : un exemple de table n'est pas une table.
function _tablesMarkdown(texte) {
  const lignes = String(texte).split(/\r?\n/);
  const tables = [];
  const pile = [];
  let dansCode = false;
  const cellules = l => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
  for (let i = 0; i < lignes.length; i++) {
    const l = lignes[i];
    if (/^\s*```/.test(l)) { dansCode = !dansCode; continue; }
    if (dansCode) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      while (pile.length && pile[pile.length - 1].niveau >= h[1].length) pile.pop();
      pile.push({ niveau: h[1].length, titre: h[2] });
      continue;
    }
    if (/^\s*\|/.test(l) && i + 1 < lignes.length && /^\s*\|?\s*:?-{2,}/.test(lignes[i + 1])) {
      const t = { ligne: i + 1, entetes: cellules(l), lignes: [], titres: pile.map(p => p.titre) };
      i += 2;
      while (i < lignes.length && /^\s*\|/.test(lignes[i])) { t.lignes.push(cellules(lignes[i])); i++; }
      i--;
      tables.push(t);
    }
  }
  return tables;
}
const _colonne = (t, ...noms) => t.entetes.findIndex(e => noms.includes(_norm(e)));

// ── O15 · le Statut déclaré d'un composant est confronté à l'export RÉEL, et un « supprimable »
// dit ce qu'il casse (TF-1113 + TF-1117, mesures Produit-11 du 14/09/2026) ───────────────────
//
// LE FAIT (TF-1113). Dix éléments sans consommateur coexistaient avec un document d'inventaire
// CONFORME : aucune colonne ne distinguait ce qui sert de ce qui ne sert plus, et deux
// suppressions « évidentes d'après le nom » auraient tué le produit. O-14 confrontait déjà
// l'export au document dans UN sens (tout nom du parc est écrit) ; le sens inverse — ce qu'on
// DÉCLARE en service existe dans le parc — attendait un Statut à vocabulaire fermé.
//
// LE FAIT (TF-1117). Sur dix lignes « inutilisées » avec preuve d'absence de consommateur, CINQ
// n'étaient pas supprimables : l'adresse d'une règle de pare-feu était celle du poste en
// service, deux connexions de service étaient les seules identités capables d'appliquer la pile.
// L'absence de consommateur ouvre une question, elle ne rend pas un verdict : la colonne qui
// protège est « ce qui cesse de fonctionner si on le supprime ».
//
// CE QUI EST JUGÉ (deux fichiers, aucun appel réseau, même posture qu'O-14) :
//   (1) toute table portant une colonne « Statut » : chaque valeur appartient au vocabulaire
//       fermé (actif / partagé / déclaré / inutilisé / hors périmètre), et un composant « actif »
//       ou « partagé » figure dans l'export (`noms`) — nom lu dans la colonne Composant/Nom/
//       Ressource, sinon la première ;
//   (2) toute table sous le titre « Composants inutilisés… » : le statut de supprimabilité
//       appartient au vocabulaire fermé (supprimable / non supprimable, droit absent / non
//       supprimable, décision / non supprimable, tiers propriétaire), et une ligne « supprimable »
//       renseigne « ce qui cesse de fonctionner si on le supprime » — ni vide, ni « rien »/
//       « aucun » sans mesure citée (une commande entre accents graves, ou « mesuré… » suivi
//       d'une date AAAA-MM-JJ ou de deux-points).
// Graphies accentuées et non accentuées acceptées, pour les valeurs comme pour les en-têtes.
const _STATUTS_O15 = ["actif", "partage", "declare", "inutilise", "hors perimetre"];
const _SUPPRIMABILITE_O15 = ["supprimable", "non supprimable, droit absent", "non supprimable, decision", "non supprimable, tiers proprietaire"];
const _MESURE_CITEE_O15 = /`[^`]+`|\bmesur\w*\b[^|]*?(\d{4}-\d{2}-\d{2}|:\s*\S)/;
if (args.includes("--statut-composants")) {
  const iSt = args.indexOf("--statut-composants");
  const exportPath = args[iSt + 1];
  const docPath = args[iSt + 2];
  const DOM15 = "Exploitation : le Statut déclaré d'un composant tient face à l'export réel, un « supprimable » dit ce qu'il casse (O-15)";
  const NJ15 = [
    "la fraîcheur et le PÉRIMÈTRE de l'export — un composant « partagé » vit souvent dans un groupe de ressources d'une autre application : si l'export ne couvre pas ce groupe, l'oracle le dit absent ; élargir l'export, jamais le Statut",
    "la JUSTESSE d'un Statut — « actif » présent dans l'export peut être inutile ; seul le consommateur résolu (image, secretRef, identité, appel) le prouve, et il ne se lit dans aucun des deux fichiers",
    "la vérité de « ce qui cesse de fonctionner » — l'oracle juge que la colonne est renseignée et qu'un « rien » cite sa mesure, jamais que la mesure est juste",
    "la présence des colonnes preuve d'inutilité, créé par quoi, geste et titulaire du droit, et de la section « Composants inutilisés » elle-même — jugée par R-20 côté pilot ; O-15 exige seulement les deux colonnes qu'il lit",
    "un nom écrit avec sa description dans la même cellule — la cellule entière, marques markdown retirées, est lue comme le nom",
  ];
  const fin15 = (verdict, code) => {
    process.stdout.write(JSON.stringify({ oracle: "oracle-ops", domaine: DOM15, artefact: docPath || null, verdict, findings: F.length ? F : [{ sev: "info", regle: "O15", msg: "chaque Statut est au vocabulaire fermé, chaque composant actif ou partagé est dans l'export, chaque « supprimable » dit ce qu'il casse", where: docPath }], non_juge: NJ15 }, null, jsonOnly ? 0 : 2));
    process.exit(code);
  };
  if (!exportPath || !fs.existsSync(exportPath)) { add("bloquant", "O15", "export introuvable", String(exportPath)); fin15("donnees_insuffisantes", 2); }
  if (!docPath || !fs.existsSync(docPath)) { add("bloquant", "O15", "document d'inventaire introuvable", String(docPath)); fin15("donnees_insuffisantes", 2); }
  let exportData = null;
  try { exportData = JSON.parse(fs.readFileSync(exportPath, "utf8")); } catch { add("bloquant", "O15", "export illisible (JSON invalide)", exportPath); fin15("FAIL", 1); }
  const noms = new Set((Array.isArray(exportData?.noms) ? exportData.noms : []).map(String));
  const tables = _tablesMarkdown(fs.readFileSync(docPath, "utf8"));
  const tablesStatut = tables.filter(t => _colonne(t, "statut") >= 0);
  const tablesInutiles = tables.filter(t => t.titres.some(h => _norm(h).startsWith("composants inutilises")));
  if (!tablesStatut.length && !tablesInutiles.length) {
    add("info", "O15", "aucune colonne « Statut » ni table sous « Composants inutilisés » — document antérieur au gabarit : rien à confronter (leur présence relève de R-20, côté pilot)", docPath);
    fin15("SKIP", 2);
  }
  if (!noms.size && tablesStatut.length)
    add("info", "O15", "export sans aucun nom — la présence des composants actifs ou partagés n'est pas confrontée", exportPath);
  for (const t of tablesStatut) {
    const iStatut = _colonne(t, "statut");
    const iNom = Math.max(0, _colonne(t, "composant", "nom", "ressource"));
    for (const l of t.lignes) {
      const nom = _valeurCellule(l[iNom]);
      const statut = _norm(l[iStatut]);
      if (!_STATUTS_O15.includes(statut))
        add("bloquant", "O15", `Statut « ${_valeurCellule(l[iStatut])} » de « ${nom} » hors du vocabulaire fermé (actif / partagé / déclaré / inutilisé / hors périmètre) — un statut libre ne distingue plus ce qui sert de ce qui peut partir (TF-1113)`, nom);
      else if ((statut === "actif" || statut === "partage") && noms.size && !noms.has(nom))
        add("bloquant", "O15", `composant « ${nom} » déclaré « ${_valeurCellule(l[iStatut])} » mais ABSENT de l'export réel — un composant dit en service que le parc ne connaît pas est un nom mort, une faute de frappe ou un export trop étroit (TF-1113)`, nom);
    }
  }
  const COL_CESSE = "ce qui cesse de fonctionner si on le supprime";
  const COL_SUPP = "statut de supprimabilite";
  for (const t of tablesInutiles) {
    const iCesse = _colonne(t, COL_CESSE);
    const iSupp = _colonne(t, COL_SUPP);
    const manquantes = [iCesse < 0 ? "ce qui cesse de fonctionner si on le supprime" : null, iSupp < 0 ? "statut de supprimabilité" : null].filter(Boolean);
    if (manquantes.length) {
      add("bloquant", "O15", `table de la section « Composants inutilisés » (ligne ${t.ligne}) sans colonne ${manquantes.map(c => `« ${c} »`).join(" ni ")} — la colonne qui protège d'une suppression dangereuse n'a rien à lire (TF-1117)`, `${path.basename(docPath)}:${t.ligne}`);
      continue;
    }
    const iNom = Math.max(0, _colonne(t, "composant", "nom", "ressource"));
    for (const l of t.lignes) {
      const nom = _valeurCellule(l[iNom]);
      // Une ligne qui déclare la section vide (« aucun composant inutilisé ») n'est pas un composant.
      if (_vide(l[iSupp]) && _vide(l[iCesse]) && /^aucun/.test(_norm(nom))) continue;
      const supp = _norm(l[iSupp]);
      if (!_SUPPRIMABILITE_O15.includes(supp)) {
        add("bloquant", "O15", `statut de supprimabilité « ${_valeurCellule(l[iSupp])} » de « ${nom} » hors du vocabulaire fermé (supprimable / non supprimable, droit absent / non supprimable, décision / non supprimable, tiers propriétaire) — sans consommateur n'est pas supprimable (TF-1117)`, nom);
        continue;
      }
      if (supp !== "supprimable") continue;
      const cesse = l[iCesse];
      if (_vide(cesse))
        add("bloquant", "O15", `« ${nom} » déclaré supprimable avec « ce qui cesse de fonctionner si on le supprime » VIDE — l'absence de consommateur ouvre une question, elle ne rend pas un verdict (TF-1117)`, nom);
      else if (/^(rien|aucun|aucune|neant)\b/.test(_norm(cesse)) && !_MESURE_CITEE_O15.test(_sansAccents(cesse)))
        add("bloquant", "O15", `« ${nom} » déclaré supprimable avec « ${_valeurCellule(cesse)} » comme effet, sans mesure citée — « rien » se prouve par une commande ou une mesure datée, jamais par l'absence de consommateur connu (TF-1117)`, nom);
    }
  }
  const durs15 = F.filter(f => f.sev === "bloquant" || f.sev === "majeur");
  fin15(durs15.length ? "FAIL" : "PASS", durs15.length ? 1 : 0);
}

// ── Verdict « rollback recommandé » · seuils SLO fixés par l'humain (TF-0107) ───────
// RECOMMANDATION SEULE : compare des mesures post-bascule à des seuils que l'humain a
// figés dans un fichier de config (latence, taux d'erreur, fenêtre minimale) — aucun défaut
// implicite (fichier de seuils obligatoire), jamais d'exécution. Doctrine « ops outille, ne
// décide jamais » : la bascule arrière reste un geste humain via `ops.mjs restaurer`.
const iVR = args.indexOf("--verdict-rollback");
const mesuresPath = iVR >= 0 ? args[iVR + 1] : null;
const iSeuilsSlo = args.indexOf("--seuils");
const seuilsSloPath = iSeuilsSlo >= 0 ? args[iSeuilsSlo + 1] : null;
if (mesuresPath) {
  const DOMR = "Exploitation : recommandation de rollback post-bascule (seuils SLO humains)";
  const NJR = [
    "exécution du rollback — geste humain via `ops.mjs restaurer`, jamais automatique",
    "le choix des seuils — responsabilité humaine ; l'oracle ne fixe ni ne devine de défaut",
    "cause racine de la dégradation observée",
  ];
  const finR = (verdict, code, extra = {}) => {
    process.stdout.write(JSON.stringify({ oracle: "oracle-ops", domaine: DOMR, artefact: mesuresPath, verdict, ...extra, findings: F.length ? F : [{ sev: "info", regle: "R", msg: "mesures sous les seuils — aucune dérive", where: mesuresPath }], non_juge: NJR }, null, jsonOnly ? 0 : 2));
    process.exit(code);
  };
  if (!seuilsSloPath || !fs.existsSync(seuilsSloPath)) { add("bloquant", "R", "fichier de seuils SLO introuvable — seuils obligatoirement humains, aucun défaut implicite", String(seuilsSloPath)); finR("donnees_insuffisantes", 2); }
  if (!fs.existsSync(mesuresPath)) { add("bloquant", "R", "fichier de mesures introuvable", mesuresPath); finR("donnees_insuffisantes", 2); }
  let mesures = null, seuilsSlo = null;
  try { mesures = JSON.parse(fs.readFileSync(mesuresPath, "utf8")); } catch { add("bloquant", "R", "mesures illisibles (JSON invalide)", mesuresPath); finR("donnees_insuffisantes", 2); }
  try { seuilsSlo = JSON.parse(fs.readFileSync(seuilsSloPath, "utf8")); } catch { add("bloquant", "R", "seuils illisibles (JSON invalide)", seuilsSloPath); finR("donnees_insuffisantes", 2); }
  if (!Array.isArray(mesures) || !mesures.length) { add("bloquant", "R", "mesures vides", mesuresPath); finR("donnees_insuffisantes", 2); }
  const requis = typeof seuilsSlo.fenetre_min_echantillons === "number" ? seuilsSlo.fenetre_min_echantillons : 1;
  if (mesures.length < requis) { add("info", "R", `fenêtre insuffisante : ${mesures.length}/${requis} échantillon(s) — verdict non rendu`, mesuresPath); finR("donnees_insuffisantes", 2); }

  const latences = mesures.map(m => m.latence_ms).filter(v => typeof v === "number").sort((a, b) => a - b);
  const erreurs = mesures.map(m => m.erreur_pct).filter(v => typeof v === "number");
  if (latences.length !== mesures.length || erreurs.length !== mesures.length)
    { add("bloquant", "R", "mesure incomplète (latence_ms/erreur_pct numériques attendus sur chaque échantillon)", mesuresPath); finR("donnees_insuffisantes", 2); }
  const p95 = latences[Math.min(latences.length - 1, Math.ceil(0.95 * latences.length) - 1)];
  const erreurMax = Math.max(...erreurs);

  if (typeof seuilsSlo.latence_p95_max_ms === "number" && p95 > seuilsSlo.latence_p95_max_ms)
    add("bloquant", "R", `latence p95 ${p95}ms > seuil humain ${seuilsSlo.latence_p95_max_ms}ms`, mesuresPath);
  if (typeof seuilsSlo.erreur_max_pct === "number" && erreurMax > seuilsSlo.erreur_max_pct)
    add("bloquant", "R", `taux d'erreur ${erreurMax}% > seuil humain ${seuilsSlo.erreur_max_pct}%`, mesuresPath);

  const dursR = F.filter(f => f.sev === "bloquant" || f.sev === "majeur");
  const verdictR = dursR.length ? "rollback_recommande" : "stable";
  finR(verdictR, dursR.length ? 1 : 0, {
    mesures_observees: { p95_latence_ms: p95, erreur_max_pct: erreurMax, echantillons: mesures.length },
    seuils_appliques: seuilsSlo,
    recommandation: dursR.length ? "geste humain suggéré : `node scripts/ops.mjs restaurer <cible>` après revue" : "aucune action requise",
  });
}

// ── O9 · TF-0607 (lot Produit-02 20260824) : UNE SOURCE DE VERITE DIT COMMENT ON S'Y
// AUTHENTIFIE ──────────────────────────────────────────────────────────────────────────────────
//
// LE FAIT, verifie sur tout un depot. Un document d'exploitation donnait pour la production
// « deploiement via <commande> » — et rien d'autre : ni la variable d'environnement attendue, ni
// OU vit le justificatif, ni la voie de repli quand la session expire. Recherche exhaustive :
// AUCUN fichier du depot ne nommait le jeton d'API ni le point d'entree alternatif. La procedure
// documentee se reduisait donc a une commande qui echoue, avec rien derriere.
//
// PIRE, ET C'EST LE PIEGE : le meme document declarait en frontmatter ses `sources_de_verite`,
// dont une commande d'etat. Non authentifiee, cette commande rend « Unauthorized » — une sortie
// qu'un lecteur prend pour UN FAIT SUR L'INFRASTRUCTURE alors qu'elle est un fait sur SA PROPRE
// SESSION. Une source de verite dont le document ne dit pas comment l'authentifier n'est pas
// opposable, et sa sortie d'erreur se lit comme un constat.
//
// CE QUI EST JUGE : la PRESENCE du champ, jamais sa justesse — « un oracle peut dire que le champ
// manque, jamais qu'il est juste », comme les six champs du cadrage design. Declarer
// `authentification: aucune` est GRATUIT et suffit : meme patron que R-45 et R-49, l'omission ne
// vaut pas decision mais l'aveu, lui, est honnete et se date.
function jugerSourcesDeVerite(chemin) {
  let texte;
  try { texte = fs.readFileSync(chemin, "utf8"); } catch { return null; }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(texte);
  if (!fm) return null;
  if (!/^sources_de_verite\s*:/m.test(fm[1])) return null;
  const declare = /^authentification\s*:\s*\S/m.test(fm[1]);
  return { declare, fm: fm[1] };
}

// ── O12 · TF-1115 (mesure Produit-11 du 14/09/2026) : UNE REMEDIATION DE SECURITE DIT SUR
// QUELS ENVIRONNEMENTS ELLE A ETE REJOUEE ───────────────────────────────────────────────────
//
// LE FAIT. La règle de pare-feu `AllowAllAzureServicesAndResources` (0.0.0.0) a été retirée
// d'un environnement le 25/08 ; `MATRICE-DE-FLUX.md` déclare depuis « ce document est appliqué »
// — SANS dire DE QUEL environnement il parle. Vingt jours plus tard, la même règle était
// toujours présente sur l'environnement suivant, devenue la SEULE voie d'accès de son API à sa
// base — la supprimer sans remplacement aurait coupé le service. Rien ne confrontait la matrice
// à un périmètre déclaré, parce que la matrice ne DÉCLARAIT aucun périmètre.
//
// CE QUI EST JUGÉ, même doctrine qu'O-9 (la PRÉSENCE du champ, jamais sa justesse) : un document
// dont le frontmatter déclare `remediation_securite: <intitulé>` porte aussi une liste
// `environnements:` — un environnement par ligne, le statut (rejouée/à rejouer) restant à la
// plume humaine. Une remédiation sans cette liste ne dit rien de son périmètre : « appliquée »
// devient une affirmation qu'aucun environnement ne peut réclamer ni exclure.
function jugerRemediationParEnvironnement(chemin) {
  let texte;
  try { texte = fs.readFileSync(chemin, "utf8"); } catch { return null; }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(texte);
  if (!fm) return null;
  if (!/^remediation_securite\s*:/m.test(fm[1])) return null;
  const declare = /^environnements\s*:/m.test(fm[1]);
  return { declare, fm: fm[1] };
}

// ── O13 · TF-1116 + TF-1118 (mesure Produit-11 du 14/09/2026) : UN GESTE DESTRUCTIF PORTE SA
// MATURITE ET SA MESURE DE NON-REGRESSION ───────────────────────────────────────────────────
//
// LE FAIT (TF-1116). Le correctif « retirer la règle AllowAllAzureServicesAndResources »
// avait réussi sur un environnement le 25/08 ; transposé tel quel à un second, il était
// INFAISABLE — le pool de sortie de l'environnement cible portait 161 adresses contre UNE
// seule sur le premier, deux environnements pourtant de même type et de même région. RIEN ne
// distinguait ce geste DÉDUIT (transposé sans mesure) d'un geste ÉPROUVÉ (rejoué et vérifié).
//
// LE FAIT (TF-1118). Sur dix lignes d'un inventaire de suppression, AUCUNE ne portait la
// vérification prouvant que le geste n'avait rien rompu — posée par prudence, elle a servi
// trois fois (dont un retour arrière réel évité). Le risque propre aux suppressions
// d'infrastructure est le DÉCALAGE : un pare-feu refermé ne casse rien tant qu'aucune
// connexion neuve ne s'ouvre — l'incident arrive à la révision suivante, sans lien visible.
//
// CE QUI EST JUGÉ, contrôle STATIQUE (coïncidence de motif, aucune exécution) : dans un
// document d'exploitation ou un carnet d'écarts, tout item de liste portant un verbe
// destructif à l'infinitif (supprimer/retirer/fermer/purger/détruire) porte, dans la fenêtre
// qui suit, DEUX marques distinctes — (a) sa MATURITÉ : « éprouvé sur cette cible le
// AAAA-MM-JJ » ou « déduit d'une autre cible, à mesurer avant exécution » ; (b) sa MESURE DE
// NON-RÉGRESSION : une ligne « Mesure de non-régression : <commande ou vérification> ». Les
// deux marques sont jugées indépendamment — un geste peut porter l'une sans l'autre.
const _GESTE_DESTRUCTIF = /^[ \t]*(?:[-*]|\d+[.)])\s.*\b(?:supprimer|retirer|fermer|purger|détruire|detruire)\b/gim;
const _MARQUE_MATURITE = /éprouvé sur cette cible le \d{4}-\d{2}-\d{2}|eprouve sur cette cible le \d{4}-\d{2}-\d{2}|déduit d'une autre cible[^.\n]{0,60}mesurer avant exécution|deduit d'une autre cible[^.\n]{0,60}mesurer avant execution/i;
const _MARQUE_NON_REGRESSION = /mesure de non[- ]r[ée]gression\s*:\s*\S/i;
const _GESTE_WINDOW = 500;

function jugerGestesDestructifs(texte) {
  const constats = [];
  let m;
  _GESTE_DESTRUCTIF.lastIndex = 0;
  while ((m = _GESTE_DESTRUCTIF.exec(texte))) {
    const ligne = m[0].trim();
    const fenetre = texte.slice(m.index, m.index + _GESTE_WINDOW);
    constats.push({
      ligne,
      sansMaturite: !_MARQUE_MATURITE.test(fenetre),
      sansMesure: !_MARQUE_NON_REGRESSION.test(fenetre),
    });
  }
  return constats;
}

// ── TF-0579 (lot Produit-02 20260824) : LE VERDICT S'ARCHIVE ET DIT SON REGIME ──────
//
// LE FAIT, verifie a l'historique git. Un smoke de MEP controlait la presence d'un chemin de
// feuille de style par egalite stricte. Un correctif de cache a versionne les feuilles par
// empreinte : le chemin nu n'existe plus. `git log -S` sur cette ligne ne rend AUCUN COMMIT —
// personne ne l'a ajustee, et personne n'a ete arrete. Le gate est donc reste ROUGE SIX JOURS
// pendant que le deploiement avait lieu : soit il n'a pas ete rejoue, soit son echec a ete
// ignore. Dans les deux cas, un gate dont l'echec n'empeche rien n'est pas un gate, c'est un avis.
//
// DEUX MANQUES, et le second explique le premier :
//  (a) AUCUNE TRACE. Sans verdict horodate et archive, « les gates sont passes » est une
//      affirmation invérifiable — exactement ce qu'un audit reproche a un fournisseur.
//  (b) LE REGIME N'ETAIT PAS DIT. Les severites existaient dans le code (bloquant / majeur /
//      info) mais le verdict ne disait pas QUELLES regles bloquent. C'est le melange des deux
//      regimes sans le dire qui a permis de passer outre sans qu'aucune decision soit prise.
//
// Ce qui suit archive chaque verdict avec son horodatage, l'empreinte de ce qu'il a juge, et le
// regime de chaque regle. L'archivage ne bloque JAMAIS : un journal qu'on ne peut pas ecrire
// (disque plein, droits) ne doit pas empecher un deploiement — il se declare et on continue.
const REGIME = { bloquant: "bloque", majeur: "bloque", info: "consultatif" };

function empreinteCible(chemin) {
  try {
    const st = fs.statSync(chemin);
    if (st.isFile()) {
      return { [path.basename(chemin)]: hacherFichier(chemin) };   // TF-0615 : fonction partagee
    }
    const out = {};
    for (const f of fs.readdirSync(chemin)) {
      const p = path.join(chemin, f);
      try {
        if (fs.statSync(p).isFile()) out[f] = hacherFichier(p);   // TF-0615 : fonction partagee
      } catch { /* illisible : absent de l'empreinte plutot que faux */ }
    }
    return out;
  } catch { return null; }
}

function archiver(verdict, code) {
  if (!cible) return { archive: false, motif: "aucune cible — rien a sceller" };
  let dossier;
  try { dossier = fs.statSync(cible).isDirectory() ? cible : path.dirname(cible); }
  catch { return { archive: false, motif: "cible illisible" }; }
  const journal = path.join(dossier, ".ops-journal.jsonl");
  const empreinte = empreinteCible(cible);
  const ligne = {
    format: "forge-ops/verdict@1",
    ts: new Date().toISOString(),
    cible: String(cible),
    verdict,
    exit: code,
    // (b) : le regime de CHAQUE regle qui a parle. « bloque » ou « consultatif », jamais implicite.
    regles: F.map(f => ({ regle: f.regle, sev: f.sev, regime: REGIME[f.sev] || "consultatif" })),
    bloquants: F.filter(f => REGIME[f.sev] === "bloque").length,
    consultatifs: F.filter(f => REGIME[f.sev] !== "bloque").length,
    // (a) : sur QUOI le verdict a ete rendu — sans quoi il vieillit en silence (meme motif que TF-0478).
    empreinte: empreinte ? { format: "forge-ops/empreinte@1", release: String(cible), fichiers: empreinte } : null,
  };
  try {
    fs.appendFileSync(journal, JSON.stringify(ligne) + "\n", "utf8");
    return { archive: true, journal, bloquants: ligne.bloquants, consultatifs: ligne.consultatifs };
  } catch (e) {
    // Un journal qu'on ne peut pas ecrire ne doit pas empecher un deploiement — il se DIT.
    return { archive: false, motif: `journal non ecrit : ${String(e.message).slice(0, 80)}` };
  }
}

function sortir(verdict, code) {
  process.stdout.write(JSON.stringify({
    oracle: "oracle-ops", domaine: DOM, artefact: cible || null,
    verdict, findings: F.length ? F : [{ sev: "info", regle: "—", msg: "O1–O4 sans écart", where: cible }],
    // TF-0579 : le verdict DIT desormais son regime et OU il est archive. Un gate dont on ne
    // sait pas s'il bloque est un avis ; un verdict sans trace est invérifiable.
    scellement: archiver(verdict, code),
    non_juge: NON_JUGE,
  }, null, jsonOnly ? 0 : 2));
  process.exit(code);
}

// O9 — si la cible est un document portant des `sources_de_verite`, elles disent comment on s'y
// authentifie. Un document sans ce frontmatter n'est pas concerne : la regle ne s'invente pas
// une cible.
if (cible && fs.existsSync(cible)) {
  try {
    if (fs.statSync(cible).isFile() && /\.md$/i.test(cible)) {
      const sv = jugerSourcesDeVerite(cible);
      if (sv && !sv.declare) {
        add("majeur", "O9", "des `sources_de_verite` sont declarees sans dire COMMENT on s'y authentifie — "
          + "une commande non authentifiee rend une erreur qu'un lecteur prend pour un fait sur l'infrastructure, "
          + "alors qu'elle est un fait sur sa propre session. Ajouter `authentification:` au frontmatter — "
          + "`authentification: aucune` suffit et est gratuit (TF-0607)", cible);
      }
      // O12 (TF-1115) — meme posture : une remediation de securite declaree sans lister les
      // environnements ou elle a ete rejouee ne dit rien de son perimetre.
      const rem = jugerRemediationParEnvironnement(cible);
      if (rem && !rem.declare) {
        add("majeur", "O12", "une `remediation_securite` est declaree sans lister les ENVIRONNEMENTS "
          + "ou elle a ete rejouee — « appliquee » sans perimetre laisse un environnement suivant "
          + "hors de portee du controle, potentiellement encore expose (TF-1115)", cible);
      }
      // O13 (TF-1116 + TF-1118) — tout geste destructif porte sa maturite ET sa mesure de
      // non-regression ; les deux marques sont jugees independamment.
      const texteCible = fs.readFileSync(cible, "utf8");
      for (const geste of jugerGestesDestructifs(texteCible)) {
        if (geste.sansMaturite)
          add("bloquant", "O13", `geste destructif sans marque de MATURITE (« ${geste.ligne} ») — `
            + "« eprouve sur cette cible le AAAA-MM-JJ » ou « deduit d'une autre cible, a mesurer "
            + "avant execution » : un geste jamais joue sur sa cible n'est pas une procedure, "
            + "c'est une hypothese redigee a l'imperatif (TF-1116)", cible);
        if (geste.sansMesure)
          add("bloquant", "O13", `geste destructif sans MESURE DE NON-REGRESSION (« ${geste.ligne} ») — `
            + "sans elle, un decalage (pare-feu referme, image supprimee) ne se revele qu'a la "
            + "revision suivante, sans lien visible avec le geste (TF-1118)", cible);
      }
    }
  } catch { /* cible illisible : O9/O12/O13 se taisent plutot que d'accuser */ }
}

if (!cible || !fs.existsSync(cible)) { add("info", "—", "cible introuvable", String(cible)); sortir("SKIP", 2); }

// ── O1/O3 · cible dont pointeur ET historique sont tenus par une PLATEFORME (TF-0844,
// lot Produit-61 20260905a + seq 74) ─────────────────────────────────────────────────
// FAIT CONSTATÉ : sur une cible déployée via un plan cloud (railway, gcp, azure, aws...),
// c'est la PLATEFORME qui tient le pointeur de déploiement actif et son historique — jamais
// `ops.mjs deployer/canary`, qui n'écrit COURANT et journal.jsonl que pour les cibles servies
// EN LOCAL par cette forge. O1 (« COURANT absent ») et O3 (« journal.jsonl absent ») FAILaient
// donc à tort sur un déploiement RÉEL, SAIN et RESTAURÉ (oracle M-4 du pilot PASS) : l'oracle
// jugeait un contrat de fichiers que la cible ne porte pas PAR CONSTRUCTION, pas un défaut.
// Piste retenue : SANS_OBJET déclaré, jamais un adaptateur qui appellerait l'API de la
// plateforme (hors périmètre forge-ops — zéro credential, zéro appel réseau, TF-0844).
// EXPLICITE, jamais déduit du nom du dossier (loi n° 3 : l'oubli n'existe pas, une cible
// nommée « railway » par coïncidence resterait jugée normalement) : le SKIP n'existe que si
// la cible porte elle-même un fichier PLATEFORME, écrit par le run qui l'exploite (même geste
// que `plan` désigne déjà sa cible par ce même nom : railway | gcp | azure | aws | ...).
const platPath = path.join(cible, "PLATEFORME");
const plateforme = fs.existsSync(platPath) ? fs.readFileSync(platPath, "utf8").trim() : null;
if (plateforme) {
  add("info", "O1", `pointeur de déploiement tenu par la plateforme « ${plateforme} », hors du contrat de fichiers forge-ops (COURANT) — SANS_OBJET, pas un défaut (TF-0844)`, "PLATEFORME");
  add("info", "O3", `historique de déploiement tenu par la plateforme « ${plateforme} » — journal.jsonl n'est pas la source de vérité de cette cible, SANS_OBJET (TF-0844)`, "PLATEFORME");
  sortir("SKIP", 2);
}

// ── O1 · pointeur ──────────────────────────────────────────────────────────
const cp = path.join(cible, "COURANT");
const courant = fs.existsSync(cp) ? fs.readFileSync(cp, "utf8").trim() : null;
if (!courant) add("bloquant", "O1", "COURANT absent — la cible n'a pas de release active désignée", "COURANT");
const releaseDir = courant ? path.join(cible, "releases", courant) : null;
if (courant && !fs.existsSync(releaseDir))
  add("bloquant", "O1", `COURANT pointe une release inexistante : ${courant}`, "COURANT");

// ── O2 · healthcheck réel de la release courante ──────────────────────────
if (courant && fs.existsSync(releaseDir)) {
  const sante = path.join(releaseDir, "sante.mjs");
  if (!fs.existsSync(sante)) add("bloquant", "O2", "sante.mjs absent de la release courante — santé invérifiable", courant);
  else {
    const r = spawnSync(process.execPath, [sante], { cwd: releaseDir, encoding: "utf8", timeout: 30000 });
    if (r.status !== 0) add("bloquant", "O2", `healthcheck en échec (exit ${r.status}) sur la release courante`, courant);
  }
}

// ── O3 · intégrité du journal (contrat ledger : seq croissant depuis 1) ───
const jp = path.join(cible, "journal.jsonl");
let entrees = [];
if (!fs.existsSync(jp)) add("bloquant", "O3", "journal.jsonl absent — exploitation non tracée", "journal.jsonl");
else {
  const lignes = fs.readFileSync(jp, "utf8").split("\n").filter(Boolean);
  let attendu = 1;
  for (let i = 0; i < lignes.length; i++) {
    let e = null;
    try { e = JSON.parse(lignes[i]); } catch { add("bloquant", "O3", `ligne ${i + 1} : JSON invalide`, "journal.jsonl:" + (i + 1)); continue; }
    if (e.seq !== attendu) add("bloquant", "O3", `ligne ${i + 1} : seq ${e.seq}, attendu ${attendu} (append-only rompu)`, "journal.jsonl:" + (i + 1));
    if (!TYPES.includes(e.type)) add("bloquant", "O3", `ligne ${i + 1} : type inconnu « ${e.type} »`, "journal.jsonl:" + (i + 1));
    attendu = (e.seq ?? attendu) + 1;
    entrees.push(e);
  }
  if (!entrees.length) add("bloquant", "O3", "journal vide — aucune exploitation tracée", "journal.jsonl");
}

// ── O4 · rollback prouvable + cohérence pointeur ↔ histoire ───────────────
// Rollback prouvable = l'histoire n'est pas purgée : toute release citée par un
// événement actif du journal existe encore sur disque (on peut toujours y revenir).
// Être positionné sur la plus ancienne release après une restauration est un état sain.
if (courant && fs.existsSync(releaseDir)) {
  const actifs = entrees.filter(e => e.type === "deploiement" || e.type === "restauration" || e.type === "canary_promotion");
  for (const e of actifs) {
    if (e.release && !fs.existsSync(path.join(cible, "releases", e.release)))
      add("majeur", "O4", `release ${e.release} citée au journal (seq ${e.seq}) mais purgée du disque — rollback impossible vers cet état`, "releases/");
  }
  const dernier = actifs[actifs.length - 1];
  if (dernier && dernier.release !== courant)
    add("bloquant", "O4", `incohérence : COURANT=${courant} mais le dernier événement actif du journal désigne ${dernier.release}`, "journal.jsonl");
}

const durs = F.filter(f => f.sev === "bloquant" || f.sev === "majeur");
sortir(durs.length ? "FAIL" : "PASS", durs.length ? 1 : 0);

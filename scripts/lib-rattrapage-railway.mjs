// lib-rattrapage-railway.mjs — juge le relevé d'un déploiement Railway qu'un contrôle en échec a fait SAUTER (TF-2519).
//
// LE FAIT (Produit-02, lot 20261105a RT-148, ledger seq 693 du 05/11/2026). La poussée d8d46d3..237dc8d fait échouer le workflow
// Contrôles pour une cause sans lien avec le commit (Chrome n'a pas démarré sur le runner en 30 s). Le réglage « Wait for CI » de
// Railway marque alors le déploiement du commit SKIPPED. Le job relancé passe au vert à 21:46:06 ; l'API Railway liste toujours le
// déploiement en SKIPPED et la production sert l'ancien manifeste à 21:48:57. Seul un déploiement NEUF du même commit (GraphQL
// `serviceInstanceDeployV2`, 21:49:45) a servi le nouveau : production restée 16 minutes sur l'ancienne version.
//
// CE QUE FAIT LA BIBLIOTHÈQUE. Elle lit un relevé `forge-ops/rattrapage-railway@1` que le run écrit depuis ses propres lectures
// (conclusion des contrôles du commit, déploiements du service avec statut, commit et date de création) et rend un verdict.
// Elle n'appelle rien : le geste de rattrapage est ÉCRIT, jamais joué ; il change la production, donc il se joue sous le GO du run.
//
// Relevé :
//   { "format": "forge-ops/rattrapage-railway@1",
//     "commit": "<sha entier du commit poussé>",
//     "controles": { "conclusion": "success", "lu_le": "<horodatage ISO 8601>" },
//     "deploiements": [ { "id": "…", "statut": "SKIPPED", "commit": "<sha>", "cree_le": "<horodatage ISO 8601>" } ],
//     "service_id": "…", "environnement_id": "…" }          (les deux derniers champs sont facultatifs)
//
// Verdicts (code de sortie de l'outil) :
//   rattrapage-requis (1) : le dernier déploiement du commit est SKIPPED et les contrôles sont au vert ;
//   rien à rattraper (0)  : `garde-tenue` (contrôles non verts : le SKIPPED est la garde qui tient), `servi` (SUCCESS),
//                           `en-cours` (construction ou déploiement en route : relire) ;
//   autre-echec (3)       : dernier déploiement FAILED ou CRASHED — ce geste n'est pas le remède, le diagnostic passe par
//                           les journaux de déploiement (plan railway) ;
//   illisible (2)         : relevé qu'on ne sait pas juger (format, commit, identifiant, statut inconnu, aucun déploiement de ce
//                           commit) — jamais un verdict inventé.

export const FORMAT = "forge-ops/rattrapage-railway@1";
export const API = "https://backboard.railway.com/graphql/v2";
const EN_COURS = ["BUILDING", "DEPLOYING", "INITIALIZING", "QUEUED", "WAITING"];
const ECHEC = ["FAILED", "CRASHED"];
const SHA = /^[0-9a-f]{40}$/i;
const SHA_COURT = /^[0-9a-f]{7,40}$/i;
const IDENTIFIANT = /^[A-Za-z0-9._-]+$/;

const illisible = raison => ({ verdict: "illisible", code: 2, raison });

export function geste({ commit, service_id, environnement_id }) {
  const svc = service_id || "<ID_SERVICE>", env = environnement_id || "<ID_ENVIRONNEMENT>";
  return {
    api: API,
    mutation: `mutation { serviceInstanceDeployV2(commitSha: "${commit}", environmentId: "${env}", serviceId: "${svc}") }`,
    jeton: "jeton de projet Railway, variable RAILWAY_TOKEN de l'environnement du run, jamais en argument ni dans un fichier",
    avant: "rejouer `juger` sur un relevé neuf : un déploiement plus récent du commit rend le geste inutile (`servi` ou `en-cours`)",
    apres: "lire la version servie (`node scripts/version-servie.mjs lire <URL_SERVICE> --attendu <commit>`) : le commit rattrapé est celui que /healthz rend",
    limite: "le nom `serviceInstanceDeployV2` est celui que rapporte le lot ; ses arguments et l'en-tête du jeton se relisent à la référence de l'API publique de Railway avant le premier envoi, la forge ne les a pas rejoués",
  };
}

export function jugerRattrapage(releve) {
  if (!releve || typeof releve !== "object" || Array.isArray(releve)) return illisible("le relevé n'est pas un objet JSON");
  if (releve.format !== FORMAT) return illisible(`format « ${releve.format ?? "absent"} » : ${FORMAT} attendu`);
  if (typeof releve.commit !== "string" || !SHA.test(releve.commit)) return illisible("commit absent ou pas un sha entier de 40 caractères hexadécimaux : le geste désigne un commit sans ambiguïté");
  const conclusion = releve.controles?.conclusion;
  if (typeof conclusion !== "string" || !conclusion.trim()) return illisible("conclusion des contrôles absente (controles.conclusion) : sans elle, on ne sait pas si le saut est la garde qui tient ou un oubli");
  for (const champ of ["service_id", "environnement_id"])
    if (releve[champ] !== undefined && (typeof releve[champ] !== "string" || !IDENTIFIANT.test(releve[champ])))
      return illisible(`${champ} « ${String(releve[champ]).slice(0, 40)} » : un identifiant n'a ni espace, ni guillemet, ni caractère de commande`);
  if (!Array.isArray(releve.deploiements) || releve.deploiements.length === 0) return illisible("aucun déploiement au relevé (deploiements)");
  for (const [i, d] of releve.deploiements.entries()) {
    if (!d || typeof d.statut !== "string" || typeof d.commit !== "string" || !SHA_COURT.test(d.commit) || typeof d.id !== "string" || !d.id || Number.isNaN(Date.parse(d.cree_le)))
      return illisible(`déploiement n°${i + 1} incomplet : id, statut, commit (7 à 40 hexadécimaux) et cree_le (ISO 8601) sont requis`);
  }
  const memeCommit = d => { const a = d.commit.toLowerCase(), b = releve.commit.toLowerCase(); return b.startsWith(a) || a.startsWith(b); };
  const du_commit = releve.deploiements.filter(memeCommit);
  if (du_commit.length === 0) return illisible(`aucun déploiement du commit ${releve.commit.slice(0, 7)} au relevé : une liste qui ne le contient pas ne dit rien de son état`);
  const dernier = du_commit.reduce((a, b) => (Date.parse(b.cree_le) >= Date.parse(a.cree_le) ? b : a));
  const statut = dernier.statut.trim().toUpperCase();
  const base = { commit: releve.commit, deploiement: { id: dernier.id, statut, cree_le: dernier.cree_le }, controles: { conclusion: conclusion.trim().toLowerCase() } };
  if (statut === "SKIPPED") {
    if (base.controles.conclusion !== "success")
      return { ...base, verdict: "garde-tenue", code: 0, raison: `déploiement SKIPPED et contrôles « ${base.controles.conclusion} » : le saut est la garde « Wait for CI » qui tient ; relancer les contrôles, pas déployer` };
    return { ...base, verdict: "rattrapage-requis", code: 1, raison: `le déploiement ${dernier.id} du commit ${releve.commit.slice(0, 7)} est SKIPPED alors que les contrôles sont au vert : Railway ne le rattrape pas, la production sert l'ancienne version ; un déploiement NEUF du même commit est le remède`, geste: geste(releve) };
  }
  if (statut === "SUCCESS") return { ...base, verdict: "servi", code: 0, raison: `le dernier déploiement du commit est SUCCESS : rien à rattraper (la version servie se relit par version-servie.mjs)` };
  if (EN_COURS.includes(statut)) return { ...base, verdict: "en-cours", code: 0, raison: `le dernier déploiement du commit est ${statut} : relire le relevé quand il aboutit` };
  if (ECHEC.includes(statut)) return { ...base, verdict: "autre-echec", code: 3, raison: `le dernier déploiement du commit est ${statut}, pas SKIPPED : ce geste n'est pas le remède ; le diagnostic passe par les journaux de déploiement (plan railway, phase rollback)` };
  return illisible(`statut « ${dernier.statut} » du dernier déploiement : ni SKIPPED, ni SUCCESS, ni en cours, ni en échec — non jugé`);
}

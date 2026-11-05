---
role: identifiants de test remis à l'humain — alphabet des secrets qu'il recopie, stabilité d'un déploiement à l'autre, règles d'O-25
nature: faits mesurés au lot Produit-86 du 04/11/2026 (RP-10, RP-11) et au banc de ce dépôt le 05/11/2026 ; aucune page externe n'est citée, « déduit » marque ce qui découle des faits
verifie_le: 2026-11-05
---

# Les identifiants de test que l'humain recopie

**Pour qui.** Le pilot et le produit dont la chaîne de déploiement remet à l'humain un fichier de comptes de
test. Le lot Produit-86 `20261104b` a mesuré deux défauts le 04/11/2026 : des mots de passe que l'humain ne
pouvait pas recopier (RP-11, TF-2167), et des mots de passe renouvelés à chaque déploiement (RP-10, TF-2166).

## 1. Un secret recopié par un humain : alphabet sans sosie ni signe (TF-2167)

**Le fait du 04/11/2026.** Le porteur n'a pas pu se connecter avec les mots de passe du fichier des comptes de
test : 2 refus 401, Chrome à 14:59 et Firefox à 15:01. Les mêmes valeurs passaient par httpx et par
Playwright. `secrets.token_urlsafe` produisait « _ » et des sosies (« 1 » et « l »). Un correctif et un
redéploiement ont suivi. Déduit : une machine recopie sans erreur, un humain lit « l » pour « 1 », et un
signe se perd à la lecture ou à la dictée.

**La règle du lot.** Tout secret qu'un humain recopie se tire dans un alphabet sans sosie (`0`, `O`, `1`, `l`,
`I`) ni signe, de 20 caractères au moins.

**Le générateur commun.** `scripts/lib-secret-humain.mjs` (importé par le script de TF-2166 et par O-25) et sa
commande `node scripts/tirer-secret-humain.mjs [--longueur 20] [--nombre 1]`.

| Propriété | Valeur |
|---|---|
| Alphabet | 25 minuscules (sans `l`), 24 majuscules (sans `I` ni `O`), 8 chiffres (de `2` à `9`) : 57 symboles |
| Longueur | 20 au moins ; une longueur plus courte est refusée (exit 2), jamais complétée |
| Tirage | `crypto.randomInt`, sans biais de modulo ; environ 117 bits à 20 caractères |
| Composition | au moins une minuscule, une majuscule et un chiffre (voir l'écart ci-dessous) |

**Écart à la lettre, déclaré.** Le lot ne demande ni minuscule, ni majuscule, ni chiffre. Le générateur les
exige tous les trois, parce que la plupart des politiques de mot de passe les demandent et que retirer les
signes ôte l'autre moyen d'y satisfaire. Le tirage est rejeté puis refait jusqu'à les réunir.

**Ce que juge O-25** (`node oracles/oracle-ops.mjs --identifiants-test <fichier.json>`) : sur un fichier au
format `forge-ops/identifiants-test@1`, le mot de passe de chaque compte de `comptes` tient en 20 caractères
au moins, sans sosie ni signe. Le constat nomme le compte et la position du défaut, jamais la valeur : un
secret ne transite pas par un rapport. Le remède est `node scripts/tirer-secret-humain.mjs`.

```json
{
  "format": "forge-ops/identifiants-test@1",
  "comptes": {
    "admin": { "mot_de_passe": "…20 caractères tirés par tirer-secret-humain.mjs…" }
  }
}
```

Fixtures à double sens : `fixtures/o25-identifiants-test/` (`verte.json`, deux rouges, un cas sans objet
rendu en SKIP).

**Ce qui n'est pas jugé.** La force du secret au-delà de sa longueur et de son alphabet. Les autres sosies
(`5` et `S`, `8` et `B`, `2` et `Z`) restent dans l'alphabet, la liste du lot ne les cite pas. Un jeton d'API
qu'une machine seule emploie n'est pas un secret recopié par un humain.

## 2. Les mêmes identifiants d'un déploiement à l'autre (TF-2166)

**La règle du porteur, le 04/11/2026**, mot pour mot : « arrête de changer les mdp à chaque fois que tu
déploies une nouvelle version. Et remonte cette règle à la Factory. » (lot Produit-86 `20261104b`, RP-10,
ledger seq 422 et 425).

**Le fait.** La chaîne de déploiement d'un produit renouvelait les mots de passe de ses comptes de test à
chaque déploiement, par une exigence du produit (E-091) posée sur le modèle des runs précédents. Quatorze
déploiements le 04/11, autant de mots de passe à recopier, 2 connexions refusées du porteur.

**La règle.** Les identifiants de test remis à l'humain restent stables d'un déploiement à l'autre. Ils ne se
renouvellent que sur demande explicite de l'humain, ou quand leur fichier manque. La chaîne vérifie qu'ils se
connectent avant de rendre PASS.

**L'outil.** `scripts/identifiants-test.mjs`, sur un fichier `forge-ops/identifiants-test@1` :

| Verbe | Effet |
|---|---|
| `assurer <fichier> --comptes a,b` | garde le mot de passe de chaque compte qui en a un ; crée un mot de passe (générateur de la section 1) pour un compte absent ou un fichier absent ; un fichier illisible n'est jamais réécrit (exit 2) |
| `renouveler <fichier> (--compte a \| --tous) --demande "<mots de l'humain>"` | le seul geste qui change un mot de passe existant ; sans `--demande`, exit 2 ; la demande entre au journal |
| `verifier <fichier> --commande "<connexion du produit>"` | joue la commande une fois par compte avec `FORGE_OPS_COMPTE` et `FORGE_OPS_MOT_DE_PASSE` dans l'environnement du fils, jamais en argument ; exit 0 si tous se connectent, 1 sinon, 2 sans commande |

Aucune valeur de mot de passe n'apparaît sur la sortie, sur l'erreur ni au journal : le fichier est la remise
à l'humain. L'outil avertit, sans bloquer, quand le fichier se trouve dans un dépôt git qui ne l'ignore pas.

**Le journal** `identifiants-test.journal.jsonl`, à côté du fichier, est à ajout seul : `identifiants_conserves`,
`identifiants_crees` (motif `fichier_absent` ou `compte_absent`), `identifiants_renouveles` (motif `demande`
et la demande), `identifiants_verifies` (`ok` et les comptes refusés).

**Ce que juge O-25 avec `--journal <journal.jsonl>`** (en plus de la section 1) :

- un `identifiants_renouveles` sans motif `demande` ou sans demande écrite est un constat bloquant : c'est le
  défaut du 04/11 ;
- un `identifiants_crees` pour un autre motif que `fichier_absent` ou `compte_absent` est un constat bloquant ;
- des comptes créés ou renouvelés qu'aucune vérification de connexion réussie ne suit sont un constat majeur ;
  une dernière vérification en échec est un constat bloquant ;
- un journal introuvable, vide, à `seq` rompu ou à type inconnu est un constat bloquant.

**Ce que la chaîne du produit fait de cette règle.** Elle remplace son étape « renouveler les mots de passe »
par `assurer` suivi de `verifier`, joue O-25 avec le journal avant de rendre PASS, et ne renouvelle que
sur une demande de l'humain (`renouveler --demande`).

**Ce qui n'est pas jugé.** Un renouvellement fait hors de l'outil, sans ligne au journal : l'oracle n'a pas
l'historique du fichier pour comparer ses valeurs d'un déploiement à l'autre. Ce que prouve la commande de
connexion du produit : l'oracle lit son code de sortie.

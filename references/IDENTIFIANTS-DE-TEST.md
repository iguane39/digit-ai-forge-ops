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

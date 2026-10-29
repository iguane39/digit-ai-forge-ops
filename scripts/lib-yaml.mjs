// lib-yaml.mjs — lecteur YAML natif de forge-ops (zéro dépendance), pour les modes d'oracle-ops qui
// lisent un fichier compose (O-20, TF-1986) ou un workflow GitHub Actions (O-21, TF-2003).
// COPIE CONFORME du lecteur de forge-websec (`oracles/oracle-workflows.mjs`, fonction `lireYaml`,
// lignes 103 à 488 au commit 3e235fa du 28/10/2026), recopiée le 29/10/2026 : les forges ne
// dépendent pas les unes des autres à l'exécution. Un correctif de ce lecteur se reporte dans les
// copies (forge-websec, forge-ops, forge-agents-security).
// Sous-ensemble : mappages et séquences en bloc, scalaires simples, entre guillemets simples ou
// doubles (y compris sur plusieurs lignes), blocs littéraux « | » et pliés « > » avec indicateurs,
// collections en flux [ ] et { }, commentaires, marqueur de document. Tout scalaire est rendu en
// chaîne (aucune conversion de type), une valeur vide en null. Le reste (ancres, alias, étiquettes,
// clés complexes, plusieurs documents) lève ErreurYaml : le fichier est alors dit non jugé, jamais
// lu à moitié.

export class ErreurYaml extends Error {
  constructor(message, ligne) { super(message); this.ligne = ligne; }
}

export function lireYaml(texte) {
  const L = String(texte).replace(/^\uFEFF/, "").split(/\r?\n/);
  const N = L.length;
  const lignes = new WeakMap();
  let i = 0;

  const indent = (s) => { let k = 0; while (k < s.length && s[k] === " ") k++; return k; };
  const vide = (s) => /^\s*(#.*)?$/.test(s);
  const erreur = (message, idx = i) => { throw new ErreurYaml(message, Math.min(idx, N - 1) + 1); };
  const estTiret = (c) => c === "-" || c.startsWith("- ");
  const sauter = () => { while (i < N && vide(L[i])) i++; };
  const marquer = (objet, ligne) => { const m = { __ligne: ligne }; lignes.set(objet, m); return m; };
  const refuserSyntaxe = (c, idx) => {
    if (c[0] === "&") erreur("ancre YAML (&) non prise en charge par le lecteur de l'oracle", idx);
    if (c[0] === "*") erreur("alias YAML (*) non pris en charge par le lecteur de l'oracle", idx);
    if (c[0] === "!") erreur("étiquette YAML (!) non prise en charge par le lecteur de l'oracle", idx);
    if (c[0] === "?" && (c.length === 1 || c[1] === " ")) erreur("clé complexe YAML (?) non prise en charge par le lecteur de l'oracle", idx);
    if (c[0] === "%" || c[0] === "@" || c[0] === "`") erreur(`caractère réservé « ${c[0]} » en tête de valeur`, idx);
  };

  // Sépare « clé: reste » ; null si la ligne n'est pas une entrée de mappage.
  function separerCle(c) {
    if (c === "" || c[0] === "#" || estTiret(c)) return null;
    if (c[0] === '"' || c[0] === "'") {
      const q = c[0];
      let p = 1, cle = "";
      while (p < c.length) {
        const ch = c[p];
        if (q === "'" && ch === "'") { if (c[p + 1] === "'") { cle += "'"; p += 2; continue; } break; }
        if (q === '"' && ch === "\\") { cle += c[p + 1] ?? ""; p += 2; continue; }
        if (q === '"' && ch === '"') break;
        cle += ch; p++;
      }
      if (p >= c.length) return null;
      const apres = c.slice(p + 1);
      const m = /^[ \t]*:(?=[ \t]|$)/.exec(apres);
      return m ? { cle, reste: apres.slice(m[0].length) } : null;
    }
    if (/^[\[{&*!|>%@`]/.test(c)) return null;
    for (let p = 0; p < c.length; p++) {
      const ch = c[p];
      if (ch === "#" && p > 0 && /\s/.test(c[p - 1])) return null;
      if (ch === ":" && (p + 1 === c.length || c[p + 1] === " " || c[p + 1] === "\t")) {
        const cle = c.slice(0, p).trim();
        return cle === "" ? null : { cle, reste: c.slice(p + 1) };
      }
    }
    return null;
  }

  function noeud(ind) {
    const c = L[i].slice(ind);
    if (c[0] === "\t") erreur("tabulation dans l'indentation (interdite en YAML)");
    if (estTiret(c)) return sequence(ind);
    if (c[0] === "?" && (c.length === 1 || c[1] === " ")) refuserSyntaxe(c, i);
    if (separerCle(c)) return mappage(ind);
    const idx = i;
    i++;
    return valeur(c, ind - 1, idx, false);
  }

  function mappage(ind) {
    const objet = {};
    const m = marquer(objet, i + 1);
    for (;;) {
      sauter();
      if (i >= N) break;
      const s = L[i];
      const k = indent(s);
      if (k < ind) break;
      if (/^(---|\.\.\.)(\s|$)/.test(s)) break;
      if (k > ind) erreur(`indentation inattendue (${k} espaces là où ${ind} sont attendus)`);
      const c = s.slice(ind);
      if (c[0] === "\t") erreur("tabulation dans l'indentation (interdite en YAML)");
      if (estTiret(c)) break; // séquence au niveau du parent : elle appartient à l'appelant
      refuserSyntaxe(c, i);
      const sc = separerCle(c);
      if (!sc) erreur(`ligne qui n'est ni une clé ni un élément de liste : « ${c.slice(0, 60)} »`);
      if (sc.cle === "<<") erreur("clé de fusion YAML (<<) non prise en charge par le lecteur de l'oracle");
      if (Object.prototype.hasOwnProperty.call(objet, sc.cle)) erreur(`clé « ${sc.cle} » définie deux fois`);
      const idx = i;
      i++;
      objet[sc.cle] = valeur(sc.reste, ind, idx, true);
      m[sc.cle] = idx + 1;
    }
    return objet;
  }

  function sequence(ind) {
    const tableau = [];
    const m = marquer(tableau, i + 1);
    for (;;) {
      sauter();
      if (i >= N) break;
      const s = L[i];
      const k = indent(s);
      if (k < ind) break;
      if (/^(---|\.\.\.)(\s|$)/.test(s)) break;
      if (k > ind) erreur(`indentation inattendue dans une liste (${k} espaces là où ${ind} sont attendus)`);
      const c = s.slice(ind);
      if (!estTiret(c)) break;
      const idx = i;
      const apresTiret = c.slice(1);
      const espaces = apresTiret.length - apresTiret.replace(/^ +/, "").length;
      const contenu = apresTiret.slice(espaces);
      let v;
      if (vide(contenu)) {
        i++;
        v = valeur("", ind, idx, false);
      } else if (estTiret(contenu) || (!/^[&*!?]/.test(contenu) && separerCle(contenu))) {
        // élément structuré qui commence sur la ligne du tiret : la ligne est ré-indentée à la
        // colonne de son contenu, et lue comme un nœud à cette colonne
        L[i] = " ".repeat(ind + 1 + espaces) + contenu;
        v = noeud(ind + 1 + espaces);
      } else {
        i++;
        v = valeur(contenu, ind, idx, false);
      }
      tableau.push(v);
      m[tableau.length - 1] = idx + 1;
    }
    return tableau;
  }

  // Valeur d'une clé ou d'un élément : `reste` est le texte sur la ligne `idx` (déjà passée).
  function valeur(reste, indParent, idx, seqMemeNiveau) {
    const r = reste.replace(/^[ \t]+/, "");
    if (r === "" || r[0] === "#") {
      sauter();
      if (i >= N) return null;
      const k = indent(L[i]);
      const c = L[i].slice(k);
      if (k > indParent && !/^(---|\.\.\.)(\s|$)/.test(L[i])) return noeud(k);
      if (seqMemeNiveau && k === indParent && estTiret(c)) return sequence(indParent);
      return null;
    }
    refuserSyntaxe(r, idx);
    if (r[0] === "|" || r[0] === ">") return blocScalaire(r, indParent, idx);
    if (r[0] === "[" || r[0] === "{") return flux(r, idx);
    if (r[0] === '"' || r[0] === "'") return guillemets(r, idx);
    return simple(r, indParent, idx);
  }

  function couperCommentaire(t) {
    for (let p = 0; p < t.length; p++) if (t[p] === "#" && (p === 0 || /\s/.test(t[p - 1]))) return t.slice(0, p);
    return t;
  }

  function simple(r, indParent, idx) {
    const morceaux = [couperCommentaire(r).trim()];
    // continuation d'un scalaire simple sur les lignes plus indentées que son parent
    for (;;) {
      let j = i;
      while (j < N && /^\s*$/.test(L[j])) j++;
      if (j >= N) break;
      const k = indent(L[j]);
      const c = L[j].slice(k);
      if (k <= indParent || c[0] === "#") break;
      if (separerCle(c)) erreur("clé de mappage dans la suite d'un scalaire simple (valeur mal indentée)", j);
      morceaux.push(j > i ? "\n".repeat(j - i) : " ");
      morceaux.push(couperCommentaire(c).trim());
      i = j + 1;
    }
    return morceaux.join("").replace(/ \n/g, "\n").replace(/\n /g, "\n");
  }

  function guillemets(r, idx) {
    const q = r[0];
    let tampon = r.slice(1), p = 0, res = "", jointure = null;
    for (;;) {
      if (p >= tampon.length) {
        // fin de ligne sans guillemet fermant : la chaîne continue à la ligne suivante
        if (i >= N) erreur("chaîne entre guillemets jamais fermée", idx);
        const suivante = L[i]; i++;
        if (jointure === "sans-espace") { res = res.replace(/[ \t]+$/, ""); }
        else {
          res = res.replace(/[ \t]+$/, "");
          if (/^\s*$/.test(suivante)) { res += "\n"; tampon = ""; p = 0; jointure = "saut"; continue; }
          if (jointure !== "saut") res += " ";
        }
        tampon = suivante.replace(/^\s+/, ""); p = 0; jointure = null;
        continue;
      }
      const ch = tampon[p];
      if (q === "'") {
        if (ch === "'") { if (tampon[p + 1] === "'") { res += "'"; p += 2; continue; } p++; break; }
        res += ch; p++; continue;
      }
      if (ch === "\\") {
        const e = tampon[p + 1];
        if (e === undefined) { p++; jointure = "sans-espace"; continue; }
        const simples = { n: "\n", t: "\t", r: "\r", 0: "\0", '"': '"', "\\": "\\", "/": "/", " ": " ", b: "\b", e: "\x1b", a: "\x07", f: "\f", v: "\v", N: "\u0085", _: "\u00a0", L: "\u2028", P: "\u2029", "\t": "\t" };
        if (e in simples) { res += simples[e]; p += 2; continue; }
        const longueur = { x: 2, u: 4, U: 8 }[e];
        if (longueur) {
          const hex = tampon.slice(p + 2, p + 2 + longueur);
          if (hex.length !== longueur || !/^[0-9a-fA-F]+$/.test(hex)) erreur(`échappement \\${e} invalide`, idx);
          res += String.fromCodePoint(parseInt(hex, 16)); p += 2 + longueur; continue;
        }
        erreur(`échappement inconnu \\${e}`, idx);
      }
      if (ch === '"') { p++; break; }
      res += ch; p++;
    }
    const apres = tampon.slice(p);
    if (!vide(apres)) erreur(`texte après une chaîne entre guillemets : « ${apres.trim().slice(0, 40)} »`, idx);
    return res;
  }

  function blocScalaire(r, indParent, idx) {
    const m = /^([|>])([1-9]?)([+-]?)([1-9]?)[ \t]*(#.*)?$/.exec(r);
    if (!m || (m[2] && m[4])) erreur(`en-tête de bloc « ${r.slice(0, 20)} » invalide`, idx);
    const style = m[1], chomp = m[3], indicateur = m[2] || m[4];
    let contenu;
    if (indicateur) contenu = Math.max(indParent, 0) + Number(indicateur);
    else {
      let j = i;
      while (j < N && /^\s*$/.test(L[j])) j++;
      contenu = j < N ? indent(L[j]) : indParent + 1;
      if (contenu <= indParent) contenu = indParent + 1;
    }
    const corps = [];
    while (i < N) {
      const s = L[i];
      if (/^\s*$/.test(s)) { corps.push(s.length > contenu ? s.slice(contenu) : ""); i++; continue; }
      if (indent(s) < contenu) break;
      corps.push(s.slice(contenu)); i++;
    }
    let fin = corps.length;
    while (fin > 0 && /^\s*$/.test(corps[fin - 1])) fin--;
    const utiles = corps.slice(0, fin);
    const traine = corps.length - fin;
    const texte = style === "|" ? utiles.join("\n") : plier(utiles);
    if (chomp === "-") return texte;
    if (chomp === "+") return texte + "\n".repeat(1 + traine);
    return utiles.length ? texte + "\n" : "";
  }

  function plier(lignesBloc) {
    let out = "", precedenteVide = true, precedenteIndentee = false;
    for (const l of lignesBloc) {
      if (/^\s*$/.test(l)) { out += "\n"; precedenteVide = true; continue; }
      const indentee = /^\s/.test(l);
      if (precedenteVide) out += l;
      else out += (indentee || precedenteIndentee ? "\n" : " ") + l;
      precedenteVide = false; precedenteIndentee = indentee;
    }
    return out;
  }

  function flux(r, idx) {
    // rassemble le texte jusqu'à l'équilibre des crochets, commentaires retirés ligne par ligne
    const fermeture = (t) => {
      let d = 0, q = null, debutScalaire = true;
      for (let k = 0; k < t.length; k++) {
        const ch = t[k];
        if (q) {
          if (q === "'" && ch === "'") { if (t[k + 1] === "'") { k++; continue; } q = null; }
          else if (q === '"' && ch === "\\") k++;
          else if (q === '"' && ch === '"') q = null;
          continue;
        }
        if ((ch === "'" || ch === '"') && debutScalaire) { q = ch; continue; }
        if (ch === "[" || ch === "{") { d++; debutScalaire = true; continue; }
        if (ch === "]" || ch === "}") { d--; if (d === 0) return k; debutScalaire = false; continue; }
        if (ch === "," || ch === ":") { debutScalaire = true; continue; }
        if (!/\s/.test(ch)) debutScalaire = false;
      }
      return -1;
    };
    const sansCommentaire = (t) => {
      let q = null;
      for (let k = 0; k < t.length; k++) {
        const ch = t[k];
        if (q) { if (q === '"' && ch === "\\") { k++; continue; } if (ch === q) q = null; continue; }
        if (ch === "'" || ch === '"') { q = ch; continue; }
        if (ch === "#" && (k === 0 || /\s/.test(t[k - 1]))) return t.slice(0, k);
      }
      return t;
    };
    let texte = sansCommentaire(r);
    while (fermeture(texte) < 0) {
      if (i >= N) erreur("collection en flux jamais fermée", idx);
      texte += " " + sansCommentaire(L[i]).trim();
      i++;
    }
    const fin = fermeture(texte);
    if (texte.slice(fin + 1).trim() !== "") erreur(`texte après une collection en flux : « ${texte.slice(fin + 1).trim().slice(0, 40)} »`, idx);
    return lireFlux(texte.slice(0, fin + 1), idx);
  }

  function lireFlux(t, idx) {
    let p = 0;
    const blanc = () => { while (p < t.length && /\s/.test(t[p])) p++; };
    const scalaire = () => {
      blanc();
      const ch = t[p];
      if (ch === '"' || ch === "'") {
        p++;
        let res = "";
        for (;;) {
          if (p >= t.length) erreur("chaîne en flux jamais fermée", idx);
          const c = t[p];
          if (ch === "'" && c === "'") { if (t[p + 1] === "'") { res += "'"; p += 2; continue; } p++; break; }
          if (ch === '"' && c === "\\") { const e = t[p + 1]; res += { n: "\n", t: "\t", '"': '"', "\\": "\\", "/": "/" }[e] ?? e; p += 2; continue; }
          if (ch === '"' && c === '"') { p++; break; }
          res += c; p++;
        }
        return res;
      }
      if (/[&*!]/.test(ch || "")) refuserSyntaxe(ch, idx);
      const debut = p;
      while (p < t.length) {
        const c = t[p];
        if (c === "," || c === "]" || c === "}" || c === "[" || c === "{") break;
        if (c === ":" && (p + 1 >= t.length || /[\s,\[\]{}]/.test(t[p + 1]))) break;
        p++;
      }
      const v = t.slice(debut, p).trim();
      return v === "" ? null : v;
    };
    const valeurFlux = () => {
      blanc();
      if (t[p] === "[") {
        p++;
        const tableau = [];
        for (;;) {
          blanc();
          if (t[p] === "]") { p++; return tableau; }
          let v = valeurFlux();
          blanc();
          if (t[p] === ":") { p++; v = { [String(v)]: valeurFlux() }; blanc(); }
          tableau.push(v);
          if (t[p] === ",") { p++; continue; }
          if (t[p] === "]") { p++; return tableau; }
          erreur("liste en flux mal formée", idx);
        }
      }
      if (t[p] === "{") {
        p++;
        const objet = {};
        for (;;) {
          blanc();
          if (t[p] === "}") { p++; return objet; }
          const cle = scalaire();
          blanc();
          let v = null;
          if (t[p] === ":") { p++; blanc(); v = (t[p] === "," || t[p] === "}") ? null : valeurFlux(); }
          if (cle === null) erreur("clé vide dans un mappage en flux", idx);
          if (Object.prototype.hasOwnProperty.call(objet, cle)) erreur(`clé « ${cle} » définie deux fois`, idx);
          objet[cle] = v;
          blanc();
          if (t[p] === ",") { p++; continue; }
          if (t[p] === "}") { p++; return objet; }
          erreur("mappage en flux mal formé", idx);
        }
      }
      return scalaire();
    };
    const v = valeurFlux();
    blanc();
    if (p < t.length) erreur("texte après une collection en flux", idx);
    return v;
  }

  // racine du document
  sauter();
  if (i < N && /^---(\s|$)/.test(L[i])) {
    const reste = L[i].slice(3);
    if (!vide(reste)) erreur("valeur sur la ligne du marqueur de document (---) non prise en charge");
    i++;
    sauter();
  }
  if (i >= N) return { valeur: null, lignes };
  const racine = noeud(indent(L[i]));
  sauter();
  if (i < N && !/^\.\.\.(\s|$)/.test(L[i])) {
    if (/^---(\s|$)/.test(L[i])) erreur("plusieurs documents YAML dans un seul fichier");
    erreur("contenu inattendu après la fin de la racine (indentation incohérente)");
  }
  return { valeur: racine, lignes };
}

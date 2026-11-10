'use strict';
// GESTAT 1.2.0 - historique des ventes de la caisse Casio (dossier « ventes » de la caisse, CLAMART : depuis 2020).
// Un fichier par jour « AAMMJJAZ.050 » : enregistrements binaires de 19 octets
//   [type 1 octet][6 octets (1er = rattachement)][code 2 octets][montant : réel Pascal 6 octets][quantité ×100 : entier 4 octets]
// Les types correspondent aux lignes du VENT.TOT de Videor :
//   1 → 050 (totaux : C.A BRUT, C.A NET = clients, espèces, cartes…)   2 → 051 (moyens de paiement)
//   241 → 056 (rayons)   242 → 055 (familles)   240 → 054 (sous-familles)   4 → 057 (tranches horaires)
// Les codes sont en hexadécimal (0x10 → « 0010 »). Les fichiers ne contiennent PAS les noms ni le détail par article :
// les noms sont repris d'une journée VENT.TOT récente du même magasin (même programmation de la caisse).
// azVersTot() fabrique un texte au format VENT.TOT, lu ensuite par GESTAT comme une journée normale (sans articles).

function reel48(b, o) {
  const e = b[o]; if (!e) return 0;
  let m = 0; for (let i = 5; i >= 1; i--) m = m * 256 + b[o + i];
  const neg = b[o + 5] & 0x80; if (neg) m -= 0x80 * Math.pow(2, 32);
  const v = (1 + m / Math.pow(2, 39)) * Math.pow(2, e - 129);
  return neg ? -v : v;
}
const code4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');
const c = (v) => Math.round(v * 100);
const pad = (v, n) => String(Math.max(0, Math.round(v))).padStart(n, '0');

function lireAz(buf) {
  const out = [];
  for (let i = 0; i + 19 <= buf.length; i += 19) {
    out.push({ t: buf[i], r: buf[i + 1], code: code4(buf[i + 7] | (buf[i + 8] << 8)), mt: reel48(buf, i + 9), q: buf.readInt32LE(i + 15) });
  }
  return out;
}

// Noms et rattachements d'après une journée VENT.TOT (texte) du même magasin.
function reference(txt) {
  const R = { t050: {}, t051: {}, t054: {}, t055: {}, t056: {}, t057: {} };
  for (const l of String(txt || '').split(/\r?\n/)) {
    const p = l.split('|');
    if (p[0] === '050') R.t050[p[2]] = p[3];
    else if (p[0] === '051') R.t051[p[1]] = p;
    else if (p[0] === '054') R.t054[p[1]] = p;
    else if (p[0] === '055') R.t055[p[1]] = p;
    else if (p[0] === '056') R.t056[p[1]] = p[2];
    else if (p[0] === '057') R.t057[p[1]] = [p[2], p[3]];
  }
  return R;
}
const NOMS050 = { '0001': 'C.A BRUT        ', '0003': 'C.A NET         ', '0004': 'ESPECES TIROIR  ', '0005': 'CARTES B TIROIR ', '0007': 'AUTRES  TIROIR  ', '0014': 'TOTAL TIROIR    ', '0051': 'REMISE IMMEDIATE' };
function tranche(code, R) {
  if (R.t057[code]) return R.t057[code];
  const n = parseInt(code, 16);
  if (n >= 4) { const h = String(n + 6).padStart(2, '0'); return [h + '00', h + '59']; }
  if (n === 3) return ['0800', '0959'];
  if (n === 2) return ['0700', '0759'];
  return ['0000', '0659'];
}

// Texte VENT.TOT reconstitué. aaaammjj sert seulement au repère de date (ligne d'en-tête 000).
function azVersTot(buf, refTxt, aaaammjj) {
  const R = reference(refTxt), L = lireAz(buf), lignes = ['000|AZ050|' + (aaaammjj || '') + '|historique caisse Casio (sans articles)'];
  let k = 0;
  for (const x of L.filter(x => x.t === 1)) lignes.push(['050', pad(++k, 4), x.code, (R.t050[x.code] || NOMS050[x.code] || ('TOTAL ' + x.code)).padEnd(16).slice(0, 16), pad(x.q, 8), pad(c(x.mt), 16)].join('|'));
  // moyens de paiement : codes connus de la caisse ; les codes à partir de 0x20 sont des sous-totaux (pas des paiements)
  for (const x of L.filter(x => x.t === 2 && (R.t051[x.code] || parseInt(x.code, 16) < 0x20))) {
    const ref = R.t051[x.code], nom = ref ? ref[4] : 'AUTRE PAIEMENT  ';
    lignes.push(['051', x.code, pad(x.r, 4), ref ? ref[3] : '00', nom, '00000000', '000000000000', '0000', ref ? ref[8] : '000000', ref ? ref[9] : '00', pad(x.q, 8), pad(c(x.mt), 10)].join('|'));
  }
  for (const x of L.filter(x => x.t === 241)) lignes.push(['056', x.code, (R.t056[x.code] || ('RAYON ' + x.code)).padEnd(16).slice(0, 16), pad(x.q, 8), pad(c(x.mt), 10), '00000000'].join('|'));
  for (const x of L.filter(x => x.t === 242)) {
    const ref = R.t055[x.code];
    lignes.push(['055', x.code, '00', ref ? ref[3] : ('FAMILLE ' + x.code).padEnd(16), x.code, '00', '00000000', '000000', ref ? ref[8] : ('06' + pad(x.r, 4)), pad(x.q, 8), pad(c(x.mt), 10), '00000000'].join('|'));
  }
  for (const x of L.filter(x => x.t === 240)) {
    const ref = R.t054[x.code];
    lignes.push(['054', x.code, '00', ref ? ref[3] : ('SOUS-FAMILLE ' + x.code).padEnd(16), ref ? ref[4] : x.code, '00', '00000000', '000000', ref ? ref[8] : ('05' + pad(x.r, 4)), pad(x.q, 8), pad(c(x.mt), 10), '00000000'].join('|'));
  }
  for (const x of L.filter(x => x.t === 4)) { const [a, b] = tranche(x.code, R); lignes.push(['057', x.code, a, b, pad(x.q, 8), pad(c(x.mt), 10)].join('|')); }
  return lignes.join('\r\n') + '\r\n';
}

// « 230711AZ.050 » → « 20230711 »
function dateAz(nom) { const m = /^(\d\d)(\d\d)(\d\d)AZ\.050$/i.exec(String(nom)); return m ? '20' + m[1] + m[2] + m[3] : ''; }

module.exports = { azVersTot, lireAz, dateAz, reel48 };

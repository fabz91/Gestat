'use strict';
// Lecture d'une archive 7-Zip (.7z) sans aucun programme extérieur : en-têtes 7z + décompression LZMA / LZMA2 / Copy.
// Sert à GESTAT pour l'archive « jrl.7z » de la caisse Casio de CLAMART (journaux des tickets compressés chaque nuit).
// Lecture seule, en mémoire. Les autres méthodes (PPMd, BZip2, filtres BCJ…) sont refusées avec un message clair.

// ---------- LZMA (d'après la spécification de l'auteur, LzmaSpec) ----------
function lzmaDecode(src, props, unpackSize, dictSize) {
  let lc, lp, pb;
  if (props.length >= 5 || typeof props === 'number') {
    let d = typeof props === 'number' ? props : props[0];
    if (d >= 9 * 5 * 5) throw new Error('LZMA : propriétés invalides');
    lc = d % 9; d = (d / 9) | 0; lp = d % 5; pb = (d / 5) | 0;
    if (typeof props !== 'number') dictSize = props[1] | (props[2] << 8) | (props[3] << 16) | (props[4] * 16777216);
  }
  return lzmaRun(src, 0, { lc, lp, pb }, unpackSize, dictSize).out;
}

function makeProbs(n) { const a = new Uint16Array(n); a.fill(1024); return a; }

// Décodeur avec état (utilisé par LZMA et LZMA2).
function LzmaState(dictSize, outSize) {
  this.out = new Uint8Array(outSize); this.pos = 0; this.dictSize = Math.max(dictSize || 1, 4096);
  this.reps = [0, 0, 0, 0]; this.state = 0;
}
LzmaState.prototype.setProps = function (lc, lp, pb) {
  this.lc = lc; this.lp = lp; this.pb = pb;
  this.literal = makeProbs(0x300 << (lc + lp));
  this.isMatch = makeProbs(192); this.isRep = makeProbs(12); this.isRepG0 = makeProbs(12); this.isRepG1 = makeProbs(12); this.isRepG2 = makeProbs(12); this.isRep0Long = makeProbs(192);
  this.posSlot = []; for (let i = 0; i < 4; i++) this.posSlot.push(makeProbs(64));
  this.posDecoders = makeProbs(115); this.align = makeProbs(16);
  this.lenDec = newLen(); this.repLenDec = newLen();
  this.reps = [0, 0, 0, 0]; this.state = 0;
};
function newLen() { const l = { choice: makeProbs(2), low: [], mid: [], high: makeProbs(256) }; for (let i = 0; i < 16; i++) { l.low.push(makeProbs(8)); l.mid.push(makeProbs(8)); } return l; }

function RangeDec(buf, off) {
  this.buf = buf; this.p = off;
  if (buf[this.p++] !== 0) throw new Error('LZMA : flux corrompu');
  this.code = 0; this.range = 0xFFFFFFFF;
  for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | buf[this.p++]) >>> 0;
}
RangeDec.prototype.norm = function () { if (this.range < 0x1000000) { this.range = (this.range << 8) >>> 0; this.code = ((this.code << 8) | (this.buf[this.p++] | 0)) >>> 0; } };
RangeDec.prototype.bit = function (probs, i) {
  const v = probs[i], bound = (this.range >>> 11) * v;
  let s;
  if (this.code < bound) { this.range = bound; probs[i] = v + ((2048 - v) >>> 5); s = 0; }
  else { this.range = (this.range - bound) >>> 0; this.code = (this.code - bound) >>> 0; probs[i] = v - (v >>> 5); s = 1; }
  this.norm(); return s;
};
RangeDec.prototype.direct = function (n) {
  let res = 0;
  while (n--) { this.range >>>= 1; let t = 0; if (this.code >= this.range) { this.code = (this.code - this.range) >>> 0; t = 1; } res = ((res << 1) | t) >>> 0; this.norm(); }
  return res;
};
function bitTree(rc, probs, bits) { let m = 1; for (let i = 0; i < bits; i++) m = (m << 1) + rc.bit(probs, m); return m - (1 << bits); }
function bitTreeRev(rc, probs, bits, off) { let m = 1, sym = 0; for (let i = 0; i < bits; i++) { const b = rc.bit(probs, (off || 0) + m); m = (m << 1) + b; sym |= b << i; } return sym; }
function lenDecode(rc, l, posState) {
  if (rc.bit(l.choice, 0) === 0) return bitTree(rc, l.low[posState], 3);
  if (rc.bit(l.choice, 1) === 0) return 8 + bitTree(rc, l.mid[posState], 3);
  return 16 + bitTree(rc, l.high, 8);
}

// Décode des données LZMA dans st jusqu'à st.pos === limit (ou marqueur de fin).
function lzmaBlock(st, rc, limit) {
  const out = st.out, lc = st.lc, lp = st.lp, pbMask = (1 << st.pb) - 1, lpMask = (1 << lp) - 1;
  let state = st.state, [r0, r1, r2, r3] = st.reps, pos = st.pos;
  while (pos < limit) {
    const posState = pos & pbMask;
    if (rc.bit(st.isMatch, (state << 4) + posState) === 0) {
      const prev = pos > 0 ? out[pos - 1] : 0;
      const base = 0x300 * (((pos & lpMask) << lc) + (prev >>> (8 - lc)));
      let sym = 1;
      if (state >= 7) {
        let mb = out[pos - r0 - 1];
        do { const matchBit = (mb >>> 7) & 1; mb <<= 1; const b = rc.bit(st.literal, base + ((1 + matchBit) << 8) + sym); sym = (sym << 1) | b; if (matchBit !== b) break; } while (sym < 0x100);
      }
      while (sym < 0x100) sym = (sym << 1) | rc.bit(st.literal, base + sym);
      out[pos++] = sym & 0xFF;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }
    let len;
    if (rc.bit(st.isRep, state) !== 0) {
      if (pos === 0) throw new Error('LZMA : flux corrompu');
      if (rc.bit(st.isRepG0, state) === 0) {
        if (rc.bit(st.isRep0Long, (state << 4) + posState) === 0) { state = state < 7 ? 9 : 11; out[pos] = out[pos - r0 - 1]; pos++; continue; }
      } else {
        let d;
        if (rc.bit(st.isRepG1, state) === 0) d = r1;
        else { if (rc.bit(st.isRepG2, state) === 0) d = r2; else { d = r3; r3 = r2; } r2 = r1; }
        r1 = r0; r0 = d;
      }
      len = lenDecode(rc, st.repLenDec, posState);
      state = state < 7 ? 8 : 11;
    } else {
      r3 = r2; r2 = r1; r1 = r0;
      len = lenDecode(rc, st.lenDec, posState);
      state = state < 7 ? 7 : 10;
      const lenState = len < 3 ? len : 3;
      const slot = bitTree(rc, st.posSlot[lenState], 6);
      if (slot < 4) r0 = slot;
      else {
        const nd = (slot >>> 1) - 1; let dist = ((2 | (slot & 1)) << nd) >>> 0;
        if (slot < 14) dist += bitTreeRev(rc, st.posDecoders, nd, dist - slot);
        else { dist += rc.direct(nd - 4) << 4; dist += bitTreeRev(rc, st.align, 4); }
        r0 = dist >>> 0;
        if (r0 === 0xFFFFFFFF) break; // marqueur de fin
      }
      if (r0 >= pos || r0 >= st.dictSize) throw new Error('LZMA : distance invalide');
    }
    len += 2;
    if (pos + len > limit) len = limit - pos;
    for (let i = 0; i < len; i++) { out[pos] = out[pos - r0 - 1]; pos++; }
  }
  st.state = state; st.reps = [r0, r1, r2, r3]; st.pos = pos;
}

function lzmaRun(src, off, p, unpackSize, dictSize) {
  const st = new LzmaState(dictSize, unpackSize); st.setProps(p.lc, p.lp, p.pb);
  const rc = new RangeDec(src, off); lzmaBlock(st, rc, unpackSize);
  return { out: st.out.subarray(0, st.pos) };
}

function lzma2Decode(src, dictProp, unpackSize) {
  const dictSize = dictProp === 40 ? 0xFFFFFFFF : ((2 | (dictProp & 1)) << ((dictProp >>> 1) + 11)) >>> 0;
  const st = new LzmaState(Math.min(dictSize, unpackSize + 1), unpackSize);
  let p = 0, need = true;
  while (p < src.length) {
    const c = src[p++];
    if (c === 0) break;
    if (c === 1 || c === 2) { const n = ((src[p] << 8) | src[p + 1]) + 1; p += 2; st.out.set(src.subarray(p, p + n), st.pos); st.pos += n; p += n; continue; }
    if (c < 0x80) throw new Error('LZMA2 : flux corrompu');
    const u = (((c & 0x1F) << 16) | (src[p] << 8) | src[p + 1]) + 1; const pk = ((src[p + 2] << 8) | src[p + 3]) + 1; p += 4;
    const mode = (c >>> 5) & 3;
    if (mode >= 2) { let d = src[p++]; const lc = d % 9; d = (d / 9) | 0; st.setProps(lc, d % 5, (d / 5) | 0); }
    else if (mode === 1) { st.reps = [0, 0, 0, 0]; st.state = 0; st.setProps(st.lc, st.lp, st.pb); }
    if (need && mode < 2) { /* tolérance */ } need = false;
    const rc = new RangeDec(src, p); lzmaBlock(st, rc, st.pos + u); p += pk;
  }
  return st.out.subarray(0, st.pos);
}

// ---------- conteneur 7z ----------
const SIG = [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C];
function Reader(b, p) { this.b = b; this.p = p || 0; }
Reader.prototype.byte = function () { if (this.p >= this.b.length) throw new Error('7z : en-tête tronqué'); return this.b[this.p++]; };
Reader.prototype.num = function () {
  const first = this.byte(); let mask = 0x80, v = 0;
  for (let i = 0; i < 8; i++) {
    if ((first & mask) === 0) { const hi = first & (mask - 1); return v + hi * Math.pow(2, 8 * i); }
    v += this.byte() * Math.pow(2, 8 * i); mask >>>= 1;
  }
  return v;
};
Reader.prototype.u32 = function () { const b = this.b, p = this.p; this.p += 4; return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; };
Reader.prototype.u64 = function () { const lo = this.u32(), hi = this.u32(); return hi * 4294967296 + lo; };
Reader.prototype.bits = function (n) { const out = []; let m = 0, c = 0; for (let i = 0; i < n; i++) { if (m === 0) { c = this.byte(); m = 0x80; } out.push(!!(c & m)); m >>>= 1; } return out; };
Reader.prototype.defined = function (n) { const all = this.byte(); if (all) return new Array(n).fill(true); return this.bits(n); };
Reader.prototype.skip = function (n) { this.p += n; };

function readPackInfo(r) {
  const pi = { packPos: r.num(), sizes: [] }; const n = r.num();
  for (;;) {
    const id = r.num(); if (id === 0) break;
    if (id === 9) { for (let i = 0; i < n; i++) pi.sizes.push(r.num()); }
    else if (id === 10) { const d = r.defined(n); d.forEach(x => { if (x) r.u32(); }); }
    else throw new Error('7z : en-tête inattendu (' + id + ')');
  }
  return pi;
}
function readFolder(r) {
  const nc = r.num(), coders = []; let nOut = 0, nIn = 0;
  for (let i = 0; i < nc; i++) {
    const f = r.byte(), idSize = f & 0xF, simple = !(f & 0x10), attrs = !!(f & 0x20);
    let id = ''; for (let k = 0; k < idSize; k++) id += r.byte().toString(16).padStart(2, '0');
    let ins = 1, outs = 1; if (!simple) { ins = r.num(); outs = r.num(); }
    let props = null; if (attrs) { const ps = r.num(); props = r.b.subarray(r.p, r.p + ps); r.skip(ps); }
    if (f & 0x80) throw new Error('7z : codeur non pris en charge');
    coders.push({ id, ins, outs, props }); nIn += ins; nOut += outs;
  }
  const bonds = []; for (let i = 0; i < nOut - 1; i++) bonds.push({ inIndex: r.num(), outIndex: r.num() });
  const nPacked = nIn - bonds.length, packed = [];
  if (nPacked === 1) { for (let i = 0; i < nIn; i++) if (!bonds.some(b => b.inIndex === i)) { packed.push(i); break; } }
  else for (let i = 0; i < nPacked; i++) packed.push(r.num());
  return { coders, bonds, packed, nOut };
}
function readUnpackInfo(r) {
  if (r.num() !== 11) throw new Error('7z : en-tête inattendu');
  const n = r.num(); if (r.byte() !== 0) throw new Error('7z : dossiers externes non pris en charge');
  const folders = []; for (let i = 0; i < n; i++) folders.push(readFolder(r));
  if (r.num() !== 12) throw new Error('7z : en-tête inattendu');
  for (const f of folders) { f.sizes = []; for (let i = 0; i < f.nOut; i++) f.sizes.push(r.num()); }
  for (;;) { const id = r.num(); if (id === 0) break; if (id === 10) { const d = r.defined(n); d.forEach(x => { if (x) r.u32(); }); } else throw new Error('7z : en-tête inattendu'); }
  return folders;
}
function readSubStreams(r, folders) {
  const counts = folders.map(() => 1); let id = r.num();
  if (id === 13) { for (let i = 0; i < folders.length; i++) counts[i] = r.num(); id = r.num(); }
  const sizes = [];
  folders.forEach((f, i) => {
    const total = folderUnpackSize(f); if (counts[i] === 0) return;
    let sum = 0; if (id === 9) { for (let k = 0; k < counts[i] - 1; k++) { const s = r.num(); sizes.push(s); sum += s; } }
    sizes.push(total - sum);
  });
  if (id === 9) id = r.num();
  while (id !== 0) {
    if (id === 10) { const nd = counts.reduce((a, b) => a + b, 0); const d = r.defined(nd); d.forEach(x => { if (x) r.u32(); }); }
    else throw new Error('7z : en-tête inattendu');
    id = r.num();
  }
  return { counts, sizes };
}
function folderUnpackSize(f) {
  for (let i = f.sizes.length - 1; i >= 0; i--) if (!f.bonds.some(b => b.outIndex === i)) return f.sizes[i];
  return f.sizes[f.sizes.length - 1];
}
function readStreamsInfo(r) {
  const si = { pack: null, folders: [], sub: null };
  for (;;) {
    const id = r.num(); if (id === 0) break;
    if (id === 6) si.pack = readPackInfo(r);
    else if (id === 7) si.folders = readUnpackInfo(r);
    else if (id === 8) si.sub = readSubStreams(r, si.folders);
    else throw new Error('7z : en-tête inattendu (' + id + ')');
  }
  if (!si.sub) si.sub = { counts: si.folders.map(() => 1), sizes: si.folders.map(folderUnpackSize) };
  return si;
}
function decodeFolder(buf, base, packPos, packSizes, f) {
  if (f.coders.length !== 1) throw new Error('7z : archive avec filtres (non prise en charge)');
  const c = f.coders[0], src = buf.subarray(base + packPos, base + packPos + packSizes[0]), size = folderUnpackSize(f);
  if (c.id === '00') return src.subarray(0, size);
  if (c.id === '030101') return lzmaDecode(src, c.props, size);
  if (c.id === '21') return lzma2Decode(src, c.props[0], size);
  throw new Error('7z : méthode de compression non prise en charge (' + c.id + ')');
}
function unpackAll(buf, base, si) {
  const out = []; let pp = si.pack ? si.pack.packPos : 0, pi = 0;
  for (const f of si.folders) {
    const n = f.packed.length, sizes = si.pack.sizes.slice(pi, pi + n);
    out.push(decodeFolder(buf, base, pp, sizes, f));
    pp += sizes.reduce((a, b) => a + b, 0); pi += n;
  }
  return out;
}
function readNames(r, n) {
  if (r.byte() !== 0) throw new Error('7z : noms externes');
  const names = []; let s = '';
  while (names.length < n) { const c = r.b[r.p] | (r.b[r.p + 1] << 8); r.p += 2; if (c === 0) { names.push(s); s = ''; } else s += String.fromCharCode(c); }
  return names;
}
function readFilesInfo(r) {
  const n = r.num(), files = []; for (let i = 0; i < n; i++) files.push({ name: '', emptyStream: false, emptyFile: false, dir: false });
  let empty = [];
  for (;;) {
    const type = r.num(); if (type === 0) break;
    const size = r.num(), end = r.p + size;
    if (type === 14) { empty = r.bits(n); empty.forEach((x, i) => { files[i].emptyStream = x; }); }
    else if (type === 15) { const ne = empty.filter(Boolean).length; const b = r.bits(ne); let k = 0; files.forEach(f => { if (f.emptyStream) f.emptyFile = b[k++]; }); }
    else if (type === 17) { readNames(r, n).forEach((s, i) => { files[i].name = s; }); }
    else if (type === 20) { // dates de modification
      const d = r.defined(n); if (r.byte() !== 0) throw new Error('7z : dates externes');
      d.forEach((x, i) => { if (x) { const ft = r.u64(); files[i].mtime = Math.round(ft / 10000 - 11644473600000); } });
    }
    r.p = end;
  }
  files.forEach(f => { if (f.emptyStream && !f.emptyFile) f.dir = true; });
  return files;
}

// Renvoie [{ name, data: Uint8Array, mtime }] pour chaque fichier de l'archive (les dossiers sont omis).
function lire7z(buf) {
  buf = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  for (let i = 0; i < 6; i++) if (buf[i] !== SIG[i]) throw new Error("Ce n'est pas une archive 7-Zip");
  const r0 = new Reader(buf, 12); const off = r0.u64(), size = r0.u64();
  let hdr = buf.subarray(32 + off, 32 + off + size);
  let r = new Reader(hdr);
  let id = r.num();
  if (id === 0x17) { const si = readStreamsInfo(r); hdr = unpackAll(buf, 32, si)[0]; r = new Reader(hdr); id = r.num(); }
  if (id !== 1) throw new Error('7z : en-tête principal introuvable');
  let si = null, files = [];
  for (;;) {
    const t = r.num(); if (t === 0) break;
    if (t === 2) { for (;;) { const a = r.num(); if (a === 0) break; r.skip(r.num()); } }
    else if (t === 3) throw new Error('7z : flux supplémentaires non pris en charge');
    else if (t === 4) si = readStreamsInfo(r);
    else if (t === 5) files = readFilesInfo(r);
    else throw new Error('7z : en-tête inattendu (' + t + ')');
  }
  const res = [];
  if (!si) return files.filter(f => !f.dir).map(f => ({ name: f.name, data: new Uint8Array(0), mtime: f.mtime }));
  const blocks = unpackAll(buf, 32, si);
  let fi = 0, si2 = 0;
  si.folders.forEach((f, k) => {
    let p = 0;
    for (let j = 0; j < si.sub.counts[k]; j++) {
      while (fi < files.length && files[fi].emptyStream) { if (!files[fi].dir) res.push({ name: files[fi].name, data: new Uint8Array(0), mtime: files[fi].mtime }); fi++; }
      const sz = si.sub.sizes[si2++], fl = files[fi++] || { name: 'fichier' + fi };
      res.push({ name: fl.name, data: blocks[k].subarray(p, p + sz), mtime: fl.mtime }); p += sz;
    }
  });
  while (fi < files.length) { if (!files[fi].dir) res.push({ name: files[fi].name, data: new Uint8Array(0), mtime: files[fi].mtime }); fi++; }
  return res;
}

module.exports = { lire7z, lzmaDecode, lzma2Decode };

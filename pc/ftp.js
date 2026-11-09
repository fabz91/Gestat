'use strict';
// GESTAT 1.1.0 - petit client FTP en LECTURE SEULE (pour la caisse Casio du magasin).
// Seules les commandes de lecture sont autorisées : impossible d'écrire, renommer ou supprimer quoi que ce soit sur la caisse.
const net = require('net');

const AUTORISEES = new Set(['USER', 'PASS', 'TYPE', 'PASV', 'NLST', 'RETR', 'SIZE', 'NOOP', 'QUIT', 'OPTS']);

class FtpLecture {
  constructor(o) {
    this.host = o.host; this.port = o.port || 21; this.user = o.user || 'anonymous'; this.pass = o.pass || '';
    this.timeout = o.timeout || 20000; this.sock = null; this.buf = ''; this.waiters = []; this.lines = []; this.closed = false;
  }
  _onData(d) {
    this.buf += d.toString('latin1');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) { const l = this.buf.slice(0, i).replace(/\r$/, ''); this.buf = this.buf.slice(i + 1); this.lines.push(l); }
    this._pump();
  }
  // Une réponse FTP : « 123 texte » ou plusieurs lignes « 123-… » terminées par « 123 … ».
  _take() {
    if (!this.lines.length) return null;
    const m = /^(\d{3})([ -])/.exec(this.lines[0]);
    if (!m) { this.lines.shift(); return this._take(); }
    if (m[2] === ' ') { const l = this.lines.shift(); return { code: +m[1], text: l.slice(4) }; }
    const end = this.lines.findIndex((l, k) => k > 0 && l.startsWith(m[1] + ' '));
    if (end < 0) return null;
    const all = this.lines.splice(0, end + 1);
    return { code: +m[1], text: all.map(l => l.slice(4)).join('\n') };
  }
  _pump() { while (this.waiters.length) { const r = this._take(); if (!r) break; const w = this.waiters.shift(); clearTimeout(w.t); w.ok(r); } }
  _reply() {
    return new Promise((ok, ko) => {
      if (this.closed) return ko(new Error('Connexion à la caisse fermée'));
      const w = { ok, ko, t: setTimeout(() => { const k = this.waiters.indexOf(w); if (k >= 0) this.waiters.splice(k, 1); ko(new Error('La caisse ne répond pas (délai dépassé)')); }, this.timeout) };
      this.waiters.push(w); this._pump();
    });
  }
  async cmd(line) {
    const verbe = String(line).split(' ')[0].toUpperCase();
    if (!AUTORISEES.has(verbe)) throw new Error('Commande refusée (lecture seule) : ' + verbe);
    if (/[\r\n]/.test(line)) throw new Error('Commande refusée');
    this.sock.write(line + '\r\n', 'latin1');
    return this._reply();
  }
  async connect() {
    try { return await this._connect(); } catch (e) { try { this.sock && this.sock.destroy(); } catch (_) {} throw e; }
  }
  async _connect() {
    await new Promise((ok, ko) => {
      const s = net.createConnection({ host: this.host, port: this.port });
      const t = setTimeout(() => { s.destroy(); ko(new Error('Caisse injoignable à l\'adresse ' + this.host + ' (vérifiez l\'adresse et que ce PC est bien au magasin)')); }, this.timeout);
      s.once('connect', () => { clearTimeout(t); ok(); });
      s.once('error', (e) => { clearTimeout(t); ko(new Error('Caisse injoignable à l\'adresse ' + this.host + ' : ' + (e.code || e.message))); });
      this.sock = s;
    });
    this.sock.on('data', (d) => this._onData(d));
    this.sock.on('close', () => { this.closed = true; while (this.waiters.length) { const w = this.waiters.shift(); clearTimeout(w.t); w.ko(new Error('Connexion à la caisse fermée')); } });
    this.sock.on('error', () => {});
    const g = await this._reply(); if (g.code !== 220) throw new Error('Réponse inattendue de la caisse : ' + g.code + ' ' + g.text);
    let r = await this.cmd('USER ' + this.user);
    if (r.code === 331) r = await this.cmd('PASS ' + this.pass);
    if (r.code !== 230 && r.code !== 202) throw new Error(r.code === 530 ? 'Identifiant ou mot de passe refusé par la caisse' : 'Connexion refusée : ' + r.code + ' ' + r.text);
    r = await this.cmd('TYPE I'); if (r.code !== 200) throw new Error('Mode binaire refusé : ' + r.code);
    return this;
  }
  async _data(line) {
    const p = await this.cmd('PASV');
    if (p.code !== 227) throw new Error('Mode passif refusé : ' + p.code + ' ' + p.text);
    const m = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(p.text); if (!m) throw new Error('Réponse PASV illisible');
    const port = (+m[5]) * 256 + (+m[6]);
    const chunks = []; let fin;
    const done = new Promise((ok, ko) => {
      // On se connecte toujours à l'adresse réglée (pas à celle annoncée : plus sûr, et marche derrière une box).
      const d = net.createConnection({ host: this.host, port });
      const t = setTimeout(() => { d.destroy(); ko(new Error('Transfert trop long')); }, Math.max(this.timeout, 120000));
      d.on('data', (c) => chunks.push(c));
      d.on('end', () => { clearTimeout(t); ok(); });
      d.on('close', () => { clearTimeout(t); ok(); });
      d.on('error', (e) => { clearTimeout(t); ko(e); });
      fin = d;
    });
    done.catch(() => {}); // évite une erreur non suivie si le transfert est annulé (fichier absent)
    const r = await this.cmd(line);
    if (r.code >= 400) { fin.destroy(); const e = new Error(r.code + ' ' + r.text); e.ftp = r.code; throw e; }
    if (r.code !== 125 && r.code !== 150 && r.code !== 226 && r.code !== 250) { fin.destroy(); throw new Error('Réponse inattendue : ' + r.code + ' ' + r.text); }
    await done;
    if (r.code === 125 || r.code === 150) { const f = await this._reply(); if (f.code >= 400) { const e = new Error(f.code + ' ' + f.text); e.ftp = f.code; throw e; } }
    return Buffer.concat(chunks);
  }
  // Liste des noms d'un dossier (« » = racine).
  async noms(dir) {
    let b;
    try { b = await this._data(dir ? 'NLST ' + dir : 'NLST'); }
    catch (e) { if (e.ftp === 450 || e.ftp >= 500) return []; throw e; }
    return b.toString('latin1').split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => s.split('/').pop()).filter(s => s !== '.' && s !== '..');
  }
  // Contenu d'un fichier (Buffer), ou null s'il n'existe pas.
  async lire(chemin) {
    try { return await this._data('RETR ' + chemin); }
    // 1.1.1 : la caisse Casio répond « 501 Cannot open file » quand le fichier n'existe pas (pas 550).
    catch (e) { if (e.ftp === 450 || e.ftp >= 500) return null; throw e; }
  }
  async taille(chemin) {
    try { const r = await this.cmd('SIZE ' + chemin); return r.code === 213 ? +String(r.text).trim() : -1; } catch (e) { return -1; }
  }
  async fermer() { try { if (!this.closed) { this.sock.write('QUIT\r\n'); } } catch (e) {} setTimeout(() => { try { this.sock.destroy(); } catch (e) {} }, 300); }
}

module.exports = { FtpLecture };

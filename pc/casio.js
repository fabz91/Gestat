'use strict';
// GESTAT 1.1.0 - copie des fichiers de la caisse Casio sur ce PC (LECTURE SEULE sur la caisse).
// Sur la caisse (ftp) :
//   JJMMAAAA/vent.tot      journée complète du magasin (le même fichier que le VENT.TOT de Videor)
//   JJMMAAAA/save001.TTT   la même journée, avec un bloc de totaux PAR CAISSE
//   0205-CC_AAAAMMJJ.JRL   journal de tous les tickets d'une caisse (annulations, caissiers…)
//   TARIF.TXT              fichier des articles (prix de vente)
//   jrl.7z                 (CLAMART, 1.2.0) les journaux .JRL de la veille, compressés chaque nuit par la caisse : extraits sur ce PC
// Sur ce PC (%APPDATA%\GESTAT\donnees\casio) :
//   jours\AAAAMMJJ\vent.tot, jours\AAAAMMJJ\save001.ttt, jrl\*.JRL, TARIF.TXT, etat.json
const fs = require('fs');
const path = require('path');
const { FtpLecture } = require('./ftp');
const { lire7z } = require('./sevenzip');

function createCasio({ dataDir, safeStorage, log }) {
  const cfgPath = path.join(dataDir, 'gestat-casio.json');
  const dir = path.join(dataDir, 'casio');
  const etatPath = path.join(dir, 'etat.json');
  let enCours = null;
  const L = log || (() => {});

  function lireCfg() { try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {}; } catch (e) { return {}; } }
  function ecrireCfg(c) { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(cfgPath + '.tmp', JSON.stringify(c, null, 1), 'utf8'); fs.renameSync(cfgPath + '.tmp', cfgPath); }
  // Le mot de passe est chiffré par Windows (lié à la session de ce PC) : il ne quitte jamais ce PC, et n'est jamais renvoyé à la page.
  function mdp(c) {
    if (!c.mdp) return '';
    try { if (c.chiffre && safeStorage && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(c.mdp, 'base64')); } catch (e) { return ''; }
    return c.chiffre ? '' : Buffer.from(c.mdp, 'base64').toString('utf8');
  }
  function lireEtat() { try { return JSON.parse(fs.readFileSync(etatPath, 'utf8')) || {}; } catch (e) { return {}; } }
  function ecrireEtat(e) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(etatPath, JSON.stringify(e, null, 1), 'utf8'); }

  function infos() {
    const c = lireCfg(), e = lireEtat();
    return { regle: !!(c.hote && c.actif !== false), actif: c.actif !== false, hote: c.hote || '', user: c.user || '', aMdp: !!c.mdp, etat: e, enCours: !!enCours, progression: enCours ? enCours.prog : null };
  }
  function regler(o) {
    const c = lireCfg();
    if (o.hote != null) { const h = String(o.hote).trim().replace(/^ftp:\/\//i, '').replace(/\/.*$/, ''); if (h && !/^[A-Za-z0-9.\-]+(:\d{1,5})?$/.test(h)) throw new Error('Adresse invalide'); c.hote = h; }
    if (o.user != null) c.user = String(o.user).trim();
    if (o.pass) {
      if (safeStorage && safeStorage.isEncryptionAvailable()) { c.mdp = safeStorage.encryptString(String(o.pass)).toString('base64'); c.chiffre = true; }
      else { c.mdp = Buffer.from(String(o.pass), 'utf8').toString('base64'); c.chiffre = false; }
    }
    if (o.actif != null) c.actif = !!o.actif;
    ecrireCfg(c); return infos();
  }
  async function ouvrir() {
    const c = lireCfg(); if (!c.hote) throw new Error('Adresse de la caisse non réglée');
    const [host, port] = c.hote.split(':');
    const f = new FtpLecture({ host, port: +port || 21, user: c.user || 'anonymous', pass: mdp(c) });
    await f.connect(); return f;
  }
  async function tester() {
    const f = await ouvrir();
    try { const n = await f.noms(''); const jours = n.filter(x => /^\d{8}$/.test(x)).length, jrl = n.filter(x => /\.jrl$/i.test(x)).length, archive = n.some(x => /^jrl\.7z$/i.test(x)); return { ok: true, n: n.length, jours, jrl: jrl || (archive ? 1 : 0), archive }; }
    finally { f.fermer(); }
  }

  const iso8 = (jjmmaaaa) => { const m = /^(\d\d)(\d\d)(\d{4})$/.exec(jjmmaaaa); if (!m) return ''; const d = +m[1], mo = +m[2], y = +m[3]; if (d < 1 || d > 31 || mo < 1 || mo > 12 || y < 2000 || y > 2100) return ''; return m[3] + m[2] + m[1]; };
  const auj8 = () => { const n = new Date(); return n.getFullYear() + String(n.getMonth() + 1).padStart(2, '0') + String(n.getDate()).padStart(2, '0'); };
  const moins = (a8, j) => { const d = new Date(+a8.slice(0, 4), +a8.slice(4, 6) - 1, +a8.slice(6, 8) - j); return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); };
  // Date réelle d'une journée : celle écrite dans les lignes articles (champ 14), sinon le nom du dossier.
  function dateContenu(buf) { const t = buf.toString('latin1', 0, Math.min(buf.length, 20000)); const m = /^001\|(?:[^|]*\|){12}(\d{8})/m.exec(t); return m ? m[1] : ''; }
  function ecrireFichier(f, buf) { try { if (fs.readFileSync(f).equals(buf)) return false; } catch (e) {} fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', buf); fs.renameSync(f + '.tmp', f); return true; }
  async function lireUn(f, noms) { for (const n of noms) { const b = await f.lire(n); if (b) return b; } return null; }

  // Copie ce qui manque. Les journées déjà copiées (plus de 3 jours) ne sont pas relues.
  async function copier(onProg) {
    if (enCours) return enCours.p;
    const prog = { etape: 'connexion', n: 0, tot: 0, nouveaux: 0 };
    const tick = () => { try { onProg && onProg(Object.assign({}, prog)); } catch (e) {} };
    const run = (async () => {
      const etat = lireEtat(); const debut = new Date().toISOString();
      let f = null;
      try {
        f = await ouvrir(); tick();
        const racine = await f.noms('');
        const a8 = auj8(), recent = moins(a8, 3), recentJrl = moins(a8, 2);
        // 1) journées (un dossier JJMMAAAA par jour)
        const dossiers = racine.filter(x => iso8(x)).map(x => ({ nom: x, d: iso8(x) })).filter(x => x.d <= a8).sort((u, v) => (u.d < v.d ? 1 : -1));
        const vides = new Set(), faits = new Set(etat.faits || []); // 1.1.1 : un dossier sans journée est simplement réessayé la fois suivante
        const aFaire = dossiers.filter(x => x.d >= recent || !faits.has(x.nom));
        // 2) journaux des tickets
        const jrls = racine.filter(x => /^[A-Za-z0-9_\-]+_\d{8}\.jrl$/i.test(x));
        const jrlFaire = jrls.filter(x => { const m = /_(\d{8})\.jrl$/i.exec(x); return (m && m[1] >= recentJrl) || !fs.existsSync(path.join(dir, 'jrl', x)); });
        // 1.2.0 : CLAMART — la caisse compresse chaque nuit les journaux de la veille dans jrl.7z (à la racine)
        const archives = racine.filter(x => /^jrl\.7z$/i.test(x));
        prog.etape = 'copie'; prog.tot = aFaire.length + jrlFaire.length + archives.length + 1; tick();
        for (const x of aFaire) {
          const v = await lireUn(f, [x.nom + '/vent.tot', x.nom + '/VENT.TOT']);
          if (!v || v.length < 20) { vides.add(x.d); }
          else {
            const d = dateContenu(v) || x.d;
            const neuf = ecrireFichier(path.join(dir, 'jours', d, 'vent.tot'), v);
            const s = await lireUn(f, [x.nom + '/save001.TTT', x.nom + '/SAVE001.TTT', x.nom + '/save001.ttt']);
            if (s) ecrireFichier(path.join(dir, 'jours', d, 'save001.ttt'), s);
            if (neuf) prog.nouveaux++; if (x.d < recent) faits.add(x.nom);
          }
          prog.n++; if (prog.n % 5 === 0) tick();
          if (prog.n % 25 === 0) ecrireEtat(Object.assign({}, etat, { faits: [...faits], vides: [...vides] })); // reprise possible si coupure
        }
        for (const x of jrlFaire) {
          const b = await f.lire(x); if (b) ecrireFichier(path.join(dir, 'jrl', x), b);
          prog.n++; if (prog.n % 5 === 0) tick();
        }
        for (const x of archives) {
          try {
            const b = await f.lire(x);
            if (b && b.length > 32) for (const e of lire7z(b)) { const nom = path.basename(String(e.name).replace(/\\/g, '/')); if (/^[A-Za-z0-9_\-]+_\d{8}\.jrl$/i.test(nom) && e.data.length) ecrireFichier(path.join(dir, 'jrl', nom), Buffer.from(e.data)); }
          } catch (e) { L('casio jrl.7z', e); prog.archiveErreur = 'jrl.7z illisible : ' + (e.message || e); }
          prog.n++; tick();
        }
        const t = await lireUn(f, ['TARIF.TXT', 'tarif.txt']); if (t && t.length > 100) ecrireFichier(path.join(dir, 'TARIF.TXT'), t);
        prog.n++; prog.etape = 'fini'; tick();
        const e2 = { derniere: new Date().toISOString(), debut, ok: true, erreur: prog.archiveErreur || '', jours: listeJours().length, jrl: listeJrl().length, nouveaux: prog.nouveaux, vides: [...vides], faits: [...faits] };
        ecrireEtat(e2); return e2;
      } catch (e) {
        L('casio', e);
        const e2 = Object.assign({}, etat, { derniereTentative: new Date().toISOString(), ok: false, erreur: e.message || String(e) });
        ecrireEtat(e2); prog.etape = 'erreur'; prog.erreur = e2.erreur; tick(); return e2;
      } finally { if (f) f.fermer(); }
    })();
    enCours = { p: run, prog };
    try { return await run; } finally { enCours = null; }
  }

  function listeJours() { try { return fs.readdirSync(path.join(dir, 'jours')).filter(d => /^\d{8}$/.test(d) && fs.existsSync(path.join(dir, 'jours', d, 'vent.tot'))).sort(); } catch (e) { return []; } }
  function listeJrl() { try { return fs.readdirSync(path.join(dir, 'jrl')).filter(x => /\.jrl$/i.test(x)).sort(); } catch (e) { return []; } }
  // Fichiers « VENT.TOT.AAAAMMJJ » vus comme ceux de Videor (même contenu) : taille + date de modification.
  function ventes() {
    return listeJours().map(d => { const f = path.join(dir, 'jours', d, 'vent.tot'); const st = fs.statSync(f); return { nom: 'VENT.TOT.' + d, size: st.size, mtime: Math.round(st.mtimeMs), casio: true }; });
  }
  function chemin(rel) {
    const r = String(rel || '').replace(/\\/g, '/');
    if (!/^(jours\/\d{8}\/(vent\.tot|save001\.ttt)|jrl\/[A-Za-z0-9_\-]+\.jrl|TARIF\.TXT)$/i.test(r)) throw new Error('Fichier refusé');
    return path.join(dir, ...r.split('/'));
  }
  function lister(quoi) {
    if (quoi === 'jrl') return listeJrl().map(x => { const st = fs.statSync(path.join(dir, 'jrl', x)); return { nom: x, size: st.size, mtime: Math.round(st.mtimeMs) }; });
    if (quoi === 'caisses') return listeJours().filter(d => fs.existsSync(path.join(dir, 'jours', d, 'save001.ttt'))).map(d => ({ nom: 'jours/' + d + '/save001.ttt', d }));
    return ventes();
  }
  return { infos, regler, tester, copier, ventes, lister, chemin, lireEtat };
}

module.exports = { createCasio };

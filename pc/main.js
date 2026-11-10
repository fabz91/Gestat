'use strict';
// GESTAT - programme Windows : ouvre la fenêtre, lit/écrit les données sur le PC,
// gère l'export, l'import, l'impression, la mise à jour depuis GitHub et (v86) la lecture du dossier des factures.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, net, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { createCore } = require('./core');
const { createCasio } = require('./casio');

if (!app.requestSingleInstanceLock()) { app.quit(); }

const appDir = __dirname;
let cfg = {};
try { cfg = require('./config.js'); } catch (e) { cfg = {}; }
// Données : %APPDATA%\GESTAT\donnees (jamais dans le dossier du programme : une réinstallation ne les touche pas).
const dataDir = process.env.GESTAT_DATA_DIR || path.join(app.getPath('userData'), 'donnees');
const core = createCore({ bundledDir: appDir, userDir: app.getPath('userData'), dataDir, fetchFn: (u, o) => net.fetch(u, o) });

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1366, height: 860, minWidth: 900, minHeight: 600, show: false,
    title: 'GESTAT', icon: path.join(appDir, 'icon.png'), backgroundColor: '#2a2e32', autoHideMenuBar: true,
    webPreferences: { preload: path.join(appDir, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.loadFile(core.currentHtmlPath());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('page-title-updated', (e) => { e.preventDefault(); win.setTitle('GESTAT'); });
  // Ctrl+P : imprimer ; F5 : recharger ; Ctrl+Maj+I : outils de diagnostic.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const k = (input.key || '').toLowerCase();
    if (input.control && !input.shift && k === 'p') { e.preventDefault(); win.webContents.print({ printBackground: true }); }
    else if (k === 'f5') { e.preventDefault(); win.webContents.reload(); }
    else if (input.control && input.shift && k === 'i') { e.preventDefault(); win.webContents.toggleDevTools(); }
  });
}

ipcMain.on('gm:config', (e) => { e.returnValue = { updateUrl: cfg.updateUrl || '', supabaseUrl: cfg.supabaseUrl || '', supabaseKey: cfg.supabaseKey || '' }; });
ipcMain.on('gm:load', (e, name) => { try { e.returnValue = core.load(name); } catch (err) { e.returnValue = null; } });
ipcMain.on('gm:save', (e, name, text) => {
  try { e.returnValue = core.save(name, text); }
  catch (err) { e.returnValue = false; dialog.showErrorBox('GESTAT', 'Enregistrement impossible dans ' + dataDir + '\n' + err.message); }
});

// ===== Sauvegarde automatique (règle GES du 08/11/2026) =====
// Une fois par jour : UN fichier avec TOUS les magasins, au format de l'export (réimportable par Réglages → Importer).
// Rangé dans le dossier « sauvegardes » des données ; on garde les 60 derniers jours. Les anciennes copies par magasin sont retirées.
function autoBackupWrite(dir, appName, text) {
  const t = String(text || '');
  JSON.parse(t); if (t.length < 50) throw new Error('sauvegarde vide');
  const d = path.join(dir, 'sauvegardes'); fs.mkdirSync(d, { recursive: true });
  const n = new Date(), day = n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  const f = path.join(d, appName + '-' + day + '.json');
  fs.writeFileSync(f + '.tmp', t, 'utf8'); fs.renameSync(f + '.tmp', f);
  const re = new RegExp('^' + appName + '-\\d{4}-\\d{2}-\\d{2}\\.json$');
  const all = fs.readdirSync(d);
  for (const x of all) if (/\.json$/i.test(x) && !re.test(x)) { try { fs.unlinkSync(path.join(d, x)); } catch (e) {} }
  const mine = all.filter(x => re.test(x)).sort();
  while (mine.length > 60) { try { fs.unlinkSync(path.join(d, mine.shift())); } catch (e) {} }
  return f;
}
ipcMain.handle('gm:autoBackup', (e, text) => { try { return autoBackupWrite(dataDir, 'GESTAT', text); } catch (err) { return false; } });
ipcMain.handle('gm:export', async (e, text) => {
  const def = path.join(app.getPath('documents'), 'GESTAT-sauvegarde-' + new Date().toISOString().slice(0, 10) + '.json');
  const r = await dialog.showSaveDialog(win, { title: 'Exporter les données GESTAT', defaultPath: def, filters: [{ name: 'Sauvegarde GESTAT', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, text, 'utf8');
  return true;
});
ipcMain.handle('gm:import', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Importer une sauvegarde GESTAT', defaultPath: app.getPath('documents'), properties: ['openFile'], filters: [{ name: 'Sauvegarde GESTAT', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  return fs.readFileSync(r.filePaths[0], 'utf8');
});
ipcMain.handle('gm:folder', async () => { fs.mkdirSync(dataDir, { recursive: true }); return shell.openPath(dataDir); });
ipcMain.handle('gm:print', async () => new Promise((res) => win.webContents.print({ printBackground: true }, (ok) => res(ok))));
ipcMain.handle('gm:updateInfo', async () => ({ version: core.installedVersion() }));
ipcMain.handle('gm:updateCheck', async (e, url) => core.updateCheck(url || cfg.updateUrl));
ipcMain.handle('gm:updateApply', async (e, url) => {
  const r = await core.updateApply(url || cfg.updateUrl);
  if (r.status === 'done') setTimeout(() => { app.relaunch(); app.exit(0); }, 1500);
  return r;
});
ipcMain.handle('gm:updateReset', async () => {
  const c = await dialog.showMessageBox(win, { type: 'question', buttons: ['Revenir à la version d\'origine', 'Annuler'], defaultId: 1, cancelId: 1, title: 'GESTAT', message: 'Revenir à la version fournie par l\'installateur ?', detail: 'Vos données ne sont pas touchées.' });
  if (c.response !== 0) return false;
  core.updateReset(); app.relaunch(); app.exit(0); return true;
});

// v86 : factures. GESTAT lit le dossier OneDrive choisi (par ex. « OneDrive - BREDIS\Documents ») et ses PDF.
// Le dossier choisi est retenu sur ce PC (factures.json, à côté des données). Lecture seule : rien n'est modifié ni déplacé.
const facCfgPath = path.join(app.getPath('userData'), 'factures.json');
function facCfg() { try { return JSON.parse(fs.readFileSync(facCfgPath, 'utf8')) || {}; } catch (e) { return {}; } }
function facSafe(rel) {
  const root = facCfg().dossier; if (!root) throw new Error('Dossier des factures non choisi');
  const p = path.resolve(root, String(rel || '')); const r = path.resolve(root);
  if (p !== r && !p.startsWith(r + path.sep)) throw new Error('Chemin refusé'); return p;
}
ipcMain.handle('gm:facDossier', async () => facCfg().dossier || '');
ipcMain.handle('gm:facChoisir', async () => {
  const c = facCfg();
  const r = await dialog.showOpenDialog(win, { title: 'Choisir le dossier des factures (celui qui contient 2026)', defaultPath: c.dossier || app.getPath('home'), properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return '';
  c.dossier = r.filePaths[0]; fs.writeFileSync(facCfgPath, JSON.stringify(c, null, 1), 'utf8'); return c.dossier;
});
ipcMain.handle('gm:facLister', async () => {
  const root = facCfg().dossier; if (!root) return { err: 'nodir' };
  if (!fs.existsSync(root)) return { err: 'absent', root };
  const files = [], dirs = [];
  const walk = async (dir, rel, depth) => {
    if (depth > 8 || files.length > 30000) return;
    let ents = []; try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { try { const st = await fs.promises.stat(p); dirs.push({ rel: r, mtime: Math.round(st.mtimeMs) }); } catch (_) {} await walk(p, r, depth + 1); }
      else if (e.isFile()) { try { const st = await fs.promises.stat(p); files.push({ rel: r, size: st.size, mtime: Math.round(st.mtimeMs) }); } catch (_) {} }
    }
  };
  await walk(root, '', 0);
  return { root, files, dirs }; // 1.3.0 : dossiers aussi (fournisseur créé même si son dossier est vide)
});
ipcMain.handle('gm:facLire', async (e, rel) => { const b = await fs.promises.readFile(facSafe(rel)); return new Uint8Array(b.buffer, b.byteOffset, b.length); });
ipcMain.handle('gm:facOuvrir', async (e, rel) => shell.openPath(facSafe(rel)));
// v99 : CA de la caisse. Videor dépose chaque nuit la journée de la caisse dans C:\transfert\reception\001\VENT.TOT.AAAAMMJJ.
// Lecture seule. On ne renvoie que les lignes de totaux (pas le détail des articles) ; le calcul se fait dans la page.
function caDir() { return facCfg().caisse || 'C:\\transfert\\reception\\001'; }
const CA_NOM = /^VENT\.TOT\.\d{8}$/i;
ipcMain.handle('gm:caLister', async () => {
  const d = caDir(); let n = [], err = '';
  try { n = await fs.promises.readdir(d); } catch (e) { err = 'absent'; }
  const files = [], vus = new Set();
  for (const f of n) { if (!CA_NOM.test(f)) continue; try { const st = await fs.promises.stat(path.join(d, f)); if (st.isFile()) { files.push({ nom: f, size: st.size, mtime: Math.round(st.mtimeMs) }); vus.add(f.toUpperCase()); } } catch (_) {} }
  // 1.1.0 : journées copiées depuis la caisse Casio (même fichier que celui de Videor) : complètent l'historique.
  let nc = 0; try { for (const f of casio.ventes()) if (!vus.has(f.nom.toUpperCase())) { files.push(f); nc++; } } catch (_) {}
  if (err && !nc) return { dir: d, err };
  return { dir: d, files, casio: nc };
});
ipcMain.handle('gm:caLire', async (e, nom) => {
  if (!CA_NOM.test(String(nom))) throw new Error('Nom refusé');
  const t = await fs.promises.readFile(path.join(caDir(), String(nom)), 'latin1');
  return t.split(/\r?\n/).filter(l => !/^(001|054|055)\|/.test(l)).join('\n');
});
// 1.5.0 : onglet VENTE : la journée de caisse complète (rayons, familles, articles, heures…). Lecture seule.
ipcMain.handle('gm:venteLire', async (e, nom) => {
  if (!CA_NOM.test(String(nom))) throw new Error('Nom refusé');
  try { return await fs.promises.readFile(path.join(caDir(), String(nom)), 'latin1'); }
  catch (err) { const d = String(nom).slice(-8); return casio.lireJour(d, derniereVideor); } // 1.2.0 : journée de la caisse, ou historique reconstitué

});
ipcMain.handle('gm:caChoisir', async () => {
  const c = facCfg();
  const r = await dialog.showOpenDialog(win, { title: 'Dossier des journées de caisse (fichiers VENT.TOT)', defaultPath: caDir(), properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return '';
  c.caisse = r.filePaths[0]; fs.writeFileSync(facCfgPath, JSON.stringify(c, null, 1), 'utf8'); return c.caisse;
});

// 1.2.0 : la journée Videor la plus récente (noms des rayons, familles… pour l'historique reconstitué)
function derniereVideor() {
  try { const n = fs.readdirSync(caDir()).filter(f => CA_NOM.test(f)).sort(); return n.length ? fs.readFileSync(path.join(caDir(), n[n.length - 1]), 'latin1') : ''; } catch (e) { return ''; }
}
// ===== 1.1.0 : caisse Casio (ftp, LECTURE SEULE) =====
// Copie sur ce PC les journées (environ 2 ans), les journaux des tickets et le fichier des articles.
// Réglages : adresse, identifiant, mot de passe (chiffré par Windows, ne quitte jamais ce PC).
const casio = createCasio({ dataDir, safeStorage, log: (k, e) => { try { console.error(k, e); } catch (_) {} } });
function casioProg(p) { try { if (win && !win.isDestroyed()) win.webContents.send('gm:casioProg', p); } catch (e) {} }
ipcMain.handle('gm:casioInfos', async () => casio.infos());
ipcMain.handle('gm:casioRegler', async (e, o) => casio.regler(o || {}));
ipcMain.handle('gm:casioTester', async () => { try { return await casio.tester(); } catch (err) { return { ok: false, erreur: err.message || String(err) }; } });
ipcMain.handle('gm:casioCopier', async () => casio.copier(casioProg));
ipcMain.handle('gm:casioLister', async (e, quoi) => casio.lister(String(quoi || '')));
ipcMain.handle('gm:casioLire', async (e, rel) => fs.promises.readFile(casio.chemin(rel), 'latin1'));
// Copie automatique : 2 minutes après l'ouverture, puis toutes les 3 heures (seulement ce qui manque).
function casioAuto() { try { const i = casio.infos(); if (i.regle && i.actif) casio.copier(casioProg).catch(() => {}); } catch (e) {} }

// pdf.js (lecture des PDF), fourni avec le programme dans le dossier pdfjs
ipcMain.handle('gm:pdfjs', async () => ({
  lib: fs.readFileSync(path.join(appDir, 'pdfjs', 'pdf.min.mjs'), 'utf8'),
  worker: fs.readFileSync(path.join(appDir, 'pdfjs', 'pdf.worker.min.mjs'), 'utf8')
}));

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('fr.fabz91.gestat');
  Menu.setApplicationMenu(null);
  createWindow();
  setTimeout(casioAuto, 2 * 60 * 1000); setInterval(casioAuto, 3 * 60 * 60 * 1000);
});
app.on('window-all-closed', () => app.quit());

'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const cfg = ipcRenderer.sendSync('gm:config') || {};
// Même interface que le programme PC de GESTIME (window.api + window.SYNC.updateUrl).
contextBridge.exposeInMainWorld('api', {
  load: (name) => ipcRenderer.sendSync('gm:load', name),
  save: (name, text) => ipcRenderer.sendSync('gm:save', name, text),
  exportData: (text, name) => ipcRenderer.invoke('gm:export', text, name),
  importData: () => ipcRenderer.invoke('gm:import'),
  autoBackup: (text) => ipcRenderer.invoke('gm:autoBackup', text),
  openFolder: () => ipcRenderer.invoke('gm:folder'),
  print: () => ipcRenderer.invoke('gm:print'),
  updateInfo: () => ipcRenderer.invoke('gm:updateInfo'),
  updateCheck: (url) => ipcRenderer.invoke('gm:updateCheck', url),
  updateApply: (url) => ipcRenderer.invoke('gm:updateApply', url),
  updateReset: () => ipcRenderer.invoke('gm:updateReset'),
  // v86 : factures (dossier OneDrive de la comptable)
  facDossier: () => ipcRenderer.invoke('gm:facDossier'),
  facChoisir: () => ipcRenderer.invoke('gm:facChoisir'),
  facLister: () => ipcRenderer.invoke('gm:facLister'),
  facLire: (rel) => ipcRenderer.invoke('gm:facLire', rel),
  facOuvrir: (rel) => ipcRenderer.invoke('gm:facOuvrir', rel),
  pdfjs: () => ipcRenderer.invoke('gm:pdfjs'),
  // v99 : CA de la caisse (fichiers Videor)
  caLister: () => ipcRenderer.invoke('gm:caLister'),
  caLire: (nom) => ipcRenderer.invoke('gm:caLire', nom),
  caChoisir: () => ipcRenderer.invoke('gm:caChoisir'),
  venteLire: (nom) => ipcRenderer.invoke('gm:venteLire', nom)
});
contextBridge.exposeInMainWorld('SYNC', { updateUrl: cfg.updateUrl || '', url: cfg.supabaseUrl || '', key: cfg.supabaseKey || '' });

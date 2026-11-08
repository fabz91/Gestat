// ============================================================
//  GESTAT - réglages modifiables
//  (après une modification, refaites l'installateur avec CREER-INSTALLATEUR.bat)
// ============================================================
module.exports = {
  // Adresse des mises à jour (dépôt GitHub public qui contient index.html et version.json).
  // Laisser vide ('') pour désactiver le bouton « Mettre à jour le logiciel ».
  updateUrl: 'https://raw.githubusercontent.com/fabz91/Gestat/main',

  // Synchronisation entre plusieurs PC (Supabase, comme GESTIME) : mêmes valeurs que le config.js de GESTIME.
  // Ne mettez JAMAIS ici la clé « secret » ou « service_role », seulement la clé « publishable ».
  supabaseUrl: '',
  supabaseKey: ''
};

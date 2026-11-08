// Pose l'icône du logiciel sur le fichier .exe pendant la fabrication de l'installateur.
// (electron-builder ne le fait pas ici car « signAndEditExecutable » est désactivé pour éviter
// le problème de winCodeSign sous Windows.) En cas d'échec, l'installateur est quand même fabriqué.
const path = require('path');
exports.default = async function (ctx) {
  if (ctx.electronPlatformName !== 'win32') return;
  const exe = path.join(ctx.appOutDir, ctx.packager.appInfo.productFilename + '.exe');
  try {
    const m = require('rcedit'); const rcedit = m.rcedit || m.default || m;
    await rcedit(exe, { icon: path.join(__dirname, 'icon.ico') });
    console.log('  Icone posee sur ' + exe);
  } catch (e) {
    console.log('  (icone du .exe non modifiee : ' + (e.message || e) + ')');
  }
};

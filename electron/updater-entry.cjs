// SOURCE for `dist-electron/updater.cjs` (`npm run desktop:bundle`), which is what the shell
// loads. The packaged app ships no node_modules (`build.files` excludes them: the dependencies
// are the web client's and the game server's, already bundled elsewhere), so electron-updater
// and its own dependencies are bundled into that one file. This file is not packaged.
module.exports = require('electron-updater');

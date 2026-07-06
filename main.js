'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { scanLibrary, buildArtistAlbumIndex, sortAllSongs } = require('./lib/scanner');
const { Store } = require('./lib/store');

// Portable by design: settings/playlists live next to the app (this folder),
// not in the OS per-user AppData path — so copying K7Audio/ to another
// drive letter or an SD card brings the library config and playlists with it.
const store = new Store(path.join(__dirname, 'data'));

let cachedTracks = [];

function withFileUrls(tracks) {
  return tracks.map((t) => ({ ...t, fileUrl: pathToFileURL(t.filePath).href }));
}

function guessDefaultLibraryPath() {
  // Matches the documented layout: <app root>/../Files
  const guess = path.join(__dirname, '..', 'Files');
  return fs.existsSync(guess) ? guess : null;
}

async function runScan() {
  let settings = store.getSettings();

  if (settings.libraryPaths.length === 0) {
    const guess = guessDefaultLibraryPath();
    if (guess) settings = store.saveSettings({ libraryPaths: [guess] });
  }

  const { tracks, errors } = await scanLibrary(settings.libraryPaths);
  cachedTracks = withFileUrls(tracks);
  return { tracks: cachedTracks, errors, libraryPaths: settings.libraryPaths };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC: library ---

ipcMain.handle('library:scan', async () => runScan());

ipcMain.handle('library:add-folder', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return { added: false };
  const settings = store.getSettings();
  const next = [...new Set([...settings.libraryPaths, result.filePaths[0]])];
  store.saveSettings({ libraryPaths: next });
  const scan = await runScan();
  return { added: true, ...scan };
});

ipcMain.handle('library:remove-folder', async (_evt, folderPath) => {
  const settings = store.getSettings();
  store.saveSettings({ libraryPaths: settings.libraryPaths.filter((p) => p !== folderPath) });
  return runScan();
});

ipcMain.handle('library:sort-all-songs', async (_evt, mode) => {
  return sortAllSongs(cachedTracks, mode);
});

ipcMain.handle('library:artist-index', async () => {
  return buildArtistAlbumIndex(cachedTracks);
});

// --- IPC: settings ---

ipcMain.handle('settings:get', async () => store.getSettings());
ipcMain.handle('settings:save', async (_evt, patch) => store.saveSettings(patch));

// --- IPC: playlists ---

ipcMain.handle('playlists:get', async () => store.getPlaylists());
ipcMain.handle('playlists:create', async (_evt, name) => store.createPlaylist(name));
ipcMain.handle('playlists:rename', async (_evt, { id, name }) => store.renamePlaylist(id, name));
ipcMain.handle('playlists:delete', async (_evt, id) => store.deletePlaylist(id));
ipcMain.handle('playlists:addTracks', async (_evt, { id, trackIds }) => store.addTracksToPlaylist(id, trackIds));
ipcMain.handle('playlists:removeTrack', async (_evt, { id, trackId }) => store.removeTrackFromPlaylist(id, trackId));
ipcMain.handle('playlists:reorder', async (_evt, { id, trackIds }) => store.reorderPlaylist(id, trackIds));

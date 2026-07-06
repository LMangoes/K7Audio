'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { scanLibrary, buildArtistAlbumIndex, buildGenreIndex, sortAllSongs } = require('./lib/scanner');
const { Store } = require('./lib/store');

// Portable by design: settings/playlists live next to the app (this folder),
// not in the OS per-user AppData path — so copying K7Audio/ to another
// drive letter or an SD card brings the library config and playlists with it.
const store = new Store(path.join(__dirname, 'data'));

let cachedTracks = [];

function withFileUrls(tracks) {
  return tracks.map((t) => ({
    ...t,
    fileUrl: pathToFileURL(t.filePath).href,
    coverUrl: t.coverPath ? pathToFileURL(t.coverPath).href : null,
  }));
}

function withCoverUrls(playlists) {
  return playlists.map((p) => ({ ...p, coverUrl: p.coverPath ? pathToFileURL(p.coverPath).href : null }));
}

const COVERS_DIR = path.join(__dirname, 'data', 'covers');

function saveCoverForPlaylist(playlistId, sourcePath) {
  fs.mkdirSync(COVERS_DIR, { recursive: true });
  // Remove any previously saved cover for this playlist under a different
  // extension before writing the new one, so switching JPG->PNG etc. doesn't
  // leave an orphaned file behind.
  for (const existing of fs.readdirSync(COVERS_DIR)) {
    if (path.parse(existing).name === playlistId) fs.unlinkSync(path.join(COVERS_DIR, existing));
  }
  const dest = path.join(COVERS_DIR, `${playlistId}${path.extname(sourcePath).toLowerCase()}`);
  fs.copyFileSync(sourcePath, dest);
  return dest;
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

ipcMain.handle('library:genre-index', async () => {
  return buildGenreIndex(cachedTracks);
});

// --- IPC: settings ---

ipcMain.handle('settings:get', async () => store.getSettings());
ipcMain.handle('settings:save', async (_evt, patch) => store.saveSettings(patch));

// --- IPC: playlists ---

ipcMain.handle('playlists:get', async () => withCoverUrls(store.getPlaylists()));
ipcMain.handle('playlists:create', async (_evt, name) => withCoverUrls([store.createPlaylist(name)])[0]);
ipcMain.handle('playlists:rename', async (_evt, { id, name }) => store.renamePlaylist(id, name));
ipcMain.handle('playlists:delete', async (_evt, id) => store.deletePlaylist(id));
ipcMain.handle('playlists:addTracks', async (_evt, { id, trackIds }) => store.addTracksToPlaylist(id, trackIds));
ipcMain.handle('playlists:removeTrack', async (_evt, { id, trackId }) => store.removeTrackFromPlaylist(id, trackId));
ipcMain.handle('playlists:reorder', async (_evt, { id, trackIds }) => store.reorderPlaylist(id, trackIds));

ipcMain.handle('playlists:set-cover', async (_evt, id) => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const dest = saveCoverForPlaylist(id, result.filePaths[0]);
  const updated = store.setPlaylistCover(id, dest);
  return withCoverUrls([updated])[0];
});

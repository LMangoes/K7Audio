'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { scanLibrary, buildArtistAlbumIndex, buildGenreIndex, sortAllSongs } = require('./lib/scanner');
const { checkOrganization, organizeLibrary } = require('./lib/organizer');
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

function withCustomTags(tracks) {
  const customTags = store.getCustomTags();
  return tracks.map((t) => ({ ...t, customTags: customTags[t.id] || [] }));
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
  cachedTracks = withCustomTags(withFileUrls(tracks));
  saveLibraryCache(cachedTracks, settings.libraryPaths);
  return { tracks: cachedTracks, errors, libraryPaths: settings.libraryPaths };
}

const LIBRARY_CACHE_FILE = path.join(__dirname, 'data', 'library-cache.json');

function saveLibraryCache(tracks, libraryPaths) {
  try {
    fs.mkdirSync(path.dirname(LIBRARY_CACHE_FILE), { recursive: true });
    const tmp = `${LIBRARY_CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ tracks, libraryPaths }), 'utf8');
    fs.renameSync(tmp, LIBRARY_CACHE_FILE);
  } catch {
    // Not fatal — worst case, next launch just does a full rescan instead of using a cache.
  }
}

function loadLibraryCache() {
  try {
    return JSON.parse(fs.readFileSync(LIBRARY_CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** Used only for the initial load on app launch — the manual RESCAN button
 * always goes through runScan() directly, regardless of this setting. */
async function loadForLaunch() {
  const settings = store.getSettings();
  if (settings.autoRescanOnLaunch === false) {
    const cache = loadLibraryCache();
    if (cache && cache.tracks?.length > 0) {
      // Re-apply custom tags fresh even though this is a cached snapshot:
      // tags:add/tags:remove only patch the in-memory cachedTracks, they
      // don't rewrite library-cache.json. Without this overlay, a tag added
      // after the last full scan would silently revert on the next launch
      // whenever auto-rescan-on-launch is off.
      cachedTracks = withCustomTags(cache.tracks);
      return { tracks: cachedTracks, errors: [], libraryPaths: cache.libraryPaths || [] };
    }
    // No usable cache yet (first launch, or it was never written) — fall
    // through to a real scan rather than showing an empty library.
  }
  return runScan();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0c',
    icon: path.join(__dirname, 'assets', 'k7-cassette.ico'),
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
ipcMain.handle('library:launch-load', async () => loadForLaunch());

ipcMain.handle('library:pick-folder', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  return { canceled: false, path: result.filePaths[0] };
});

ipcMain.handle('library:check-organization', async (_evt, folderPath) => {
  return checkOrganization(folderPath);
});

ipcMain.handle('library:organize', async (_evt, folderPath) => {
  return organizeLibrary(folderPath);
});

ipcMain.handle('library:confirm-add-folder', async (_evt, folderPath) => {
  const settings = store.getSettings();
  const next = [...new Set([...settings.libraryPaths, folderPath])];
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

ipcMain.handle('library:sort-tracks', async (_evt, { trackIds, mode }) => {
  const byId = new Map(cachedTracks.map((t) => [t.id, t]));
  const tracks = trackIds.map((id) => byId.get(id)).filter(Boolean);
  return sortAllSongs(tracks, mode);
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
ipcMain.handle('playlists:reorder-list', async (_evt, orderedIds) => store.reorderPlaylists(orderedIds));

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

function updateCachedTrackTags(trackId) {
  const idx = cachedTracks.findIndex((t) => t.id === trackId);
  if (idx === -1) return null;
  const allCustomTags = store.getCustomTags();
  cachedTracks[idx] = { ...cachedTracks[idx], customTags: allCustomTags[trackId] || [] };
  return cachedTracks[idx];
}

/** Same as updateCachedTrackTags but for many tracks at once — reads
 * getCustomTags() a single time rather than once per track. Returns the
 * updated track objects for whichever of trackIds were actually found. */
function updateCachedTracksTags(trackIds) {
  const idSet = new Set(trackIds);
  const allCustomTags = store.getCustomTags();
  const updated = [];
  cachedTracks = cachedTracks.map((t) => {
    if (!idSet.has(t.id)) return t;
    const next = { ...t, customTags: allCustomTags[t.id] || [] };
    updated.push(next);
    return next;
  });
  return updated;
}

ipcMain.handle('tags:add', async (_evt, { trackId, tag }) => {
  store.addCustomTag(trackId, tag);
  return updateCachedTrackTags(trackId);
});

ipcMain.handle('tags:remove', async (_evt, { trackId, tag }) => {
  store.removeCustomTag(trackId, tag);
  return updateCachedTrackTags(trackId);
});

ipcMain.handle('tags:add-bulk', async (_evt, { trackIds, tag }) => {
  store.addCustomTagToTracks(trackIds, tag);
  return updateCachedTracksTags(trackIds);
});

ipcMain.handle('tags:remove-bulk', async (_evt, { trackIds, tag }) => {
  store.removeCustomTagFromTracks(trackIds, tag);
  return updateCachedTracksTags(trackIds);
});

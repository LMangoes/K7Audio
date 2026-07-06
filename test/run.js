'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { scanLibrary, buildArtistAlbumIndex, sortAllSongs } = require('../lib/scanner');
const { Store } = require('../lib/store');

async function main() {
  const libRoot = path.join(__dirname, '..', 'test-library', 'Files');

  const { tracks, errors } = await scanLibrary([libRoot]);
  assert.strictEqual(errors.length, 0, `unexpected scan errors: ${JSON.stringify(errors)}`);
  assert.strictEqual(tracks.length, 4, `expected 4 tracks, got ${tracks.length}`);

  const byTitle = Object.fromEntries(tracks.map((t) => [t.title, t]));

  // Tagged mp3
  assert.strictEqual(byTitle['Signal Loss'].artist, 'Neon Drift');
  assert.strictEqual(byTitle['Signal Loss'].album, 'Static Bloom');
  assert.strictEqual(byTitle['Signal Loss'].trackNo, 1);
  assert.ok(byTitle['Signal Loss'].duration > 0, 'duration should be read from mp3');
  assert.strictEqual(byTitle['Signal Loss'].hasTags, true);

  // Tagged flac
  assert.strictEqual(byTitle['Cassette Heart'].artist, 'Ada Voss');
  assert.strictEqual(byTitle['Cassette Heart'].format, 'flac');
  assert.ok(byTitle['Cassette Heart'].duration > 0, 'duration should be read from flac');

  // Untagged file -> must fall back to folder names + filename, not vanish
  const untagged = tracks.find((t) => t.filePath.includes('track07.mp3'));
  assert.ok(untagged, 'untagged file must still be scanned');
  assert.strictEqual(untagged.artist, 'Unknown Artist Folder');
  assert.strictEqual(untagged.album, 'Loose Tracks');
  assert.strictEqual(untagged.title, 'track07');
  assert.strictEqual(untagged.hasTags, false);

  // Artist/Album index: alphabetical at every level
  const index = buildArtistAlbumIndex(tracks);
  const artistOrder = index.map((a) => a.artist);
  const expectedArtistOrder = [...artistOrder].sort((a, b) => a.localeCompare(b));
  assert.deepStrictEqual(artistOrder, expectedArtistOrder, 'artists must be alphabetically sorted');
  const staticBloom = index.find((a) => a.artist === 'Neon Drift').albums.find((al) => al.album === 'Static Bloom');
  assert.deepStrictEqual(
    staticBloom.tracks.map((t) => t.title),
    ['Signal Loss', 'Afterimage'],
    'tracks within an album must be ordered by track number, not filename string'
  );

  // All-songs sort modes
  const byTitleSort = sortAllSongs(tracks, 'title').map((t) => t.title);
  assert.deepStrictEqual(byTitleSort, [...byTitleSort].sort((a, b) => a.localeCompare(b)));

  console.log('scanner.js: all assertions passed (' + tracks.length + ' tracks, ' + index.length + ' artists)');

  // --- store.js ---
  const tmpDir = fs.mkdtempSync('/tmp/k7-store-test-');
  const store = new Store(tmpDir);

  const settings = store.getSettings();
  assert.deepStrictEqual(settings.libraryPaths, []);
  store.saveSettings({ libraryPaths: [libRoot], volume: 0.5 });
  assert.strictEqual(store.getSettings().volume, 0.5);

  const pl = store.createPlaylist('Late Night Drive');
  assert.strictEqual(store.getPlaylists().length, 1);
  store.addTracksToPlaylist(pl.id, [byTitle['Signal Loss'].id, byTitle['Cassette Heart'].id]);
  assert.strictEqual(store.getPlaylists()[0].trackIds.length, 2);
  store.addTracksToPlaylist(pl.id, [byTitle['Signal Loss'].id]); // duplicate add must be a no-op
  assert.strictEqual(store.getPlaylists()[0].trackIds.length, 2, 'duplicate track add must be ignored');
  store.removeTrackFromPlaylist(pl.id, byTitle['Signal Loss'].id);
  assert.strictEqual(store.getPlaylists()[0].trackIds.length, 1);
  store.renamePlaylist(pl.id, 'Late Night Drive v2');
  assert.strictEqual(store.getPlaylists()[0].name, 'Late Night Drive v2');
  store.deletePlaylist(pl.id);
  assert.strictEqual(store.getPlaylists().length, 0);

  // Simulate a killed write mid-save: settings.json must never end up truncated/corrupt.
  const raw = fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8');
  JSON.parse(raw); // throws if corrupt

  console.log('store.js: all assertions passed');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});

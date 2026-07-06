'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav', '.wma']);
const COVER_NAMES = new Set(['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'album.jpg', 'album.png']);

function trackId(filePath) {
  return crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16);
}

function isAudioFile(fileName) {
  return AUDIO_EXT.has(path.extname(fileName).toLowerCase());
}

// music-metadata is ESM-only; loaded lazily via dynamic import from this CJS module.
let mmPromise = null;
function loadMM() {
  if (!mmPromise) mmPromise = import('music-metadata');
  return mmPromise;
}

/**
 * Finds a cover image next to a track: explicit cover.* file in the album folder,
 * else any single image file present in that folder.
 */
function findFolderCover(albumDir, dirEntries) {
  const named = dirEntries.find((f) => COVER_NAMES.has(f.toLowerCase()));
  if (named) return path.join(albumDir, named);
  const anyImage = dirEntries.find((f) => /\.(jpe?g|png)$/i.test(f));
  return anyImage ? path.join(albumDir, anyImage) : null;
}

/**
 * Reads embedded/folder metadata for one file. Falls back to the parent
 * two folder names (ArtistFolder/AlbumFolder) and the filename when tags
 * are missing or unreadable, so an untagged download is never dropped.
 */
async function readTrack(filePath, artistFolder, albumFolder, folderCoverPath) {
  const mm = await loadMM();
  const base = path.basename(filePath, path.extname(filePath));
  let common = {};
  let duration = 0;
  let format = path.extname(filePath).slice(1).toLowerCase();

  try {
    const meta = await mm.parseFile(filePath, { duration: true, skipCovers: true });
    common = meta.common || {};
    duration = meta.format?.duration || 0;
  } catch {
    // Corrupt tag block or unreadable header: proceed with folder-derived fallback below.
  }

  return {
    id: trackId(filePath),
    filePath,
    title: common.title || base,
    artist: common.artist || artistFolder,
    albumArtist: common.albumartist || common.artist || artistFolder,
    album: common.album || albumFolder,
    // Grouping keys for the artist/album tree and "artist-album" sort — always
    // the literal folder names, never a tag. Tags (artist/albumartist) can
    // both legally contain "maybe several artists written in a single
    // string" (music-metadata's own type docs), e.g. Picard joining features
    // as "Kyo; Alice on the roof" in one TPE1 frame. Grouping on that
    // fragments one album into one node per distinct credit line. The folder
    // is what was actually curated deliberately, so it's the only reliable key.
    groupArtist: artistFolder,
    groupAlbum: albumFolder,
    trackNo: common.track?.no ?? null,
    year: common.year ?? null,
    genre: (common.genre && common.genre[0]) || null,
    duration,
    format,
    coverPath: folderCoverPath,
    hasTags: Boolean(common.title || common.artist || common.album),
  };
}

/**
 * Scans one or more library roots laid out as Root/ArtistFolder/AlbumFolder/*.ext.
 * Files sitting directly under an ArtistFolder (no album subfolder) are grouped
 * under an "Unsorted" album for that artist rather than skipped.
 */
async function scanLibrary(rootPaths) {
  const roots = Array.isArray(rootPaths) ? rootPaths : [rootPaths];
  const tracks = [];
  const errors = [];

  for (const root of roots) {
    if (!fs.existsSync(root)) {
      errors.push({ root, error: 'path does not exist' });
      continue;
    }

    const artistFolders = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());

    for (const artistDir of artistFolders) {
      const artistPath = path.join(root, artistDir.name);
      const artistEntries = fs.readdirSync(artistPath, { withFileTypes: true });
      const albumDirs = artistEntries.filter((d) => d.isDirectory());
      const looseFiles = artistEntries.filter((d) => d.isFile() && isAudioFile(d.name));

      for (const albumDir of albumDirs) {
        const albumPath = path.join(artistPath, albumDir.name);
        const albumEntries = fs.readdirSync(albumPath);
        const cover = findFolderCover(albumPath, albumEntries);
        const audioFiles = albumEntries.filter(isAudioFile);

        for (const fileName of audioFiles) {
          const filePath = path.join(albumPath, fileName);
          try {
            tracks.push(await readTrack(filePath, artistDir.name, albumDir.name, cover));
          } catch (err) {
            errors.push({ file: filePath, error: err.message });
          }
        }
      }

      if (looseFiles.length) {
        const cover = findFolderCover(artistPath, artistEntries.filter((d) => d.isFile()).map((d) => d.name));
        for (const fileEntry of looseFiles) {
          const filePath = path.join(artistPath, fileEntry.name);
          try {
            tracks.push(await readTrack(filePath, artistDir.name, 'Unsorted', cover));
          } catch (err) {
            errors.push({ file: filePath, error: err.message });
          }
        }
      }
    }
  }

  return { tracks, errors };
}

/** Groups a flat track list into { artist -> { album -> [tracks] } }, alphabetical at every level. */
function buildArtistAlbumIndex(tracks) {
  const byArtist = new Map();
  for (const t of tracks) {
    if (!byArtist.has(t.groupArtist)) byArtist.set(t.groupArtist, new Map());
    const albums = byArtist.get(t.groupArtist);
    if (!albums.has(t.groupAlbum)) albums.set(t.groupAlbum, []);
    albums.get(t.groupAlbum).push(t);
  }

  const sortedArtists = [...byArtist.keys()].sort((a, b) => a.localeCompare(b));
  const index = [];
  for (const artist of sortedArtists) {
    const albumsMap = byArtist.get(artist);
    const sortedAlbums = [...albumsMap.keys()].sort((a, b) => a.localeCompare(b));
    const albums = sortedAlbums.map((album) => ({
      album,
      tracks: albumsMap.get(album).sort((a, b) => (a.trackNo ?? 999) - (b.trackNo ?? 999) || a.title.localeCompare(b.title)),
    }));
    index.push({ artist, albums });
  }
  return index;
}

/** Groups tracks by genre tag, alphabetical, with untagged tracks bucketed last. */
function buildGenreIndex(tracks) {
  const byGenre = new Map();
  for (const t of tracks) {
    const key = t.genre || 'UNTAGGED';
    if (!byGenre.has(key)) byGenre.set(key, []);
    byGenre.get(key).push(t);
  }

  const sortedGenres = [...byGenre.keys()].sort((a, b) => {
    if (a === 'UNTAGGED') return 1;
    if (b === 'UNTAGGED') return -1;
    return a.localeCompare(b);
  });

  return sortedGenres.map((genre) => ({
    genre,
    tracks: byGenre.get(genre).sort(
      (a, b) =>
        a.groupArtist.localeCompare(b.groupArtist) ||
        a.groupAlbum.localeCompare(b.groupAlbum) ||
        (a.trackNo ?? 999) - (b.trackNo ?? 999) ||
        a.title.localeCompare(b.title)
    ),
  }));
}

/** "All Songs" view: alphabetical by title, or grouped Artist->Album order. */
function sortAllSongs(tracks, mode = 'title') {
  const copy = [...tracks];
  if (mode === 'title') {
    return copy.sort((a, b) => a.title.localeCompare(b.title));
  }
  if (mode === 'genre') {
    return copy.sort((a, b) => {
      const ag = a.genre || '';
      const bg = b.genre || '';
      if (ag === '' && bg !== '') return 1;
      if (bg === '' && ag !== '') return -1;
      return (
        ag.localeCompare(bg) ||
        a.groupArtist.localeCompare(b.groupArtist) ||
        a.groupAlbum.localeCompare(b.groupAlbum) ||
        (a.trackNo ?? 999) - (b.trackNo ?? 999) ||
        a.title.localeCompare(b.title)
      );
    });
  }
  // artist-album mode
  return copy.sort(
    (a, b) =>
      a.groupArtist.localeCompare(b.groupArtist) ||
      a.groupAlbum.localeCompare(b.groupAlbum) ||
      (a.trackNo ?? 999) - (b.trackNo ?? 999) ||
      a.title.localeCompare(b.title)
  );
}

module.exports = { scanLibrary, buildArtistAlbumIndex, buildGenreIndex, sortAllSongs, isAudioFile, trackId };

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isAudioFile } = require('./scanner');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function isImageFile(fileName) {
  return IMAGE_EXT.has(path.extname(fileName).toLowerCase());
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function findDuplicateInDir(dir, candidateFilePath) {
  if (!fs.existsSync(dir)) return null;
  let candidateSize;
  try {
    candidateSize = fs.statSync(candidateFilePath).size;
  } catch {
    return null;
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && isAudioFile(e.name));
  const sameSize = entries
    .map((e) => path.join(dir, e.name))
    .filter((p2) => {
      try {
        return fs.statSync(p2).size === candidateSize;
      } catch {
        return false;
      }
    });
  if (sameSize.length === 0) return null;
  const candidateHash = await hashFile(candidateFilePath);
  for (const existingPath of sameSize) {
    if ((await hashFile(existingPath)) === candidateHash) return existingPath;
  }
  return null;
}

// music-metadata is ESM-only; loaded lazily via dynamic import from this CJS
// module (same pattern as lib/scanner.js).
let mmPromise = null;
function loadMM() {
  if (!mmPromise) mmPromise = import('music-metadata');
  return mmPromise;
}

/**
 * Checks whether a library root is already organised: no audio files sitting
 * loose directly in the root itself. This matters because scanLibrary only
 * ever looks inside artist subfolders — a loose root-level audio file is
 * silently invisible to the app, never scanned, never shown anywhere.
 */
function checkOrganization(rootPath) {
  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  const looseAudioFiles = entries.filter((e) => e.isFile() && isAudioFile(e.name)).map((e) => e.name);
  return { isOrganized: looseAudioFiles.length === 0, looseAudioFiles };
}

function walkFiles(rootPath, excludeDirs) {
  const results = [];
  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (excludeDirs.some((d) => path.resolve(fullPath) === path.resolve(d))) continue;
      results.push(...walkFiles(fullPath, excludeDirs));
    } else if (entry.isFile()) {
      results.push({ filePath: fullPath, parentDir: rootPath, fileName: entry.name });
    }
  }
  return results;
}

/** Strips characters Windows forbids in folder names; never returns empty. */
function sanitizeFolderName(name) {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim();
  return cleaned || 'Unknown';
}

/** Appends " (1)", " (2)", etc. if the destination already exists — a move
 * NEVER overwrites an existing file. */
function uniqueDestination(destPath) {
  if (!fs.existsSync(destPath)) return destPath;
  const dir = path.dirname(destPath);
  const ext = path.extname(destPath);
  const base = path.basename(destPath, ext);
  let n = 1;
  let candidate;
  do {
    candidate = path.join(dir, `${base} (${n})${ext}`);
    n += 1;
  } while (fs.existsSync(candidate));
  return candidate;
}

/** Moves a file, never overwriting. Falls back to copy+unlink if a plain
 * rename fails (e.g. cross-device) — the source is only removed after the
 * copy succeeds, so a mid-operation failure never loses the original. */
function safeMove(source, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const finalDest = uniqueDestination(dest);
  try {
    fs.renameSync(source, finalDest);
  } catch {
    fs.copyFileSync(source, finalDest);
    fs.unlinkSync(source);
  }
  return finalDest;
}

function recordDestination(map, sourceDir, destDir) {
  if (!map.has(sourceDir)) map.set(sourceDir, new Set());
  map.get(sourceDir).add(destDir);
}

/** Removes empty directories under rootPath bottom-up (never rootPath itself).
 * Returns the removed paths. Symlinked dirs are not followed. */
function pruneEmptyDirs(rootPath) {
  const removed = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      walk(full);
      try {
        if (fs.readdirSync(full).length === 0) {
          fs.rmdirSync(full);
          removed.push(full);
        }
      } catch {
        // Not fatal — a locked/permissioned folder just stays.
      }
    }
  };
  walk(rootPath);
  return removed;
}

const normKey = (str) => String(str).trim().toLowerCase();

/**
 * Decides the top-level (artist) folder for each tagged record, prioritising
 * the album over the individual track artist so multi-artist albums (cast
 * recordings, collabs, compilations) land in ONE folder:
 *   1. an explicit Album Artist tag wins;
 *   2. else the compilation flag -> the album itself acts as the artist folder
 *      (Root/<Album>/<Album>/);
 *   3. else, if tracks sharing an album name have different artists, treat the
 *      album as a multi-artist album and file it the same way (album-named
 *      folder in the root) — but only when every track
 *      has a track number and no (disc, track) number repeats. A repeat means
 *      two unrelated albums that merely share a name (e.g. "Greatest Hits"),
 *      which must stay split by artist;
 *   4. else the track artist.
 * Mutates each record, setting folderArtist.
 */
function assignFolderArtists(records) {
  const inferable = [];
  for (const r of records) {
    if (r.albumArtist) r.folderArtist = r.albumArtist;
    else if (r.compilation) r.folderArtist = r.album;
    else inferable.push(r);
  }

  const byAlbum = new Map();
  for (const r of inferable) {
    const key = normKey(r.album);
    if (!byAlbum.has(key)) byAlbum.set(key, []);
    byAlbum.get(key).push(r);
  }

  for (const group of byAlbum.values()) {
    const artists = new Set(group.map((r) => normKey(r.artist)));
    let merge = false;
    if (artists.size > 1 && group.every((r) => r.trackNo)) {
      const seen = new Set(group.map((r) => `${r.discNo || 1}-${r.trackNo}`));
      merge = seen.size === group.length;
    }
    for (const r of group) r.folderArtist = merge ? r.album : r.artist;
  }
}

/**
 * Legacy cleanup: dissolves Root/Various Artists/<Album>/ by moving each album
 * to Root/<Album>/<Album>/ (no tag reading — the folder name is the album).
 * Files sitting loose directly inside "Various Artists" are left alone, so the
 * folder only survives when it holds something with no album. Never overwrites.
 * Returns [{ from, to }] for every moved file.
 */
function dissolveVariousArtists(rootPath) {
  const vaDir = path.join(rootPath, 'Various Artists');
  const moved = [];
  if (!fs.existsSync(vaDir)) return moved;
  for (const album of fs.readdirSync(vaDir, { withFileTypes: true })) {
    if (!album.isDirectory()) continue;
    const albumSrc = path.join(vaDir, album.name);
    const destDir = path.join(rootPath, album.name, album.name);
    for (const f of walkFiles(albumSrc, [])) {
      const to = safeMove(f.filePath, path.join(destDir, path.relative(albumSrc, f.filePath)));
      moved.push({ from: f.filePath, to });
    }
  }
  pruneEmptyDirs(rootPath);
  return moved;
}

/**
 * Reorganizes rootPath into Root/Artist/Album/track.ext based on ID3/Vorbis
 * tags (multi-artist albums go to Root/<Album>/<Album>/ — see
 * assignFolderArtists). Empty folders left behind are removed. Never deletes anything: files it can't confidently place (missing
 * tags, unreadable, not audio) are moved into Root/unsupported/ instead of
 * being left scattered or discarded. Idempotent — a file already at its
 * correct destination is left untouched, and re-running on an
 * already-organized folder is a no-op.
 */
async function organizeLibrary(rootPath) {
  const mm = await loadMM();
  const unsupportedDir = path.join(rootPath, 'unsupported');
  const duplicatesDir = path.join(rootPath, 'duplicates');
  const files = walkFiles(rootPath, [unsupportedDir, duplicatesDir]);

  const audioFiles = files.filter((f) => isAudioFile(f.fileName));
  const imageFiles = files.filter((f) => isImageFile(f.fileName));
  const otherFiles = files.filter((f) => !isAudioFile(f.fileName) && !isImageFile(f.fileName));

  const moved = [];
  const unsupported = [];
  const duplicates = [];
  const errors = [];
  // Which destination album folder(s) audio files from a given source
  // directory ended up in — used to decide where a sibling cover image goes.
  const destinationsByDir = new Map();

  // Pass 1: read tags for every file. Pass 2 needs the whole set because
  // album-level decisions (multi-artist albums) can't be made per file.
  const records = [];
  for (const file of audioFiles) {
    const rec = { file, artist: null, album: null, albumArtist: null, compilation: false, trackNo: null, discNo: null };
    try {
      const meta = await mm.parseFile(file.filePath, { duration: false, skipCovers: true });
      const c = meta.common || {};
      rec.artist = c.artist || null;
      rec.album = c.album || null;
      rec.albumArtist = c.albumartist || null;
      rec.compilation = Boolean(c.compilation);
      rec.trackNo = c.track?.no || null;
      rec.discNo = c.disk?.no || null;
    } catch (err) {
      errors.push({ file: file.filePath, error: err.message });
    }
    records.push(rec);
  }

  const placeable = [];
  for (const rec of records) {
    if (!rec.album || !(rec.artist || rec.albumArtist)) {
      const dest = safeMove(rec.file.filePath, path.join(unsupportedDir, rec.file.fileName));
      unsupported.push({ from: rec.file.filePath, to: dest, reason: 'missing artist/album tag' });
    } else {
      placeable.push(rec);
    }
  }
  assignFolderArtists(placeable);

  for (const rec of placeable) {
    const { file, album } = rec;
    const artist = rec.folderArtist;
    const destDir = path.join(rootPath, sanitizeFolderName(artist), sanitizeFolderName(album));
    const destPath = path.join(destDir, file.fileName);

    if (path.resolve(file.filePath) === path.resolve(destPath)) {
      recordDestination(destinationsByDir, file.parentDir, destDir);
      continue;
    }

    let duplicateOf = null;
    try {
      duplicateOf = await findDuplicateInDir(destDir, file.filePath);
    } catch (err) {
      errors.push({ file: file.filePath, error: `duplicate check failed: ${err.message}` });
    }

    if (duplicateOf) {
      const dupDestDir = path.join(duplicatesDir, sanitizeFolderName(artist), sanitizeFolderName(album));
      const dupDest = safeMove(file.filePath, path.join(dupDestDir, file.fileName));
      duplicates.push({ from: file.filePath, to: dupDest, duplicateOf });
      continue;
    }

    try {
      const finalDest = safeMove(file.filePath, destPath);
      moved.push({ from: file.filePath, to: finalDest });
      recordDestination(destinationsByDir, file.parentDir, destDir);
    } catch (err) {
      errors.push({ file: file.filePath, error: err.message });
    }
  }

  for (const file of imageFiles) {
    const destDirs = destinationsByDir.get(file.parentDir);
    if (destDirs && destDirs.size === 1) {
      const destDir = [...destDirs][0];
      const destPath = path.join(destDir, file.fileName);
      if (path.resolve(file.filePath) === path.resolve(destPath)) continue;
      try {
        const finalDest = safeMove(file.filePath, destPath);
        moved.push({ from: file.filePath, to: finalDest });
      } catch (err) {
        errors.push({ file: file.filePath, error: err.message });
      }
    } else {
      const dest = safeMove(file.filePath, path.join(unsupportedDir, file.fileName));
      unsupported.push({
        from: file.filePath,
        to: dest,
        reason: destDirs ? 'ambiguous album for cover art' : 'no associated audio files',
      });
    }
  }

  for (const file of otherFiles) {
    const dest = safeMove(file.filePath, path.join(unsupportedDir, file.fileName));
    unsupported.push({ from: file.filePath, to: dest, reason: 'not an audio or image file' });
  }

  const removedFolders = pruneEmptyDirs(rootPath);

  return {
    moved,
    removedFolders,
    unsupported,
    duplicates,
    errors,
    unsupportedDir: fs.existsSync(unsupportedDir) ? unsupportedDir : null,
    duplicatesDir: duplicates.length > 0 ? duplicatesDir : null,
  };
}

module.exports = { checkOrganization, organizeLibrary, isImageFile, assignFolderArtists, dissolveVariousArtists };

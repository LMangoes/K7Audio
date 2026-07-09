'use strict';

const fs = require('fs');
const path = require('path');
const { isAudioFile } = require('./scanner');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function isImageFile(fileName) {
  return IMAGE_EXT.has(path.extname(fileName).toLowerCase());
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

/**
 * Reorganizes rootPath into Root/Artist/Album/track.ext based on ID3/Vorbis
 * tags. Never deletes anything: files it can't confidently place (missing
 * tags, unreadable, not audio) are moved into Root/unsupported/ instead of
 * being left scattered or discarded. Idempotent — a file already at its
 * correct destination is left untouched, and re-running on an
 * already-organized folder is a no-op.
 */
async function organizeLibrary(rootPath) {
  const mm = await loadMM();
  const unsupportedDir = path.join(rootPath, 'unsupported');
  const files = walkFiles(rootPath, [unsupportedDir]);

  const audioFiles = files.filter((f) => isAudioFile(f.fileName));
  const imageFiles = files.filter((f) => isImageFile(f.fileName));
  const otherFiles = files.filter((f) => !isAudioFile(f.fileName) && !isImageFile(f.fileName));

  const moved = [];
  const unsupported = [];
  const errors = [];
  // Which destination album folder(s) audio files from a given source
  // directory ended up in — used to decide where a sibling cover image goes.
  const destinationsByDir = new Map();

  for (const file of audioFiles) {
    let artist = null;
    let album = null;
    try {
      const meta = await mm.parseFile(file.filePath, { duration: false, skipCovers: true });
      artist = meta.common?.artist || null;
      album = meta.common?.album || null;
    } catch (err) {
      errors.push({ file: file.filePath, error: err.message });
    }

    if (!artist || !album) {
      const dest = safeMove(file.filePath, path.join(unsupportedDir, file.fileName));
      unsupported.push({ from: file.filePath, to: dest, reason: 'missing artist/album tag' });
      continue;
    }

    const destDir = path.join(rootPath, sanitizeFolderName(artist), sanitizeFolderName(album));
    const destPath = path.join(destDir, file.fileName);

    if (path.resolve(file.filePath) === path.resolve(destPath)) {
      recordDestination(destinationsByDir, file.parentDir, destDir);
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

  return { moved, unsupported, errors, unsupportedDir: unsupported.length > 0 ? unsupportedDir : null };
}

module.exports = { checkOrganization, organizeLibrary, isImageFile };

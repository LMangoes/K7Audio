'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  libraryPaths: [],
  volume: 0.8,
  shuffle: false,
  repeat: 'off', // off | all | one
  allSongsSort: 'artist-album', // artist-album | title | genre
  lastPlayback: null, // { trackId, position } | null — restored paused on launch
  autoRescanOnLaunch: true,
};

// Fixed, well-known ID rather than a random UUID: the app needs to find this
// specific playlist reliably (pin it in the sidebar, exclude it from the
// regular playlist list, protect it from deletion) without a separate flag.
const FAVOURITES_ID = 'favourites';

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.playlistsFile = path.join(dataDir, 'playlists.json');
    this.customTagsFile = path.join(dataDir, 'custom-tags.json');
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(this.settingsFile)) this._write(this.settingsFile, DEFAULT_SETTINGS);
    if (!fs.existsSync(this.playlistsFile)) this._write(this.playlistsFile, []);
    if (!fs.existsSync(this.customTagsFile)) this._write(this.customTagsFile, {});
    this._ensureFavouritesPlaylist();
  }

  _read(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  _write(file, data) {
    // Write to a temp file then rename: avoids a truncated/corrupt JSON file
    // if the process is killed mid-write (e.g. Windows update, power loss).
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  getSettings() {
    return { ...DEFAULT_SETTINGS, ...this._read(this.settingsFile, {}) };
  }

  saveSettings(patch) {
    const merged = { ...this.getSettings(), ...patch };
    this._write(this.settingsFile, merged);
    return merged;
  }

  getPlaylists() {
    return this._read(this.playlistsFile, []);
  }

  savePlaylists(playlists) {
    this._write(this.playlistsFile, playlists);
    return playlists;
  }

  createPlaylist(name) {
    const playlists = this.getPlaylists();
    const playlist = { id: crypto.randomUUID(), name, trackIds: [], coverPath: null, createdAt: Date.now() };
    playlists.push(playlist);
    this.savePlaylists(playlists);
    return playlist;
  }

  setPlaylistCover(id, coverPath) {
    const playlists = this.getPlaylists();
    const p = playlists.find((pl) => pl.id === id);
    if (!p) throw new Error(`playlist ${id} not found`);
    p.coverPath = coverPath; // null clears it
    this.savePlaylists(playlists);
    return p;
  }

  renamePlaylist(id, name) {
    if (id === FAVOURITES_ID) throw new Error('cannot rename the Favourites playlist');
    const playlists = this.getPlaylists();
    const p = playlists.find((pl) => pl.id === id);
    if (!p) throw new Error(`playlist ${id} not found`);
    p.name = name;
    this.savePlaylists(playlists);
    return p;
  }

  _ensureFavouritesPlaylist() {
    const playlists = this.getPlaylists();
    if (!playlists.find((pl) => pl.id === FAVOURITES_ID)) {
      playlists.push({ id: FAVOURITES_ID, name: 'Favourites', trackIds: [], coverPath: null, createdAt: Date.now(), system: true });
      this.savePlaylists(playlists);
    }
  }

  deletePlaylist(id) {
    if (id === FAVOURITES_ID) throw new Error('cannot delete the Favourites playlist');
    const playlists = this.getPlaylists().filter((pl) => pl.id !== id);
    this.savePlaylists(playlists);
  }

  addTracksToPlaylist(id, trackIds) {
    const playlists = this.getPlaylists();
    const p = playlists.find((pl) => pl.id === id);
    if (!p) throw new Error(`playlist ${id} not found`);
    for (const tid of trackIds) if (!p.trackIds.includes(tid)) p.trackIds.push(tid);
    this.savePlaylists(playlists);
    return p;
  }

  removeTrackFromPlaylist(id, trackId) {
    const playlists = this.getPlaylists();
    const p = playlists.find((pl) => pl.id === id);
    if (!p) throw new Error(`playlist ${id} not found`);
    p.trackIds = p.trackIds.filter((t) => t !== trackId);
    this.savePlaylists(playlists);
    return p;
  }

  reorderPlaylist(id, orderedTrackIds) {
    const playlists = this.getPlaylists();
    const p = playlists.find((pl) => pl.id === id);
    if (!p) throw new Error(`playlist ${id} not found`);
    p.trackIds = orderedTrackIds;
    this.savePlaylists(playlists);
    return p;
  }

  reorderPlaylists(orderedIds) {
    const playlists = this.getPlaylists();
    const byId = new Map(playlists.map((p) => [p.id, p]));
    const reordered = [];
    for (const id of orderedIds) {
      if (byId.has(id)) {
        reordered.push(byId.get(id));
        byId.delete(id);
      }
    }
    // Anything not mentioned (e.g. Favourites, which the sidebar never
    // includes in a reorder request) keeps its existing relative order,
    // appended after the explicitly reordered ones.
    const remainder = playlists.filter((p) => byId.has(p.id));
    const result = [...reordered, ...remainder];
    this.savePlaylists(result);
    return result;
  }

  getCustomTags() {
    return this._read(this.customTagsFile, {});
  }

  addCustomTag(trackId, tag) {
    const cleaned = tag.trim();
    const tags = this.getCustomTags();
    if (!cleaned) return tags[trackId] || [];
    if (!tags[trackId]) tags[trackId] = [];
    if (!tags[trackId].includes(cleaned)) tags[trackId].push(cleaned);
    this._write(this.customTagsFile, tags);
    return tags[trackId];
  }

  /** Applies one tag to many tracks in a single file write — used for
   * tagging an entire artist/album folder at once, rather than looping
   * addCustomTag per track (which would be one read+write per track). */
  addCustomTagToTracks(trackIds, tag) {
    const cleaned = tag.trim();
    const tags = this.getCustomTags();
    if (!cleaned) return tags;
    for (const trackId of trackIds) {
      if (!tags[trackId]) tags[trackId] = [];
      if (!tags[trackId].includes(cleaned)) tags[trackId].push(cleaned);
    }
    this._write(this.customTagsFile, tags);
    return tags;
  }

  removeCustomTag(trackId, tag) {
    const tags = this.getCustomTags();
    if (tags[trackId]) {
      tags[trackId] = tags[trackId].filter((t) => t !== tag);
      if (tags[trackId].length === 0) delete tags[trackId];
    }
    this._write(this.customTagsFile, tags);
    return tags[trackId] || [];
  }
}

module.exports = { Store, DEFAULT_SETTINGS, FAVOURITES_ID };

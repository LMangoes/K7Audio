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
};

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.playlistsFile = path.join(dataDir, 'playlists.json');
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(this.settingsFile)) this._write(this.settingsFile, DEFAULT_SETTINGS);
    if (!fs.existsSync(this.playlistsFile)) this._write(this.playlistsFile, []);
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
    const playlists = this.getPlaylists();
    const p = playlists.find((pl) => pl.id === id);
    if (!p) throw new Error(`playlist ${id} not found`);
    p.name = name;
    this.savePlaylists(playlists);
    return p;
  }

  deletePlaylist(id) {
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
}

module.exports = { Store, DEFAULT_SETTINGS };

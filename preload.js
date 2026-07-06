'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('k7', {
  scanLibrary: () => ipcRenderer.invoke('library:scan'),
  addLibraryFolder: () => ipcRenderer.invoke('library:add-folder'),
  removeLibraryFolder: (folderPath) => ipcRenderer.invoke('library:remove-folder', folderPath),
  sortAllSongs: (mode) => ipcRenderer.invoke('library:sort-all-songs', mode),
  getArtistIndex: () => ipcRenderer.invoke('library:artist-index'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),

  getPlaylists: () => ipcRenderer.invoke('playlists:get'),
  createPlaylist: (name) => ipcRenderer.invoke('playlists:create', name),
  renamePlaylist: (id, name) => ipcRenderer.invoke('playlists:rename', { id, name }),
  deletePlaylist: (id) => ipcRenderer.invoke('playlists:delete', id),
  addTracksToPlaylist: (id, trackIds) => ipcRenderer.invoke('playlists:addTracks', { id, trackIds }),
  removeTrackFromPlaylist: (id, trackId) => ipcRenderer.invoke('playlists:removeTrack', { id, trackId }),
  reorderPlaylist: (id, trackIds) => ipcRenderer.invoke('playlists:reorder', { id, trackIds }),
});

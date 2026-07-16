'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('k7', {
  scanLibrary: () => ipcRenderer.invoke('library:scan'),
  launchLoad: () => ipcRenderer.invoke('library:launch-load'),
  pickLibraryFolder: () => ipcRenderer.invoke('library:pick-folder'),
  checkOrganization: (folderPath) => ipcRenderer.invoke('library:check-organization', folderPath),
  organizeLibrary: (folderPath) => ipcRenderer.invoke('library:organize', folderPath),
  confirmAddFolder: (folderPath) => ipcRenderer.invoke('library:confirm-add-folder', folderPath),
  removeLibraryFolder: (folderPath) => ipcRenderer.invoke('library:remove-folder', folderPath),
  sortAllSongs: (mode) => ipcRenderer.invoke('library:sort-all-songs', mode),
  sortTracks: (trackIds, mode) => ipcRenderer.invoke('library:sort-tracks', { trackIds, mode }),
  getArtistIndex: () => ipcRenderer.invoke('library:artist-index'),
  getGenreIndex: () => ipcRenderer.invoke('library:genre-index'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),

  getPlaylists: () => ipcRenderer.invoke('playlists:get'),
  createPlaylist: (name) => ipcRenderer.invoke('playlists:create', name),
  renamePlaylist: (id, name) => ipcRenderer.invoke('playlists:rename', { id, name }),
  deletePlaylist: (id) => ipcRenderer.invoke('playlists:delete', id),
  addTracksToPlaylist: (id, trackIds) => ipcRenderer.invoke('playlists:addTracks', { id, trackIds }),
  removeTrackFromPlaylist: (id, trackId) => ipcRenderer.invoke('playlists:removeTrack', { id, trackId }),
  reorderPlaylist: (id, trackIds) => ipcRenderer.invoke('playlists:reorder', { id, trackIds }),
  reorderPlaylists: (orderedIds) => ipcRenderer.invoke('playlists:reorder-list', orderedIds),
  setPlaylistCover: (id) => ipcRenderer.invoke('playlists:set-cover', id),
  addCustomTag: (trackId, tag) => ipcRenderer.invoke('tags:add', { trackId, tag }),
  removeCustomTag: (trackId, tag) => ipcRenderer.invoke('tags:remove', { trackId, tag }),
  addCustomTagToTracks: (trackIds, tag) => ipcRenderer.invoke('tags:add-bulk', { trackIds, tag }),
  removeCustomTagFromTracks: (trackIds, tag) => ipcRenderer.invoke('tags:remove-bulk', { trackIds, tag }),
});

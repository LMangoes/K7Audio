'use strict';

// Must match lib/store.js's FAVOURITES_ID — the renderer can't import that
// Node module directly (sandboxed, no require), so it's duplicated here as a
// stable literal rather than round-tripped through IPC on every reference.
const FAVOURITES_PLAYLIST_ID = 'favourites';

(() => {
  const state = {
    allTracks: [],
    tracksById: new Map(),
    playlists: [],
    settings: null,
    view: { type: 'all' }, // {type:'all'} | {type:'artists'} | {type:'playlist', id}
    activeQueueView: null, // view that produced player's current queue — frozen at queue-set time, not re-read later
    search: '',
    sortMode: 'artist-album',
  };

  const el = {
    viewTitle: document.getElementById('view-title'),
    viewRoot: document.getElementById('view-root'),
    searchInput: document.getElementById('search-input'),
    searchClear: document.getElementById('search-clear'),
    sortSelect: document.getElementById('sort-select'),
    playlistList: document.getElementById('playlist-list'),
    libraryPaths: document.getElementById('library-paths'),
    scanStatus: document.getElementById('scan-status'),
    modalRoot: document.getElementById('modal-root'),
    toastRoot: document.getElementById('toast-root'),
    nowTitle: document.getElementById('now-title'),
    nowArtist: document.getElementById('now-artist'),
    nowSource: document.getElementById('now-source'),
    nowFavBtn: document.getElementById('now-fav-btn'),
    reels: document.getElementById('reels'),
    btnPlayPause: document.getElementById('btn-playpause'),
    btnShuffle: document.getElementById('btn-shuffle'),
    btnRepeat: document.getElementById('btn-repeat'),
    seekLed: document.getElementById('seek-led'),
    seekFill: document.getElementById('seek-led-fill'),
    seekRange: document.getElementById('seek-range'),
    timeCurrent: document.getElementById('time-current'),
    timeTotal: document.getElementById('time-total'),
    volumeRange: document.getElementById('volume-range'),
    volumeFill: document.getElementById('volume-led-fill'),
    volValue: document.getElementById('vol-value'),
  };

  const audioEl = document.getElementById('audio-el');
  const player = new K7Player(audioEl);
  new K7Visualizer(document.getElementById('visualizer-canvas'), player);
  let seekDragging = false;

  function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function matchesSearch(track, q) {
    if (!q) return true;
    const hay = `${track.title} ${track.artist} ${track.album} ${track.genre || ''}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const PLACEHOLDER_COVER_SVG = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <rect width="100" height="100" rx="14" fill="#111318"/>
    <circle cx="34" cy="46" r="14" fill="none" stroke="#3dff8f" stroke-width="4"/>
    <circle cx="66" cy="46" r="14" fill="none" stroke="#ff2fb0" stroke-width="4"/>
    <circle cx="34" cy="46" r="5" fill="#3dff8f"/>
    <circle cx="66" cy="46" r="5" fill="#ff2fb0"/>
    <rect x="14" y="72" width="72" height="6" rx="3" fill="#ff2fb0"/>
  </svg>`;

  const PLACEHOLDER_HEART_SVG = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <rect width="100" height="100" rx="14" fill="#111318"/>
    <path d="M50 78 L24 52 C12 40 12 22 26 16 C36 12 46 17 50 27 C54 17 64 12 74 16 C88 22 88 40 76 52 Z" fill="#ff2fb0"/>
  </svg>`;

  /** Cover priority: explicit playlist cover -> first track's folder art (or,
   * for Favourites, a fixed heart identity instead — see resolvePlaylistCover)
   * -> generic placeholder. */
  function makeCoverEl(coverUrl, sizeClass, placeholder = 'cassette') {
    const wrap = document.createElement('div');
    wrap.className = `cover-thumb ${sizeClass}`;
    if (coverUrl) {
      const img = document.createElement('img');
      img.src = coverUrl;
      img.alt = '';
      wrap.appendChild(img);
    } else {
      wrap.innerHTML = placeholder === 'heart' ? PLACEHOLDER_HEART_SVG : PLACEHOLDER_COVER_SVG;
    }
    return wrap;
  }

  function resolvePlaylistCover(pl) {
    if (pl.coverUrl) return pl.coverUrl;
    // Favourites gets a stable heart identity rather than borrowing whichever
    // track happens to be first — that would change unpredictably as tracks
    // are favourited/unfavourited, unlike a normal playlist's cover.
    if (pl.id === FAVOURITES_PLAYLIST_ID) return null;
    const firstTrack = pl.trackIds.map((id) => state.tracksById.get(id)).find((t) => t?.coverUrl);
    return firstTrack ? firstTrack.coverUrl : null;
  }

  // ---------- Data loading ----------

  async function loadAll() {
    state.settings = await window.k7.getSettings();
    state.sortMode = state.settings.allSongsSort || 'artist-album';
    el.sortSelect.value = state.sortMode;
    el.volumeRange.value = Math.round((state.settings.volume ?? 0.8) * 100);
    el.volumeFill.style.width = `${el.volumeRange.value}%`;
    el.volValue.textContent = el.volumeRange.value;
    player.setVolume(state.settings.volume ?? 0.8);
    player.setShuffle(Boolean(state.settings.shuffle));
    player.setRepeat(state.settings.repeat || 'off');
    updateShuffleRepeatUI();

    await loadLibraryForLaunch();
    state.playlists = await window.k7.getPlaylists();
    renderLibraryPaths();
    renderPlaylistSidebar();
    renderCurrentView();

    const last = state.settings.lastPlayback;
    if (last?.trackId) {
      const track = state.tracksById.get(last.trackId);
      if (track) {
        const view = last.view || { type: 'all' };
        const tracks = await resolveViewTracks(view);
        const idx = tracks.findIndex((t) => t.id === track.id);
        if (idx >= 0) {
          setActiveQueueView(view);
          player.setQueue(tracks, idx, false);
        } else {
          // Saved context no longer contains this track (e.g. removed from
          // the playlist since) — fall back to just the track itself rather
          // than dropping the restore entirely.
          setActiveQueueView({ type: 'all' });
          player.setQueue([track], 0, false);
        }
        player.seekOnceLoaded(last.position || 0);
      }
    }
  }

  async function rescan() {
    el.scanStatus.textContent = 'SCANNING...';
    el.scanStatus.classList.remove('error');
    try {
      applyScanData(await window.k7.scanLibrary());
    } catch (err) {
      el.scanStatus.textContent = 'SCAN FAILED';
      el.scanStatus.classList.add('error');
      console.error(err);
    }
  }

  // Used only for the initial load on app launch — respects the
  // autoRescanOnLaunch setting (main process falls back to a cached
  // snapshot instead of a full filesystem scan). The manual RESCAN button
  // always goes through rescan() above, unconditionally.
  async function loadLibraryForLaunch() {
    el.scanStatus.textContent = 'LOADING...';
    el.scanStatus.classList.remove('error');
    try {
      applyScanData(await window.k7.launchLoad());
    } catch (err) {
      el.scanStatus.textContent = 'LOAD FAILED';
      el.scanStatus.classList.add('error');
      console.error(err);
    }
  }

  function applyScanData({ tracks, errors, libraryPaths }) {
    state.allTracks = tracks;
    state.tracksById = new Map(tracks.map((t) => [t.id, t]));
    state.settings.libraryPaths = libraryPaths;
    el.scanStatus.textContent = `${tracks.length} TRACKS INDEXED`;
    if (errors && errors.length) {
      el.scanStatus.textContent += ` · ${errors.length} ERRORS`;
      el.scanStatus.classList.add('error');
    }
    if (tracks.length === 0) {
      el.scanStatus.textContent = 'NO LIBRARY FOLDER SET';
    }
    renderLibraryPaths();
  }

  // ---------- Sidebar ----------

  function renderLibraryPaths() {
    el.libraryPaths.innerHTML = '';
    const paths = state.settings?.libraryPaths || [];
    if (paths.length === 0) {
      const row = document.createElement('div');
      row.className = 'library-path-row';
      row.textContent = 'none set';
      el.libraryPaths.appendChild(row);
      return;
    }
    for (const p of paths) {
      const row = document.createElement('div');
      row.className = 'library-path-row';
      const label = document.createElement('span');
      label.textContent = p;
      label.title = p;
      const btn = document.createElement('button');
      btn.textContent = '×';
      btn.title = 'Remove folder';
      btn.addEventListener('click', async () => {
        const result = await window.k7.removeLibraryFolder(p);
        applyScanData(result);
        renderCurrentView();
      });
      row.append(label, btn);
      el.libraryPaths.appendChild(row);
    }
  }

  function renderPlaylistSidebar() {
    el.playlistList.innerHTML = '';
    const userPlaylists = state.playlists.filter((p) => p.id !== FAVOURITES_PLAYLIST_ID);
    for (const pl of userPlaylists) {
      const item = document.createElement('div');
      item.className = 'playlist-item';
      item.draggable = true;
      item.dataset.playlistId = pl.id;
      if (state.view.type === 'playlist' && state.view.id === pl.id) item.classList.add('active');
      if (state.activeQueueView?.type === 'playlist' && state.activeQueueView.id === pl.id) item.classList.add('playing-from');

      const cover = makeCoverEl(resolvePlaylistCover(pl), 'cover-xs', pl.id === FAVOURITES_PLAYLIST_ID ? 'heart' : 'cassette');
      const label = document.createElement('span');
      label.className = 'playlist-item-label';
      label.textContent = pl.name;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = pl.trackIds.length;
      const playBtn = document.createElement('button');
      playBtn.className = 'playlist-play-btn';
      playBtn.textContent = '►';
      playBtn.title = `Play ${pl.name}`;
      playBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const alreadyPlayingThis = viewsMatch(state.activeQueueView, { type: 'playlist', id: pl.id });
        if (alreadyPlayingThis && player.currentTrack()) {
          // Already the active queue — just ensure it's playing, picking up
          // from wherever it's paused, like a normal resume. A dedicated
          // play button should never double as a pause toggle.
          player.play();
          return;
        }
        const tracks = await window.k7.sortTracks(pl.trackIds, state.sortMode);
        startFreshQueue(tracks, { type: 'playlist', id: pl.id });
      });

      const del = document.createElement('button');
      del.className = 'del-btn';
      del.textContent = '×';
      del.title = 'Delete playlist';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        openConfirmModal(`Delete playlist "${pl.name}"? This cannot be undone.`, async () => {
          await window.k7.deletePlaylist(pl.id);
          state.playlists = await window.k7.getPlaylists();
          if (state.view.type === 'playlist' && state.view.id === pl.id) switchView({ type: 'all' });
          else renderPlaylistSidebar();
        });
      });

      item.append(cover, label, count, playBtn, del);
      item.addEventListener('click', () => switchView({ type: 'playlist', id: pl.id }));
      wireDragReorder(item, pl.id);
      el.playlistList.appendChild(item);
    }
    updateNowFavButton();
  }

  /** Keeps the heart button next to the now-playing track in sync with
   * Favourites membership. Called from renderPlaylistSidebar() rather than
   * separately at every place favourite status can change (Song Options,
   * bulk options, this button itself) — one place, can't go stale. */
  function updateNowFavButton() {
    const track = player.currentTrack();
    if (!track) {
      el.nowFavBtn.textContent = '♡';
      el.nowFavBtn.classList.remove('active');
      el.nowFavBtn.disabled = true;
      return;
    }
    el.nowFavBtn.disabled = false;
    const favPlaylist = state.playlists.find((p) => p.id === FAVOURITES_PLAYLIST_ID);
    const isFav = favPlaylist ? favPlaylist.trackIds.includes(track.id) : false;
    el.nowFavBtn.textContent = isFav ? '♥' : '♡';
    el.nowFavBtn.classList.toggle('active', isFav);
  }

  let dragSourceId = null;

  function wireDragReorder(item, playlistId) {
    item.addEventListener('dragstart', (e) => {
      dragSourceId = playlistId;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      document.querySelectorAll('.playlist-item.drag-over-top, .playlist-item.drag-over-bottom').forEach((el2) => {
        el2.classList.remove('drag-over-top', 'drag-over-bottom');
      });
    });
    item.addEventListener('dragover', (e) => {
      if (!dragSourceId || dragSourceId === playlistId) return;
      e.preventDefault();
      const rect = item.getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      item.classList.toggle('drag-over-top', before);
      item.classList.toggle('drag-over-bottom', !before);
    });
    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      const before = item.classList.contains('drag-over-top');
      item.classList.remove('drag-over-top', 'drag-over-bottom');
      if (!dragSourceId || dragSourceId === playlistId) return;

      const userPlaylists = state.playlists.filter((p) => p.id !== FAVOURITES_PLAYLIST_ID);
      const ids = userPlaylists.map((p) => p.id);
      const fromIdx = ids.indexOf(dragSourceId);
      if (fromIdx === -1) return;
      ids.splice(fromIdx, 1);
      let toIdx = ids.indexOf(playlistId);
      if (!before) toIdx += 1;
      ids.splice(toIdx, 0, dragSourceId);

      dragSourceId = null;
      state.playlists = await window.k7.reorderPlaylists(ids);
      renderPlaylistSidebar();
    });
  }

  function updateNavActive() {
    document.querySelectorAll('.nav-item').forEach((btn) => {
      if (btn.dataset.view === 'favourites') {
        btn.classList.toggle('active', state.view.type === 'playlist' && state.view.id === FAVOURITES_PLAYLIST_ID);
        btn.classList.toggle('playing-from', state.activeQueueView?.type === 'playlist' && state.activeQueueView.id === FAVOURITES_PLAYLIST_ID);
      } else {
        btn.classList.toggle('active', btn.dataset.view === state.view.type);
        btn.classList.toggle('playing-from', btn.dataset.view === state.activeQueueView?.type);
      }
    });
  }

  /** Single entry point for changing state.view: a stale search filter carried
   * into a different browsing context is confusing, so every view change
   * clears it, not just the ones explicitly triggered from the sidebar. */
  function switchView(view) {
    state.view = view;
    state.search = '';
    el.searchInput.value = '';
    el.searchClear.classList.remove('visible');
    updateNavActive();
    renderPlaylistSidebar();
    renderCurrentView();
  }


  // ---------- Track row ----------

  function makeTrackRow(track, idx, queueList, playlistContext) {
    const row = document.createElement('div');
    row.className = 'track-row';
    row.dataset.trackId = track.id;
    if (player.currentTrack()?.id === track.id) row.classList.add('playing');

    const coverCell = document.createElement('div');
    coverCell.className = 'cover-row';
    if (track.coverUrl) {
      const img = document.createElement('img');
      img.src = track.coverUrl;
      img.alt = '';
      coverCell.appendChild(img);
    }

    const idxCell = document.createElement('span');
    idxCell.className = 'idx';
    idxCell.textContent = String(idx + 1);

    const titleCell = document.createElement('span');
    titleCell.className = 'col-title';
    titleCell.textContent = track.title;
    if (!track.hasTags) {
      const flag = document.createElement('span');
      flag.className = 'no-tag-flag';
      flag.textContent = 'NO TAGS';
      titleCell.appendChild(flag);
    }

    const artistCell = document.createElement('span');
    artistCell.className = 'col-album';
    artistCell.textContent = track.artist;

    const albumCell = document.createElement('span');
    albumCell.className = 'col-album';
    albumCell.textContent = track.album;

    const durCell = document.createElement('span');
    durCell.className = 'col-dur';
    durCell.textContent = fmtTime(track.duration);

    const addBtn = document.createElement('button');
    addBtn.className = 'row-add-btn';
    addBtn.textContent = '+';
    addBtn.title = 'Add to playlist';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAddToPlaylistModal(track.id);
    });

    const removeCell = document.createElement('span');
    if (playlistContext) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'row-remove-btn';
      removeBtn.textContent = '−';
      removeBtn.title = `Remove from ${playlistContext.name}`;
      removeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.k7.removeTrackFromPlaylist(playlistContext.id, track.id);
        state.playlists = await window.k7.getPlaylists();
        renderPlaylistSidebar();
        renderCurrentView();
      });
      removeCell.appendChild(removeBtn);
    }

    const optionsBtn = document.createElement('button');
    optionsBtn.className = 'row-options-btn';
    optionsBtn.textContent = '⋮';
    optionsBtn.title = 'Song options';
    optionsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTrackOptionsModal(track);
    });

    row.append(coverCell, idxCell, titleCell, artistCell, albumCell, durCell, addBtn, removeCell, optionsBtn);
    row.addEventListener('click', () => {
      const queueIdx = queueList.findIndex((t) => t.id === track.id);
      setActiveQueueView({ ...state.view });
      player.setQueue(queueList, queueIdx >= 0 ? queueIdx : idx);
    });
    return row;
  }

  function makeListHeader() {
    const header = document.createElement('div');
    header.className = 'list-header';
    header.innerHTML = '<span></span><span>#</span><span>TITLE</span><span>ARTIST</span><span>ALBUM</span><span></span><span></span><span></span><span></span>';
    return header;
  }

  // ---------- Views ----------

  function renderCurrentView() {
    el.viewRoot.innerHTML = '';

    if (state.view.type === 'all') {
      el.viewTitle.textContent = 'ALL TRACKS';
      renderFlatList(state.allTracks);
      return;
    }

    if (state.view.type === 'artists') {
      el.viewTitle.textContent = 'ARTISTS / ALBUMS';
      renderArtistTree();
      return;
    }

    if (state.view.type === 'genres') {
      el.viewTitle.textContent = 'GENRES';
      renderGenreTree();
      return;
    }

    if (state.view.type === 'playlist') {
      const pl = state.playlists.find((p) => p.id === state.view.id);
      if (!pl) { state.view = { type: 'all' }; state.search = ''; el.searchInput.value = ''; el.searchClear.classList.remove('visible'); renderCurrentView(); return; }
      el.viewTitle.textContent = pl.name.toUpperCase();
      el.viewRoot.appendChild(makePlaylistCoverHeader(pl));
      renderSortedPlaylistList(pl);
      return;
    }
  }

  async function renderSortedPlaylistList(pl) {
    const sorted = await window.k7.sortTracks(pl.trackIds, state.sortMode);
    renderFlatList(sorted, pl);
  }

  function makePlaylistCoverHeader(pl) {
    const header = document.createElement('div');
    header.className = 'playlist-cover-header';
    header.appendChild(makeCoverEl(resolvePlaylistCover(pl), 'cover-lg', pl.id === FAVOURITES_PLAYLIST_ID ? 'heart' : 'cassette'));

    const meta = document.createElement('div');
    meta.className = 'playlist-cover-meta';
    const count = document.createElement('div');
    count.className = 'playlist-cover-count';
    count.textContent = `${pl.trackIds.length} TRACK${pl.trackIds.length === 1 ? '' : 'S'}`;
    const changeBtn = document.createElement('button');
    changeBtn.className = 'mini-btn';
    changeBtn.textContent = pl.coverUrl ? 'CHANGE COVER' : 'SET COVER';
    changeBtn.addEventListener('click', async () => {
      const updated = await window.k7.setPlaylistCover(pl.id);
      if (!updated) return; // dialog cancelled
      const idx = state.playlists.findIndex((p) => p.id === pl.id);
      if (idx !== -1) state.playlists[idx] = updated;
      renderPlaylistSidebar();
      renderCurrentView();
    });

    const btnRow = document.createElement('div');
    btnRow.className = 'playlist-cover-actions';
    btnRow.appendChild(changeBtn);
    if (pl.id !== FAVOURITES_PLAYLIST_ID) {
      const renameBtn = document.createElement('button');
      renameBtn.className = 'mini-btn';
      renameBtn.textContent = 'RENAME';
      renameBtn.addEventListener('click', () => openRenamePlaylistModal(pl));
      btnRow.appendChild(renameBtn);
    }
    meta.append(count, btnRow);
    header.appendChild(meta);
    return header;
  }

  function renderFlatList(fullTracks, playlistContext) {
    const visible = fullTracks.filter((t) => matchesSearch(t, state.search));
    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = state.allTracks.length === 0
        ? 'NO TRACKS INDEXED YET.<br><span class="accent">+ ADD FOLDER</span> in the sidebar to point K7 at your music.'
        : 'NO TRACKS MATCH THIS VIEW.';
      el.viewRoot.appendChild(empty);
      return;
    }
    el.viewRoot.appendChild(makeListHeader());
    // queueList is the full, unfiltered list: an active search narrows what's
    // shown, not what plays next — clicking a row queues the whole context.
    visible.forEach((t, i) => el.viewRoot.appendChild(makeTrackRow(t, i, fullTracks, playlistContext)));
  }

  async function renderArtistTree() {
    const index = await window.k7.getArtistIndex();
    const q = state.search.toLowerCase();

    if (index.length === 0) {
      el.viewRoot.innerHTML = '<div class="empty-state">NO TRACKS INDEXED YET.</div>';
      return;
    }

    for (const artistEntry of index) {
      const artistMatches = !q || artistEntry.artist.toLowerCase().includes(q);
      const visibleAlbums = artistEntry.albums
        .map((al) => ({
          ...al,
          visibleTracks: al.tracks.filter((t) => artistMatches || matchesSearch(t, state.search) || al.album.toLowerCase().includes(q)),
        }))
        .filter((al) => artistMatches || al.visibleTracks.length > 0);

      if (!artistMatches && visibleAlbums.length === 0) continue;

      const artistNode = document.createElement('details');
      artistNode.className = 'artist-node';
      const summary = document.createElement('summary');
      summary.className = 'artist-summary-row';
      const summaryLabel = document.createElement('span');
      summaryLabel.className = 'artist-name-label';
      summaryLabel.textContent = `${artistEntry.artist} (${artistEntry.albums.reduce((n, a) => n + a.tracks.length, 0)})`;
      const allArtistTracks = artistEntry.albums.flatMap((al) => al.tracks);

      const playBtn = document.createElement('button');
      playBtn.className = 'artist-play-btn mini-btn';
      playBtn.textContent = '► PLAY';
      playBtn.title = `Play all ${artistEntry.artist} tracks`;
      playBtn.addEventListener('click', (e) => {
        e.preventDefault(); // don't trigger the <details> disclosure toggle
        e.stopPropagation();
        startFreshQueue(allArtistTracks, { type: 'artist', name: artistEntry.artist });
      });

      const optionsBtn = document.createElement('button');
      optionsBtn.className = 'artist-options-btn mini-btn';
      optionsBtn.textContent = '⋮';
      optionsBtn.title = `Options for ${artistEntry.artist}`;
      optionsBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openBulkOptionsModal(artistEntry.artist, allArtistTracks.map((t) => t.id));
      });

      summary.append(summaryLabel, playBtn, optionsBtn);
      artistNode.appendChild(summary);

      for (const album of visibleAlbums) {
        const albumNode = document.createElement('details');
        albumNode.className = 'album-node';
        const albumSummary = document.createElement('summary');
        albumSummary.className = 'album-summary-row';
        const albumLabel = document.createElement('span');
        albumLabel.className = 'album-name-label';
        albumLabel.textContent = `${album.album} (${album.tracks.length})`;

        const albumPlayBtn = document.createElement('button');
        albumPlayBtn.className = 'album-play-btn mini-btn';
        albumPlayBtn.textContent = '► PLAY';
        albumPlayBtn.title = `Play ${album.album}`;
        albumPlayBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          startFreshQueue(album.tracks, { type: 'album', artist: artistEntry.artist, album: album.album });
        });

        const albumOptionsBtn = document.createElement('button');
        albumOptionsBtn.className = 'album-options-btn mini-btn';
        albumOptionsBtn.textContent = '⋮';
        albumOptionsBtn.title = `Options for ${album.album}`;
        albumOptionsBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openBulkOptionsModal(`${artistEntry.artist} / ${album.album}`, album.tracks.map((t) => t.id));
        });

        albumSummary.append(albumLabel, albumPlayBtn, albumOptionsBtn);
        albumNode.appendChild(albumSummary);
        // queueList is album.tracks (full), rendered rows are visibleTracks
        // (filtered) — clicking a filtered row still queues the whole album.
        album.visibleTracks.forEach((t, i) => albumNode.appendChild(makeTrackRow(t, i, album.tracks)));
        artistNode.appendChild(albumNode);
      }
      el.viewRoot.appendChild(artistNode);
    }
  }

  async function renderGenreTree() {
    const index = await window.k7.getGenreIndex();

    if (index.length === 0) {
      el.viewRoot.innerHTML = '<div class="empty-state">NO TRACKS INDEXED YET.</div>';
      return;
    }

    for (const genreEntry of index) {
      const visibleTracks = genreEntry.tracks.filter((t) => matchesSearch(t, state.search));
      if (visibleTracks.length === 0) continue;

      const genreNode = document.createElement('details');
      genreNode.className = 'genre-node';
      const summary = document.createElement('summary');
      summary.className = 'genre-summary-row';
      const label = genreEntry.genre === 'UNTAGGED' ? 'NO GENRE TAG' : genreEntry.genre;
      const summaryLabel = document.createElement('span');
      summaryLabel.className = 'genre-name-label';
      summaryLabel.textContent = `${label} (${genreEntry.tracks.length})`;

      const playBtn = document.createElement('button');
      playBtn.className = 'genre-play-btn mini-btn';
      playBtn.textContent = '► PLAY';
      playBtn.title = `Play all ${label} tracks`;
      playBtn.addEventListener('click', (e) => {
        e.preventDefault(); // don't trigger the <details> disclosure toggle
        e.stopPropagation();
        startFreshQueue(genreEntry.tracks, { type: 'genre', genre: genreEntry.genre });
      });

      summary.append(summaryLabel, playBtn);
      genreNode.appendChild(summary);
      visibleTracks.forEach((t, i) => genreNode.appendChild(makeTrackRow(t, i, genreEntry.tracks)));
      el.viewRoot.appendChild(genreNode);
    }
  }

  // ---------- Modals ----------

  function closeModal() {
    el.modalRoot.innerHTML = '';
  }

  function openModal(html, onMount, extraClass = '') {
    el.modalRoot.innerHTML = `<div class="modal-backdrop"><div class="modal-box ${extraClass}">${html}</div></div>`;
    el.modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-backdrop')) closeModal();
    });
    onMount(el.modalRoot.querySelector('.modal-box'));
  }

  /** Themed replacement for window.confirm() — native dialogs break the
   * app's aesthetic entirely (OS chrome, system font, no way to style them). */
  function openConfirmModal(message, onConfirm) {
    openModal(
      `<h3>CONFIRM</h3>
       <p style="font-size:12px;color:var(--text);margin:0 0 16px;line-height:1.5;">${escapeHtml(message)}</p>
       <div class="modal-actions">
         <button id="confirm-cancel">CANCEL</button>
         <button id="confirm-ok" class="danger-btn">DELETE</button>
       </div>`,
      (box) => {
        box.querySelector('#confirm-cancel').addEventListener('click', closeModal);
        box.querySelector('#confirm-ok').addEventListener('click', async () => {
          closeModal();
          await onConfirm();
        });
      },
      'danger'
    );
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    el.toastRoot.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 250);
    }, 1800);
  }

  function openNewPlaylistModal() {
    openModal(
      `<h3>NEW PLAYLIST</h3>
       <input type="text" id="pl-name-input" placeholder="Playlist name" maxlength="60" />
       <div class="modal-actions">
         <button id="pl-cancel">CANCEL</button>
         <button id="pl-create">CREATE</button>
       </div>`,
      (box) => {
        const input = box.querySelector('#pl-name-input');
        input.focus();
        box.querySelector('#pl-cancel').addEventListener('click', closeModal);
        const create = async () => {
          const name = input.value.trim();
          if (!name) return;
          const pl = await window.k7.createPlaylist(name);
          state.playlists = await window.k7.getPlaylists();
          switchView({ type: 'playlist', id: pl.id });
          closeModal();
        };
        box.querySelector('#pl-create').addEventListener('click', create);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
      }
    );
  }

  function openRenamePlaylistModal(pl) {
    openModal(
      `<h3>RENAME PLAYLIST</h3>
       <input type="text" id="pl-rename-input" maxlength="60" value="${escapeHtml(pl.name)}" />
       <div class="modal-actions">
         <button id="pl-rename-cancel">CANCEL</button>
         <button id="pl-rename-save">SAVE</button>
       </div>`,
      (box) => {
        const input = box.querySelector('#pl-rename-input');
        input.focus();
        input.select();
        box.querySelector('#pl-rename-cancel').addEventListener('click', closeModal);
        const save = async () => {
          const name = input.value.trim();
          if (!name || name === pl.name) { closeModal(); return; }
          await window.k7.renamePlaylist(pl.id, name);
          state.playlists = await window.k7.getPlaylists();
          renderPlaylistSidebar();
          if (state.view.type === 'playlist' && state.view.id === pl.id) renderCurrentView();
          closeModal();
        };
        box.querySelector('#pl-rename-save').addEventListener('click', save);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
      }
    );
  }

  function openAddToPlaylistModal(trackId) {
    if (state.playlists.length === 0) {
      openModal(
        `<h3>NO PLAYLISTS YET</h3><p style="font-size:11px;color:var(--text-dim)">Create one first.</p>
         <div class="modal-actions"><button id="pl-close">CLOSE</button></div>`,
        (box) => box.querySelector('#pl-close').addEventListener('click', closeModal)
      );
      return;
    }
    renderAddToPlaylistModal(trackId);
  }

  function renderAddToPlaylistModal(trackId) {
    const items = state.playlists
      .map((pl) => {
        const inPlaylist = pl.trackIds.includes(trackId);
        return `<button data-id="${pl.id}" class="${inPlaylist ? 'in-playlist' : ''}">${inPlaylist ? '✓ ' : ''}${escapeHtml(pl.name)} (${pl.trackIds.length})</button>`;
      })
      .join('');
    const html = `<h3>PLAYLISTS</h3><div class="modal-list">${items}</div>
       <div class="modal-actions"><button id="pl-close">CLOSE</button></div>`;

    const existingBox = el.modalRoot.querySelector('.modal-box');
    if (existingBox) {
      existingBox.innerHTML = html;
      wireAddToPlaylistModal(existingBox, trackId);
    } else {
      openModal(html, (box) => wireAddToPlaylistModal(box, trackId));
    }
  }

  function wireAddToPlaylistModal(box, trackId) {
    box.querySelectorAll('.modal-list button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const pl = state.playlists.find((p) => p.id === id);
        const alreadyIn = pl.trackIds.includes(trackId);
        if (alreadyIn) await window.k7.removeTrackFromPlaylist(id, trackId);
        else await window.k7.addTracksToPlaylist(id, [trackId]);
        state.playlists = await window.k7.getPlaylists();
        renderPlaylistSidebar();
        if (state.view.type === 'playlist' && state.view.id === id) renderCurrentView();
        renderAddToPlaylistModal(trackId);
      });
    });
    box.querySelector('#pl-close').addEventListener('click', closeModal);
  }

  function openTrackOptionsModal(track) {
    renderTrackOptionsModal(track);
  }

  /** Applies a genre/custom tag to every track under an artist or album at
   * once — the per-track Song Options modal only tags one track, which is
   * impractical for classifying a whole folder. trackIds is resolved by the
   * caller (all of an artist's tracks across every album, or one album's). */
  function openBulkOptionsModal(scopeLabel, trackIds) {
    renderBulkOptionsModal(scopeLabel, trackIds);
  }

  function renderBulkOptionsModal(scopeLabel, trackIds) {
    const tracks = trackIds.map((id) => state.tracksById.get(id)).filter(Boolean);
    const tagCounts = new Map();
    for (const t of tracks) {
      for (const tag of t.customTags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
    const sortedTags = [...tagCounts.keys()].sort((a, b) => a.localeCompare(b));
    const tagsHtml = sortedTags.length
      ? sortedTags
          .map(
            (tag) =>
              `<span class="tag-chip">${escapeHtml(tag)} <span class="tag-chip-count">${tagCounts.get(tag)}/${tracks.length}</span> <button class="tag-remove-btn" data-tag="${escapeHtml(tag)}">×</button></span>`
          )
          .join('')
      : '<span class="tag-chip-empty">none yet</span>';

    const html = `
      <h3>${escapeHtml(scopeLabel)}</h3>
      <p style="font-size:11px;color:var(--text-dim);margin:0 0 14px;">${trackIds.length} track${trackIds.length === 1 ? '' : 's'}</p>
      <div class="modal-list">
        <button id="bulk-opt-queue">ADD ALL TO QUEUE</button>
        <button id="bulk-opt-fav">ADD ALL TO FAVOURITES</button>
      </div>
      <div class="tag-section">
        <div class="sidebar-label"><span>GENRE TAGS</span></div>
        <div class="tag-chips">${tagsHtml}</div>
        ${tagAutocompleteHtml()}
      </div>
      <div class="modal-actions"><button id="bulk-opt-close">CLOSE</button></div>
    `;
    const existingBox = el.modalRoot.querySelector('.modal-box');
    if (existingBox) {
      existingBox.innerHTML = html;
      wireBulkOptionsModal(existingBox, scopeLabel, trackIds);
    } else {
      openModal(html, (box) => wireBulkOptionsModal(box, scopeLabel, trackIds));
    }
  }

  function wireBulkOptionsModal(box, scopeLabel, trackIds) {
    box.querySelector('#bulk-opt-close').addEventListener('click', closeModal);

    box.querySelector('#bulk-opt-queue').addEventListener('click', () => {
      const tracks = trackIds.map((id) => state.tracksById.get(id)).filter(Boolean);
      // In order, one at a time: each addToQueue call inserts right after
      // the previous one, so the whole batch lands as a consecutive block
      // right after the current track — same "play next" semantics as a
      // single track, just repeated.
      tracks.forEach((t) => player.addToQueue(t));
      showToast(`QUEUED ${tracks.length} TRACK${tracks.length === 1 ? '' : 'S'}`);
      closeModal();
    });

    box.querySelector('#bulk-opt-fav').addEventListener('click', async () => {
      await window.k7.addTracksToPlaylist(FAVOURITES_PLAYLIST_ID, trackIds);
      state.playlists = await window.k7.getPlaylists();
      renderPlaylistSidebar();
      if (state.view.type === 'playlist' && state.view.id === FAVOURITES_PLAYLIST_ID) renderCurrentView();
      showToast(`ADDED ${trackIds.length} TRACK${trackIds.length === 1 ? '' : 'S'} TO FAVOURITES`);
    });

    box.querySelectorAll('.tag-remove-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const updatedTracks = await window.k7.removeCustomTagFromTracks(trackIds, btn.dataset.tag);
        updatedTracks.forEach(applyUpdatedTrack);
        renderCurrentView();
        showToast(`REMOVED TAG: ${btn.dataset.tag}`);
        renderBulkOptionsModal(scopeLabel, trackIds);
      });
    });

    wireTagAutocomplete(box, {
      // Not excluding any tags here (unlike the per-track modal): tracks in
      // the same folder can each have different existing tags already, so
      // there's no single "already applied" set to hide suggestions for.
      excludeTags: new Set(),
      onAdd: async (tag) => {
        const updatedTracks = await window.k7.addCustomTagToTracks(trackIds, tag);
        updatedTracks.forEach(applyUpdatedTrack);
        renderCurrentView();
        showToast(`TAGGED ${trackIds.length} TRACK${trackIds.length === 1 ? '' : 'S'}: ${tag}`);
        renderBulkOptionsModal(scopeLabel, trackIds);
      },
    });
  }

  function renderTrackOptionsModal(track) {
    const favPlaylist = state.playlists.find((p) => p.id === FAVOURITES_PLAYLIST_ID);
    const isFav = favPlaylist ? favPlaylist.trackIds.includes(track.id) : false;
    const customTags = track.customTags || [];
    const tagsHtml = customTags.length
      ? customTags.map((tag) => `<span class="tag-chip">${escapeHtml(tag)} <button class="tag-remove-btn" data-tag="${escapeHtml(tag)}">×</button></span>`).join('')
      : '<span class="tag-chip-empty">none yet</span>';

    const html = `
      <h3>${escapeHtml(track.title)}</h3>
      <div class="modal-list">
        <button id="opt-queue">ADD TO QUEUE</button>
        <button id="opt-fav" class="${isFav ? 'in-playlist' : ''}">${isFav ? '✓ ' : ''}FAVOURITE</button>
      </div>
      <div class="tag-section">
        <div class="sidebar-label"><span>CUSTOM TAGS</span></div>
        <p class="file-genre-line">${
          track.genre
            ? `FILE GENRE: <span class="file-genre-value">${escapeHtml(track.genre)}</span>`
            : 'NO FILE GENRE — add a tag below to classify this track for browsing/sorting.'
        }</p>
        <div class="tag-chips">${tagsHtml}</div>
        ${tagAutocompleteHtml()}
      </div>
      <div class="modal-actions"><button id="opt-close">CLOSE</button></div>
    `;

    const existingBox = el.modalRoot.querySelector('.modal-box');
    if (existingBox) {
      existingBox.innerHTML = html;
      wireTrackOptionsModal(existingBox, track);
    } else {
      openModal(html, (box) => wireTrackOptionsModal(box, track));
    }
  }

  function wireTrackOptionsModal(box, track) {
    box.querySelector('#opt-close').addEventListener('click', closeModal);

    box.querySelector('#opt-queue').addEventListener('click', () => {
      player.addToQueue(track);
      showToast(`PLAYING NEXT: ${track.title}`);
      closeModal();
    });

    box.querySelector('#opt-fav').addEventListener('click', async () => {
      const favPlaylist = state.playlists.find((p) => p.id === FAVOURITES_PLAYLIST_ID);
      const isFav = favPlaylist ? favPlaylist.trackIds.includes(track.id) : false;
      if (isFav) await window.k7.removeTrackFromPlaylist(FAVOURITES_PLAYLIST_ID, track.id);
      else await window.k7.addTracksToPlaylist(FAVOURITES_PLAYLIST_ID, [track.id]);
      state.playlists = await window.k7.getPlaylists();
      renderPlaylistSidebar();
      if (state.view.type === 'playlist' && state.view.id === FAVOURITES_PLAYLIST_ID) renderCurrentView();
      renderTrackOptionsModal(track);
    });

    box.querySelectorAll('.tag-remove-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const updatedTrack = await window.k7.removeCustomTag(track.id, btn.dataset.tag);
        applyUpdatedTrack(updatedTrack);
        renderCurrentView();
        renderTrackOptionsModal(updatedTrack || track);
      });
    });

    wireTagAutocomplete(box, {
      excludeTags: new Set(track.customTags || []),
      onAdd: async (tag) => {
        const updatedTrack = await window.k7.addCustomTag(track.id, tag);
        applyUpdatedTrack(updatedTrack);
        renderCurrentView();
        renderTrackOptionsModal(updatedTrack || track);
      },
    });
  }

  /** HTML for a tag input + autocomplete-suggestion dropdown — shared markup
   * between the per-track Song Options modal and the bulk artist/album tag
   * modal. Safe to reuse the same ids across modal templates since only one
   * modal is ever in the DOM at a time. */
  function tagAutocompleteHtml() {
    return `<div class="tag-add-row">
      <div class="tag-input-wrap">
        <input type="text" id="new-tag-input" placeholder="ADD TAG..." maxlength="30" autocomplete="off" />
        <div class="tag-suggestions" id="tag-suggestions"></div>
      </div>
      <button id="add-tag-btn" class="mini-btn">ADD</button>
    </div>`;
  }

  /** Wires the input/suggestions pair produced by tagAutocompleteHtml().
   * onAdd(tag) fires for every add action (typed + Enter, ADD click, or a
   * suggestion click). excludeTags hides tags that don't make sense to
   * suggest again (e.g. already on the track/every track in scope). */
  function wireTagAutocomplete(box, { onAdd, excludeTags }) {
    const input = box.querySelector('#new-tag-input');
    const suggestBox = box.querySelector('#tag-suggestions');

    const addTag = (explicitTag) => {
      const tag = (explicitTag ?? input.value).trim();
      if (!tag) return;
      onAdd(tag);
    };

    box.querySelector('#add-tag-btn').addEventListener('click', () => addTag());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addTag();
    });

    const renderSuggestions = () => {
      const query = input.value.trim().toLowerCase();
      const candidates = getAllKnownTags().filter((t) => !excludeTags.has(t));
      const matches = query ? candidates.filter((t) => t.toLowerCase().includes(query)) : candidates;
      if (matches.length === 0) {
        suggestBox.classList.remove('visible');
        suggestBox.innerHTML = '';
        return;
      }
      suggestBox.innerHTML = matches
        .slice(0, 8)
        .map((t) => `<div class="tag-suggestion-item" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</div>`)
        .join('');
      suggestBox.classList.add('visible');
      suggestBox.querySelectorAll('.tag-suggestion-item').forEach((item) => {
        // mousedown, not click: fires before the input's blur event, so the
        // dropdown-hide-on-blur handler below doesn't remove it first.
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          addTag(item.dataset.tag);
        });
      });
    };
    input.addEventListener('input', renderSuggestions);
    input.addEventListener('focus', renderSuggestions);
    input.addEventListener('blur', () => {
      setTimeout(() => suggestBox.classList.remove('visible'), 150);
    });
  }

  /** Every distinct tag value in use anywhere in the library — both file
   * genre tags and custom tags — powering the autocomplete suggestion
   * dropdown. Typing "ro" should surface "Rock" (a file genre) and
   * "Alternative Rock" (a custom tag) side by side, not just custom ones. */
  function getAllKnownTags() {
    const tags = new Set();
    for (const t of state.allTracks) {
      if (t.genre) tags.add(t.genre);
      for (const tag of t.customTags || []) tags.add(tag);
    }
    return [...tags].sort((a, b) => a.localeCompare(b));
  }

  function applyUpdatedTrack(updatedTrack) {
    if (!updatedTrack) return;
    state.tracksById.set(updatedTrack.id, updatedTrack);
    const idx = state.allTracks.findIndex((t) => t.id === updatedTrack.id);
    if (idx !== -1) state.allTracks[idx] = updatedTrack;
  }

  function openSettingsModal() {
    renderSettingsModal();
  }

  function renderSettingsModal() {
    const autoRescan = state.settings.autoRescanOnLaunch !== false;
    const html = `
      <h3>SETTINGS</h3>
      <div class="settings-row">
        <span>RESCAN LIBRARY ON LAUNCH</span>
        <div class="toggle-switch ${autoRescan ? 'on' : ''}" id="toggle-auto-rescan" role="switch" aria-checked="${autoRescan}"><div class="toggle-knob"></div></div>
      </div>
      <p style="font-size:10px;color:var(--text-dim);margin:4px 0 0;line-height:1.5;">Off: launch loads the last known library instantly instead of re-scanning disk. RESCAN in the sidebar still works manually any time.</p>
      <div class="modal-actions"><button id="settings-close">CLOSE</button></div>
    `;
    const existingBox = el.modalRoot.querySelector('.modal-box');
    if (existingBox) {
      existingBox.innerHTML = html;
      wireSettingsModal(existingBox);
    } else {
      openModal(html, (box) => wireSettingsModal(box));
    }
  }

  function wireSettingsModal(box) {
    box.querySelector('#settings-close').addEventListener('click', closeModal);
    box.querySelector('#toggle-auto-rescan').addEventListener('click', () => {
      const next = !(state.settings.autoRescanOnLaunch !== false);
      state.settings.autoRescanOnLaunch = next;
      window.k7.saveSettings({ autoRescanOnLaunch: next });
      renderSettingsModal();
    });
  }

  // ---------- Transport UI ----------

  function updateShuffleRepeatUI() {
    el.btnShuffle.classList.toggle('on', player.shuffleOn);
    el.btnRepeat.classList.toggle('on', player.repeat !== 'off');
    el.btnRepeat.textContent = player.repeat === 'one' ? 'RPT·1' : 'RPT';
  }

  function setNowPlayingText(title) {
    const safeTitle = escapeHtml(title);
    el.nowTitle.innerHTML = safeTitle;
    el.nowTitle.classList.remove('scrolling');
    el.nowTitle.style.animation = 'none';
    requestAnimationFrame(() => {
      const wrapWidth = el.nowTitle.parentElement.clientWidth;
      const textWidth = el.nowTitle.scrollWidth;
      el.nowTitle.style.animation = '';
      if (textWidth > wrapWidth) {
        const gapPx = 40;
        el.nowTitle.innerHTML = `<span class="marquee-copy">${safeTitle}</span><span class="marquee-gap"></span><span class="marquee-copy">${safeTitle}</span><span class="marquee-gap"></span>`;
        const duration = Math.max(6, (textWidth + gapPx) / 28);
        el.nowTitle.style.setProperty('--marquee-gap', `${gapPx}px`);
        el.nowTitle.style.animationDuration = `${duration}s`;
        el.nowTitle.classList.add('scrolling');
      }
    });
  }

  function persistPlaybackState() {
    const track = player.currentTrack();
    if (!track) return;
    window.k7.saveSettings({
      lastPlayback: {
        trackId: track.id,
        position: player.audio.currentTime || 0,
        view: state.activeQueueView || { type: 'all' },
      },
    });
  }

  player.onTrackChange = (track) => {
    setNowPlayingText(track.title);
    el.nowArtist.textContent = `${track.artist} — ${track.album}`;
    document.querySelectorAll('.track-row.playing').forEach((r) => r.classList.remove('playing'));
    document.querySelectorAll(`.track-row[data-track-id="${track.id}"]`).forEach((r) => r.classList.add('playing'));
    updateNowFavButton();
  };

  player.onPlayStateChange = (isPlaying) => {
    el.btnPlayPause.textContent = isPlaying ? '❙❙' : '►';
    el.reels.classList.toggle('playing', isPlaying);
    if (!isPlaying) persistPlaybackState();
  };

  player.onTimeUpdate = (current, duration) => {
    el.timeCurrent.textContent = fmtTime(current);
    el.timeTotal.textContent = fmtTime(duration);
    if (!seekDragging) {
      const frac = duration > 0 ? current / duration : 0;
      el.seekRange.value = String(Math.round(frac * 1000));
      el.seekFill.style.width = `${frac * 100}%`;
    }
  };

  // ---------- Add folder / library organiser ----------

  function baseName(filePath) {
    return filePath.split(/[\\/]/).pop();
  }

  async function handleAddFolder() {
    const picked = await window.k7.pickLibraryFolder();
    if (picked.canceled) return;

    const check = await window.k7.checkOrganization(picked.path);
    if (!check.isOrganized) {
      openOrganizePromptModal(picked.path, check);
      return;
    }
    await finishAddFolder(picked.path);
  }

  async function finishAddFolder(folderPath) {
    el.scanStatus.textContent = 'ADDING FOLDER...';
    el.scanStatus.classList.remove('error');
    const result = await window.k7.confirmAddFolder(folderPath);
    if (result.added) {
      applyScanData(result);
      renderCurrentView();
    }
  }

  function openOrganizePromptModal(folderPath, check) {
    const count = check.looseAudioFiles.length;
    const html = `
      <h3>LIBRARY NOT ORGANISED</h3>
      <p style="font-size:12px;color:var(--text);line-height:1.6;margin:0 0 14px;">
        ${count} track${count === 1 ? '' : 's'} found loose in this folder, not inside an Artist/Album structure.
        K7 Audio only scans inside artist folders — loose files would be silently skipped, not shown anywhere.
        Organise now? Files are only <strong>moved</strong> by tag (Artist/Album), never deleted. Anything it can't
        confidently place goes to an <strong>unsupported/</strong> folder instead of being left behind or lost.
      </p>
      <div class="modal-actions">
        <button id="org-no">ADD AS-IS</button>
        <button id="org-yes" style="color:var(--green);border-color:var(--green-dim);">ORGANISE</button>
      </div>
    `;
    openModal(html, (box) => {
      box.querySelector('#org-no').addEventListener('click', async () => {
        closeModal();
        await finishAddFolder(folderPath);
      });
      box.querySelector('#org-yes').addEventListener('click', async () => {
        closeModal();
        await runOrganizeThenAdd(folderPath);
      });
    });
  }

  async function runOrganizeThenAdd(folderPath) {
    el.scanStatus.textContent = 'ORGANISING...';
    el.scanStatus.classList.remove('error');
    const report = await window.k7.organizeLibrary(folderPath);
    showToast(`ORGANISED: ${report.moved.length} FILE${report.moved.length === 1 ? '' : 'S'} MOVED`);
    if (report.unsupported.length > 0) {
      openUnsupportedFilesModal(report);
    }
    await finishAddFolder(folderPath);
  }

  function openUnsupportedFilesModal(report) {
    const items = report.unsupported
      .map((u) => `<div class="unsupported-row">${escapeHtml(baseName(u.from))}<span class="unsupported-reason">${escapeHtml(u.reason)}</span></div>`)
      .join('');
    const html = `
      <h3>${report.unsupported.length} FILE${report.unsupported.length === 1 ? '' : 'S'} NEED ATTENTION</h3>
      <p style="font-size:11px;color:var(--text-dim);margin:0 0 10px;line-height:1.5;">
        Moved to <strong style="color:var(--text);">${escapeHtml(report.unsupportedDir || 'unsupported/')}</strong> —
        nothing deleted, nothing guessed.
      </p>
      <div class="modal-list unsupported-list">${items}</div>
      <div class="modal-actions"><button id="unsupported-close">CLOSE</button></div>
    `;
    openModal(html, (box) => box.querySelector('#unsupported-close').addEventListener('click', closeModal));
  }

  // ---------- Event wiring ----------

  function navViewFor(dataView) {
    return dataView === 'favourites' ? { type: 'playlist', id: FAVOURITES_PLAYLIST_ID } : { type: dataView };
  }

  function viewsMatch(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    if (a.type === 'playlist') return a.id === b.id;
    if (a.type === 'artist') return a.name === b.name;
    if (a.type === 'album') return a.artist === b.artist && a.album === b.album;
    if (a.type === 'genre') return a.genre === b.genre;
    return true; // all / artists / genres have no further discriminator
  }

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchView(navViewFor(btn.dataset.view)));
  });

  document.querySelectorAll('.nav-play-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation(); // don't also trigger the parent .nav-item's switchView
      const view = navViewFor(btn.dataset.view);
      if (viewsMatch(state.activeQueueView, view) && player.currentTrack()) {
        player.play();
        return;
      }
      const tracks = await resolveViewTracks(view);
      startFreshQueue(tracks, view);
    });
  });

  document.getElementById('new-playlist-btn').addEventListener('click', openNewPlaylistModal);
  document.getElementById('settings-btn').addEventListener('click', openSettingsModal);

  document.getElementById('add-folder-btn').addEventListener('click', handleAddFolder);

  document.getElementById('rescan-btn').addEventListener('click', async () => {
    await rescan();
    renderCurrentView();
  });

  el.searchInput.addEventListener('input', (e) => {
    state.search = e.target.value;
    el.searchClear.classList.toggle('visible', state.search.length > 0);
    renderCurrentView();
  });

  el.searchClear.addEventListener('click', () => {
    state.search = '';
    el.searchInput.value = '';
    el.searchClear.classList.remove('visible');
    el.searchInput.focus();
    renderCurrentView();
  });

  el.sortSelect.addEventListener('change', async (e) => {
    state.sortMode = e.target.value;
    window.k7.saveSettings({ allSongsSort: state.sortMode });
    if (state.view.type === 'all') {
      state.allTracks = await window.k7.sortAllSongs(state.sortMode);
    }
    if (state.view.type === 'all' || state.view.type === 'playlist') {
      renderCurrentView();
    }
  });

  async function resolveViewTracks(view) {
    if (view.type === 'all') return state.allTracks;
    if (view.type === 'playlist') {
      const pl = state.playlists.find((p) => p.id === view.id);
      return pl ? window.k7.sortTracks(pl.trackIds, state.sortMode) : [];
    }
    if (view.type === 'artist') {
      const index = await window.k7.getArtistIndex();
      const artistEntry = index.find((a) => a.artist === view.name);
      return artistEntry ? artistEntry.albums.flatMap((al) => al.tracks) : [];
    }
    if (view.type === 'album') {
      const index = await window.k7.getArtistIndex();
      const artistEntry = index.find((a) => a.artist === view.artist);
      const albumEntry = artistEntry?.albums.find((al) => al.album === view.album);
      return albumEntry ? albumEntry.tracks : [];
    }
    if (view.type === 'artists') {
      const index = await window.k7.getArtistIndex();
      return index.flatMap((a) => a.albums.flatMap((al) => al.tracks));
    }
    if (view.type === 'genre') {
      const index = await window.k7.getGenreIndex();
      const genreEntry = index.find((g) => g.genre === view.genre);
      return genreEntry ? genreEntry.tracks : [];
    }
    if (view.type === 'genres') {
      const index = await window.k7.getGenreIndex();
      return index.flatMap((g) => g.tracks);
    }
    return [];
  }

  function getCurrentViewTracks() {
    return resolveViewTracks(state.view);
  }

  function describeQueueView(view) {
    if (!view) return '';
    if (view.type === 'all') return 'ALL TRACKS';
    if (view.type === 'artist') return view.name;
    if (view.type === 'album') return `${view.artist} / ${view.album}`;
    if (view.type === 'artists') return 'ARTISTS / ALBUMS';
    if (view.type === 'genre') return view.genre === 'UNTAGGED' ? 'NO GENRE TAG' : view.genre;
    if (view.type === 'genres') return 'GENRES';
    if (view.type === 'playlist') {
      const pl = state.playlists.find((p) => p.id === view.id);
      return pl ? pl.name : 'PLAYLIST';
    }
    return '';
  }

  /** Single point for changing which view "owns" the current queue — keeps
   * state, the transport-bar label, and the sidebar's playing-from indicator
   * from drifting out of sync with each other. */
  function setActiveQueueView(view) {
    state.activeQueueView = view;
    el.nowSource.textContent = view ? `PLAYING FROM ${describeQueueView(view)}` : '';
    updateNavActive();
    renderPlaylistSidebar();
  }

  /** Starts a brand-new queue from scratch (as opposed to clicking a specific
   * row, which always starts at that exact track): respects shuffle by
   * picking a random starting track when shuffle is on, first track when
   * it's off. Used by every "play this whole thing" entry point — the main
   * play button with nothing loaded, an artist's play button, a playlist's
   * play button — so they behave consistently with each other. */
  function startFreshQueue(tracks, viewDescriptor) {
    if (tracks.length === 0) return;
    const startIdx = player.shuffleOn ? Math.floor(Math.random() * tracks.length) : 0;
    setActiveQueueView(viewDescriptor);
    player.setQueue(tracks, startIdx);
  }

  document.getElementById('btn-playpause').addEventListener('click', async () => {
    if (!player.currentTrack()) {
      const tracks = await getCurrentViewTracks();
      startFreshQueue(tracks, { ...state.view });
      return;
    }
    player.togglePlay();
  });
  document.getElementById('btn-next').addEventListener('click', () => player.next());
  document.getElementById('btn-prev').addEventListener('click', () => player.prev());

  el.nowFavBtn.addEventListener('click', async () => {
    const track = player.currentTrack();
    if (!track) return;
    const favPlaylist = state.playlists.find((p) => p.id === FAVOURITES_PLAYLIST_ID);
    const isFav = favPlaylist ? favPlaylist.trackIds.includes(track.id) : false;
    if (isFav) await window.k7.removeTrackFromPlaylist(FAVOURITES_PLAYLIST_ID, track.id);
    else await window.k7.addTracksToPlaylist(FAVOURITES_PLAYLIST_ID, [track.id]);
    state.playlists = await window.k7.getPlaylists();
    renderPlaylistSidebar(); // also refreshes this same button, see updateNowFavButton
    if (state.view.type === 'playlist' && state.view.id === FAVOURITES_PLAYLIST_ID) renderCurrentView();
  });
  document.getElementById('btn-shuffle').addEventListener('click', () => {
    player.setShuffle(!player.shuffleOn);
    window.k7.saveSettings({ shuffle: player.shuffleOn });
    updateShuffleRepeatUI();
  });
  document.getElementById('btn-repeat').addEventListener('click', () => {
    const next = { off: 'all', all: 'one', one: 'off' }[player.repeat];
    player.setRepeat(next);
    window.k7.saveSettings({ repeat: next });
    updateShuffleRepeatUI();
  });

  el.seekRange.addEventListener('pointerdown', () => { seekDragging = true; });
  el.seekRange.addEventListener('pointerup', () => { seekDragging = false; });
  el.seekRange.addEventListener('input', (e) => {
    player.seekTo(Number(e.target.value) / 1000, true);
    el.seekFill.style.width = `${Number(e.target.value) / 10}%`;
  });

  el.volumeRange.addEventListener('input', (e) => {
    const pct = Number(e.target.value);
    const v = pct / 100;
    player.setVolume(v);
    window.k7.saveSettings({ volume: v });
    el.volumeFill.style.width = `${pct}%`;
    el.volValue.textContent = String(pct);
  });

  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); player.prev(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); player.next(); }
  });

  setInterval(() => {
    if (!player.audio.paused) persistPlaybackState();
  }, 5000);
  window.addEventListener('beforeunload', persistPlaybackState);

  loadAll();
})();

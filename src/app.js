'use strict';

(() => {
  const state = {
    allTracks: [],
    tracksById: new Map(),
    playlists: [],
    settings: null,
    view: { type: 'all' }, // {type:'all'} | {type:'artists'} | {type:'playlist', id}
    search: '',
    sortMode: 'artist-album',
  };

  const el = {
    viewTitle: document.getElementById('view-title'),
    viewRoot: document.getElementById('view-root'),
    searchInput: document.getElementById('search-input'),
    sortSelect: document.getElementById('sort-select'),
    playlistList: document.getElementById('playlist-list'),
    libraryPaths: document.getElementById('library-paths'),
    scanStatus: document.getElementById('scan-status'),
    modalRoot: document.getElementById('modal-root'),
    nowTitle: document.getElementById('now-title'),
    nowArtist: document.getElementById('now-artist'),
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
  };

  const audioEl = document.getElementById('audio-el');
  const player = new K7Player(audioEl);
  let seekDragging = false;

  function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function matchesSearch(track, q) {
    if (!q) return true;
    const hay = `${track.title} ${track.artist} ${track.album}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  }

  // ---------- Data loading ----------

  async function loadAll() {
    state.settings = await window.k7.getSettings();
    state.sortMode = state.settings.allSongsSort || 'artist-album';
    el.sortSelect.value = state.sortMode;
    el.volumeRange.value = Math.round((state.settings.volume ?? 0.8) * 100);
    player.setVolume(state.settings.volume ?? 0.8);
    player.setShuffle(Boolean(state.settings.shuffle));
    player.setRepeat(state.settings.repeat || 'off');
    updateShuffleRepeatUI();

    await rescan();
    state.playlists = await window.k7.getPlaylists();
    renderLibraryPaths();
    renderPlaylistSidebar();
    renderCurrentView();
  }

  async function rescan() {
    el.scanStatus.textContent = 'SCANNING...';
    el.scanStatus.classList.remove('error');
    try {
      const { tracks, errors, libraryPaths } = await window.k7.scanLibrary();
      state.allTracks = tracks;
      state.tracksById = new Map(tracks.map((t) => [t.id, t]));
      state.settings.libraryPaths = libraryPaths;
      el.scanStatus.textContent = `${tracks.length} TRACKS INDEXED`;
      if (errors.length) {
        el.scanStatus.textContent += ` · ${errors.length} ERRORS`;
        el.scanStatus.classList.add('error');
      }
      if (tracks.length === 0) {
        el.scanStatus.textContent = 'NO LIBRARY FOLDER SET';
      }
    } catch (err) {
      el.scanStatus.textContent = 'SCAN FAILED';
      el.scanStatus.classList.add('error');
      console.error(err);
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
        applyScanResult(result);
        renderCurrentView();
      });
      row.append(label, btn);
      el.libraryPaths.appendChild(row);
    }
  }

  function applyScanResult(result) {
    state.allTracks = result.tracks;
    state.tracksById = new Map(result.tracks.map((t) => [t.id, t]));
    state.settings.libraryPaths = result.libraryPaths;
    el.scanStatus.textContent = `${result.tracks.length} TRACKS INDEXED`;
    renderLibraryPaths();
  }

  function renderPlaylistSidebar() {
    el.playlistList.innerHTML = '';
    for (const pl of state.playlists) {
      const item = document.createElement('div');
      item.className = 'playlist-item';
      if (state.view.type === 'playlist' && state.view.id === pl.id) item.classList.add('active');

      const label = document.createElement('span');
      label.textContent = pl.name;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = pl.trackIds.length;
      const del = document.createElement('button');
      del.className = 'del-btn';
      del.textContent = '×';
      del.title = 'Delete playlist';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete playlist "${pl.name}"?`)) return;
        await window.k7.deletePlaylist(pl.id);
        state.playlists = await window.k7.getPlaylists();
        if (state.view.type === 'playlist' && state.view.id === pl.id) state.view = { type: 'all' };
        renderPlaylistSidebar();
        renderCurrentView();
        updateNavActive();
      });

      item.append(label, count, del);
      item.addEventListener('click', () => {
        state.view = { type: 'playlist', id: pl.id };
        updateNavActive();
        renderPlaylistSidebar();
        renderCurrentView();
      });
      el.playlistList.appendChild(item);
    }
  }

  function updateNavActive() {
    document.querySelectorAll('.nav-item').forEach((btn) => {
      const isAll = btn.dataset.view === 'all' && state.view.type === 'all';
      const isArtists = btn.dataset.view === 'artists' && state.view.type === 'artists';
      btn.classList.toggle('active', isAll || isArtists);
    });
  }

  // ---------- Track row ----------

  function makeTrackRow(track, idx, queueList) {
    const row = document.createElement('div');
    row.className = 'track-row';
    row.dataset.trackId = track.id;
    if (player.currentTrack()?.id === track.id) row.classList.add('playing');

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

    row.append(idxCell, titleCell, artistCell, albumCell, durCell, addBtn);
    row.addEventListener('click', () => {
      player.setQueue(queueList, idx);
    });
    return row;
  }

  function makeListHeader() {
    const header = document.createElement('div');
    header.className = 'list-header';
    header.innerHTML = '<span>#</span><span>TITLE</span><span>ARTIST</span><span>ALBUM</span><span></span><span></span>';
    return header;
  }

  // ---------- Views ----------

  function renderCurrentView() {
    el.viewRoot.innerHTML = '';

    if (state.view.type === 'all') {
      el.viewTitle.textContent = 'ALL TRACKS';
      renderFlatList(state.allTracks.filter((t) => matchesSearch(t, state.search)));
      return;
    }

    if (state.view.type === 'artists') {
      el.viewTitle.textContent = 'ARTISTS / ALBUMS';
      renderArtistTree();
      return;
    }

    if (state.view.type === 'playlist') {
      const pl = state.playlists.find((p) => p.id === state.view.id);
      if (!pl) { state.view = { type: 'all' }; renderCurrentView(); return; }
      el.viewTitle.textContent = pl.name.toUpperCase();
      const tracks = pl.trackIds.map((id) => state.tracksById.get(id)).filter(Boolean);
      renderFlatList(tracks.filter((t) => matchesSearch(t, state.search)), pl);
      return;
    }
  }

  function renderFlatList(tracks, playlistContext) {
    if (tracks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = state.allTracks.length === 0
        ? 'NO TRACKS INDEXED YET.<br><span class="accent">+ ADD FOLDER</span> in the sidebar to point K7 at your music.'
        : 'NO TRACKS MATCH THIS VIEW.';
      el.viewRoot.appendChild(empty);
      return;
    }
    el.viewRoot.appendChild(makeListHeader());
    tracks.forEach((t, i) => el.viewRoot.appendChild(makeTrackRow(t, i, tracks)));
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
          tracks: al.tracks.filter((t) => artistMatches || matchesSearch(t, state.search) || al.album.toLowerCase().includes(q)),
        }))
        .filter((al) => artistMatches || al.tracks.length > 0);

      if (!artistMatches && visibleAlbums.length === 0) continue;

      const artistNode = document.createElement('details');
      artistNode.className = 'artist-node';
      const summary = document.createElement('summary');
      summary.textContent = `${artistEntry.artist} (${artistEntry.albums.reduce((n, a) => n + a.tracks.length, 0)})`;
      artistNode.appendChild(summary);

      for (const album of visibleAlbums) {
        const albumNode = document.createElement('details');
        albumNode.className = 'album-node';
        const albumSummary = document.createElement('summary');
        albumSummary.textContent = `${album.album} (${album.tracks.length})`;
        albumNode.appendChild(albumSummary);
        album.tracks.forEach((t, i) => albumNode.appendChild(makeTrackRow(t, i, album.tracks)));
        artistNode.appendChild(albumNode);
      }
      el.viewRoot.appendChild(artistNode);
    }
  }

  // ---------- Modals ----------

  function closeModal() {
    el.modalRoot.innerHTML = '';
  }

  function openModal(html, onMount) {
    el.modalRoot.innerHTML = `<div class="modal-backdrop"><div class="modal-box">${html}</div></div>`;
    el.modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-backdrop')) closeModal();
    });
    onMount(el.modalRoot.querySelector('.modal-box'));
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
          renderPlaylistSidebar();
          state.view = { type: 'playlist', id: pl.id };
          updateNavActive();
          renderPlaylistSidebar();
          renderCurrentView();
          closeModal();
        };
        box.querySelector('#pl-create').addEventListener('click', create);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
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
    const items = state.playlists
      .map((pl) => `<button data-id="${pl.id}">${pl.name} (${pl.trackIds.length})</button>`)
      .join('');
    openModal(
      `<h3>ADD TO PLAYLIST</h3><div class="modal-list">${items}</div>
       <div class="modal-actions"><button id="pl-close">CLOSE</button></div>`,
      (box) => {
        box.querySelectorAll('.modal-list button').forEach((btn) => {
          btn.addEventListener('click', async () => {
            await window.k7.addTracksToPlaylist(btn.dataset.id, [trackId]);
            state.playlists = await window.k7.getPlaylists();
            renderPlaylistSidebar();
            closeModal();
          });
        });
        box.querySelector('#pl-close').addEventListener('click', closeModal);
      }
    );
  }

  // ---------- Transport UI ----------

  function updateShuffleRepeatUI() {
    el.btnShuffle.classList.toggle('on', player.shuffleOn);
    el.btnRepeat.classList.toggle('on', player.repeat !== 'off');
    el.btnRepeat.textContent = player.repeat === 'one' ? 'RPT·1' : 'RPT';
  }

  function setNowPlayingText(title) {
    el.nowTitle.textContent = title;
    el.nowTitle.classList.remove('scrolling');
    el.nowTitle.style.animation = 'none';
    requestAnimationFrame(() => {
      const wrapWidth = el.nowTitle.parentElement.clientWidth;
      const textWidth = el.nowTitle.scrollWidth;
      el.nowTitle.style.animation = '';
      if (textWidth > wrapWidth) {
        const distance = textWidth - wrapWidth + 16;
        const duration = Math.max(4, distance / 28);
        el.nowTitle.style.setProperty('--scroll-distance', `-${distance}px`);
        el.nowTitle.style.animationDuration = `${duration}s`;
        el.nowTitle.classList.add('scrolling');
      }
    });
  }

  player.onTrackChange = (track) => {
    setNowPlayingText(track.title);
    el.nowArtist.textContent = `${track.artist} — ${track.album}`;
    document.querySelectorAll('.track-row.playing').forEach((r) => r.classList.remove('playing'));
    document.querySelectorAll(`.track-row[data-track-id="${track.id}"]`).forEach((r) => r.classList.add('playing'));
  };

  player.onPlayStateChange = (isPlaying) => {
    el.btnPlayPause.textContent = isPlaying ? '❙❙' : '►';
    el.reels.classList.toggle('playing', isPlaying);
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

  // ---------- Event wiring ----------

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.view = { type: btn.dataset.view };
      updateNavActive();
      renderPlaylistSidebar();
      renderCurrentView();
    });
  });

  document.getElementById('new-playlist-btn').addEventListener('click', openNewPlaylistModal);

  document.getElementById('add-folder-btn').addEventListener('click', async () => {
    const result = await window.k7.addLibraryFolder();
    if (result.added) {
      applyScanResult(result);
      renderCurrentView();
    }
  });

  document.getElementById('rescan-btn').addEventListener('click', async () => {
    await rescan();
    renderCurrentView();
  });

  el.searchInput.addEventListener('input', (e) => {
    state.search = e.target.value;
    renderCurrentView();
  });

  el.sortSelect.addEventListener('change', async (e) => {
    state.sortMode = e.target.value;
    window.k7.saveSettings({ allSongsSort: state.sortMode });
    if (state.view.type === 'all') {
      state.allTracks = await window.k7.sortAllSongs(state.sortMode);
      renderCurrentView();
    }
  });

  document.getElementById('btn-playpause').addEventListener('click', () => player.togglePlay());
  document.getElementById('btn-next').addEventListener('click', () => player.next());
  document.getElementById('btn-prev').addEventListener('click', () => player.prev());
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
    const v = Number(e.target.value) / 100;
    player.setVolume(v);
    window.k7.saveSettings({ volume: v });
  });

  loadAll();
})();

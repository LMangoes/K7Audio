'use strict';

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
    nowTitle: document.getElementById('now-title'),
    nowArtist: document.getElementById('now-artist'),
    nowSource: document.getElementById('now-source'),
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

  /** Cover priority: explicit playlist cover -> first track's folder art -> generic placeholder. */
  function makeCoverEl(coverUrl, sizeClass) {
    const wrap = document.createElement('div');
    wrap.className = `cover-thumb ${sizeClass}`;
    if (coverUrl) {
      const img = document.createElement('img');
      img.src = coverUrl;
      img.alt = '';
      wrap.appendChild(img);
    } else {
      wrap.innerHTML = PLACEHOLDER_COVER_SVG;
    }
    return wrap;
  }

  function resolvePlaylistCover(pl) {
    if (pl.coverUrl) return pl.coverUrl;
    const firstTrack = pl.trackIds.map((id) => state.tracksById.get(id)).find((t) => t?.coverUrl);
    return firstTrack ? firstTrack.coverUrl : null;
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
      if (state.activeQueueView?.type === 'playlist' && state.activeQueueView.id === pl.id) item.classList.add('playing-from');

      const cover = makeCoverEl(resolvePlaylistCover(pl), 'cover-xs');
      const label = document.createElement('span');
      label.className = 'playlist-item-label';
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
        if (state.view.type === 'playlist' && state.view.id === pl.id) switchView({ type: 'all' });
        else renderPlaylistSidebar();
      });

      const rename = document.createElement('button');
      rename.className = 'rename-btn';
      rename.textContent = '✎';
      rename.title = 'Rename playlist';
      rename.addEventListener('click', (e) => {
        e.stopPropagation();
        openRenamePlaylistModal(pl);
      });

      item.append(cover, label, count, rename, del);
      item.addEventListener('click', () => switchView({ type: 'playlist', id: pl.id }));
      el.playlistList.appendChild(item);
    }
  }

  function updateNavActive() {
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === state.view.type);
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

    row.append(coverCell, idxCell, titleCell, artistCell, albumCell, durCell, addBtn, removeCell);
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
    header.innerHTML = '<span></span><span>#</span><span>TITLE</span><span>ARTIST</span><span>ALBUM</span><span></span><span></span><span></span>';
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
    header.appendChild(makeCoverEl(resolvePlaylistCover(pl), 'cover-lg'));

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

    const renameBtn = document.createElement('button');
    renameBtn.className = 'mini-btn';
    renameBtn.textContent = 'RENAME';
    renameBtn.addEventListener('click', () => openRenamePlaylistModal(pl));

    const btnRow = document.createElement('div');
    btnRow.className = 'playlist-cover-actions';
    btnRow.append(changeBtn, renameBtn);
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
      summary.textContent = `${artistEntry.artist} (${artistEntry.albums.reduce((n, a) => n + a.tracks.length, 0)})`;
      artistNode.appendChild(summary);

      for (const album of visibleAlbums) {
        const albumNode = document.createElement('details');
        albumNode.className = 'album-node';
        const albumSummary = document.createElement('summary');
        albumSummary.textContent = `${album.album} (${album.tracks.length})`;
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
      const label = genreEntry.genre === 'UNTAGGED' ? 'NO GENRE TAG' : genreEntry.genre;
      summary.textContent = `${label} (${genreEntry.tracks.length})`;
      genreNode.appendChild(summary);
      visibleTracks.forEach((t, i) => genreNode.appendChild(makeTrackRow(t, i, genreEntry.tracks)));
      el.viewRoot.appendChild(genreNode);
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

  // ---------- Event wiring ----------

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchView({ type: btn.dataset.view }));
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
    if (view.type === 'artists') {
      const index = await window.k7.getArtistIndex();
      return index.flatMap((a) => a.albums.flatMap((al) => al.tracks));
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
    if (view.type === 'artists') return 'ARTISTS / ALBUMS';
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
    renderPlaylistSidebar();
  }

  document.getElementById('btn-playpause').addEventListener('click', async () => {
    if (!player.currentTrack()) {
      const tracks = await getCurrentViewTracks();
      if (tracks.length === 0) return;
      setActiveQueueView({ ...state.view });
      player.setQueue(tracks, 0);
      return;
    }
    player.togglePlay();
  });
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

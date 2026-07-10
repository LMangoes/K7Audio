'use strict';

/**
 * K7Player: wraps a single <audio> element with queue/shuffle/repeat logic.
 * No framework, no external deps — kept dependency-free so this file can be
 * reused as-is if the UI shell is later swapped (e.g. a Capacitor build).
 */
class K7Player {
  constructor(audioEl) {
    this.audio = audioEl;
    this.queue = [];       // full ordered list for the current context (album/playlist/all)
    this.order = [];       // indices into queue, in play order (identity, or shuffled)
    this.position = -1;    // index into `order`
    this.repeat = 'off';   // off | all | one
    this.shuffleOn = false;

    this.audioContext = null;
    this.analyser = null;
    this.freqData = null;

    this.onTrackChange = null;  // (track) => void
    this.onPlayStateChange = null; // (isPlaying) => void
    this.onTimeUpdate = null; // (currentTime, duration) => void
    this.onQueueEnd = null; // () => void

    this.audio.addEventListener('timeupdate', () => {
      this.onTimeUpdate?.(this.audio.currentTime, this.audio.duration || 0);
    });
    this.audio.addEventListener('play', () => this.onPlayStateChange?.(true));
    this.audio.addEventListener('pause', () => this.onPlayStateChange?.(false));
    this.audio.addEventListener('ended', () => this._handleEnded());

    this._wireMediaSession();
  }

  _wireMediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.setActionHandler('play', () => this.play());
    navigator.mediaSession.setActionHandler('pause', () => this.pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => this.prev());
    navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
  }

  _updateMediaSessionMetadata(track) {
    if (!('mediaSession' in navigator) || !track) return;
    const artwork = track.coverPath
      ? [{ src: `file:///${track.coverPath.replace(/\\/g, '/').replace(/^\/+/, '')}`, sizes: '512x512', type: 'image/jpeg' }]
      : [];
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork,
    });
  }

  _freshOrder(len) {
    const identity = Array.from({ length: len }, (_, i) => i);
    if (!this.shuffleOn) return identity;
    // Fisher-Yates
    for (let i = identity.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [identity[i], identity[j]] = [identity[j], identity[i]];
    }
    return identity;
  }

  /** Loads a new queue (array of track objects with .fileUrl) and starts at startIndex. */
  setQueue(tracks, startIndex = 0, autoplay = true) {
    this.queue = tracks;
    this.order = this._freshOrder(tracks.length);
    // Bring the requested start track to the front of the play order so
    // clicking a specific song always plays that song first, even shuffled.
    const pos = this.order.indexOf(startIndex);
    if (pos > 0) {
      this.order.splice(pos, 1);
      this.order.unshift(startIndex);
    }
    this.position = 0;
    this._manualQueueCount = 0;
    this._loadCurrent(autoplay);
  }

  /** One-shot seek once the current track's metadata is available (setting
   * currentTime before duration is known is unreliable). Used after
   * setQueue(..., false) to restore a saved playback position. */
  seekOnceLoaded(seconds) {
    const target = Math.max(0, seconds || 0);
    const onLoaded = () => {
      this.audio.currentTime = target;
      this.audio.removeEventListener('loadedmetadata', onLoaded);
    };
    this.audio.addEventListener('loadedmetadata', onLoaded);
  }

  /** "Play next": inserts immediately after the current track, or after the
   * last manually-queued track if one's already pending — so queuing two
   * songs back to back plays them in that order right after the current
   * track, not buried at the end of whatever's already queued. Unaffected
   * by shuffle. If nothing is currently loaded, loads as the current track
   * instead (paused — this isn't a "play now" action). */
  addToQueue(track) {
    if (this.position < 0 || this.queue.length === 0) {
      this.queue = [track];
      this.order = [0];
      this.position = 0;
      this._manualQueueCount = 0;
      this._loadCurrent(false);
      return;
    }
    const newIndex = this.queue.length;
    this.queue = [...this.queue, track];
    const insertAt = this.position + 1 + (this._manualQueueCount || 0);
    this.order.splice(insertAt, 0, newIndex);
    this._manualQueueCount = (this._manualQueueCount || 0) + 1;
  }

  setShuffle(on) {
    this.shuffleOn = on;
    if (this.queue.length === 0) return;
    const currentTrackIdx = this.order[this.position];
    this.order = this._freshOrder(this.queue.length);
    const pos = this.order.indexOf(currentTrackIdx);
    if (pos > 0) {
      this.order.splice(pos, 1);
      this.order.unshift(currentTrackIdx);
    }
    this.position = 0;
  }

  setRepeat(mode) {
    this.repeat = mode; // off | all | one
  }

  _loadCurrent(autoplay) {
    const track = this.currentTrack();
    if (!track) return;
    this.audio.src = track.fileUrl;
    this.onTrackChange?.(track);
    this._updateMediaSessionMetadata(track);
    if (autoplay) this.play();
  }

  currentTrack() {
    if (this.position < 0 || this.position >= this.order.length) return null;
    return this.queue[this.order[this.position]];
  }

  // createMediaElementSource can only be called once per <audio> element for
  // its entire lifetime — calling it twice throws. Since this element is
  // reused across tracks (only .src changes), this must run exactly once,
  // guarded by the audioContext null-check, on the first user-gesture play().
  _ensureAudioGraph() {
    if (this.audioContext) return;
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = this.audioContext.createMediaElementSource(this.audio);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 64;
    this.analyser.smoothingTimeConstant = 0.75;
    // Analyser must forward to destination itself — createMediaElementSource
    // detaches the element from its default output, so skipping this line
    // silences all playback, not just the visualizer.
    source.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
  }

  /** Returns a live Uint8Array (0-255 per bin) or null if playback hasn't started yet. */
  getFrequencyData() {
    if (!this.analyser) return null;
    this.analyser.getByteFrequencyData(this.freqData);
    return this.freqData;
  }

  play() {
    if (!this.audio.src) return;
    this._ensureAudioGraph();
    if (this.audioContext.state === 'suspended') this.audioContext.resume();
    this.audio.play().catch(() => {
      // Autoplay/decode rejection: surface as a stopped state rather than
      // throwing into an unhandled promise rejection.
      this.onPlayStateChange?.(false);
    });
  }

  pause() {
    this.audio.pause();
  }

  togglePlay() {
    if (this.audio.paused) this.play();
    else this.pause();
  }

  next(userInitiated = true) {
    if (this.queue.length === 0) return;
    if (this.position + 1 < this.order.length) {
      this.position += 1;
      this._manualQueueCount = Math.max(0, (this._manualQueueCount || 0) - 1);
    } else if (this.repeat === 'all' || userInitiated) {
      // Wrap around. A fresh shuffle order is drawn each lap so repeats
      // don't follow the same sequence every time round.
      this.order = this._freshOrder(this.queue.length);
      this.position = 0;
      this._manualQueueCount = 0;
    } else {
      this.onQueueEnd?.();
      return;
    }
    this._loadCurrent(true);
  }

  prev() {
    if (this.queue.length === 0) return;
    if (this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      return;
    }
    if (this.position > 0) {
      this.position -= 1;
    } else {
      this.position = this.order.length - 1;
    }
    this._loadCurrent(true);
  }

  seekTo(fractionOrSeconds, asFraction = false) {
    if (!this.audio.duration) return;
    this.audio.currentTime = asFraction ? fractionOrSeconds * this.audio.duration : fractionOrSeconds;
  }

  setVolume(v) {
    this.audio.volume = Math.min(1, Math.max(0, v));
  }

  _handleEnded() {
    if (this.repeat === 'one') {
      this.audio.currentTime = 0;
      this.play();
      return;
    }
    this.next(false);
  }
}

window.K7Player = K7Player;

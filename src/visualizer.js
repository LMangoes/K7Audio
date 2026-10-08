'use strict';

/**
 * BAR_COUNT must match player.js's analyser.fftSize/2 (frequencyBinCount).
 * Kept as a local constant rather than read from the analyser because the
 * analyser doesn't exist until the first play() call, but the visualizer
 * has to render an at-rest (all-zero) state before that.
 */
const BAR_COUNT = 32;

class K7Visualizer {
  constructor(canvas, player) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.player = player;
    this.levels = new Array(BAR_COUNT).fill(0);
    this.peaks = new Array(BAR_COUNT).fill(0);

    this._resize();
    window.addEventListener('resize', () => this._resize());
    requestAnimationFrame(() => this._draw());
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }

  _draw() {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const data = this.player.audio.paused ? null : this.player.getFrequencyData();

    const gap = Math.max(1, w * 0.006);
    const barWidth = w / BAR_COUNT;
    const half = BAR_COUNT / 2;

    const gradient = ctx.createLinearGradient(0, h, 0, 0);
    gradient.addColorStop(0, '#3dff8f');
    gradient.addColorStop(1, '#ff2fb0');

    for (let j = 0; j < half; j++) {
      // Sample every other bin (0,2,4,...) so the half-count mirror still
      // spans the full bass-to-treble range instead of only the lower half.
      const target = data ? data[j * 2] / 255 : 0;

      for (const slot of [half - 1 - j, half + j]) {
        const prev = this.levels[slot];
        // Fast attack, slower release: bars jump up on a beat, ease back down
        // rather than dropping instantly, which reads as jittery.
        this.levels[slot] = target > prev ? prev + (target - prev) * 0.6 : prev + (target - prev) * 0.18;

        const barH = this.levels[slot] * h;
        this.peaks[slot] = barH > this.peaks[slot] ? barH : Math.max(0, this.peaks[slot] - h * 0.03);

        const x = slot * barWidth + gap / 2;
        const bw = Math.max(1, barWidth - gap);

        ctx.fillStyle = gradient;
        ctx.shadowColor = 'rgba(255,47,176,0.35)';
        ctx.shadowBlur = h * 0.15;
        ctx.fillRect(x, h - barH, bw, barH);

        if (this.peaks[slot] > 2) {
          ctx.shadowBlur = 0;
          ctx.fillStyle = '#e8fff0';
          ctx.fillRect(x, Math.max(0, h - this.peaks[slot] - 1.5), bw, 1.5);
        }
      }
    }

    requestAnimationFrame(() => this._draw());
  }
}

window.K7Visualizer = K7Visualizer;

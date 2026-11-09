import { frameAt } from '../skills/UiMaskDocument.js';

// Compatibility playback for browsers without requestVideoFrameCallback.
// The native clock is not evidence of which pixels drawImage(video) will read.
// Keep native playback paused and commit only completed, indexed seeks instead.
export class UiMaskSeekPlayback {
  constructor(video, source, { onFrame, onState = () => {}, now = () => performance.now(),
    schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id) }) {
    Object.assign(this, { video, source, onFrame, onState, now, schedule, cancel });
    this.frame = 0; this.target = 0; this.seekTime = 0; this.playing = false;
    this.nativePause = video.pause.bind(video);
    this.pauseDescriptor = Object.getOwnPropertyDescriptor(video, 'pause');
    this.playDescriptor = Object.getOwnPropertyDescriptor(video, 'play');
    // Existing editor tools pause through this public video interface. Preserve
    // that contract so drawing/selection/closing also stop compatibility playback.
    video.pause = () => this.pause();
    video.play = () => { this.play(); return Promise.resolve(); };
    this.ready = () => this.commitReady();
    video.addEventListener('loadeddata', this.ready);
    video.addEventListener('seeked', this.ready);
  }

  request(frame) {
    this.target = Math.max(0, Math.min(this.source.frames - 1, Math.round(frame)));
    const start = this.source.times[this.target];
    const end = this.source.times[this.target + 1] ?? this.source.duration;
    this.seekTime = start + Math.min(.01, (end - start) / 2);
    this.video.currentTime = this.seekTime;
  }

  seek(frame) { this.pause(); this.request(frame); }

  commitReady() {
    if (this.closed || this.target == null || this.video.seeking || this.video.readyState < 2 ||
        Math.abs(this.video.currentTime - this.seekTime) > .00001) return;
    const frame = this.target;
    this.target = null; this.frame = frame;
    this.onFrame(frame);
    if (this.playing) this.scheduleNext();
  }

  play() {
    if (this.closed || this.playing) return;
    this.nativePause(); this.playing = true;
    this.anchorFrame = this.target ?? this.frame;
    if (this.anchorFrame === this.source.frames - 1) { this.anchorFrame = 0; this.request(0); }
    this.anchorTime = this.source.times[this.anchorFrame]; this.anchorWall = this.now();
    this.rate = this.video.playbackRate || 1;
    if (this.target == null) this.scheduleNext();
    this.onState();
  }

  scheduleNext() {
    this.cancel(this.timer);
    if (this.closed || !this.playing) return;
    if (this.rate !== this.video.playbackRate) {
      this.anchorTime = this.source.times[this.frame]; this.anchorWall = this.now();
      this.rate = this.video.playbackRate || 1;
    }
    const next = this.source.times[this.frame + 1] ?? this.source.duration;
    const due = this.anchorWall + (next - this.anchorTime) * 1000 / this.rate;
    this.timer = this.schedule(() => this.tick(), Math.max(0, due - this.now()));
  }

  tick() {
    if (this.closed || !this.playing || this.target != null) return;
    const time = this.anchorTime + (this.now() - this.anchorWall) * this.rate / 1000;
    if (time >= this.source.duration) {
      if (this.frame < this.source.frames - 1) { this.request(this.source.frames - 1); return; }
      if (this.video.loop) {
        this.anchorTime = 0; this.anchorWall = this.now(); this.request(0);
      } else this.pause();
      return;
    }
    const frame = Math.max(this.frame + 1, frameAt(this.source.times, time));
    if (frame < this.source.frames) this.request(frame);
    else this.scheduleNext();
  }

  pause() {
    this.playing = false; this.cancel(this.timer); this.nativePause(); this.onState();
  }

  close() {
    if (this.closed) return;
    this.closed = true; this.pause();
    this.video.removeEventListener('loadeddata', this.ready);
    this.video.removeEventListener('seeked', this.ready);
    for (const [name, descriptor] of [['pause', this.pauseDescriptor], ['play', this.playDescriptor]]) {
      if (descriptor) Object.defineProperty(this.video, name, descriptor);
      else delete this.video[name];
    }
  }
}

import { startEditorGesture } from './EditorInteraction.js';
import { vertex, setAppearanceValue } from '../skills/UiMaskAppearance.js';
import { pathDraftGeometry } from './UiMaskPathGeometry.js';

export class UiMaskPathDrawing {
  constructor(editor) { this.e = editor; this.points = []; }
  reset() { this.points = []; }
  redraw() { if (this.e.viewport) this.e.viewport.draw(); else this.e.draw(); }
  keydown(event) {
    if (this.e.tool !== 'pen' || !this.points.length) return false;
    if (event.key.toLowerCase() === 's' && !event.ctrlKey && !event.metaKey) {
      this.e.status('请先完成当前轮廓，再给它设置关键帧'); return true;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      this.points.pop(); this.redraw(); return true;
    }
    if (event.key === 'Enter') { this.finish(); return true; }
    if (['Backspace', 'Delete'].includes(event.key)) {
      this.points.pop(); this.redraw(); return true;
    }
    return false;
  }
  pointer(event) {
    const e = this.e;
    e.video.pause(); e.keyFocus = false; e.canvas.focus({ preventScroll: true });
    const p = e.point(event, false), rect = e.canvas.getBoundingClientRect();
    const distance = (a, b) => Math.hypot((a[0] - b[0]) * rect.width, (a[1] - b[1]) * rect.height);
    if (this.points.length >= 3 && distance(p, this.points[0].point) < 10) { this.finish(); return; }
    if (this.points.length >= 4096) { e.status('轮廓已达到点数上限，请完成当前轮廓'); return; }
    const before = structuredClone(this.points), v = vertex(...p);
    this.points.push(v); this.redraw();
    startEditorGesture(event, { element: e.canvas, scope: e.dialog,
      move: ev => {
        const q = e.point(ev, false);
        if (distance(q, p) < 3) return;
        v.out = q.map((n, i) => n - p[i]); v.in = v.out.map(n => -n); this.redraw();
      },
      end: () => e.draw(),
      cancel: () => { this.points = before; this.redraw(); },
    });
  }
  finish() {
    const e = this.e;
    if (e.node.busy || !this.points.length) return;
    try {
      const { box, path } = pathDraftGeometry(this.points, e.node.document.source);
      e.edit(() => {
        const t = e.newTrack(e.category, box, e.frame);
        setAppearanceValue(t, 'shape', e.frame, path);
        e.node.document.tracks.push(t); e.selected = t.id; e.selectedKey = null;
      });
      this.reset(); e.property = 'shape'; e.setTool('select');
      e.status('轮廓已完成，可拖动点和手柄；画幅外的路径也会保存。');
    } catch (error) { e.status(error.message); }
  }
  draw(ctx, scale) {
    if (!this.points.length) return;
    const { width: w, height: h } = this.e.canvas;
    ctx.beginPath();
    this.points.forEach((v, i) => {
      if (!i) { ctx.moveTo(v.point[0] * w, v.point[1] * h); return; }
      const a = this.points[i - 1];
      ctx.bezierCurveTo((a.point[0] + a.out[0]) * w, (a.point[1] + a.out[1]) * h,
        (v.point[0] + v.in[0]) * w, (v.point[1] + v.in[1]) * h, v.point[0] * w, v.point[1] * h);
    });
    ctx.strokeStyle = '#aaf7e1'; ctx.lineWidth = 2 * scale; ctx.stroke();
    for (const [i, v] of this.points.entries()) {
      ctx.fillStyle = i ? '#aaf7e1' : '#ffe095';
      ctx.fillRect(v.point[0] * w - 4 * scale, v.point[1] * h - 4 * scale, 8 * scale, 8 * scale);
    }
    const v = this.points.at(-1);
    for (const side of ['in', 'out']) if (v[side].some(Boolean)) {
      const x = (v.point[0] + v[side][0]) * w, y = (v.point[1] + v[side][1]) * h;
      ctx.strokeStyle = '#e8b97d'; ctx.lineWidth = scale;
      ctx.beginPath(); ctx.moveTo(v.point[0] * w, v.point[1] * h); ctx.lineTo(x, y); ctx.stroke();
      ctx.fillStyle = '#e8b97d'; ctx.fillRect(x - 3 * scale, y - 3 * scale, 6 * scale, 6 * scale);
    }
  }
}

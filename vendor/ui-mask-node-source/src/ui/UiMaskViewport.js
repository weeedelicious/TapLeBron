import { trackPolygon } from '../skills/UiMaskDocument.js';

// Editing guides use the stage viewport, not the source image's clipped bitmap.
// All tools share the same video-to-screen transform, including zoom and scroll.
export class UiMaskViewport {
  constructor(editor) {
    this.e = editor;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ui-mask-guides';
    this.canvas.setAttribute('aria-hidden', 'true');
    editor.dialog.append(this.canvas);
    editor.$('.ui-mask-stage').addEventListener('scroll', () => this.draw(), { signal: editor.abort.signal });
  }
  draw() {
    const e = this.e, stage = e.$('.ui-mask-stage'), bounds = stage.getBoundingClientRect();
    const r = e.canvas.getBoundingClientRect(), canvas = this.canvas, dpr = window.devicePixelRatio || 1;
    const width = stage.clientWidth, height = stage.clientHeight;
    Object.assign(canvas.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${width}px`, height: `${height}px` });
    const pixelWidth = Math.round(width * dpr), pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!r.width || !width || !height) return;
    const w = e.canvas.width, h = e.canvas.height, scale = w / r.width;
    ctx.setTransform(dpr * r.width / w, 0, 0, dpr * r.height / h, dpr * (r.left - bounds.left), dpr * (r.top - bounds.top));
    // Expose off-frame contours for every mask, including after leaving path mode.
    for (const t of e.visibleTracks()) {
      const points = trackPolygon(t, e.frame, e.node.document.source);
      if (!points) continue;
      ctx.strokeStyle = e.selectedIds.has(t.id) ? '#aaf7e1' : t.enabled ? (t.kind === 'static' ? '#57d9b4' : '#ab99ff') : '#777';
      ctx.lineWidth = (e.selectedIds.has(t.id) ? 3 : 1) * scale;
      ctx.beginPath();
      points.forEach((p, i) => i ? ctx.lineTo(p[0] * w, p[1] * h) : ctx.moveTo(p[0] * w, p[1] * h));
      ctx.closePath(); ctx.stroke();
    }
    e.pathEditor?.draw(ctx);
    e.pathDrawing?.draw(ctx, scale);
  }
}

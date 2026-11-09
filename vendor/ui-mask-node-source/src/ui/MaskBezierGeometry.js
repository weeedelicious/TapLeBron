const mix = (a, b, t) => a.map((n, i) => n + (b[i] - n) * t);
const sub = (a, b) => a.map((n, i) => n - b[i]);
const control = (v, side) => v.point.map((n, i) => n + v[side][i]);

// Migrated from MaskEditor.insertPoint: project onto 64 short curve segments,
// then split with de Casteljau so inserting an anchor preserves the contour.
// Both mask workspaces use this operation; toScreen returns CSS pixels.
export function insertPathPoint(path, cursor, toScreen, threshold = 12) {
  if (path.length < 2 || path.length >= 4096) return null;
  let best = null, distance = threshold;
  const count = path.length >= 3 ? path.length : path.length - 1;
  for (let i = 0; i < count; i++) {
    const a = path[i].point, b = control(path[i], 'out');
    const next = path[(i + 1) % path.length], c = control(next, 'in'), d = next.point;
    let previous = toScreen(a);
    for (let k = 1; k <= 64; k++) {
      const t = k / 64;
      const curve = mix(mix(mix(a,b,t),mix(b,c,t),t),mix(mix(b,c,t),mix(c,d,t),t),t);
      const p = toScreen(curve), delta = sub(p, previous), offset = sub(cursor, previous);
      const u = Math.max(0, Math.min(1, (offset[0]*delta[0]+offset[1]*delta[1])/(delta[0]**2+delta[1]**2 || 1)));
      const dist = Math.hypot(offset[0]-u*delta[0], offset[1]-u*delta[1]);
      if (dist < distance) { distance = dist; best = {i, t:(k-1+u)/64, a,b,c,d}; }
      previous = p;
    }
  }
  if (!best || best.t < .01 || best.t > .99) return null;
  const {i,t,a,b,c,d} = best, result = structuredClone(path);
  const ab=mix(a,b,t), bc=mix(b,c,t), cd=mix(c,d,t);
  const left=mix(ab,bc,t), right=mix(bc,cd,t), point=mix(left,right,t);
  result[i].out=sub(ab,a); result[(i+1)%path.length].in=sub(cd,d);
  result.splice(i+1,0,{point,in:sub(left,point),out:sub(right,point)});
  return {path:result,index:i+1};
}

"""Split the compass plate into small tick+label boxes that follow per frame.

Whole-band masks starve Seedance of nearby pixels. Other HUD plates are unchanged.
"""
import cv2
import numpy as np


# Full-width tick row: split-screen compass spans the whole top, not the old 0.27–0.75 band.
TICK_X0, TICK_X1 = 0.02, 0.985


def _tick_band(frame):
    h, w = frame.shape[:2]
    return h, w, int(w * TICK_X0), int(w * TICK_X1), 0, int(h * 0.12)


def compass_tick_boxes(frame, width=None, height=None):
    """Return pixel xyxy boxes for every visible tick+label on the top strip."""
    h, w, x0, x1, y0, y1 = _tick_band(frame)
    gray = cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    ticks = []
    for th in (205, 185, 165, 145):
        binary = np.uint8(gray > th)
        binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, np.ones((2, 1), np.uint8))
        count, _, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
        found = []
        for i in range(1, count):
            bx, by, bw, bh, area = stats[i]
            if 1 <= bw <= 7 and 5 <= bh <= 26 and bh >= bw * 1.6 and area >= 6:
                found.append((bx, by, bw, bh))
        if len(found) > len(ticks):
            ticks = found
    if not ticks:
        return []
    ticks.sort(key=lambda t: t[0])
    groups = []
    for bx, by, bw, bh in ticks:
        cx = bx + bw / 2
        if groups and cx - groups[-1]['cx'] < 14:
            g = groups[-1]
            g['x0'] = min(g['x0'], bx)
            g['y0'] = min(g['y0'], by)
            g['x1'] = max(g['x1'], bx + bw)
            g['y1'] = max(g['y1'], by + bh)
            g['cx'] = 0.5 * (g['x0'] + g['x1'])
        else:
            groups.append(dict(x0=bx, y0=by, x1=bx + bw, y1=by + bh, cx=cx))
    pad_x, pad_top, label_h = 22, 4, 52
    boxes = []
    for g in groups:
        px0 = x0 + g['x0'] - pad_x
        px1 = x0 + g['x1'] + pad_x
        py0 = y0 + g['y0'] - pad_top
        py1 = y0 + g['y0'] + label_h
        box = [max(0, px0), max(0, py0), min(w, px1), min(h, py1)]
        if box[2] - box[0] >= 12 and box[3] - box[1] >= 16 and box[1] <= h * 0.09:
            cx = 0.5 * (box[0] + box[2]) / w
            if TICK_X0 <= cx <= TICK_X1:
                boxes.append(box)
    # drop boxes that collide too much (keep left)
    kept = []
    for box in boxes:
        if kept and box[0] < kept[-1][2] - 8:
            continue
        kept.append(box)
    return kept


def tick_centers(frame):
    """Local-contrast peaks in the tick row; works when ticks are not globally bright."""
    h, w, x0, x1, y0, y1 = _tick_band(frame)
    y1 = int(h * 0.10)
    gray = cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    row = gray[:max(8, int(gray.shape[0] * 0.58))]
    colmax = row.max(axis=0).astype(np.float32)
    baseline = cv2.GaussianBlur(colmax.reshape(1, -1), (0, 0), 7).ravel()
    resp = colmax - baseline
    peaks = []
    for i in range(3, len(resp) - 3):
        if resp[i] >= resp[i - 1] and resp[i] >= resp[i + 1] and resp[i] > 6:
            peaks.append((i, float(resp[i])))
    peaks.sort(key=lambda p: -p[1])
    taken = np.zeros(len(resp), np.bool_)
    xs = []
    for i, _score in peaks:
        if taken[max(0, i - 9):i + 10].any():
            continue
        taken[max(0, i - 9):i + 10] = True
        xs.append(x0 + i)
    xs.sort()
    if not xs:
        return []
    ys = []
    for x in xs:
        col = gray[:, max(0, x - x0 - 2):min(gray.shape[1], x - x0 + 3)].mean(axis=1)
        ys.append(y0 + int(np.argmax(col[:max(1, int(len(col) * 0.7))])))
    return list(zip(xs, ys))


def fit_lattice(xs, min_spacing=58, max_spacing=140):
    xs = np.asarray(sorted(float(x) for x in xs))
    if len(xs) < 2:
        return None
    gaps = np.diff(xs)
    plausible = gaps[(gaps >= min_spacing) & (gaps <= max_spacing)]
    if len(plausible) == 0:
        doubled = gaps[(gaps >= min_spacing / 2) & (gaps <= max_spacing / 2)] * 2
        plausible = doubled[(doubled >= min_spacing) & (doubled <= max_spacing)]
    if len(plausible) == 0:
        return None
    spacing = float(np.median(plausible))
    phases = np.mod(xs, spacing)
    ang = phases / spacing * 2 * np.pi
    phase = (np.arctan2(np.mean(np.sin(ang)), np.mean(np.cos(ang))) % (2 * np.pi)) * spacing / (2 * np.pi)
    dist = np.abs(np.mod(xs - phase + spacing / 2.0, spacing) - spacing / 2.0)
    inliers = int(np.sum(dist <= 12))
    if inliers < 2:
        return None
    return dict(spacing=spacing, phase=phase, inliers=inliers)


def lattice_slots(phase, spacing, x0, x1, w):
    if spacing <= 1:
        return []
    x = phase
    while x > x0:
        x -= spacing
    slots = []
    while x < x1:
        if 0.272 * w <= x <= 0.75 * w:
            slots.append(float(x))
        x += spacing
    return slots


def boxes_from_slots(slots, y, w, h):
    pad_x, pad_top, label_h = 22, 4, 52
    boxes = []
    for x in slots:
        box = [max(0, x - pad_x), max(0, y - pad_top), min(w, x + pad_x), min(h, y + label_h)]
        if box[2] - box[0] >= 12 and box[3] - box[1] >= 16:
            boxes.append(box)
    return boxes


def _column_response(gray, x0):
    row = gray[:max(8, int(gray.shape[0] * 0.58))]
    colmax = row.max(axis=0).astype(np.float32)
    baseline = cv2.GaussianBlur(colmax.reshape(1, -1), (0, 0), 7).ravel()
    return colmax - baseline


def _has_local_tick(resp, x_full, x0, min_resp=6, radius=10):
    i = int(round(x_full - x0))
    if i < radius or i >= len(resp) - radius:
        return False
    return float(np.max(resp[i - radius:i + radius + 1])) >= min_resp


def compass_tick_boxes_structured(frame, state=None):
    """Search with lattice+flow, but only emit boxes that still have tick evidence."""
    h, w, x0, x1, y0, y1 = _tick_band(frame)
    gray = cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    resp = _column_response(gray, x0)
    detected = compass_tick_boxes(frame)
    raw_n = len(detected)
    fx = fy = 0.0
    if state and state.get('prev_gray') is not None:
        flow = cv2.calcOpticalFlowFarneback(state['prev_gray'], gray, None,
                                            0.5, 3, 15, 3, 5, 1.2, 0)
        fx = float(np.median(flow[:, :, 0]))
        fy = float(np.median(flow[:, :, 1]))
    boxes = list(detected)
    for box in (state or {}).get('boxes') or []:
        shifted = [box[0] + fx, box[1] + fy, box[2] + fx, box[3] + fy]
        cx = 0.5 * (shifted[0] + shifted[2])
        if not (TICK_X0 * w <= cx <= TICK_X1 * w):
            continue
        if not _has_local_tick(resp, cx, x0, min_resp=8):
            continue
        if any(abs(cx - 0.5 * (b[0] + b[2])) < 16 for b in boxes):
            continue
        boxes.append(shifted)
    boxes.sort(key=lambda b: b[0])
    kept = []
    for box in boxes:
        box = [max(0, box[0]), max(0, box[1]), min(w, box[2]), min(h, box[3])]
        if box[2] - box[0] < 12 or box[3] - box[1] < 16:
            continue
        if kept and box[0] < kept[-1][2] - 8:
            continue
        kept.append(box)
    y = float(np.median([b[1] for b in kept])) if kept else (state or {}).get('y', h * 0.03)
    return kept, dict(prev_gray=gray, y=y, raw_n=raw_n, filled=len(kept), boxes=kept)


def _norm_box(box, width, height):
    x0, y0, x1, y1 = box
    return [x0 / width, y0 / height, x1 / width, y1 / height]


def _center(box):
    return 0.5 * (box[0] + box[2]), 0.5 * (box[1] + box[3])


def track_compass_ticks(job, source, meta):
    """Follow compass ticks with constellation+flow, then associate by center."""
    from ui_mask_trained import observed_ranges

    width, height = meta['width'], meta['height']
    max_dx, max_dy, buffer, min_len = 48.0, 30.0, 12, 12
    live, finished, next_id = [], [], 1
    state = None
    cap = cv2.VideoCapture(str(source))
    try:
        for frame in range(meta['frames']):
            job.check()
            ok, image = cap.read()
            if not ok:
                raise ValueError(f'无法读取第{frame+1}帧，请检查视频')
            boxes, state = compass_tick_boxes_structured(image, state)
            used = set()
            for track in live:
                lx, ly = _center(track['last_box'])
                best, best_i = 1e9, None
                for i, box in enumerate(boxes):
                    if i in used:
                        continue
                    cx, cy = _center(box)
                    dist = abs(cx - lx) + 0.6 * abs(cy - ly)
                    if dist < best:
                        best, best_i = dist, i
                if best_i is not None and abs(_center(boxes[best_i])[0] - lx) <= max_dx and abs(_center(boxes[best_i])[1] - ly) <= max_dy:
                    box = boxes[best_i]
                    used.add(best_i)
                    track['samples'].append(dict(frame=frame, box=_norm_box(box, width, height), confidence=0.9))
                    track['last_box'] = box
                    track['miss'] = 0
                else:
                    track['miss'] += 1
            for i, box in enumerate(boxes):
                if i in used:
                    continue
                live.append(dict(id=next_id, samples=[dict(frame=frame, box=_norm_box(box, width, height), confidence=0.9)],
                                 last_box=box, miss=0))
                next_id += 1
            still = []
            for track in live:
                if track['miss'] <= buffer:
                    still.append(track)
                else:
                    finished.append(track)
            live = still
            if frame % 20 == 0 or frame == meta['frames'] - 1:
                job.status('running', f'罗盘小块跟随 {frame+1}/{meta["frames"]}',
                           92 + 6 * (frame + 1) / meta['frames'])
    finally:
        cap.release()
    finished.extend(live)
    tracks = []
    for index, raw in enumerate(finished, 1):
        if len(raw['samples']) < min_len:
            continue
        tracks.append(dict(
            id=f'compass-tick-{raw["id"]}', label=f'罗盘刻度 {index}', kind='dynamic',
            enabled=True, origin='auto-detected', detectorVersion=3,
            modelVersion='hud-panel-a15-20261027', requiresManualReview=True,
            panelName='compass_tick',
            classificationReason='罗盘刻度按帧跟随，归入动态遮罩；静态修复保留这一排作为参考画面',
            confidence=0.9, ranges=observed_ranges(s['frame'] for s in raw['samples']),
            samples=raw['samples'], keys=[], overrides=[]))
    return tracks


def drop_whole_compass(tracks, panels):
    compass = next((p for p in panels if p['name'] == 'compass'), None)
    kept = []
    for track in tracks:
        if track.get('panelName') == 'compass':
            continue
        samples = track.get('samples') or []
        if compass and samples and not track.get('panelName'):
            med = np.median(np.asarray([s['box'] for s in samples], dtype=float), axis=0)
            cx, cy = (med[0] + med[2]) / 2, (med[1] + med[3]) / 2
            if compass['box'][0] <= cx <= compass['box'][2] and cy <= 0.18:
                continue
        kept.append(track)
    return kept

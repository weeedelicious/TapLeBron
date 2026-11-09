"""Lossless contour review data. Unlabelled pixels are NEVER background.

This is an offline annotation contract, not a production detector or trainer.
Coordinates are source pixel centres; each part has an outer ring and holes.
Parts are unioned without joining disconnected components with fake bridges.
"""
from collections import defaultdict
import math

import cv2
import numpy as np

BACKGROUND, UI, UNCERTAIN, UNKNOWN = 0, 1, 2, 255
DEFAULT_REPAIR_MARGIN_PX = 4


def expand_repair_mask(mask, margin_px=DEFAULT_REPAIR_MARGIN_PX):
    """Per-frame repair allowance, separate from truth and uncertainty labels.

    Boolean input is mandatory: four-state annotation PNGs must not accidentally
    turn unknown/background/uncertainty into repair targets. A square kernel
    matches the pilot's existing two-pixel outer-band pixel convention.
    """
    array = np.asarray(mask)
    if array.dtype != np.bool_ or array.ndim != 2 or 0 in array.shape:
        raise ValueError('Repair expansion requires a nonempty 2D boolean UI mask')
    if type(margin_px) is not int or not 0 <= margin_px <= 64:
        raise ValueError('Repair margin must be an integer from 0 to 64 source pixels')
    if not margin_px:
        return array.copy()
    kernel = np.ones((2*margin_px+1, 2*margin_px+1), np.uint8)
    return cv2.dilate(array.astype(np.uint8), kernel,
                      borderType=cv2.BORDER_CONSTANT, borderValue=0).astype(bool)


def polygon_mask(points, width, height):
    points = np.asarray(points, dtype=float)
    if (points.ndim != 2 or points.shape[1] != 2 or len(points) < 3
            or not np.isfinite(points).all()
            or (points < 0).any() or (points[:, 0] > width-1).any()
            or (points[:, 1] > height-1).any()):
        raise ValueError('Invalid source-pixel polygon')
    if abs(cv2.contourArea(points.astype(np.float32))) < .5:
        raise ValueError('Degenerate polygon')
    mask = np.zeros((height, width), np.uint8)
    cv2.fillPoly(mask, [np.rint(points).astype(np.int32)], 1)
    return mask.astype(bool)


def shape_mask(parts, width, height):
    if not parts:
        raise ValueError('A visible shape needs at least one part')
    result = np.zeros((height, width), bool)
    for part in parts:
        # Exact reviewed raster support, including isolated pixels and 1px
        # strokes that cannot be represented by a nondegenerate polygon.
        # Runs are [source_y, source_x_start, source_x_end_exclusive].
        if 'pixel_runs' in part:
            if set(part) != {'pixel_runs'} or not part['pixel_runs']:
                raise ValueError('Pixel runs cannot mix polygon geometry or be empty')
            for run in part['pixel_runs']:
                if (not isinstance(run, list) or len(run) != 3
                        or any(type(v) is not int for v in run)):
                    raise ValueError('Pixel runs require three integer coordinates')
                y, left, right = run
                if not (0 <= y < height and 0 <= left < right <= width):
                    raise ValueError('Pixel run outside source image')
                result[y, left:right] = True
            continue
        outer = polygon_mask(part['outer'], width, height)
        layer = outer.copy()
        for ring in part.get('holes', []):
            hole = polygon_mask(ring, width, height)
            if (hole & ~outer).any():
                raise ValueError('Hole lies outside its own part')
            layer &= ~hole
        if not layer.any():
            raise ValueError('Empty contour part')
        result |= layer
    return result


def mask_to_parts(mask):
    """Lossless serialization of reviewed native binary pixels, never a trace
    simplification, confidence threshold or annotation admission decision.
    """
    mask = np.asarray(mask)
    if (mask.dtype != np.bool_ or mask.ndim != 2 or 0 in mask.shape
            or not mask.any()):
        raise ValueError('Expected a nonempty reviewed boolean foreground mask')
    changes = np.diff(np.pad(mask.astype(np.int8), ((0, 0), (1, 1))), axis=1)
    ys, starts = np.where(changes == 1)
    ye, ends = np.where(changes == -1)
    assert np.array_equal(ys, ye)
    return [{'pixel_runs': [[int(y), int(x), int(end)]
                            for y, x, end in zip(ys, starts, ends)]}]


def boundary_masks(mask, radius):
    if type(radius) is not int or not 0 <= radius <= 8:
        raise ValueError('Boundary uncertainty must be an integer from 0 to 8')
    if not radius:
        return mask.copy(), np.zeros_like(mask)
    kernel = np.ones((2*radius+1, 2*radius+1), np.uint8)
    # Out-of-frame pixels are not evidence; only the visible image is labelled.
    core = cv2.erode(mask.astype(np.uint8), kernel,
                     borderType=cv2.BORDER_CONSTANT, borderValue=1).astype(bool)
    support = cv2.dilate(mask.astype(np.uint8), kernel,
                        borderType=cv2.BORDER_CONSTANT, borderValue=0).astype(bool)
    return core, support & ~core


def rasterize(record, width, height, radius):
    labels = np.full((height, width), UNKNOWN, np.uint8)
    foreground = np.zeros((height, width), bool)
    positive = np.zeros_like(foreground)
    uncertain = np.zeros_like(positive)
    negative = np.zeros_like(positive)
    instances = {}
    objects = {}
    raw_masks = {}
    for obj in record.get('instances', []):
        identity = obj['instance_id']
        if identity in objects:
            raise ValueError('Duplicate instance on a frame')
        if obj.get('geometry_source') not in ('manual_visual_contour', 'assisted_visual_contour'):
            raise ValueError('Boxes or unaudited model masks cannot become contour truth')
        objects[identity] = obj
        raw_masks[identity] = shape_mask(obj['parts'], width, height)

    def check_occlusion(identity, active, checked):
        if identity not in objects:
            raise ValueError('Unknown foreground occluder')
        if identity in active:
            raise ValueError('Cyclic occlusion ordering')
        if identity in checked:
            return
        active.add(identity)
        for other in objects[identity].get('occluded_by', []):
            check_occlusion(other, active, checked)
        active.remove(identity)
        checked.add(identity)

    checked = set()
    for identity in objects:
        check_occlusion(identity, set(), checked)
    for identity, obj in objects.items():
        mask = raw_masks[identity].copy()
        # These exclusions are manually reviewed front-to-back ordering. They
        # are annotation geometry, never model propagation or invented pixels.
        for other in obj.get('occluded_by', []):
            mask &= ~raw_masks[other]
        if not mask.any():
            raise ValueError('Fully occluded instance has no visible label')
        core, edge = boundary_masks(mask, radius)
        instances[identity] = dict(mask=mask, core=core, boundary=edge)
        foreground |= mask
    # An instance seam within known UI is not a semantic UI/background edge.
    positive, foreground_edge = boundary_masks(foreground, radius)
    uncertain |= foreground_edge
    for region in record.get('background', []):
        mask = shape_mask(region['parts'], width, height)
        core, edge = boundary_masks(mask, radius)
        negative |= core
        uncertain |= edge
    for region in record.get('uncertain', []):
        uncertain |= shape_mask(region['parts'], width, height)
    review = record.get('full_frame_background_review')
    if review is not None:
        # This is an explicit whole-image annotation, never an inference from
        # absent boxes or an exhaustive flag alone. Bind it to the inventory so
        # adding/removing an instance invalidates the earlier background review.
        inventory = review.get('visible_instance_ids', [])
        if (record.get('review_status') != 'accepted' or not record.get('exhaustive')
                or review.get('status') != 'accepted'
                or not str(review.get('reviewer', '')).strip()
                or not str(review.get('evidence', '')).strip()
                or len(inventory) != len(set(inventory))
                or set(inventory) != set(instances)):
            raise ValueError('Full-frame background needs an accepted, matching visual inventory')
        # Preserve holes, disconnected parts, explicit ambiguous regions and
        # the existing uncertainty band. Repair allowance is not annotation UI.
        negative |= ~foreground & ~uncertain
    ownership_uncertain = np.zeros_like(positive)
    for region in record.get('ownership_uncertain', []):
        area = shape_mask(region['parts'], width, height)
        if (area & ~foreground).any():
            raise ValueError('Uncertain ownership lies outside confirmed UI')
        ownership_uncertain |= area
    # Optional, source-bound reviewed pixel centres rescue thin confirmed UI
    # from geometric erosion. They never override semantic/ownership doubt.
    explicit_uncertain = np.zeros_like(positive)
    for region in record.get('uncertain', []):
        explicit_uncertain |= shape_mask(region['parts'], width, height)
    reviewed_positive = np.zeros_like(positive)
    for identity, data in instances.items():
        obj = objects[identity]
        points = obj.get('reliable_positive_points', [])
        verified = np.zeros_like(positive)
        if points:
            review = obj.get('positive_review', {})
            if (not str(review.get('reviewer', '')).strip()
                    or not str(review.get('evidence', '')).strip()
                    or not record.get('image_sha256')
                    or review.get('image_sha256') != record['image_sha256']):
                raise ValueError('Reliable positives need a source-bound visual review')
            for point in points:
                if (not isinstance(point, list) or len(point) != 2
                        or any(type(v) is not int for v in point)
                        or not (0 <= point[0] < width and 0 <= point[1] < height)):
                    raise ValueError('Reliable positive must be an in-frame integer pixel centre')
                x, y = point
                if (not data['mask'][y, x] or explicit_uncertain[y, x]
                        or ownership_uncertain[y, x] or negative[y, x]):
                    raise ValueError('Reliable positive conflicts with visible UI or explicit uncertainty/background')
                verified[y, x] = True
        data['reliable_positive'] = verified
        data['boundary'] &= ~verified
        reviewed_positive |= verified
    positive |= reviewed_positive
    uncertain &= ~reviewed_positive
    for data in instances.values():
        # Semantic foreground remains valid; per-instance training must ignore
        # these pixels instead of forcing an arbitrary owner or background.
        # A washed-out/ambiguous semantic region is not reliable instance
        # supervision either, even when the provisional silhouette covers it.
        data['identity_core'] = (data['core'] | data['reliable_positive']) & ~ownership_uncertain & ~uncertain
    if (positive & negative).any():
        raise ValueError('UI and explicit background labels conflict')
    labels[negative] = BACKGROUND
    labels[positive] = UI
    # Unresolved overlap or edge evidence must not silently become a hard label.
    labels[uncertain] = UNCERTAIN
    return labels, instances


def validate_manifest(manifest):
    if manifest.get('schema') != 'hud-contour-review-v1':
        raise ValueError('Unknown annotation schema')
    sources = {s['source_id']: s for s in manifest['sources']}
    if len(sources) != len(manifest['sources']):
        raise ValueError('Duplicate source id')
    roles = defaultdict(set)
    for source in sources.values():
        if source['split'] not in ('train', 'development', 'holdout'):
            raise ValueError('Unknown split')
        for key in ('game_id', 'source_sha256'):
            roles[(key, source[key])].add(source['split'])
        times = source['times']
        if (len(times) != source['frame_count'] or not all(math.isfinite(t) for t in times)
                or any(b <= a for a, b in zip(times, times[1:]))):
            raise ValueError('Invalid source PTS table')
    for source in manifest.get('reserved_holdouts', []):
        for key in ('game_id', 'source_sha256'):
            roles[(key, source[key])].add('holdout')
    if any(len(v) != 1 for v in roles.values()):
        raise ValueError('Game or source video crosses train/development/holdout splits')
    seen = set()
    for row in manifest['frames']:
        source = sources[row['source_id']]
        frame = row['frame']
        key = (source['source_sha256'], frame)
        if key in seen:
            raise ValueError('Duplicate decoded frame')
        seen.add(key)
        if type(frame) is not int or not 0 <= frame < source['frame_count']:
            raise ValueError('Frame outside source')
        if abs(row['pts'] - source['times'][frame]) > 1e-6:
            raise ValueError('Frame index/PTS mismatch')
        if row['display_frame'] != frame+1:
            raise ValueError('Incorrect one-based display frame')
        labels, _ = rasterize(row, source['width'], source['height'], manifest['boundary_uncertainty_px'])
        if row.get('exhaustive') and (labels == UNKNOWN).any():
            raise ValueError('Exhaustive frame still has unknown pixels')
    return True


def training_readiness(manifest):
    """Fail closed. The pilot is review data and never an implicit YOLO dataset."""
    validate_manifest(manifest)
    sources = {s['source_id']: s for s in manifest['sources']}
    reasons = []
    for split in ('train', 'development'):
        rows = [r for r in manifest['frames'] if sources[r['source_id']]['split'] == split]
        if not rows:
            reasons.append(f'no_{split}_frames')
        elif any(not r.get('exhaustive') or r.get('review_status') != 'accepted' for r in rows):
            reasons.append(f'{split}_not_exhaustively_accepted')
    held_games = {s['game_id'] for s in sources.values() if s['split'] == 'holdout'}
    held_games.update(s['game_id'] for s in manifest.get('reserved_holdouts', []))
    if len(held_games) < 3:
        reasons.append('fewer_than_three_reserved_holdout_games')
    # Standard polygon text loaders lose ignore regions/topology. An explicit
    # adapter review is required even after the annotation work is complete.
    if not manifest.get('training_adapter_verified', False):
        reasons.append('mask_topology_and_ignore_loss_adapter_unverified')
    if manifest.get('detail_support_review_status') not in (None, 'accepted'):
        reasons.append('detail_support_not_visually_accepted')
    return dict(ready=not reasons, reasons=reasons)


def score_scoped_mask(prediction, labels):
    """Counts on known support only. Never report this as full-frame precision."""
    prediction = np.asarray(prediction, dtype=bool)
    if prediction.shape != labels.shape:
        raise ValueError('Prediction/label geometry mismatch')
    ui, bg = labels == UI, labels == BACKGROUND
    return dict(ui_pixels=int(ui.sum()), covered_ui_pixels=int((prediction & ui).sum()),
                explicit_background_pixels=int(bg.sum()),
                covered_background_pixels=int((prediction & bg).sum()),
                prediction_on_unknown_or_uncertain=int((prediction & ~(ui | bg)).sum()))

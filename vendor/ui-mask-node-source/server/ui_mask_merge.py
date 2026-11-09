"""Reanalysis replaces machine proposals, while preserving deliberate edits."""
import re
import uuid
from ui_mask_detect import suppress_panel_children


def retain_on_reanalysis(track,category):
    generated=track.get('origin')=='auto-detected' or bool(re.fullmatch(r'ui-(?:\d+|[0-9a-f]{32})',track['id']))
    animated=any(c.get('keys') for c in track.get('animation',{}).get('channels',{}).values())
    appearance=any(c.get('keys') for c in track.get('appearance',{}).values() if isinstance(c,dict))
    return (track['kind']!=category or bool(track.get('manualEdited') or track.get('classificationLocked') or
            track.get('keys') or track.get('overrides') or animated or appearance) or not generated or
            track.get('origin') in ('manual','user-reviewed-container') or not track['enabled'])


def merge_candidates(previous, fresh, category):
    fresh_has_compass=any(t.get('panelName')=='compass_tick' for t in fresh)
    retained=[t for t in previous if retain_on_reanalysis(t,category) and not (
        fresh_has_compass and t.get('panelName')=='compass_tick' and t.get('origin')=='auto-detected'
        and not t.get('manualEdited'))]
    # Keep original confirmed IDs; assign new machine IDs before deduplication.
    fresh=[t for t in fresh if not any(t['id']==p['id'] for p in retained)]
    for t in fresh:t['id']='ui-'+uuid.uuid4().hex
    # Scope ownership to the parent's visible time and complete motion. Never
    # discard an independent track solely because its first box was inside one.
    parents=[]
    for t in retained:
        # Animated/manual paths require the full renderer to evaluate ownership;
        # leave these candidates for review rather than suppressing by stale samples.
        if t.get('animation') or t.get('overrides') or t.get('keys') or t.get('polygon') or t.get('appearance') or t.get('staticAppearance') or t.get('staticPose',{}).get('angle',0)%360:continue
        p={**t,'_panel':True}
        if t.get('staticPose'):p['samples']=[{'frame':0,'box':t['staticPose']['box']}]
        parents.append(p)
    remaining=suppress_panel_children(parents+[{**t,'_panel':False} for t in fresh],allow_equal=True)
    ids={t['id'] for t in remaining}
    return retained+[t for t in fresh if t['id'] in ids]

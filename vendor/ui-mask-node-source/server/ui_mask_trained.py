"""Local trained proposals for the editable mask node. Inference only.

Confirmed tracks recover their actual first observation. Missed frames are
excluded from visibility ranges; tracker predictions never become painted masks.
"""
from collections import defaultdict
import json
import os
from pathlib import Path
from types import SimpleNamespace
import time

import cv2
import numpy as np
from ui_mask_core import atomic_json, sha256
from ui_mask_detect import detect_video as detect_static, suppress_panel_children

ROOT=Path(__file__).resolve().parents[1]
os.environ.setdefault('YOLO_CONFIG_DIR',str(ROOT/'.hud-research/ui-detect-config'))
os.environ.setdefault('YOLO_AUTOINSTALL','false')
os.environ.setdefault('MPLCONFIGDIR',str(ROOT/'.hud-research/ui-detect-config/matplotlib'))


def collect_observations(tracker, tracked, proposals, frame, epoch, observations, pending):
    admitted=[]
    for result in tracked:
        index=int(result[-1])
        if not 0<=index<len(proposals):
            raise ValueError('跟踪器返回了无效候选')
        identity=(epoch,int(result[4]))
        first=pending.pop(identity,None)
        if first is not None and not observations[identity]:
            observations[identity].append(first)
            admitted.append(first)
        row=dict(frame=frame,**proposals[index])
        observations[identity].append(row)
        admitted.append(row)
    live=set()
    for track in tracker.tracked_stracks:
        if track.is_activated:
            continue
        identity=(epoch,int(track.track_id))
        live.add(identity)
        pending.setdefault(identity,dict(frame=frame,**proposals[int(track.idx)]))
    for identity in set(pending)-live:
        pending.pop(identity)
    return admitted


def observed_ranges(frames):
    ranges=[]
    for frame in sorted(set(frames)):
        if ranges and ranges[-1][1]==frame:
            ranges[-1][1]+=1
        else:
            ranges.append([frame,frame+1])
    return ranges


STATIC_MIN_COVERAGE=0.90
STATIC_MAX_CENTER_SPREAD_PX=16.0
STATIC_MAX_SIZE_VARIATION=0.15
STATIC_MAX_DRIFT_PX=24.0


def classify_model_track(rows, meta):
    """Label a YOLO track from box motion, not from overlay contents.

    Normalized 0.004 spread was ~8px at 1080p and marked stable HUD as dynamic.
    Pixel thresholds keep jittering full-clip panels static, while a one-way
    slide (nameplates on short clips) stays dynamic.
    """
    width,height=meta['width'],meta['height']
    raw=np.clip(np.asarray([r['box'] for r in rows],dtype=float),
                [0,0,0,0],[width,height,width,height])
    centers=(raw[:,:2]+raw[:,2:])/2
    sizes=np.maximum(raw[:,2:]-raw[:,:2],1e-6)
    spread_px=float(np.percentile(np.linalg.norm(centers-np.median(centers,axis=0),axis=1),95))
    variation=float(np.percentile(np.abs(sizes/np.median(sizes,axis=0)-1),95))
    chunk=max(1,len(centers)//10)
    drift_px=float(np.linalg.norm(np.median(centers[-chunk:],axis=0)-np.median(centers[:chunk],axis=0)))
    present=len(rows)/max(1,meta['frames'])>=STATIC_MIN_COVERAGE
    fixed=present and spread_px<STATIC_MAX_CENTER_SPREAD_PX and variation<STATIC_MAX_SIZE_VARIATION and drift_px<STATIC_MAX_DRIFT_PX
    if fixed:
        return True,'位置尺寸基本稳定；请核对完整范围与类别'
    return False,'位置、尺寸或出现时段变化；可手动调整'


def build_tracks(observations, meta, category, model_version):
    tracks=[]
    for identity,rows in sorted(observations.items()):
        width,height=meta['width'],meta['height']
        raw=np.clip(np.asarray([r['box'] for r in rows],dtype=float),
                    [0,0,0,0],[width,height,width,height])
        boxes=raw/[width,height,width,height]
        fixed,reason=classify_model_track(rows,meta)
        kind='static' if fixed else 'dynamic'
        if category and kind!=category:
            continue
        tracks.append(dict(id=f'trained-ui-{identity[0]}-{identity[1]}',
            label=f'AI候选 {len(tracks)+1}',kind=kind,enabled=True,origin='auto-detected',
            detectorVersion=3,modelVersion=model_version,requiresManualReview=True,
            classificationReason=reason,
            confidence=float(np.mean([r['confidence'] for r in rows])),
            ranges=observed_ranges(r['frame'] for r in rows),
            samples=[dict(frame=r['frame'],box=b.tolist()) for r,b in zip(rows,boxes)],
            keys=[],overrides=[]))
    if len(tracks)>2000:
        raise ValueError('候选超过2000个，请分段识别，或使用手画遮罩')
    return tracks


def combine_static_and_model(static_tracks, model_tracks, category=None):
    """Keep established static containers; add only independent AI candidates.

    Suppression happens before category filtering so a static panel also owns
    its changing internal text in a dynamic-only analysis. Time gaps and tracks
    moving outside a panel must survive.
    """
    parents=[dict(t,_panel=True) for t in static_tracks]
    candidates=[dict(t,_panel=False) for t in model_tracks]
    survivors=suppress_panel_children(parents+candidates,allow_equal=True)
    ids={t['id'] for t in survivors}
    tracks=static_tracks+[t for t in model_tracks if t['id'] in ids]
    return [t for t in tracks if not category or t['kind']==category]


class DetectionPhase:
    def __init__(self, job, start, span):
        self.job=job
        self.directory=job.directory
        self.start=start
        self.span=span

    def check(self):
        self.job.check()

    def status(self, state, message, progress=0):
        self.job.status(state,message,self.start+self.span*progress/100)


def detect_video(job, source, meta, category=None, reviewed_regions=(), temporal_recovery='off'):
    # The model supplements the established detector. It must not replace
    # reviewed source layouts or the border/motion based static container pass.
    started=time.perf_counter()
    static_tracks=detect_static(DetectionPhase(job,5,30),source,meta,reviewed_regions,'static')
    model_tracks=_detect_model(DetectionPhase(job,35,60),source,meta,recover='guarded-v2' if category=='dynamic' and temporal_recovery=='guarded-v2' else False)
    tracks=combine_static_and_model(static_tracks,model_tracks,category)
    if len(tracks)>2000:
        raise ValueError('候选超过2000个，请分段识别，或使用手画遮罩')
    info_path=job.directory/'detector-info.json'
    info=json.loads(info_path.read_text('utf-8'))
    info.update(engine='static-containers+trained',modelCandidates=info['tracks'],
                modelSeconds=info['seconds'],seconds=time.perf_counter()-started,
                staticContainers=len(static_tracks),
                reviewedContainers=sum(t.get('origin')=='user-reviewed-container' for t in static_tracks),
                tracks=len(tracks),category=category)
    atomic_json(info_path,info)
    return tracks


PANEL_LABELS={
    'overview':'赛事总览','compass':'罗盘','minimap':'小地图','leaderboard':'排行榜',
    'team_status':'队伍状态','team_resource':'队伍资源','character':'角色状态',
    'equipment':'装备物品','pip':'解说窗','bottom_bar':'底部横条',
}


def _box_iou(a, b):
    ix=max(0.0, min(a[2], b[2])-max(a[0], b[0]))
    iy=max(0.0, min(a[3], b[3])-max(a[1], b[1]))
    inter=ix*iy
    ua=max(0.0,(a[2]-a[0])*(a[3]-a[1]))+max(0.0,(b[2]-b[0])*(b[3]-b[1]))-inter
    return inter/max(1e-9, ua)


def name_panel_tracks(tracks, panels):
    pairs=[]
    for i, track in enumerate(tracks):
        samples=track.get('samples') or []
        if not samples:
            continue
        med=np.median(np.asarray([s['box'] for s in samples], dtype=float), axis=0).tolist()
        for panel in panels:
            pairs.append((_box_iou(med, panel['box']), i, panel))
    pairs.sort(key=lambda row: -row[0])
    used_tracks, used_names=set(), set()
    for score, index, panel in pairs:
        if score<0.30 or index in used_tracks or panel['name'] in used_names:
            continue
        tracks[index]['label']=panel.get('label') or PANEL_LABELS.get(panel['name'], panel['name'])
        tracks[index]['panelName']=panel['name']
        used_tracks.add(index)
        used_names.add(panel['name'])
    return tracks


def detect_panel_video(job, source, meta, category=None):
    """Whole-panel detector. Static runs do not track compass ticks."""
    started=time.perf_counter()
    # 60fps 4K was inferred on every frame and then waited on compass tracking.
    # Static plates are stable, so sample about 12fps and hold the boxes between samples.
    stride=max(1, int(round(meta['fps']/12))) if category=='static' and meta.get('fps',0)>=40 else 1
    tracks=_detect_model(DetectionPhase(job, 5, 82), source, meta, None,
                         config_name='ui_mask_panel.json', infer_stride=stride)
    for track in tracks:
        track['kind']='static'
        track['classificationReason']='赛事整板固定底板，内部数字变化不改类别'
    config=json.loads((Path(__file__).with_name('ui_mask_panel.json')).read_text('utf-8'))
    panels=config.get('panels') or []
    tracks=name_panel_tracks(tracks, [p for p in panels if p['name']!='compass'])
    from ui_mask_compass import drop_whole_compass, track_compass_ticks
    tracks=drop_whole_compass(tracks, panels)
    # The per-frame compass pass redecodes the whole video on CPU. A 4K 60fps
    # clip spent several minutes there after the panel model had already finished.
    ticks=track_compass_ticks(job, source, meta) if category!='static' else []
    tracks=tracks+ticks
    if category:
        tracks=[t for t in tracks if t.get('kind')==category or t.get('panelName')=='compass_tick']
    info_path=job.directory/'detector-info.json'
    info=json.loads(info_path.read_text('utf-8')) if info_path.exists() else {}
    info.update(engine='panel-a15', panelTracks=len(tracks),
                named=sum(1 for t in tracks if t.get('panelName')),
                compassTicks=sum(1 for t in tracks if t.get('panelName')=='compass_tick'),
                seconds=time.perf_counter()-started, category=category)
    atomic_json(info_path, info)
    return tracks


def _detect_model(job, source, meta, category=None, recover=False, config_name='ui_mask_model.json', infer_stride=1):
    from ui_mask_model_runtime import ModelTiming, models, import_watch
    timing=ModelTiming(job.directory)
    config=json.loads((Path(__file__).with_name(config_name)).read_text('utf-8'))
    weights=(ROOT/config['weights']).resolve()
    missing=('赛事整板模型缺失或校验不一致，请恢复模型，或改选 AI 辅助/手画遮罩'
             if config_name.endswith('panel.json') else
             'AI 模型缺失或校验不一致，请恢复模型，或选择基础识别/手画遮罩')
    if not weights.is_relative_to(ROOT) or not weights.is_file() or sha256(weights)!=config['sha256']:
        raise ValueError(missing)
    job.check()
    timing.mark('weightValidationSeconds')
    job.status('running', f"加载{config.get('label', '本机 AI 辅助')}模型…", 6)
    with import_watch(job.directory):
        timing.save(state='importing-torch')
        import torch
        timing.mark('torchImportSeconds')
        job.check()
        timing.save(state='importing-ultralytics')
        from ultralytics import YOLO,settings
        from ultralytics.engine.results import Boxes
        from ultralytics.trackers.byte_tracker import BYTETracker
        timing.mark('ultralyticsImportSeconds')
        timing.data['dependencyImportSeconds']=timing.data['torchImportSeconds']+timing.data['ultralyticsImportSeconds']
        job.check()
    timing.save(state='dependencies-ready')
    settings.update({'sync':False,'weights_dir':str(ROOT/'.hud-research/ui-detect-models')})
    torch.set_num_threads(4)
    device='0' if torch.cuda.is_available() else 'cpu'
    job.check()
    timing.mark('deviceSetupSeconds')
    model,reused=models.load(YOLO,weights,config,device)
    timing.mark('modelCreateSeconds')
    timing.save(state='model-ready', modelReused=reused, weightsSha256=config['sha256'])
    duration=meta['times'][-1]-meta['times'][0]
    rate=(meta['frames']-1)/duration if duration>0 else meta['fps']
    tracker=BYTETracker(SimpleNamespace(track_high_thresh=config['confidence'],
        track_low_thresh=config['candidateConfidence'],new_track_thresh=config['confidence'],
        track_buffer=max(1,round(rate)),match_thresh=.8,fuse_score=False))
    observations=defaultdict(list)
    recovery=None
    recovery_log=None
    if recover:
        from ui_mask_recovery import ObservationRecovery, VERSION, POLICY
        recovery_log=(job.directory/'recovery-decisions.jsonl').open('w',encoding='utf-8')
        recovery=ObservationRecovery(config['confidence'],
            lambda row:recovery_log.write(json.dumps(row,ensure_ascii=False)+'\n'),
            max_size_growth_px=8 if recover=='guarded-v2' else None)
    pending={}
    previous=None
    held={}
    epoch=0
    infer_stride=max(1, int(infer_stride))
    cap=cv2.VideoCapture(str(source))
    timing.mark('taskSetupSeconds')
    decode_seconds=predict_seconds=post_seconds=0.0
    started=time.perf_counter()
    try:
        for frame in range(meta['frames']):
            job.check()
            tick=time.perf_counter()
            ok,image=cap.read()
            decode_seconds+=time.perf_counter()-tick
            tick=time.perf_counter()
            if not ok:
                raise ValueError(f'无法读取第{frame+1}帧，请检查视频')
            if image.shape[1::-1]!=(meta['width'],meta['height']):
                raise ValueError('视频解码尺寸不一致')
            thumb=cv2.resize(cv2.cvtColor(image,cv2.COLOR_BGR2GRAY),(64,36))
            if previous is not None and np.mean(cv2.absdiff(previous,thumb))>48:
                tracker.reset()
                pending.clear()
                held.clear()
                epoch+=1
            previous=thumb
            post_seconds+=time.perf_counter()-tick
            infer=infer_stride==1 or frame%infer_stride==0 or frame==meta['frames']-1
            if not infer:
                for identity, row in held.items():
                    observations[identity].append(dict(frame=frame, box=list(row['box']), confidence=row['confidence']))
                if frame%10==0 or frame==meta['frames']-1:
                    job.status('running',f'AI 辅助识别 {frame+1}/{meta["frames"]} 帧，完成后可手动修改',10+85*(frame+1)/meta['frames'])
                continue
            tick=time.perf_counter()
            result=model.predict(image,imgsz=config['imgsz'],conf=config['candidateConfidence'],
                device=device,verbose=False,max_det=100,agnostic_nms=True)[0]
            prediction=time.perf_counter()-tick
            predict_seconds+=prediction
            if frame==0:
                timing.save(state='first-prediction-ready',firstPredictSeconds=prediction,firstFrameReadySeconds=time.perf_counter()-timing.started)
            tick=time.perf_counter()
            candidates=[]
            for box,confidence in zip(result.boxes.xyxy.cpu().tolist(),result.boxes.conf.cpu().tolist()):
                box=np.clip(box,[0,0,0,0],[meta['width'],meta['height'],meta['width'],meta['height']]).tolist()
                if np.isfinite(box).all() and box[2]>box[0] and box[3]>box[1]:
                    candidates.append(dict(box=box,confidence=confidence))
            data=np.asarray([p['box']+[p['confidence'],0] for p in candidates],dtype=np.float32).reshape(-1,6)
            tracked=tracker.update(Boxes(data,image.shape[:2]),image)
            admitted=collect_observations(tracker,tracked,candidates,frame,epoch,observations,pending)
            if recovery is not None:
                recovery.add(image,candidates,frame,meta['times'][frame],epoch,admitted)
            seen=set()
            for identity, rows in observations.items():
                if rows and rows[-1]['frame']==frame:
                    last=rows[-1]
                    held[identity]=dict(box=list(last['box']), confidence=last['confidence'])
                    seen.add(identity)
            for identity in list(held):
                if identity not in seen:
                    held.pop(identity, None)
            post_seconds+=time.perf_counter()-tick
            if frame%10==0 or frame==meta['frames']-1:
                job.status('running',f'AI 辅助识别 {frame+1}/{meta["frames"]} 帧，完成后可手动修改',10+85*(frame+1)/meta['frames'])
        job.check()
    finally:
        cap.release()
        if recovery_log is not None:recovery_log.close()
    if recovery is not None:
        # The last window is finalized after decoding. Its audit remains in the
        # same job; original observations and their geometry are never replaced.
        with (job.directory/'recovery-decisions.jsonl').open('a',encoding='utf-8') as tail:
            recovery.audit=lambda row:tail.write(json.dumps(row,ensure_ascii=False)+'\n')
            observations.update(recovery.finish())
    tracks=build_tracks(observations,meta,category,config['version'])
    if recovery is not None:
        recovered_ids={f'trained-ui-{epoch}-{identity}' for epoch,identity in recovery.observations}
        for track in tracks:
            if track['id'] in recovered_ids:
                track.update(observationRecovery=VERSION,label=track['label'].replace('AI候选','AI补回'))
    timing.save(state='complete',decodeSeconds=decode_seconds,predictSeconds=predict_seconds,frameProcessingSeconds=post_seconds,frames=meta['frames'],inferStride=infer_stride)
    info=dict(engine='trained',modelVersion=config['version'],
        weightsSha256=config['sha256'],device=device,frames=meta['frames'],tracks=len(tracks),
        seconds=time.perf_counter()-started,sceneResets=epoch,requiresManualReview=True,
        trainingInvoked=False,renderedLostPredictions=False)
    if recovery is not None:
        info.update(observationRecovery=dict(version='observed-recovery-size-gate-v2' if recover=='guarded-v2' else VERSION,policy=POLICY,maxSizeGrowthPx=8 if recover=='guarded-v2' else None,**recovery.stats))
    atomic_json(job.directory/'detector-info.json',info)
    return tracks

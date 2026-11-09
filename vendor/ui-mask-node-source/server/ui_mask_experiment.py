"""Pinned contour candidate inference. No labels, reviewed layouts or optimizer.

Native source pixels -> stride padding -> model masks -> one 4px repair mask.
The same saved mask drives the PNG preview, lossless mask and covered video.
"""
import json
import os
from pathlib import Path
import sys
import time

import cv2
import numpy as np
from ui_mask_core import atomic_json, sha256, probe, write_png, export_category

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools/ui_mask_lab'))
from contour_annotations import expand_repair_mask


def read_config(version=None):
    registry = json.loads((ROOT/'server/ui_mask_experiment.json').read_text('utf8'))
    primary={k:v for k,v in registry.items() if k!='alternatives'}
    configs=[primary,*registry.get('alternatives',[])]
    config=primary if version is None else next((c for c in configs if c['version']==version),None)
    if config is None:
        raise ValueError('实验模型版本未登记')
    for key, digest_key in [('weights','sha256'),('initialization','initializationSha256')]:
        target = (ROOT/config[key]).resolve()
        if not target.is_relative_to(ROOT) or not target.is_file() or sha256(target) != config[digest_key]:
            raise ValueError('实验模型文件缺失或校验不一致')
    return config


def load_yolo_seg(config):
    from ultralytics import YOLO, settings
    settings.update({'sync': False, 'weights_dir': str(ROOT / '.hud-research/ui-detect-models')})
    return YOLO(str(ROOT / config['weights']))


def predict_mask_yolo(model, image, config, device):
    result = model.predict(
        image, imgsz=config.get('imgsz', 1280), conf=config['confidence'],
        iou=config.get('iou', 0.5), device=device, verbose=False,
        max_det=config.get('maxDetections', 50), agnostic_nms=True)[0]
    height, width = image.shape[:2]
    union = np.zeros((height, width), np.uint8)
    masks = getattr(result, 'masks', None)
    if masks is not None and getattr(masks, 'xy', None):
        for poly in masks.xy:
            pts = np.round(np.asarray(poly)).astype(np.int32)
            if len(pts) >= 3:
                cv2.fillPoly(union, [pts], 1)
    elif result.boxes is not None and len(result.boxes):
        for x0, y0, x1, y1 in result.boxes.xyxy.cpu().numpy():
            cv2.rectangle(union, (int(x0), int(y0)), (int(x1), int(y1)), 1, -1)
    count = 0 if result.boxes is None else len(result.boxes)
    return union.astype(bool), int(count)


def load_candidate(config, device):
    for entry in config.get('dependencyPaths', []):
        dependency = (ROOT / entry).resolve()
        if not dependency.is_relative_to(ROOT) or not dependency.is_dir():
            raise ValueError('实验模型依赖路径无效')
        if str(dependency) not in sys.path:
            sys.path.insert(0, str(dependency))
    import torch
    initial = torch.load(ROOT/config['initialization'], map_location='cpu', weights_only=False)
    checkpoint = torch.load(ROOT/config['weights'], map_location='cpu', weights_only=False)
    if (initial.get('trained') is not False or checkpoint.get('integration_only') is not False
            or checkpoint.get('candidate_eligible') is not True or checkpoint.get('step') != config.get('expectedStep',312)
            or checkpoint.get('initialization_sha256') != config['initializationSha256']
            or checkpoint.get('manifest_sha256') != config['manifestSha256']):
        raise ValueError('实验候选来源或训练状态不匹配')
    if config.get('parentCheckpointSha256') and checkpoint.get('parent_checkpoint_sha256') != config['parentCheckpointSha256']:
        raise ValueError('实验候选父权重不匹配')
    model = initial['model'].float()
    model.load_state_dict(checkpoint['model'], strict=True)
    if 'background_classifier' in checkpoint and 'semantic_verifier' in checkpoint:
        raise ValueError('实验候选不能混用未验证的分类纠偏模块')
    if 'background_classifier' in checkpoint:
        from background_classifier import attach_background_classifier
        model = attach_background_classifier(model, checkpoint['background_classifier'])
    if 'semantic_verifier' in checkpoint:
        specification = checkpoint['semantic_verifier']
        if specification.get('kind') == 'HM-frontier-component-v1':
            from component_semantic_veto import attach_component_veto
            model = attach_component_veto(model, specification, ROOT, device)
        elif specification.get('kind') == 'HM-fragment-consensus-v1':
            from fragment_semantic_veto import attach_fragment_veto
            model = attach_fragment_veto(model, specification, ROOT, device)
        elif specification.get('kind') == 'conservative-HM-veto-v1':
            from semantic_veto import attach_conservative_veto
            model = attach_conservative_veto(model, specification, ROOT, device)
        else:
            from semantic_verifier import attach_semantic_verifier
            model = attach_semantic_verifier(model, specification)
    if model.model[-1].nc != 1 or model.end2end:
        raise ValueError('实验模型结构与固定推理协议不匹配')
    for parameter in model.parameters():
        parameter.requires_grad_(False)
    return model.to(device).eval()


def predict_mask(model, image, config, device):
    import torch
    from ultralytics.utils.ops import process_mask_native
    from ultralytics.utils.nms import non_max_suppression
    height, width = image.shape[:2]
    bottom, right = (-height) % 32, (-width) % 32
    padded = cv2.copyMakeBorder(cv2.cvtColor(image,cv2.COLOR_BGR2RGB),0,bottom,0,right,
                               cv2.BORDER_CONSTANT,value=(114,114,114))
    tensor = torch.from_numpy(np.ascontiguousarray(padded.transpose(2,0,1))).unsqueeze(0).to(device).float()/255
    with torch.inference_mode():
        (pred, proto), _ = model(tensor)
        detections = non_max_suppression(pred, conf_thres=config['confidence'],
            iou_thres=config['iou'], nc=1, max_det=config['maxDetections'])[0]
        masks = process_mask_native(proto[0],detections[:,6:],detections[:,:4],padded.shape[:2])
        if hasattr(model, 'semantic_verifier') and len(detections):
            from semantic_verifier import pool_mask_context
            evidence_masks = masks.bool()
            evidence_masks[:,height:,:] = False
            evidence_masks[:,:,width:] = False
            nonempty = evidence_masks.flatten(1).any(1)
            detections, masks = detections[nonempty], masks[nonempty]
            if hasattr(model, 'proposal_crop_encoder'):
                from semantic_veto import combined_veto_features
                features = combined_veto_features(model, image, evidence_masks[nonempty], detections[:,:4])
            else:
                features = pool_mask_context(model._semantic_pyramid, evidence_masks[nonempty],
                                             detections[:,:4], (height,width))
            if getattr(model.semantic_verifier, 'refines_instance_masks', False):
                from component_semantic_veto import refine_component_masks
                masks, retained = refine_component_masks(model, image, evidence_masks[nonempty], features)
            else:
                if getattr(model.semantic_verifier, 'requires_instance_masks', False):
                    scores = model.semantic_verifier.corrected_scores(features, detections[:,4], evidence_masks[nonempty])
                else:
                    scores = model.semantic_verifier.corrected_scores(features, detections[:,4])
                retained = scores >= config['confidence']
            model._semantic_last = dict(before=len(detections), after=int(retained.sum()))
            if hasattr(model.semantic_verifier, 'last_counts'):
                model._semantic_last.update(model.semantic_verifier.last_counts)
            detections, masks = detections[retained], masks[retained]
        elif hasattr(model, 'semantic_verifier'):
            model._semantic_last = dict(before=0, after=0)
        union = (masks[:,:height,:width].bool().any(0).cpu().numpy()
                 if len(masks) else np.zeros((height,width),bool))
    return union, len(detections)


class ExportPhase:
    def __init__(self, job):
        self.job, self.directory = job, job.directory
    def check(self):
        self.job.check()
    def run(self, *args, **kwargs):
        return self.job.run(*args, **kwargs)
    def status(self, state, message, progress=0):
        self.job.status(state, message, 68+progress*.30)


def run_experiment(job, ffmpeg, request):
    started = time.perf_counter()
    config = read_config(request.get('modelVersion'))
    if request.get('modelVersion') != config['version'] or request.get('weightsSha256') != config['sha256']:
        raise ValueError('实验模型版本已改变，请重新建立验证任务')
    os.environ.setdefault('YOLO_CONFIG_DIR',str(ROOT/'.hud-research/ui-detect-config'))
    os.environ.setdefault('YOLO_AUTOINSTALL','false')
    os.environ.setdefault('MPLCONFIGDIR',str(ROOT/'.hud-research/ui-detect-config/matplotlib'))
    source = job.directory/'source.bin'
    job.status('running','读取实验视频时间轴…',2)
    meta = probe(job,ffmpeg,source)
    if (meta['width']>config['maxWidth'] or meta['height']>config['maxHeight']
            or meta['frames']>config['maxFrames'] or meta['duration']>config['maxDuration']):
        raise ValueError(f"实验入口支持最多{config['maxWidth']}×{config['maxHeight']}、{config['maxDuration']}秒、{config['maxFrames']}帧的片段；请先分段，不会自动缩小原图")
    if meta['width']%2 or meta['height']%2:
        raise ValueError('实验视频宽高需为偶数')
    meta.update(sha256=sha256(source), filename=request['filename'])
    if config.get('backend') == 'text-component-association':
        from ui_mask_component_engine import run_components
        return run_components(job,ffmpeg,request,config,meta)
    import torch
    torch.set_num_threads(4)
    torch.backends.cudnn.benchmark=False
    torch.backends.cudnn.deterministic=True
    device='cuda:0' if torch.cuda.is_available() else 'cpu'
    job.status('running',f"加载{config['label']}权重…",5)
    yolo_backend = config.get('backend') == 'yolo11-seg'
    model = load_yolo_seg(config) if yolo_backend else load_candidate(config, device)
    infer = predict_mask_yolo if yolo_backend else predict_mask
    folders={kind:job.directory/'frames'/kind for kind in ('source','raw','repair','covered')}
    for folder in folders.values():
        folder.mkdir(parents=True)
    records=[]
    cap=cv2.VideoCapture(str(source))
    try:
        for frame in range(meta['frames']):
            job.check()
            ok,image=cap.read()
            if not ok or image.shape[:2]!=(meta['height'],meta['width']):
                raise ValueError(f'第{frame+1}帧解码失败或尺寸改变')
            raw,count=infer(model,image,config,device)
            repair=expand_repair_mask(raw,config['repairMarginPx'])
            covered=image.copy();covered[repair]=0
            name=f'{frame:06d}.png'
            for kind,pixels in [('source',image),('raw',raw.astype('uint8')*255),
                                ('repair',repair.astype('uint8')*255),('covered',covered)]:
                write_png(folders[kind]/name,pixels)
            records.append(dict(frame=frame,pts=meta['times'][frame],detections=count,
                rawPixels=int(raw.sum()),repairPixels=int(repair.sum()),
                sourcePngSha256=sha256(folders['source']/name),rawMaskSha256=sha256(folders['raw']/name),
                repairMaskSha256=sha256(folders['repair']/name)))
            if frame%5==0 or frame==meta['frames']-1:
                job.status('running',f'新模型逐帧识别 {frame+1}/{meta["frames"]}，检测全画面 UI',8+58*(frame+1)/meta['frames'])
    finally:
        cap.release()
    del model
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    def mask_provider(frame):
        return cv2.imread(str(folders['repair']/f'{frame:06d}.png'),cv2.IMREAD_GRAYSCALE)
    result=None if request.get('draftOnly') else export_category(ExportPhase(job),ffmpeg,source,dict(source=meta,tracks=[]),
                           'dynamic','follow',mask_provider=mask_provider,exact_mask=True)
    report=dict(modelVersion=config['version'],modelLabel=config['label'],weightsSha256=config['sha256'],
        source=meta,frames=records,export=result,device=device,repairMarginPx=config['repairMarginPx'],
        encodingExtraMarginPx=0,trainingInvoked=False,referenceMasksUsed=False,
        reviewedLayoutsUsed=False,trackingOrTemporalPropagation=False,
        experimental=True,draftOnly=bool(request.get('draftOnly')),notice=config['notice'],seconds=time.perf_counter()-started)
    atomic_json(job.directory/'experiment-result.json',report)
    job.status('ready','检测草稿完成：载入后可手动修正，确认后生成视频' if request.get('draftOnly') else '实验检测完成：请核对漏遮、轮廓偏宽和场景误遮',100)

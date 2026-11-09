"""Opt-in component association drafts. Uses only this job's source and evidence."""
from pathlib import Path
import sys,json,time,shutil,os
from concurrent.futures import ThreadPoolExecutor
from threading import Event
import cv2
from ui_mask_core import atomic_json,sha256,export_category,Job
from ui_mask_assets import COMPONENT_LAYOUT,frame_path
ROOT=Path(__file__).resolve().parents[1]
def run_components(job,ffmpeg,request,config,meta):
    started=time.perf_counter();p=job.directory;source=p/'source.bin'
    if config.get('opencvThreads'):cv2.setNumThreads(config['opencvThreads'])
    atomic_json(p/'runtime-fingerprint.json',dict(config=config,files={str(f.relative_to(ROOT)):sha256(f) for f in [Path(__file__),ROOT/'server/ui_mask_assets.py',*(ROOT/'server/ui_mask_components').glob('*.py')]}))
    baseline=json.loads((ROOT/'server/ui_mask_model.json').read_text('utf-8'))
    if baseline['sha256']!=config['sha256']:raise ValueError('组件方案登记权重与当前基线不一致，请更新方案版本')
    from ui_mask_trained import detect_video
    atomic_json(p/'source.json',dict(path=str(source),**meta))
    python=ROOT/'.hud-research/ui-ocr-venv/Scripts/python.exe'
    if not python.exists():raise ValueError('组件增强需要本机文字检测环境')
    ocr_device=config.get('ocrDevice','cpu')
    ocr_python=ROOT/config['ocrRuntime']/'Scripts/python.exe' if config.get('ocrRuntime') else python
    if not ocr_python.exists():raise ValueError('所选文字推理环境未安装')
    ocr_command=[ocr_python,'-u',ROOT/'server/ui_mask_components/ocr_worker.py',p,'--device',ocr_device]
    if config.get('ocrFastIO'):ocr_command.append('--fast-io')
    if config.get('ocrStreamSource'):ocr_command.append('--stream-source')
    if config.get('checkpointInterval'):ocr_command.extend(['--checkpoint-interval',str(config['checkpointInterval'])])
    phases={}
    if config.get('overlapOCR'):
        stop=Event()
        class EvidenceJob(Job):
            def check(self):
                super().check()
                if stop.is_set():raise InterruptedError('关联任务已停止')
        # Independent subprocesses retain their own predictors; no masks or evidence
        # are shared across jobs. Any parent failure terminates the owned OCR child.
        with ThreadPoolExecutor(max_workers=1) as pool:
            future=pool.submit(EvidenceJob(p).run,ocr_command,'component-ocr.log')
            try:
                tick=time.perf_counter()
                tracks=detect_video(job,source,meta,category='dynamic',temporal_recovery='guarded-v2')
                phases['baselineWall']=time.perf_counter()-tick
                job.status('running','基础检测完成，等待本视频文字证据…',65)
                future.result()
            finally:stop.set()
        phases['overlappedEvidenceWall']=time.perf_counter()-started
    else:
        tracks=detect_video(job,source,meta,category='dynamic',temporal_recovery='guarded-v2')
        if config.get('ocrDevice')=='gpu':
            import gc,torch
            gc.collect()
            if torch.cuda.is_available():torch.cuda.empty_cache()
        job.status('running',f"逐帧文字检测（{config.get('ocrDevice','cpu').upper()}），随后关联组件…",45)
        job.run(ocr_command,'component-ocr.log')
    atomic_json(p/'baseline-document.json',dict(version=2,revision=0,source=meta,tracks=tracks))
    job.check();job.status('running','关联文字、底板与图标…',75)
    association_command=[python,'-u',ROOT/'server/ui_mask_components/pipeline.py',p]
    if config.get('continuousText'):association_command.append('--continuous-text')
    if config.get('parallelFrames'):association_command.append('--parallel-frames')
    if config.get('leanMasks'):association_command.append('--lean-masks')
    if config.get('parallelComponents'):association_command.append('--parallel-components')
    tick=time.perf_counter();job.run(association_command,'component-association.log');job.check()
    phases['associationWall']=time.perf_counter()-tick
    tick=time.perf_counter();result=finish_components(job,ffmpeg,request,config,meta,started)
    phases['publishWall']=time.perf_counter()-tick
    atomic_json(p/'component-phase-times.json',phases)
    return result

def finish_components(job,ffmpeg,request,config,meta,started):
    """Publish this job's computed maps; shared by execution and verified cache import."""
    p=job.directory;source=p/'source.bin'
    records=[]
    for kind in ['source','raw','repair','covered']:(p/'frames'/kind).mkdir(parents=True,exist_ok=True)
    def publish_frame(f):
        job.check();name=f'{f:06d}.png';key=f'v03-{f:03d}.png'
        for kind,folder in [('source','source'),('raw','raw-union'),('repair','combined-repair'),('covered','black-preview')]:
            origin=p/folder/key;target=p/'frames'/kind/name
            if target.exists():
                if sha256(origin)!=sha256(target):raise ValueError('Existing draft frame differs from computed output')
            else:
                try:os.link(origin,target)
                except OSError:shutil.copyfile(origin,target)
        raw=cv2.imread(str(p/'frames/raw'/name),0);repair=cv2.imread(str(p/'frames/repair'/name),0)
        return dict(frame=f,pts=meta['times'][f],detections=None,rawPixels=int((raw>0).sum()),repairPixels=int((repair>0).sum()),sourcePngSha256=sha256(p/'frames/source'/name),rawMaskSha256=sha256(p/'frames/raw'/name),repairMaskSha256=sha256(p/'frames/repair'/name))
    manifest=p/'component-frame-records.json'
    layout=None
    if manifest.exists():
        prepared=json.loads(manifest.read_text('utf8'))
        if prepared.get('frameLayout')!=COMPONENT_LAYOUT or prepared.get('sourceSha256')!=meta['sha256']:
            raise ValueError('组件草稿来源不一致')
        records=prepared['frames'];layout=COMPONENT_LAYOUT
        if len(records)!=meta['frames']:raise ValueError('组件草稿帧序列不完整')
        for f,row in enumerate(records):
            job.check()
            if row['frame']!=f or row['pts']!=meta['times'][f]:raise ValueError('组件草稿时间轴不一致')
            for kind in ('source','raw','repair','covered'):
                if not frame_path(p,kind,f,layout).is_file():raise ValueError('组件草稿图片不完整')
    else:
        with ThreadPoolExecutor(max_workers=4 if config.get('parallelPublish') else 1) as pool:
            records=list(pool.map(publish_frame,range(meta['frames'])))
    result=None
    if not request.get('draftOnly'):result=export_category(job,ffmpeg,source,dict(source=meta,tracks=[]),'dynamic','follow',mask_provider=lambda f:cv2.imread(str(frame_path(p,'repair',f,layout)),0),exact_mask=True)
    report=dict(modelVersion=config['version'],modelLabel=config['label'],weightsSha256=config['sha256'],source=meta,frames=records,export=result,device='model-auto+ocr-'+config.get('ocrDevice','cpu'),repairMarginPx=4,encodingExtraMarginPx=0,trainingInvoked=False,referenceMasksUsed=False,reviewedLayoutsUsed=False,trackingOrTemporalPropagation=True,experimental=True,draftOnly=bool(request.get('draftOnly')),notice=config['notice'],seconds=time.perf_counter()-started)
    if layout:report['frameLayout']=layout
    job.check();atomic_json(p/'experiment-result.json',report);job.status('ready','组件增强草稿已生成，请检查漏遮与误遮；未声明准确率',100)

import time
PROCESS_ENTRY=time.time()
import argparse
import os
import json
from pathlib import Path
import traceback
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))

import cv2
import imageio_ffmpeg

from ui_mask_core import Job, atomic_json, probe, sha256, export_category

# Shotflow：线程数可配（线上 4 核默认 4；4090 GPU Worker 设 UI_MASK_THREADS）。
# ui_mask_core.py 参与算法版本号，不能改，所以在这里把 ffmpeg 的 -threads 4 换掉。
WORKER_THREADS=str(max(1,int(os.environ.get('UI_MASK_THREADS','4') or 4)))
if WORKER_THREADS!='4':
    _run=Job.run
    def _run_with_threads(self,args,log_name):
        args=list(args)
        for index in range(len(args)-1):
            if args[index]=='-threads' and str(args[index+1])=='4':args[index+1]=WORKER_THREADS
        return _run(self,args,log_name)
    Job.run=_run_with_threads
PROCESS_READY=time.time()


def main(directory):
    job=Job(directory)
    atomic_json(job.directory/'worker-entry-times.json',dict(processEntryEpoch=PROCESS_ENTRY,processReadyEpoch=PROCESS_READY,taskEntryEpoch=time.time(),moduleImportSeconds=PROCESS_READY-PROCESS_ENTRY))
    try:
        cv2.setNumThreads(int(os.environ.get('UI_MASK_THREADS','4') or 4))
        request=json.loads((job.directory/'request.json').read_text('utf-8'))
        ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
        if request['kind']=='experiment':
            from ui_mask_experiment import run_experiment
            run_experiment(job,ffmpeg,request)
        elif request['kind']=='analysis':
            source=job.directory/'source.bin'
            job.status('running','读取视频时间轴…',2)
            meta=probe(job,ffmpeg,source)
            if meta['frames']>36000 or meta['duration']>1200 or meta['width']*meta['height']>4096*2160:
                raise ValueError('目前支持不超过20分钟、36000帧、4K的视频，请先分段')
            if meta['width']%2 or meta['height']%2:
                raise ValueError('视频宽高需为偶数，请先规范画幅')
            meta['sha256']=sha256(source)
            meta['filename']=request['filename']
            profile=Path(__file__).resolve().parents[1]/'outputs'/'ui-mask-reviewed-layouts'/(meta['sha256']+'.json')
            if not profile.exists():
                # Ship established demo layouts with the node code as well.
                # Local reviewed overrides take priority; both require exact SHA.
                profile=Path(__file__).resolve().parent/'ui-mask-reviewed-layouts'/(meta['sha256']+'.json')
            reviewed=[]
            if request.get('operation')!='manual' and profile.exists():
                layout=json.loads(profile.read_text('utf-8'))
                if layout.get('sourceSha256')!=meta['sha256'] or layout.get('width')!=meta['width'] or layout.get('height')!=meta['height']:
                    raise ValueError('已确认面板布局与素材不匹配')
                reviewed=layout.get('staticRegions',[])
                if len(reviewed)>100 or any(not isinstance(r.get('label'),str) or len(r['label'])>100 or len(r.get('box',[]))!=4 or
                    not all(isinstance(v,(float,int)) and 0<=v<=1 for v in r['box']) or r['box'][0]>=r['box'][2] or r['box'][1]>=r['box'][3] for r in reviewed):
                    raise ValueError('已确认面板范围无效')
            tracks=[]
            if request.get('operation','detect')=='detect':
                if request.get('detector')=='trained':
                    from ui_mask_trained import detect_video
                    tracks=detect_video(job,source,meta,request.get('category'),reviewed_regions=reviewed,temporal_recovery=request.get('temporalRecovery','off'))
                elif request.get('detector')=='panel':
                    from ui_mask_trained import detect_panel_video
                    tracks=detect_panel_video(job,source,meta,request.get('category'))
                else:
                    from ui_mask_detect import detect_video
                    tracks=detect_video(job,source,meta,reviewed,request.get('category'))
            initial=job.directory/'initial-document.json'
            if initial.exists():
                previous=json.loads(initial.read_text('utf-8'))
                if previous['source']['sha256']!=meta['sha256']:
                    raise ValueError('原遮罩与输入视频不匹配')
                from ui_mask_merge import merge_candidates
                tracks=merge_candidates(previous['tracks'],tracks,request['category'])
            doc=dict(version=2,revision=0,source=meta,tracks=tracks)
            if initial.exists() and previous.get('nextMaskNumber'):
                doc['nextMaskNumber']=previous['nextMaskNumber']
            atomic_json(job.directory/'document.json',doc)
            message='视频已就绪，可直接手画遮罩'
            if request.get('operation')!='manual':
                name={'trained':'AI 辅助','panel':'赛事整板 a15'}.get(request.get('detector'),'基础')
                message=f'{name}识别完成，人工修改已保留；请检查范围，可补画、删除或调整类别'
                info_path=job.directory/'detector-info.json'
                fresh_compass=0
                if info_path.exists():
                    fresh_compass=json.loads(info_path.read_text('utf-8')).get('compassTicks') or 0
                if fresh_compass:
                    message+='。罗盘刻度已放入动态遮罩，静态结果不盖这一排，便于二次修复保留参考画面'
                if isinstance(request.get('notice'), str) and request['notice'].strip():
                    message=f"{request['notice'].strip()}。{message}"
            job.status('ready',message,100)
        elif request['kind']=='export':
            doc=json.loads((job.directory/'document.json').read_text('utf-8'))
            source=job.directory.parent/request['parent']/'source.bin'
            if sha256(source)!=doc['source']['sha256']:
                raise ValueError('输入视频已改变，请重新识别')
            results=[]
            if doc.get('modelBase'):
                from ui_mask_model_edit import model_mask_provider
                cover=request.get('coverColor') or 'black'
                result=export_category(job,ffmpeg,source,doc,'dynamic','follow',mask_provider=model_mask_provider(job,doc),exact_mask=True,cover_color=cover)
                corrections=sum(1 for t in doc['tracks'] if t['enabled'] and t['ranges'])
                result.update(modelBase=doc['modelBase'],manualCorrections=corrections>0,manualCorrectionCount=corrections,inferenceInvoked=False,trainingInvoked=False)
                results.append(result)
            for category in [request['category']]:
                if not doc.get('modelBase') and any(t['enabled'] and t['kind']==category and t['ranges'] for t in doc['tracks']):
                    results.append(export_category(job,ffmpeg,source,doc,category,request['mode'],cover_color=request.get('coverColor') or 'black'))
            job.check()
            atomic_json(job.directory/'result.json',results)
            if not results:raise ValueError('当前类别没有启用的遮罩，请手画或识别本类UI')
            job.status('ready','当前类别的 Mask 视频已生成',100)
        else:
            raise ValueError('未知任务')
        return 0
    except InterruptedError:
        job.status('cancelled','已取消');return 1
    except Exception as error:
        traceback.print_exc()
        job.status('failed',str(error));return 1


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--job',type=Path,required=True)
    raise SystemExit(main(parser.parse_args().job))

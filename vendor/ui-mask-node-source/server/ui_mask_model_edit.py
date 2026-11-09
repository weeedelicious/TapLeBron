"""CPU-only edits of immutable model masks. Never invokes inference/training."""
from pathlib import Path
import json,sys,re
import cv2
import numpy as np
from ui_mask_core import paint_track_opaque,opacity_at,sha256
from ui_mask_assets import frame_path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools/ui_mask_lab'))
from contour_annotations import expand_repair_mask


def corrected_mask(raw,document,frame):
    """Erase only model pixels, then add manual coverage; expand once at the end."""
    add=np.zeros(raw.shape,np.uint8);erase=np.zeros_like(add)
    for track in document['tracks']:
        if track['enabled'] and track['kind']=='dynamic' and opacity_at(track,frame)>0:
            paint_track_opaque(erase if track.get('maskOperation')=='erase' else add,track,frame)
    return expand_repair_mask((raw.astype(bool)&~erase.astype(bool))|add.astype(bool),4).astype(np.uint8)*255


def model_mask_provider(job,document):
    base=document['modelBase'];identity=base['jobId']
    if not re.fullmatch(r'[a-f0-9-]{36}',identity):raise ValueError('模型草稿编号无效')
    folder=job.directory.parent/identity
    info=json.loads((folder/'experiment-result.json').read_text('utf8'))
    if (info['source']!=document['source'] or info['weightsSha256']!=base['weightsSha256']
        or info['modelVersion']!=base['modelVersion'] or base['repairMarginPx']!=4):
        raise ValueError('模型草稿与原始检测不一致')
    def mask(frame):
        job.check()
        file=frame_path(folder,'raw',frame,info.get('frameLayout'))
        if sha256(file)!=info['frames'][frame]['rawMaskSha256']:raise ValueError('原始模型遮罩已改变')
        raw=cv2.imread(str(file),cv2.IMREAD_GRAYSCALE)
        if raw is None or raw.shape!=(document['source']['height'],document['source']['width']):raise ValueError('模型遮罩尺寸无效')
        return corrected_mask(raw>0,document,frame)
    return mask

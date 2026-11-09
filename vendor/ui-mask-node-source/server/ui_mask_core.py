"""CPU mask geometry and video timing. No image reconstruction or repair models."""
import bisect
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import time
from fractions import Fraction

import cv2
import numpy as np


# Source-resolution padding keeps 4:2:0 colour mixing outside the drawn mask.
BLACK_EDGE_GUARD_PIXELS = 2
BLACK_COVERED_CHANNEL_LIMIT = 24  # Small quantization noise is allowed in lossy MP4.
COVER_COLORS = {'black': (0, 0, 0), 'red': (255, 0, 0), 'green': (0, 255, 0), 'blue': (0, 0, 255)}


def atomic_json(file, data):
    file = Path(file)
    temporary = file.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    for attempt in range(20):
        try:
            os.replace(temporary, file)
            return
        except PermissionError:
            if attempt == 19:
                raise
            time.sleep(.05)


class Job:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.started = time.monotonic()

    def check(self):
        if (self.directory/'cancel').exists():
            raise InterruptedError('已取消')

    def status(self, state, message, progress=0, **extra):
        self.check() if state == 'running' else None
        atomic_json(self.directory/'status.json', dict(state=state, message=message, progress=progress,
                    elapsed=round(time.monotonic()-self.started, 1), **extra))

    def run(self, args, log_name):
        self.check()
        with (self.directory/log_name).open('wb') as log:
            child = subprocess.Popen([str(a) for a in args], stdin=subprocess.DEVNULL, stdout=log,
                                     stderr=subprocess.STDOUT, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            try:
                while child.poll() is None:
                    self.check()
                    time.sleep(.1)
                if child.returncode:
                    detail = (self.directory/log_name).read_text('utf-8', errors='replace')[-1800:]
                    raise RuntimeError(f'视频处理失败：{detail}')
            finally:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill(); child.wait()


def probe(job, ffmpeg, source, prefix='source'):
    job.run([ffmpeg, '-hide_banner', '-nostdin', '-i', source, '-map', '0:v:0', '-an',
             '-vf', 'showinfo,scale=2:2', '-fps_mode', 'passthrough', '-f', 'null', '-'], prefix+'-timing.log')
    text = (job.directory/(prefix+'-timing.log')).read_text('utf-8', errors='replace')
    rows = [line for line in text.splitlines() if 'pts_time:' in line and ' n:' in line]
    if not rows:
        raise ValueError('没有可读取的视频帧')
    times, durations = [], []
    time_base = Fraction(re.search(r'config in time_base:\s*(\d+/\d+)', text)[1])
    for row in rows:
        times.append(float(int(re.search(r'\bpts:\s*(-?\d+)', row)[1])*time_base))
        m = re.search(r'\bduration:\s*(\d+)', row)
        durations.append(float(int(m[1])*time_base) if m else 0)
    size = re.search(r'\bs:(\d+)x(\d+)', rows[0])
    rate = re.search(r'frame_rate:\s*(\d+/\d+)', text)
    fps = Fraction(rate[1]) if rate and rate[1] != '0/0' else Fraction(1/max(.001, np.median(np.diff(times))))
    start = times[0]
    times = [round(t-start, 6) for t in times]
    if any(b <= a for a,b in zip(times, times[1:])):
        raise ValueError('视频时间戳不连续，请先重新封装视频')
    last = durations[-1] or (times[-1]-times[-2] if len(times)>1 else 1/float(fps))
    return dict(width=int(size[1]), height=int(size[2]), frames=len(times), times=times,
                fps=float(fps), fpsRatio=str(fps), duration=round(times[-1]+last, 6), start=start,
                hasAudio=bool(re.search(r'Stream #.*Audio:', text)))


def sha256(file):
    h = hashlib.sha256()
    with open(file, 'rb') as stream:
        for block in iter(lambda: stream.read(8*1024**2), b''):
            h.update(block)
    return h.hexdigest()


def interpolate(samples, frame):
    # Sparse samples interpolate only within a track's explicit visible intervals.
    pos = bisect.bisect_right(samples, frame, key=lambda p:p['frame'])
    if pos == 0:
        return list(samples[0]['box'])
    if pos == len(samples):
        return list(samples[-1]['box'])
    a,b = samples[pos-1:pos+1]
    u = (frame-a['frame'])/(b['frame']-a['frame'])
    return [x+(y-x)*u for x,y in zip(a['box'],b['box'])]


def box_at(track, frame):
    if not any(a <= frame < b for a,b in track['ranges']):
        return None
    if track['kind']=='static' and track.get('staticPose'):
        return track['staticPose']['box']
    if track.get('motionMode')=='absolute':
        return pose_at(track,frame)['box']
    single = next((p for p in track['overrides'] if p['frame'] == frame), None)
    if single:
        return single['box']
    box = interpolate(track['samples'], frame)
    if track['keys']:
        offsets = [dict(frame=k['frame'], box=[v-b for v,b in zip(k['box'],interpolate(track['samples'],k['frame']))])
                   for k in track['keys']]
        box = [max(0,min(1,v+d)) for v,d in zip(box, interpolate(offsets,frame))]
        box[0]=min(.9999,box[0]);box[1]=min(.9999,box[1]);box[2]=max(box[0]+.0001,box[2]);box[3]=max(box[1]+.0001,box[3])
    return box


def pose_at(track,frame):
    if track['kind']=='static' and track.get('staticPose'):
        return track['staticPose']
    if track.get('animation'):
        return channel_pose(track,frame)
    if track.get('motionMode')!='absolute':
        return dict(box=box_at(track,frame) or interpolate(track['samples'],frame),angle=0)
    interval=next((r for r in track['ranges'] if r[0]<=frame<r[1]),None)
    rows=[k for k in track['keys'] if interval[0]<=k['frame']<interval[1]] if interval else track['keys']
    if not rows:
        previous=[k for k in track['keys'] if k['frame']<=frame]
        rows=[previous[-1] if previous else track['keys'][0]]
    pos=bisect.bisect_right(rows,frame,key=lambda p:p['frame'])
    a=rows[max(0,pos-1)];b=rows[min(len(rows)-1,pos)]
    u=0 if a is b or track.get('interpolation')=='hold' else (frame-a['frame'])/(b['frame']-a['frame'])
    return dict(box=[x+(y-x)*u for x,y in zip(a['box'],b['box'])],angle=a.get('angle',0)+(b.get('angle',0)-a.get('angle',0))*u)


def scalar_at(channel,frame,ranges):
    keys=channel['keys']
    if not keys:return channel['value']
    interval=next((r for r in ranges if r[0]<=frame<r[1]),None)
    rows=[k for k in keys if interval[0]<=k['frame']<interval[1]] if interval else keys
    if not rows:
        previous=[k for k in keys if k['frame']<=frame]
        return (previous[-1] if previous else keys[0])['value']
    if frame<=rows[0]['frame']:return rows[0]['value']
    if frame>=rows[-1]['frame']:return rows[-1]['value']
    pos=bisect.bisect_right(rows,frame,key=lambda p:p['frame']);a,b=rows[pos-1:pos+1]
    if a['interpolation']=='hold':return a['value']
    d=b['frame']-a['frame'];delta=b['value']-a['value']
    if a['interpolation']!='bezier':return a['value']+delta*(frame-a['frame'])/d
    out=a.get('out',[d/3,delta/3]);incoming=b.get('in',[-d/3,-delta/3])
    x1=max(0,min(d,out[0]));x2=max(0,min(d,-incoming[0]));scale=d/(x1+x2) if x1+x2>d else 1
    s1=1 if out[0]==0 else x1/out[0]*scale;s2=1 if incoming[0]==0 else -x2/incoming[0]*scale
    xs=[a['frame'],a['frame']+x1*scale,b['frame']-x2*scale,b['frame']]
    ys=[a['value'],a['value']+out[1]*s1,b['value']+incoming[1]*s2,b['value']]
    def cubic(p,t):
        s=1-t
        return s*s*s*p[0]+3*s*s*t*p[1]+3*s*t*t*p[2]+t*t*t*p[3]
    left=0;right=1
    for _ in range(42):
        u=(left+right)/2
        if cubic(xs,u)<frame:left=u
        else:right=u
    return cubic(ys,(left+right)/2)


def channel_pose(track,frame):
    v={p:scalar_at(c,frame,track['ranges']) for p,c in track['animation']['channels'].items()}
    width=max(.0001,min(1,v['width']));height=max(.0001,min(1,v['height']))
    x=max(0,min(1-width,v['x']));y=max(0,min(1-height,v['y']))
    return dict(box=[x,y,x+width,y+height],angle=max(-36000,min(36000,v['angle'])))


def track_polygon(track,frame,width,height):
    box=box_at(track,frame)
    if box is None:return None
    if track.get('appearance') or track.get('staticAppearance'):
        points=[[box[0]+p[0]*(box[2]-box[0]),box[1]+p[1]*(box[3]-box[1])] for p in flatten_path(path_at(track,frame))]
    elif track.get('polygon'):
        ref=track['samples'][0]['box']
        points=[[max(0,min(1,box[i]+(p[i]-ref[i])*(box[i+2]-box[i])/(ref[i+2]-ref[i]))) for i in [0,1]] for p in track['polygon']]
    else:
        x,y,r,b=box;points=[[x,y],[r,y],[r,b],[x,b]]
    angle=pose_at(track,frame)['angle']*math.pi/180;c=math.cos(angle);s=math.sin(angle)
    cx=(box[0]+box[2])*width/2;cy=(box[1]+box[3])*height/2
    return [[(cx+(x*width-cx)*c-(y*height-cy)*s)/width,(cy+(x*width-cx)*s+(y*height-cy)*c)/height] for x,y in points]


def paint_polygon(mask,points):
    h,w=mask.shape;p=[(x*w,y*h) for x,y in points]
    for y in range(max(0,math.ceil(min(v[1] for v in p)-.5)),min(h,math.ceil(max(v[1] for v in p)-.5))):
        center=y+.5;intersections=[]
        for a,b in zip(p,p[1:]+p[:1]):
            if (a[1]<=center<b[1]) or (b[1]<=center<a[1]):
                intersections.append(a[0]+(center-a[1])*(b[0]-a[0])/(b[1]-a[1]))
        intersections.sort()
        for left,right in zip(intersections[::2],intersections[1::2]):
            x=max(0,math.ceil(left-.5));r=min(w,math.ceil(right-.5))
            if r>x:mask[y,x:r]=255


def opacity_at(track,frame):
    if track['kind']=='static' and track.get('staticAppearance'):
        return track['staticAppearance']['opacity']
    c=track.get('appearance',{}).get('opacity')
    return max(0,min(1,c['value'] if track['kind']=='static' else scalar_at(c,frame,track['ranges']))) if c else 1


def initial_path(track):
    ref=track['samples'][0]['box']
    points=[[(p[i]-ref[i])/(ref[i+2]-ref[i]) for i in (0,1)] for p in track['polygon']] if track.get('polygon') else [[0,0],[1,0],[1,1],[0,1]]
    return [dict(point=p,**{'in':[0,0],'out':[0,0]}) for p in points]


def path_at(track,frame):
    if track['kind']=='static' and track.get('staticAppearance'):return track['staticAppearance']['shape']
    c=track.get('appearance',{}).get('shape')
    if not c:return initial_path(track)
    if track['kind']=='static' or not c['keys']:return c['value']
    interval=next((r for r in track['ranges'] if r[0]<=frame<r[1]),None)
    rows=[k for k in c['keys'] if interval[0]<=k['frame']<interval[1]] if interval else c['keys']
    if not rows:return next((k['value'] for k in reversed(c['keys']) if k['frame']<=frame),c['keys'][0]['value'])
    a=next((k for k in reversed(rows) if k['frame']<=frame),rows[0]);b=next((k for k in rows if k['frame']>frame),None)
    if not b or a['frame']>=frame or a['interpolation']!='linear' or len(a['value'])!=len(b['value']):return a['value']
    u=(frame-a['frame'])/(b['frame']-a['frame'])
    return [{p:[x+(y-x)*u for x,y in zip(v[p],b['value'][i][p])] for p in ('point','in','out')} for i,v in enumerate(a['value'])]


def flatten_path(path):
    points=[]
    for i,a in enumerate(path):
        b=path[(i+1)%len(path)];n=24 if any(a['out']) or any(b['in']) else 1
        for j in range(n):
            t=j/n;s=1-t
            points.append([s*s*s*a['point'][d]+3*s*s*t*(a['point'][d]+a['out'][d])+3*s*t*t*(b['point'][d]+b['in'][d])+t*t*t*b['point'][d] for d in (0,1)])
    return points


def paint_track(mask, track, frame, union=False):
    alpha=int(math.floor(opacity_at(track,frame)*255+.5))
    if alpha<=0:return
    if alpha<255:
        layer=np.zeros_like(mask);paint_track_opaque(layer,track,frame)
        where=layer>0
        if union:mask[where]=np.maximum(mask[where],alpha)
        else:mask[where]=np.minimum(255,alpha+np.floor(mask[where].astype(float)*(1-alpha/255)+.5)).astype(np.uint8)
        return
    paint_track_opaque(mask,track,frame)


def paint_track_opaque(mask, track, frame):
    box = box_at(track,frame)
    if box is None:
        return
    h,w = mask.shape
    path=path_at(track,frame)
    rectangle=len(path)==4 and all(v['point']==p and not any(v['in']+v['out']) for v,p in zip(path,[[0,0],[1,0],[1,1],[0,1]]))
    if ((track.get('appearance') or track.get('staticAppearance')) and not rectangle) or (track.get('motionMode')=='absolute' and (track.get('polygon') or pose_at(track,frame)['angle']%360)):
        paint_polygon(mask,track_polygon(track,frame,w,h))
    elif track.get('polygon'):
        ref=track['samples'][0]['box']
        points=np.asarray(track['polygon'],float)
        for axis in [0,1]:
            points[:,axis]=np.clip(box[axis]+(points[:,axis]-ref[axis])*(box[axis+2]-box[axis])/(ref[axis+2]-ref[axis]),0,1)
        cv2.fillPoly(mask, [np.rint(points*[w,h]).astype(np.int32)], 255)
    else:
        x,y,r,b = box
        mask[max(0,math.floor(y*h)):min(h,math.ceil(b*h)), max(0,math.floor(x*w)):min(w,math.ceil(r*w))] = 255


def mask_at(doc, category, mode, frame, union=None):
    if category == 'dynamic' and mode == 'trail' and union is not None:
        return union
    s = doc['source']
    mask = np.zeros((s['height'],s['width']), np.uint8)
    for track in doc['tracks']:
        if track['enabled'] and track['kind'] == category:
            paint_track(mask, track, frame)
    return mask


def trajectory_union(doc, job=None):
    s = doc['source']
    mask = np.zeros((s['height'],s['width']), np.uint8)
    for track in doc['tracks']:
        if not track['enabled'] or track['kind'] != 'dynamic':
            continue
        for a,b in track['ranges']:
            for frame in range(a,b):
                if job and frame%100 == 0:
                    job.check()
                paint_track(mask,track,frame,union=True)
    return mask


def write_png(file, frame):
    ok, encoded = cv2.imencode('.png',frame)
    if not ok:
        raise RuntimeError('遮罩图片编码失败')
    encoded.tofile(str(file))


def export_category(job, ffmpeg, source, doc, category, mode, *, mask_provider=None, exact_mask=False, cover_color='black'):
    s = doc['source']
    folder = job.directory/category
    folder.mkdir()
    masks_dir = folder/'frames'
    masks_dir.mkdir()
    if mask_provider is not None and mode != 'follow':
        raise ValueError('逐帧像素遮罩只支持当前帧跟随覆盖')
    if exact_mask and mask_provider is None:
        raise ValueError('精确遮罩导出需要逐帧像素来源')
    union = trajectory_union(doc,job) if category == 'dynamic' and mode == 'trail' else None
    def current_mask(frame):
        mask = mask_provider(frame) if mask_provider is not None else mask_at(doc,category,mode,frame,union)
        if mask is None or mask.shape != (s['height'],s['width']) or mask.dtype != np.uint8:
            raise ValueError('逐帧遮罩尺寸或像素格式不一致')
        if exact_mask and not np.isin(mask, [0,255]).all():
            raise ValueError('实验修复遮罩必须为二值像素')
        return mask
    concat = ['ffconcat version 1.0']
    cache = {}
    for frame in range(s['frames']):
        job.check()
        mask = current_mask(frame)
        digest = hashlib.sha256(mask.tobytes()).hexdigest()
        if digest not in cache:
            name = f'{len(cache):06d}.png'
            write_png(masks_dir/name,mask)
            cache[digest] = name
        duration = (s['times'][frame+1] if frame+1<s['frames'] else s['duration'])-s['times'][frame]
        concat += [f"file 'frames/{cache[digest]}'", 'option framerate 1000000', f'duration {duration:.6f}']
        if frame%50 == 0:
            job.status('running',f'生成{ "静态" if category=="static" else "动态" }黑色遮罩 {frame+1}/{s["frames"]}',10+40*frame/s['frames'])
    # A sentinel provides the final real frame's duration; remux removes the sentinel.
    concat += [f"file 'frames/{cache[digest]}'",'option framerate 1000000']
    (folder/'timeline.ffconcat').write_text('\n'.join(concat)+'\n','utf-8')
    job.status('running','编码遮罩时间轴…',52)
    common = ['-c:v','libx264','-threads','4','-preset','fast','-crf','0','-pix_fmt','yuv444p',
              '-enc_time_base','1:1000000','-fps_mode','passthrough','-video_track_timescale','1000000']
    job.run([ffmpeg,'-hide_banner','-nostdin','-y','-f','concat','-safe','0','-i',folder/'timeline.ffconcat',
             *common,folder/'mask-with-sentinel.mp4'],category+'-mask-encode.log')
    job.run([ffmpeg,'-hide_banner','-nostdin','-y','-i',folder/'mask-with-sentinel.mp4',
             '-map','0:v:0','-c','copy','-frames:v',s['frames'],folder/'mask.mp4'],category+'-mask-trim.log')
    # Pad only the compositing input; saved geometry and the lossless mask stay exact.
    # Max filtering preserves opacity values, including fully transparent frames.
    job.status('running','按遮罩形状与不透明度合成视频…',70)
    edge_guard = 0 if exact_mask else BLACK_EDGE_GUARD_PIXELS
    guard_filter = 'format=gray,' + 'dilation,' * edge_guard
    output_format = 'yuv444p' if exact_mask else 'yuv420p'
    if cover_color not in COVER_COLORS: raise ValueError('遮罩颜色无效')
    red, green, blue = COVER_COLORS[cover_color]
    filter_graph = ('[0:v]setpts=PTS-STARTPTS,format=gbrp,split[bg][tmp];'
                    f'[tmp]lutrgb=r={red}:g={green}:b={blue}[fill];'
                    f'[1:v]{guard_filter}format=gbrp[mask];'
                    f'[bg][fill][mask]maskedmerge,format={output_format}[out]')
    last_duration=round((s['duration']-s['times'][-1])*1000000)
    # A frame-limited encode can stop audio packet copying before its final
    # packets. Encode the picture first, then copy every source audio stream in
    # a separate remux with no frame/time/shortest limit.
    picture_path=folder/'video-picture.mp4'
    encode_threads='0' if s['width']*s['height']>1920*1080 else '4'
    job.run([ffmpeg,'-hide_banner','-nostdin','-y','-i',source,'-i',folder/'mask.mp4',
             '-filter_complex',filter_graph,'-map','[out]','-an',
             # Disable perceptual/AQ redistribution that introduced bright black-edge pixels.
             '-c:v','libx264','-threads',encode_threads,'-preset','fast','-crf','0' if exact_mask else '12','-tune','psnr','-bf','0',
             '-enc_time_base','1:1000000','-fps_mode','passthrough','-video_track_timescale','1000000',
             '-bsf:v',f'setts=duration=if(eq(N\\,{s["frames"]-1})\\,{last_duration}\\,DURATION)',
             '-frames:v',s['frames'],'-movflags','+faststart',picture_path],category+'-black-video.log')
    job.status('running','保留完整原音轨…',86)
    job.run([ffmpeg,'-hide_banner','-nostdin','-y','-i',picture_path,'-i',source,
             '-map','0:v:0','-map','1:a?','-c','copy','-video_track_timescale','1000000',
             '-movflags','+faststart',folder/'video.mp4'],category+'-audio-copy.log')
    audio_hash=None
    if s['hasAudio']:
        hashes=[]
        for name,media in [('source',source),('output',folder/'video.mp4')]:
            target=folder/(name+'-audio.sha256')
            job.run([ffmpeg,'-v','error','-nostdin','-y','-i',media,'-map','0:a',
                     '-c','copy','-f','hash','-hash','sha256',target],category+'-'+name+'-audio-hash.log')
            hashes.append(target.read_text('utf-8').strip())
        if hashes[0]!=hashes[1]:
            raise RuntimeError('导出音轨与原片不一致')
        audio_hash=hashes[0]
    # Full pixel replay is required for 1080p regression. Above that, redecoding
    # every 4K frame added about two minutes after the video already existed.
    heavy=s['width']*s['height']>1920*1080
    job.status('running','核对成片时间轴…' if heavy else '核对输出帧数、时间轴与黑色覆盖…',90)
    actual = probe(job,ffmpeg,folder/'video.mp4',category+'-output')
    checked=[actual]
    if not heavy:
        checked.append(probe(job,ffmpeg,folder/'mask.mp4',category+'-mask'))
    for info in checked:
        if info['frames'] != s['frames'] or (info['width'],info['height']) != (s['width'],s['height']):
            raise RuntimeError('输出帧数或分辨率不匹配')
        if max(abs(a-b) for a,b in zip(info['times'],s['times'])) > .0001:
            raise RuntimeError('输出时间轴与输入不匹配')
        if abs(info['duration']-s['duration'])>.0001:
            raise RuntimeError('输出末帧时长与输入不匹配')
    cap = cv2.VideoCapture(str(folder/'video.mp4'))
    mask_cap = cv2.VideoCapture(str(folder/'mask.mp4')) if not heavy else None
    first = None
    max_black_mean = 0
    max_black_covered_channel = 0
    try:
        audit_frames=range(s['frames']) if not heavy else [0]
        for frame in audit_frames:
            job.check()
            ok,picture = cap.read(); 
            if not ok:
                raise RuntimeError('输出解码不完整')
            if mask_cap is not None:
                mok,m = mask_cap.read()
                if not mok:
                    raise RuntimeError('输出解码不完整')
                expected = current_mask(frame)
                if np.max(np.abs(m[:,:,0].astype(np.int16)-expected.astype(np.int16)))>3:
                    raise RuntimeError('输出遮罩与确认范围不一致')
            else:
                expected = current_mask(frame)
            # Include the original boundary and thin masks, which erosion would discard.
            covered = expected == 255
            if cover_color == 'black' and covered.any():
                peak = int(picture[covered].max())
                max_black_covered_channel = max(max_black_covered_channel,peak)
                if peak > BLACK_COVERED_CHANNEL_LIMIT:
                    raise RuntimeError(f'第{frame+1}帧遮罩边缘有颜色残留，输出未通过检查')
            inside = cv2.erode((expected==255).astype(np.uint8),np.ones((7,7),np.uint8))>0
            if inside.any():
                if cover_color == 'black':
                    max_black_mean = max(max_black_mean,float(picture[inside].mean()))
                else:
                    target = np.array(COVER_COLORS[cover_color][::-1], np.int16)
                    max_black_mean = max(max_black_mean,float(np.abs(picture[inside].astype(np.int16)-target).mean()))
            if first is None:
                first = picture
        color_limit = 5 if cover_color == 'black' else 48
        color_name = {'black':'黑色','red':'红色','green':'绿色','blue':'蓝色'}[cover_color]
        if not heavy and max_black_mean > color_limit:
            raise RuntimeError(f'遮罩区域不是{color_name}，输出未通过检查')
        if heavy and max_black_mean > color_limit:
            raise RuntimeError(f'首帧遮罩区域不是{color_name}，输出未通过检查')
    finally:
        cap.release()
        if mask_cap is not None: mask_cap.release()
    write_png(folder/'reference.png',first)
    color_label='黑色遮罩视频' if cover_color=='black' else {'red':'红色','green':'绿色','blue':'蓝色'}[cover_color]+'Mask视频'
    return dict(category=category,mode=mode,coverColor=cover_color,filename=('静态' if category=='static' else '动态-'+('跟随' if mode=='follow' else '拖尾'))+'-'+color_label+'.mp4',
                frames=s['frames'],width=s['width'],height=s['height'],fps=s['fps'],duration=s['duration'],
                hasAudio=actual['hasAudio'],audioPacketsPreserved=True,audioPacketHash=audio_hash,
                maxBlackInteriorMean=max_black_mean,maxBlackCoveredChannel=max_black_covered_channel,
                edgeGuardPixels=edge_guard,exactRepairMask=exact_mask,pixelFormat=output_format,sha256=sha256(folder/'video.mp4'))

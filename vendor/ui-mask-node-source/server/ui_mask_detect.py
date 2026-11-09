"""Propose repaint regions: a backed UI panel is one mask, never its text cells.

These are visual candidates, not semantic guarantees; the user reviews them.
"""
import cv2
import numpy as np
from ui_mask_motion import whole_motion, border_template, border_presence, classify_container


def overlap(a,b):
    inter=max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
    area=lambda q:max(0,q[2]-q[0])*max(0,q[3]-q[1])
    return inter/max(1e-9,area(a)+area(b)-inter)


def containment(child, parent):
    area=max(0,child[2]-child[0])*max(0,child[3]-child[1])
    inter=max(0,min(child[2],parent[2])-max(child[0],parent[0]))*max(0,min(child[3],parent[3])-max(child[1],parent[1]))
    return inter/max(1e-9,area)


def envelope(a,b):
    return [min(a[0],b[0]),min(a[1],b[1]),max(a[2],b[2]),max(a[3],b[3])]


def backed_panels(frame, gray, glyphs):
    """Find the containing plate before proposing its contents.

    Accept tall tables as well as horizontal plates. Connected dark scenery is
    rejected unless its outer contour is rectangular and contains UI-like ink.
    Attach aligned solid header/footer strips using pixel evidence, not distance
    between words; this must not join separate panels across gameplay.
    """
    h,w=gray.shape
    if not len(glyphs):
        return []
    def ink_count(box):
        x,y,r,b=box
        return np.count_nonzero((glyphs[:,0]>=x-2)&(glyphs[:,1]>=y-2)&(glyphs[:,2]<=r+2)&(glyphs[:,3]<=b+2))
    seeds=[]
    for level in (32,56,80,105,128):
        dark=cv2.morphologyEx(np.uint8(gray<level)*255,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
        contours,_=cv2.findContours(dark,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
        for c in contours:
            x,y,bw,bh=cv2.boundingRect(c)
            if bw<max(18,w*.025) or bh<7 or bw*bh>w*h*.96 or cv2.contourArea(c)/(bw*bh)<.82:
                continue
            # Remove short protrusions from nearby shadows without shrinking the
            # continuous plate. Filled contour, rather than ink, defines its edge.
            solid=np.zeros((bh,bw),np.uint8)
            cv2.drawContours(solid,[c-[x,y]],-1,1,-1)
            cols=np.flatnonzero(solid.mean(axis=0)>.88)
            if not len(cols):
                continue
            rows=np.flatnonzero(solid[:,cols[0]:cols[-1]+1].mean(axis=1)>.88)
            if not len(rows):
                continue
            box=[x+int(cols[0]),y+int(rows[0]),x+int(cols[-1])+1,y+int(rows[-1])+1]
            if ink_count(box)<(6 if box[3]-box[1]>h*.18 else 3):
                continue
            # Prefer the darker, well-defined plate when a higher threshold also
            # pulls in nearby scenery. Colored headers are attached separately.
            if not any(overlap(box,p)>.7 for p in seeds):
                seeds.append(box)
    if not seeds:
        return []
    # Header/footer plates can be colored while the table body is black.
    hsv=cv2.cvtColor(frame,cv2.COLOR_BGR2HSV)
    bands=[]
    for hue in range(0,180,30):
        distance=np.abs(hsv[:,:,0].astype(np.int16)-hue)
        distance=np.minimum(distance,180-distance)
        colored=np.uint8((distance<=18)&(hsv[:,:,1]>110)&(hsv[:,:,2]>75))*255
        colored=cv2.morphologyEx(colored,cv2.MORPH_CLOSE,np.ones((3,5),np.uint8))
        contours,_=cv2.findContours(colored,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
        for c in contours:
            x,y,bw,bh=cv2.boundingRect(c)
            if bw>=18 and bh>=5 and bw*bh<w*h*.3 and cv2.contourArea(c)/(bw*bh)>.65:
                bands.append([x,y,x+bw,y+bh])
    for i,seed in enumerate(seeds):
        box=seed[:]
        for _ in range(3):
            before=box[:]
            for band in bands:
                bw,bh=band[2]-band[0],band[3]-band[1]
                pw,ph=box[2]-box[0],box[3]-box[1]
                near_y=max(band[1],box[1])-min(band[3],box[3])<=3
                near_x=max(band[0],box[0])-min(band[2],box[2])<=3
                same_width=abs(band[0]-box[0])<=max(3,pw*.035) and abs(band[2]-box[2])<=max(3,pw*.035)
                same_height=abs(band[1]-box[1])<=max(3,ph*.06) and abs(band[3]-box[3])<=max(3,ph*.06)
                if (near_y and same_width and bh<=max(12,ph*.3)) or (near_x and same_height and bw<=w*.6):
                    box=envelope(box,band)
            if box==before:
                break
        seeds[i]=box
    parents=[]
    for box in sorted(seeds,key=lambda b:(b[2]-b[0])*(b[3]-b[1]),reverse=True):
        if not any(containment(box,p)>.92 for p in parents):
            parents.append(box)
    # The repaint mask includes plate outlines, antialiasing and short shadows.
    margin=max(2,int(np.ceil(min(w,h)*.004)))
    return [[0 if x<=margin*3 else x-margin,0 if y<=margin*3 else y-margin,
             w if r>=w-margin*3 else r+margin,h if b>=h-margin*3 else b+margin] for x,y,r,b in parents]


def text_row_evidence(gray, ink, box):
    """Require contrast and a shared text baseline, not just bright fragments.

    This is conservative visual evidence, not OCR or a semantic UI classifier.
    A connected word and its badge count as two glyphs; independent small name
    labels are retained even when they have no opaque rectangular backing.
    """
    h,w=gray.shape;x,y,r,b=map(int,box)
    x=max(0,x-2);y=max(0,y-2);r=min(w,r+2);b=min(h,b+2)
    crop=ink[y:b,x:r];luma=gray[y:b,x:r]
    if not crop.size:return False
    _,labels,stats,_=cv2.connectedComponentsWithStats(crop,8)
    evidence=[]
    for i,(gx,gy,gw,gh,pixels) in enumerate(stats[1:],1):
        if not (2<=gw<=w*.06 and 5<=gh<=h*.07 and pixels>=8):continue
        mask=np.uint8(labels==i)
        ring=(cv2.dilate(mask,np.ones((5,5),np.uint8))>0)&(crop==0)
        if not ring.any():continue
        contrast=float(np.median(luma[mask>0]))-float(np.median(luma[ring]))
        if contrast>=38:evidence.append((gx,gy,gw,gh))
    for _,gy,_,gh in evidence:
        aligned=[g for g in evidence if abs(g[1]+g[3]-gy-gh)<=max(2,min(gh,g[3])*.4) and .4<=g[3]/gh<=2.5]
        if len(aligned)>=2 and sum(g[2] for g in aligned)>=max(12,w*.018):return True
    return False


def proposals(frame, with_panels=False, excluded_regions=()):
    h,w=frame.shape[:2]
    gray=cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY)
    blue,green,red=cv2.split(frame)
    brightest=cv2.max(cv2.max(blue,green),red)
    darkest=cv2.min(cv2.min(blue,green),red)
    chroma=cv2.subtract(brightest,darkest)
    # Bright letters and icon borders provide proposals, not a semantic UI guarantee.
    ink=np.uint8(((gray>165)&(chroma<90))|((brightest>195)&(chroma>70)&(gray>100)))*255
    for x,y,r,b in excluded_regions:
        ink[y:b,x:r]=0
    count,_,stats,_=cv2.connectedComponentsWithStats(ink,8)
    glyphs=[]
    clean=np.zeros_like(ink)
    for x,y,bw,bh,pixels in stats[1:]:
        if 1<=bw<=w*.045 and 4<=bh<=h*.07 and 4<=pixels<=w*h*.0025 and pixels/(bw*bh)>.08:
            glyphs.append((x,y,x+bw,y+bh))
            clean[y:y+bh,x:x+bw]=ink[y:y+bh,x:x+bw]
    if not glyphs:
        return (gray,[],[]) if with_panels else (gray,[])
    glyphs=np.asarray(glyphs)
    panels=[p for p in backed_panels(frame,gray,glyphs) if not any(containment(p,region)>.7 for region in excluded_regions)]
    # Once a panel is found, its ink must not seed separate text tracks or join
    # nearby scenery. Suppressing only the final boxes is too late: a line can
    # already have grown across the panel boundary by then.
    for x,y,r,b in panels:
        clean[y:b,x:r]=0
    glyphs=np.asarray([g for g in glyphs if not any(p[0]<=(g[0]+g[2])/2<p[2] and p[1]<=(g[1]+g[3])/2<p[3] for p in panels)])
    if not len(glyphs):
        return (gray,panels,panels) if with_panels else (gray,panels)
    grouped=cv2.morphologyEx(clean,cv2.MORPH_CLOSE,cv2.getStructuringElement(cv2.MORPH_RECT,(max(5,int(w*.012)),3)))
    contours,_=cv2.findContours(grouped,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    result=[]
    for c in contours:
        x,y,bw,bh=cv2.boundingRect(c)
        if not (w*.025<=bw<=w*.65 and 4<=bh<=h*.13 and bw/bh>=1.6):
            continue
        inside=(glyphs[:,0]>=x-2)&(glyphs[:,1]>=y-2)&(glyphs[:,2]<=x+bw+2)&(glyphs[:,3]<=y+bh+2)
        if np.count_nonzero(inside)<3:
            continue
        if not text_row_evidence(gray,ink,[x,y,x+bw,y+bh]):
            continue
        # Include adjacent badges, shadows and bars; review can tighten this envelope.
        left=max(0,x-4); top=max(0,y-3);right=min(w,x+bw+4);bottom=min(h,y+bh+6)
        adjacent=(glyphs[:,2]>=left-28)&(glyphs[:,0]<left)&(glyphs[:,1]<bottom)&(glyphs[:,3]>top)
        if adjacent.any():
            badge=glyphs[adjacent]
            left=max(0,int(badge[:,0].min())-2);top=max(0,min(top,int(badge[:,1].min())-2))
            bottom=min(h,max(bottom,int(badge[:,3].max())+3))
        box=[left,top,right,bottom]
        if not any(overlap(box,b)>.6 for b in result):
            result.append(box)
    # Expand detected text to a nearby dark panel when its rectangular boundary is
    # supported by pixels. This includes the plate and blood bar, not just letters.
    dark=np.uint8(gray<105)*255
    dark=cv2.morphologyEx(dark,cv2.MORPH_CLOSE,cv2.getStructuringElement(cv2.MORPH_RECT,(9,3)))
    dark_contours,_=cv2.findContours(dark,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    short_plates=[]
    for c in dark_contours:
        x,y,bw,bh=cv2.boundingRect(c)
        if w*.035<bw<w*.65 and 7<bh<h*.14 and bw/bh>2.2 and np.mean(dark[y:y+bh,x:x+bw]>0)>.66:
            short_plates.append([max(0,x-3),max(0,y-3),min(w,x+bw+3),min(h,y+bh+3)])
    for i,box in enumerate(result):
        for panel in short_plates:
            cx,cy=(box[0]+box[2])/2,(box[1]+box[3])/2
            if panel[0]<cx<panel[2] and panel[1]<cy<panel[3] and overlap(box,panel)>.18:
                result[i]=[min(box[0],panel[0]),min(box[1],panel[1]),max(box[2],panel[2]),max(box[3],panel[3])];break
    # A name, team badge and adjacent bar belong to one panel, not separate tracks.
    merged=[]
    for box in sorted(result,key=lambda b:b[0]):
        joined=False
        for i,b in enumerate(merged):
            vertical=min(box[3],b[3])-max(box[1],b[1])
            gap=max(box[0],b[0])-min(box[2],b[2])
            if vertical>min(box[3]-box[1],b[3]-b[1])*.45 and gap<max(8,min(box[3]-box[1],b[3]-b[1])*.6):
                if max(box[2],b[2])-min(box[0],b[0])<w*.65:
                    merged[i]=[min(box[0],b[0]),min(box[1],b[1]),max(box[2],b[2]),max(box[3],b[3])];joined=True;break
        if not joined:
            merged.append(box)
    # The parent plate owns all its internal text, numbers, icons and dividers.
    # Keep independent unbacked UI outside it as separate candidates.
    boxes=panels+[b for b in merged if not any(containment(b,p)>.85 for p in panels)]
    boxes=[b for b in boxes if not any(containment(b,region)>.7 for region in excluded_regions)]
    boxes=sorted(boxes,key=lambda b:(b[2]-b[0])*(b[3]-b[1]),reverse=True)[:80]
    return (gray,boxes,panels) if with_panels else (gray,boxes)


def stationary_regions(edge_sum, count, w, h):
    if count<3:
        return []
    stable=np.uint8(edge_sum>=count*.75)*255
    stable[:2]=0;stable[-2:]=0;stable[:,:2]=0;stable[:,-2:]=0
    joined=cv2.morphologyEx(stable,cv2.MORPH_CLOSE,cv2.getStructuringElement(cv2.MORPH_RECT,(9,5)))
    contours,_=cv2.findContours(joined,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    boxes=[]
    for c in contours:
        x,y,bw,bh=cv2.boundingRect(c)
        if bw<10 or bh<5 or bw>w*.85 or bw*bh>w*h*.12 or bh>h*.35:
            continue
        cx,cy=(x+bw/2)/w,(y+bh/2)/h
        peripheral=cx<.2 or cx>.8 or cy<.18 or cy>.85
        small_cross=bw<=w*.022 and bh<=h*.035
        if not peripheral and not small_cross:
            continue
        # A fixed screen graphic needs substantial persistent detail. Isolated dots
        # and a single long landscape edge are not proposed as panels.
        pixels=np.count_nonzero(stable[y:y+bh,x:x+bw])
        if pixels<22 or pixels/(bw*bh)<.035:
            continue
        margin=3
        boxes.append([max(0,x-margin)/w,max(0,y-margin)/h,min(w,x+bw+margin)/w,min(h,y+bh+margin)/h])
    return sorted(boxes,key=lambda b:(b[2]-b[0])*(b[3]-b[1]),reverse=True)[:40]


def intervals(frames):
    result=[]
    for frame in frames:
        if result and result[-1][1]==frame:
            result[-1][1]+=1
        else:
            result.append([frame,frame+1])
    return result


def candidate_lifetime(samples, detection_frames, motions, visible, frame_count, *, backed_panel=False):
    """An absence of measurable motion is not proof of a full-clip overlay.

    Only an observed stable region spanning the clip can become full-clip static.
    Sparse edge matches cannot bootstrap a one-frame speck into a UI track.
    """
    if len(detection_frames)<min(3,frame_count):
        return None
    kind,reason=classify_container(motions,visible,[s['frame'] for s in samples],frame_count)
    frames=[s['frame'] for s in samples]
    coordinates=np.asarray([s['box'] for s in samples],float)
    centers=(coordinates[:,:2]+coordinates[:,2:])/2
    stable=np.max(np.quantile(centers,.95,axis=0)-np.quantile(centers,.05,axis=0))<=2.5
    spans_clip=frames[0]==0 and frames[-1]==frame_count-1 and len(set(frames))>=frame_count*.9
    if kind=='static' and not stable and spans_clip and backed_panel:
        # A missed header/footer changes the proposal centre although the
        # actual container stays anchored. Only a consistently detected plate
        # with THREE stable sides may use its complete observed envelope.
        # Translation changes opposing sides; rotation/disappearance already
        # have positive dynamic evidence above. Large reveal animations do
        # not qualify as a small header/footer proposal change.
        spread=np.quantile(coordinates,.95,axis=0)-np.quantile(coordinates,.05,axis=0)
        median_size=np.median(coordinates[:,2:]-coordinates[:,:2],axis=0)
        stable=np.count_nonzero(spread<=2.5)>=3 and np.max(spread)<=min(median_size)*.2
        if stable:reason='固定面板；三侧边界稳定，标题或底栏候选范围变化'
    if kind=='static' and (not stable or not spans_clip):
        kind,reason='dynamic','仅在已观测时段出现；不外推为全片静态'
    return kind,reason


def suppress_panel_children(tracks, allow_equal=False):
    """Absorb internal candidates only while a containing plate covers them.

    A nearby independent UI or a label which moves outside the plate survives.
    Parent visibility must cover every child interval, including disappearances.
    """
    parents=[t for t in tracks if t.get('_panel')]
    def at(t,frame):
        rows=t['samples']
        if t['kind']=='static' or frame<=rows[0]['frame']:
            return rows[0]['box']
        if frame>=rows[-1]['frame']:
            return rows[-1]['box']
        lo,hi=0,len(rows)-1
        while hi-lo>1:
            mid=(lo+hi)//2
            if rows[mid]['frame']<=frame:lo=mid
            else:hi=mid
        a,b=rows[lo],rows[hi];u=(frame-a['frame'])/(b['frame']-a['frame'])
        return [x+(y-x)*u for x,y in zip(a['box'],b['box'])]
    def absorbs(parent,child):
        if parent is child:
            return False
        if not all(any(pa<=a and pb>=b for pa,pb in parent['ranges']) for a,b in child['ranges']):
            return False
        frames={s['frame'] for s in child['samples']}
        frames.update(s['frame'] for s in parent['samples'] if any(a<=s['frame']<b for a,b in child['ranges']))
        frames.update(f for a,b in child['ranges'] for f in (a,b-1))
        for frame in frames:
            small,big=at(child,frame),at(parent,frame)
            small_area=(small[2]-small[0])*(small[3]-small[1]);big_area=(big[2]-big[0])*(big[3]-big[1])
            if big_area<small_area*(.95 if allow_equal else 1.15) or containment(small,big)<.90:
                return False
        return True
    result=[t for t in tracks if not any(absorbs(p,t) for p in parents)]
    for t in result:
        t.pop('_panel',None)
    return result


def detect_video(job, source, meta, reviewed_regions=(), category=None):
    cap=cv2.VideoCapture(str(source))
    scale=min(1,960/meta['width'],540/meta['height'])
    w=max(2,round(meta['width']*scale));h=max(2,round(meta['height']*scale))
    excluded=[np.rint(np.asarray(r['box'])*[w,h,w,h]).astype(int).tolist() for r in reviewed_regions]
    live=[]; finished=[]; previous=None;next_id=1
    try:
        for frame_index in range(meta['frames']):
            job.check()
            ok,frame=cap.read()
            if not ok:
                raise RuntimeError(f'第{frame_index+1}帧读取失败')
            if frame.shape[1::-1]!=(meta['width'],meta['height']):
                raise RuntimeError('视频旋转信息与解码尺寸不一致，请先规范视频方向')
            small=cv2.resize(frame,(w,h),interpolation=cv2.INTER_AREA)
            gray,boxes,panels=proposals(small,with_panels=True,excluded_regions=excluded)
            presence_edges=cv2.dilate(cv2.Canny(gray,55,130),np.ones((5,5),np.uint8))
            cut=previous is not None and np.mean(cv2.absdiff(cv2.resize(gray,(64,36)),cv2.resize(previous,(64,36))))>48
            if cut:
                finished.extend(live);live=[]
            predictions=[];motions=[]
            for t in live:
                box=t['box']
                motion=whole_motion(previous,gray,box) if previous is not None and not t['missed'] else None
                if motion is not None and np.hypot(motion['dx'],motion['dy'])<w*.18:
                    dx,dy=motion['dx'],motion['dy'];box=[box[0]+dx,box[1]+dy,box[2]+dx,box[3]+dy]
                motions.append(motion)
                predictions.append(box)
            pairs=sorted(((overlap(p,b),ti,bi) for ti,p in enumerate(predictions) for bi,b in enumerate(boxes)),reverse=True)
            used_t=set();used_b=set()
            for score,ti,bi in pairs:
                if score<.20:
                    break
                if ti in used_t or bi in used_b:
                    continue
                t=live[ti];t['box']=boxes[bi];t['missed']=0;t['samples'].append(dict(frame=frame_index,box=boxes[bi]))
                t['panel_hits']+=int(boxes[bi] in panels);t['detection_frames'].append(frame_index)
                t['motions'].append(motions[ti]);t['visible'].append(True);t['template']=border_template(gray,boxes[bi])
                used_t.add(ti);used_b.add(bi)
            survivors=[]
            for ti,t in enumerate(live):
                if ti not in used_t:
                    presence=border_presence(gray,t['template'],presence_edges)
                    observed=True if presence is not None and presence>.70 else False if presence is not None and presence<.18 else None
                    t['visible'].append(observed)
                    if t['panel_hits']>=3 and observed is True and motions[ti] is not None and np.hypot(motions[ti]['dx'],motions[ti]['dy'])<.6:
                        # A stable panel border is still present even when its
                        # numbers/animation produce no text proposal this frame.
                        t['samples'].append(dict(frame=frame_index,box=t['box'][:]))
                        t['motions'].append(motions[ti]);t['missed']=0
                    else:t['missed']+=1
                if t['missed']>2:
                    finished.append(t)
                else:
                    survivors.append(t)
            live=survivors
            for bi,b in enumerate(boxes):
                if bi not in used_b:
                    template=border_template(gray,b)
                    before=border_presence(previous,template) if previous is not None else None
                    visibility=[False,True] if before is not None and before<.18 else [True]
                    live.append(dict(id=f'ui-{next_id}',box=b,missed=0,panel_hits=int(b in panels),detection_frames=[frame_index],motions=[],visible=visibility,template=template,samples=[dict(frame=frame_index,box=b)]));next_id+=1
            previous=gray
            if frame_index%20==0:
                job.status('running',f'识别与跟踪UI {frame_index+1}/{meta["frames"]}',10+85*frame_index/meta['frames'])
    finally:
        cap.release()
    finished.extend(live)
    tracks=[dict(id=f'reviewed-static-{i}',label=r['label'],kind='static',enabled=True,_panel=True,
                 origin='user-reviewed-container',classificationReason='用户确认：整块面板固定，内部内容变化不参与分类',
                 ranges=[[0,meta['frames']]],samples=[dict(frame=0,box=r['box'])],keys=[],overrides=[])
            for i,r in enumerate(reviewed_regions)]
    # Persistent text edges no longer create independent static/dynamic tracks.
    # Classification belongs to a containing region and its verified motion.
    static_boxes=[t['samples'][0]['box'] for t in tracks]
    for t in finished:
        samples=t['samples']
        lifetime=candidate_lifetime(samples,t['detection_frames'],t['motions'],t['visible'],meta['frames'],
                                    backed_panel=t['panel_hits']>=len(t['detection_frames'])*.9)
        if lifetime is None:
            continue
        coordinates=np.asarray([p['box'] for p in samples],float)/[w,h,w,h]
        median=np.median(coordinates,axis=0).tolist()
        is_panel=t['panel_hits']>=len(t['detection_frames'])*.5
        if not is_panel and any(overlap([v*1000 for v in median],[v*1000 for v in b])>.45 for b in static_boxes):
            continue
        kind,reason=lifetime
        fixed=kind=='static'
        if fixed:
            # A fixed panel's content/header must not change the repaint region.
            # Retain its full observed extent instead of clipping to median text.
            bounds=[float(coordinates[:,0].min()),float(coordinates[:,1].min()),float(coordinates[:,2].max()),float(coordinates[:,3].max())] if is_panel else median
            rows=[dict(frame=0,box=bounds)]
        else:
            rows=[dict(frame=p['frame'],box=[round(float(v),7) for v in q]) for p,q in zip(samples,coordinates)]
        tracks.append(dict(id=t['id'],label=f'{"静态" if fixed else "动态"}{"面板" if is_panel else "UI"} {len(tracks)+1}',kind=kind,enabled=True,_panel=is_panel,origin='auto-detected',detectorVersion=2,
                           classificationReason=reason,ranges=[[0,meta['frames']]] if fixed else intervals([p['frame'] for p in samples]),samples=rows,keys=[],overrides=[]))
    tracks=suppress_panel_children(tracks)
    if category is not None:
        tracks=[t for t in tracks if t['kind']==category]
    if len(tracks)>2000:
        raise RuntimeError('候选过多，请将视频分段后识别')
    return tracks

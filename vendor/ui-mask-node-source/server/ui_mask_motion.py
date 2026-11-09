"""Classify the UI container, never the animation inside that container."""
import cv2
import numpy as np


def outer_features(gray, box):
    h,w=gray.shape;x,y,r,b=np.rint(box).astype(int)
    x=max(0,x);y=max(0,y);r=min(w,r);b=min(h,b)
    if r-x<5 or b-y<5:return None
    crop=gray[y:b,x:r];mask=np.full_like(crop,255)
    inset=max(2,min(6,round(min(r-x,b-y)*.12)))
    if r-x>inset*2 and b-y>inset*2:mask[inset:-inset,inset:-inset]=0
    points=cv2.goodFeaturesToTrack(crop,maxCorners=48,qualityLevel=.04,minDistance=3,mask=mask)
    return None if points is None else points+np.array([x,y],np.float32)


def whole_motion(previous,current,previous_box):
    """Motion needs a coherent transform supported around the outside border."""
    points=outer_features(previous,previous_box)
    if points is None or len(points)<4:return None
    moved,status,_=cv2.calcOpticalFlowPyrLK(previous,current,points,None,winSize=(25,25),maxLevel=3)
    if moved is None:return None
    back,reverse,_=cv2.calcOpticalFlowPyrLK(current,previous,moved,None,winSize=(25,25),maxLevel=3)
    if back is None:return None
    good=(status.ravel()>0)&(reverse.ravel()>0)&(np.linalg.norm(back-points,axis=2).ravel()<1.2)
    if np.count_nonzero(good)<4:return None
    a=points[good].reshape(-1,2);b=moved[good].reshape(-1,2)
    matrix,inliers=cv2.estimateAffinePartial2D(a,b,method=cv2.RANSAC,ransacReprojThreshold=1.5)
    if matrix is None or inliers is None or inliers.mean()<.75:return None
    # One animated corner is not evidence that the complete panel moved.
    a=a[inliers.ravel()>0];b=b[inliers.ravel()>0]
    bw=previous_box[2]-previous_box[0];bh=previous_box[3]-previous_box[1]
    if np.ptp(a[:,0])<bw*.55 or np.ptp(a[:,1])<bh*.4:return None
    center=np.array([(previous_box[0]+previous_box[2])/2,(previous_box[1]+previous_box[3])/2])
    displacement=matrix[:,:2]@center+matrix[:,2]-center
    return dict(dx=float(displacement[0]),dy=float(displacement[1]),angle=float(np.degrees(np.arctan2(matrix[1,0],matrix[0,0]))))


def border_template(gray,box):
    """Store only an outer ring. Changing numbers/maps/video inside are ignored."""
    h,w=gray.shape;x,y,r,b=np.rint(box).astype(int)
    x=max(0,x);y=max(0,y);r=min(w,r);b=min(h,b)
    if r-x<5 or b-y<5:return None
    edge=cv2.Canny(gray[y:b,x:r],55,130)
    ring=np.zeros_like(edge);depth=max(2,min(7,round(min(r-x,b-y)*.12)))
    ring[:depth]=1;ring[-depth:]=1;ring[:,:depth]=1;ring[:,-depth:]=1
    points=np.argwhere((edge>0)&(ring>0))
    if len(points)<12:return None
    # Cap work independently of video dimensions.
    points=points[::max(1,len(points)//160)]
    return points+np.array([y,x])


def border_presence(gray,template,edge=None):
    if template is None:return None
    if edge is None:edge=cv2.dilate(cv2.Canny(gray,55,130),np.ones((5,5),np.uint8))
    p=template
    return float(np.mean(edge[p[:,0],p[:,1]]>0))


def classify_container(motions, visible, detection_frames, frame_count):
    """Only positive whole-object evidence makes a region dynamic.

    Missing detector observations are not observations of a missing container.
    'visible' contains explicit border-presence observations, possibly unknown.
    """
    reliable=[m for m in motions if m is not None]
    if reliable:
        dx=sum(m['dx'] for m in reliable);dy=sum(m['dy'] for m in reliable)
        path=sum(np.hypot(m['dx'],m['dy']) for m in reliable)
        rotation=np.ptp(np.cumsum([0]+[m['angle'] for m in reliable]))
        if rotation>3:return 'dynamic','整体旋转'
        if np.hypot(dx,dy)>2.5 or path>max(6,len(reliable)*.8):return 'dynamic','整体位移'
    observed=[v for v in visible if v is not None]
    if observed and any(v is False for v in observed) and any(v is True for v in observed):
        return 'dynamic','整体出现或消失'
    return 'static','固定区域；内部内容变化不参与分类'

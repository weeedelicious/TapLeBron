"""Local image evidence shared by production recovery and tracking experiments."""
import cv2
import numpy as np


def local_translations(previous, current, boxes):
    """Estimate translations with corner, photometric and forward/backward checks.

    Returned positions are evidence for matching detector observations only.
    They must never become rendered boxes when the detector has no observation.
    """
    if previous is None or current is None or previous.shape != current.shape:
        return {}
    height, width = previous.shape
    all_points, groups = [], []
    for identity, box in boxes.items():
        x1, y1, x2, y2 = np.rint(box).astype(int)
        x1, y1, x2, y2 = max(0,x1), max(0,y1), min(width,x2), min(height,y2)
        if x2-x1 < 8 or y2-y1 < 8:
            continue
        points = cv2.goodFeaturesToTrack(previous[y1:y2,x1:x2], maxCorners=32,
                                         qualityLevel=.03, minDistance=4, blockSize=3)
        if points is None or len(points) < 6:
            continue
        points = points.reshape(-1,2) + [x1,y1]
        groups.append((identity,len(all_points),len(points)))
        all_points.extend(points)
    if not all_points:
        return {}
    points = np.asarray(all_points,dtype=np.float32).reshape(-1,1,2)
    options = dict(winSize=(31,31),maxLevel=4,
                   criteria=(cv2.TERM_CRITERIA_EPS|cv2.TERM_CRITERIA_COUNT,30,.01))
    forward, status, error = cv2.calcOpticalFlowPyrLK(previous,current,points,None,**options)
    if forward is None:
        return {}
    backward, back_status, _ = cv2.calcOpticalFlowPyrLK(current,previous,forward,None,**options)
    if backward is None:
        return {}
    valid = (status.ravel()!=0) & (back_status.ravel()!=0)
    valid &= np.linalg.norm((backward-points).reshape(-1,2),axis=1) < 1.5
    valid &= error.ravel() < 25
    flow = (forward-points).reshape(-1,2)
    valid &= np.isfinite(flow).all(axis=1)
    result = {}
    for identity,start,count in groups:
        local = flow[start:start+count][valid[start:start+count]]
        if len(local) < 6:
            continue
        median = np.median(local,axis=0)
        inliers = local[np.linalg.norm(local-median,axis=1)<3]
        if len(inliers)<6 or len(inliers)<.6*len(local):
            continue
        delta=np.median(inliers,axis=0)
        if np.linalg.norm(delta) > .25*max(width,height):
            continue
        result[identity]=dict(delta=delta,points=len(inliers))
    return result

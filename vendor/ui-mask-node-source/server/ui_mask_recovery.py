"""Recover actual detector observations supported by nearby confirmed observations.

The original tracker remains authoritative for its existing observations. A
bounded image-evidence chain can recover missing observations, but cannot invent
geometry, create a target without confirmed anchors, or cross a scene/gap.
"""
from collections import defaultdict, deque
import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment
from ui_mask_detect import overlap
from ui_mask_local_evidence import local_translations

VERSION='observed-recovery-v1'
POLICY=dict(window_seconds=.25,max_frame_gap_seconds=.1,min_warp_iou=.5,
            min_size_ratio=2/3,max_size_ratio=1.5,ambiguity_margin=.1,
            required_anchors=2,duplicate_coverage=.9)


def covered_fraction(box, other):
    area=max(0,box[2]-box[0])*max(0,box[3]-box[1])
    intersection=max(0,min(box[2],other[2])-max(box[0],other[0]))*max(0,min(box[3],other[3])-max(box[1],other[1]))
    return intersection/max(area,1e-9)


class ObservationRecovery:
    def __init__(self, confidence, audit=None, max_size_growth_px=None):
        self.confidence=confidence
        self.max_size_growth_px=max_size_growth_px
        self.audit=audit
        self.history=deque()
        self.by_key={}
        self.chains=defaultdict(deque)
        self.previous=[]
        self.gray=None
        self.last_frame=None
        self.last_time=None
        self.epoch=None
        self.next_chain=0
        self.observations=defaultdict(list)
        self.stats=dict(candidates=0,flow_supported=0,linked=0,recovered=0,
                        insufficient_anchors=0,already_covered=0,peak_buffered_candidates=0)

    @staticmethod
    def key(frame,box):
        return frame,tuple(box)

    def add(self,image,proposals,frame,pts,epoch,admitted):
        if self.last_frame is not None and frame<=self.last_frame:
            raise ValueError('Recovery frames must be strictly increasing')
        if self.last_time is not None and pts<=self.last_time:
            raise ValueError('Recovery timestamps must be strictly increasing')
        gray=cv2.cvtColor(image,cv2.COLOR_BGR2GRAY)
        consecutive=(self.epoch==epoch and self.last_frame is not None and frame==self.last_frame+1
                     and pts-self.last_time<=POLICY['max_frame_gap_seconds']+1e-9)
        if not consecutive:
            self.flush()
        nodes=[dict(frame=frame,pts=pts,epoch=epoch,index=i,box=list(p['box']),
                    confidence=float(p['confidence']),anchor=False,done=False)
               for i,p in enumerate(proposals)]
        assigned={}
        if consecutive and self.previous and nodes:
            motion=local_translations(self.gray,gray,{i:n['box'] for i,n in enumerate(self.previous)})
            self.stats['flow_supported']+=len(motion)
            costs=np.full((len(self.previous),len(nodes)),1e6)
            for i,evidence in motion.items():
                old=np.asarray(self.previous[i]['box'])
                moved=old+np.tile(evidence['delta'],2)
                for j,node in enumerate(nodes):
                    box=np.asarray(node['box'])
                    ratios=(box[2:]-box[:2])/np.maximum(old[2:]-old[:2],1e-9)
                    iou=overlap(moved,box)
                    if (iou>=POLICY['min_warp_iou'] and np.all(ratios>=POLICY['min_size_ratio'])
                            and np.all(ratios<=POLICY['max_size_ratio'])):
                        costs[i,j]=1-iou
            if costs.size:
                rr,cc=linear_sum_assignment(costs)
                for i,j in zip(rr,cc):
                    value=costs[i,j]
                    if value>=1e5:continue
                    # Ambiguous parent/child or crossing pairs stay unlinked.
                    alternatives=np.concatenate((np.delete(costs[i],j),np.delete(costs[:,j],i)))
                    if len(alternatives) and np.min(alternatives)-value<POLICY['ambiguity_margin']:
                        continue
                    assigned[j]=self.previous[i]['chain']
        for j,node in enumerate(nodes):
            chain=assigned.get(j)
            if chain is None:
                self.next_chain+=1
                chain=self.next_chain
            else:self.stats['linked']+=1
            node['chain']=chain
            self.history.append(node)
            self.chains[chain].append(node)
            self.by_key[self.key(frame,node['box'])]=node
        # Includes a just-confirmed track's real first observation from the
        # preceding frame. Recovered observations never become new anchors.
        for row in admitted:
            node=self.by_key.get(self.key(row['frame'],row['box']))
            if node is not None:node['anchor']=True
        self.stats['candidates']+=len(nodes)
        self.stats['peak_buffered_candidates']=max(self.stats['peak_buffered_candidates'],len(self.history))
        for node in self.history:
            if pts-node['pts']>POLICY['window_seconds']+1e-9:self._finalize(node)
        while self.history and pts-self.history[0]['pts']>2*POLICY['window_seconds']+1e-9:
            old=self.history.popleft()
            self.by_key.pop(self.key(old['frame'],old['box']),None)
            self.chains[old['chain']].popleft()
            if not self.chains[old['chain']]:del self.chains[old['chain']]
        self.gray,self.previous=gray,nodes
        self.last_frame,self.last_time,self.epoch=frame,pts,epoch

    def _finalize(self,node):
        if node['done']:return
        node['done']=True
        if node['anchor']:return
        anchors=[a for a in self.chains[node['chain']] if a['anchor'] and a['confidence']>=self.confidence
                 and abs(a['pts']-node['pts'])<=POLICY['window_seconds']+1e-9]
        nearby=[n for n in self.history if n['frame']==node['frame'] and n['anchor']]
        reason='insufficient_anchors'
        if any(covered_fraction(node['box'],a['box'])>=POLICY['duplicate_coverage'] for a in nearby):
            reason='already_covered'
        elif len({a['frame'] for a in anchors})>=POLICY['required_anchors']:
            if self.max_size_growth_px is not None:
                sizes=np.asarray([np.asarray(a['box'])[2:]-np.asarray(a['box'])[:2] for a in anchors])
                expected=np.median(sizes,axis=0)
                actual=np.asarray(node['box'])[2:]-np.asarray(node['box'])[:2]
                if np.any(actual>expected+self.max_size_growth_px):
                    self.stats.setdefault('rejected_growth',0);self.stats['rejected_growth']+=1
                    if self.audit:self.audit(dict(frame=node['frame'],box=node['box'],reason='rejected_growth',actualSize=actual.tolist(),anchorMedianSize=expected.tolist()))
                    return
            reason='recovered'
            row=dict(frame=node['frame'],box=node['box'],confidence=node['confidence'])
            self.observations[(node['epoch'],-node['chain'])].append(row)
        self.stats[reason]+=1
        if self.audit:
            self.audit(dict(frame=node['frame'],pts=node['pts'],index=node['index'],box=node['box'],
                confidence=node['confidence'],chain=node['chain'],reason=reason,
                anchors=[dict(frame=a['frame'],confidence=a['confidence']) for a in anchors]))

    def flush(self):
        for node in self.history:self._finalize(node)
        self.history.clear()
        self.by_key.clear()
        self.chains.clear()
        self.previous=[]
        self.gray=None

    def finish(self):
        self.flush()
        return dict(self.observations)

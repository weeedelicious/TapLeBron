import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { maskDetectorConfig, maskPanelConfig } from './uiMaskDetector.js';
export function pipelineVersion(root){
 const hash=crypto.createHash('sha256');
 for(const name of ['ui_mask_trained.py','ui_mask_recovery.py','ui_mask_detect.py','ui_mask_core.py']){const file=path.join(root,'server',name);if(fs.existsSync(file))hash.update(fs.readFileSync(file));}
 return 'node-r1-20261031-'+hash.digest('hex').slice(0,10);
}
export function runIdentity(root,detector,temporalRecovery='off'){
 const model=detector==='panel'?maskPanelConfig(root):detector==='trained'?maskDetectorConfig(root):{};
 return {pipelineVersion:pipelineVersion(root),detector,modelVersion:model.version||null,weightsSha256:model.sha256||null,temporalRecovery:detector==='trained'?temporalRecovery:'off'};
}
export function runIsStale(root,request){
 if(request.kind==='analysis'&&!request.operation)return true;
 if(request.kind==='experiment'||!['trained','panel','rules'].includes(request.detector))return false;
 return !request.provenance||JSON.stringify(request.provenance)!==JSON.stringify(runIdentity(root,request.detector,request.provenance.temporalRecovery));
}
export function recoveryMode(value,category,detector){
 if(value!=null&&!['off','guarded-v2'].includes(value))throw new Error('跨帧方式无效');
 return category==='dynamic'&&detector==='trained'?(value||'off'):'off';
}

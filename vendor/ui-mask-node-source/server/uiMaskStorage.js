import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// A stable per-project local cache, not an automatically deleted scratch folder.
// Existing outputs remain in place; API lookup checks both roots.
export function componentJobsDirectory(root){
  if(process.env.WXHB_UI_COMPONENT_JOBS_DIRECTORY)return path.resolve(process.env.WXHB_UI_COMPONENT_JOBS_DIRECTORY);
  const project=path.resolve(root);
  const identity=process.platform==='win32'?project.toLowerCase():project;
  const key=crypto.createHash('sha256').update(identity).digest('hex').slice(0,16);
  return path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'.cache'),'WXHB_XG','ui-mask-jobs',key);
}

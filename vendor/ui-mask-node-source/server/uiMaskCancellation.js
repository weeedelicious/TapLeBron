import {spawn} from 'node:child_process';
import path from 'node:path';

// Cooperative cancellation first; a stuck import cannot observe the marker.
export function terminateProcessTree(child) {
  if (!child.pid || child.exitCode != null || child.signalCode != null) return;
  if (process.platform !== 'win32') { child.kill('SIGKILL'); return; }
  const killer=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),
    ['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  const fallback=()=>{if(child.exitCode==null&&child.signalCode==null)child.kill('SIGKILL');};
  killer.once('error',fallback);
  killer.once('exit',code=>{if(code!==0)fallback();});
}

export function cancellationGuard(child, {markCancelled, graceMs=5000, terminate=terminateProcessTree}) {
  let timer=null, closed=false, requested=false;
  child.once('close',()=>{closed=true;clearTimeout(timer);timer=null;});
  return ()=>{
    if(closed||requested)return;
    requested=true;
    markCancelled();
    timer=setTimeout(()=>{timer=null;if(!closed)terminate(child);},graceMs);
    timer.unref?.();
  };
}

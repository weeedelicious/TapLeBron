"""Shotflow UI 遮罩 / 视频转码 GPU Worker（4090）。

线上 Shotflow 把遮罩任务（识别 / 导出）的输入文件传过来，这里用同一份 ui_mask_worker.py
在显卡上跑，线上轮询 status.json 同步进度，结束后整包取回任务目录。

目录：
  node/                 ui-mask-node-source 的运行子集（server/*.py、模型配置、权重）
  node/outputs/ui-mask-jobs/<id>/   任务目录，结构与线上完全一致
鉴权：请求头 X-Worker-Token 必须等于 .env 里的 UI_MASK_WORKER_TOKEN。
"""
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

ROOT = Path(__file__).resolve().parent
NODE = ROOT / 'node'
JOBS = NODE / 'outputs' / 'ui-mask-jobs'
WORKER = NODE / 'server' / 'ui_mask_worker.py'
PYTHON = Path(sys.executable)
TOKEN = os.environ.get('UI_MASK_WORKER_TOKEN', '')
KEEP_SECONDS = 2 * 24 * 3600
INPUT_FILES = {'request.json', 'document.json', 'initial-document.json', 'source.bin'}
# 取回时不带的：原视频（线上本来就有）和中间产物
BUNDLE_SKIP = {'source.bin', 'video-picture.mp4', 'mask-with-sentinel.mp4', 'status.json', 'request.json', 'cancel', 'worker.log'}
ID_RE = re.compile(r'^[a-f0-9-]{36}$')

JOBS.mkdir(parents=True, exist_ok=True)
app = FastAPI()
children: dict[str, subprocess.Popen] = {}
lock = threading.Lock()


def job_dir(job_id: str) -> Path:
    if not ID_RE.match(job_id):
        raise HTTPException(400, '任务编号无效')
    return JOBS / job_id


@app.middleware('http')
async def auth(request: Request, call_next):
    if not TOKEN or request.headers.get('x-worker-token') != TOKEN:
        return JSONResponse({'error': 'unauthorized'}, status_code=401)
    return await call_next(request)


@app.get('/health')
def health():
    info = {'ok': True, 'running': len([c for c in children.values() if c.poll() is None])}
    try:
        out = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.used,memory.total,utilization.gpu',
                              '--format=csv,noheader'], capture_output=True, text=True, timeout=10)
        info['gpu'] = out.stdout.strip()
    except Exception as error:  # noqa: BLE001
        info['gpu'] = 'unknown: ' + str(error)
    return info


@app.get('/jobs/{job_id}/inputs')
def inputs(job_id: str):
    folder = job_dir(job_id)
    return {name: (folder / name).stat().st_size for name in INPUT_FILES if (folder / name).is_file()}


@app.put('/jobs/{job_id}/files/{name}')
async def put_file(job_id: str, name: str, request: Request):
    if name not in INPUT_FILES:
        raise HTTPException(400, '不接受这个文件')
    folder = job_dir(job_id)
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / name
    temporary = folder / (name + '.uploading')
    size = 0
    with temporary.open('wb') as handle:
        async for chunk in request.stream():
            size += len(chunk)
            handle.write(chunk)
    os.replace(temporary, target)
    os.utime(folder)
    return {'ok': True, 'size': size}


@app.post('/jobs/{job_id}/start')
def start(job_id: str):
    folder = job_dir(job_id)
    if not (folder / 'request.json').is_file():
        raise HTTPException(400, '缺少 request.json')
    with lock:
        current = children.get(job_id)
        if current and current.poll() is None:
            return {'ok': True, 'already': True}
        for name in ('cancel', 'status.json', 'result.json'):
            (folder / name).unlink(missing_ok=True)
        (folder / 'status.json').write_text(json.dumps(
            {'state': 'running', 'message': '4090 GPU 已接收任务…', 'progress': 1}, ensure_ascii=False), 'utf-8')
        env = dict(os.environ)
        log = (folder / 'worker.log').open('ab')
        children[job_id] = subprocess.Popen(
            [str(PYTHON), '-u', str(WORKER), '--job', str(folder)], cwd=str(NODE), env=env,
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        log.close()
    return {'ok': True}


@app.get('/jobs/{job_id}/status')
def status(job_id: str):
    folder = job_dir(job_id)
    child = children.get(job_id)
    running = bool(child and child.poll() is None)
    try:
        current = json.loads((folder / 'status.json').read_text('utf-8'))
    except Exception:  # noqa: BLE001  正在原子替换时偶尔读不到，下次再取
        current = None
    return {'status': current, 'running': running, 'exitCode': None if running or not child else child.returncode}


@app.post('/jobs/{job_id}/cancel')
def cancel(job_id: str):
    folder = job_dir(job_id)
    if folder.is_dir():
        (folder / 'cancel').write_text('', 'utf-8')
    child = children.get(job_id)
    if child and child.poll() is None:
        def reap():
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                child.kill()
        threading.Thread(target=reap, daemon=True).start()
    return {'ok': True}


@app.get('/jobs/{job_id}/bundle')
def bundle(job_id: str):
    folder = job_dir(job_id)
    if not folder.is_dir():
        raise HTTPException(404, '任务不存在')
    child = children.get(job_id)
    if child and child.poll() is None:
        raise HTTPException(409, '任务还在运行')

    def generate():
        buffer = io.BytesIO()
        with tarfile.open(fileobj=_Pipe(buffer), mode='w|') as archive:
            for path in sorted(folder.rglob('*')):
                if path.is_dir() or path.name in BUNDLE_SKIP or path.name.endswith('.uploading'):
                    continue
                archive.add(str(path), arcname=path.relative_to(folder).as_posix(), recursive=False)
                if buffer.tell():
                    yield buffer.getvalue()
                    buffer.seek(0)
                    buffer.truncate()
        if buffer.tell():
            yield buffer.getvalue()

    return StreamingResponse(generate(), media_type='application/x-tar')


class _Pipe(io.RawIOBase):
    """tarfile 流式写入：写到可清空的 BytesIO，生成器边写边吐。"""
    def __init__(self, buffer):
        self.buffer = buffer

    def writable(self):
        return True

    def write(self, data):
        return self.buffer.write(data)


# ---------------------------------------------------------------------------
# 视频预览 / 查看版转码（360P 节点预览、1080P 展开播放），NVENC 编码。
# 线上 Shotflow 决定参数（短边、帧率上限、码率），这里只负责按参数转码：
#   PUT  /video-variants/<id>/source        原视频
#   POST /video-variants/<id>/run           {outputs:[{name,shortEdge,fps,cq,maxrateKbps,audioKbps}], hasAudio}
#   GET  /video-variants/<id>/files/<name>  取结果
#   DELETE /video-variants/<id>
# ---------------------------------------------------------------------------
VARIANTS = ROOT / 'video-variants'
VARIANTS.mkdir(parents=True, exist_ok=True)
VARIANT_NAME_RE = re.compile(r'^[a-z0-9_-]{1,40}\.mp4$')
VARIANT_KEEP_SECONDS = 3600
nvenc_slots = threading.Semaphore(3)


def ffmpeg_exe():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def variant_dir(job_id: str) -> Path:
    if not ID_RE.match(job_id):
        raise HTTPException(400, '任务编号无效')
    return VARIANTS / job_id


def short_edge_scale(edge: int) -> str:
    return f"scale='if(gte(iw,ih),-2,min(iw,{edge}))':'if(gte(iw,ih),min(ih,{edge}),-2)'"


@app.put('/video-variants/{job_id}/source')
async def variant_source(job_id: str, request: Request):
    folder = variant_dir(job_id)
    folder.mkdir(parents=True, exist_ok=True)
    temporary = folder / 'source.uploading'
    size = 0
    with temporary.open('wb') as handle:
        async for chunk in request.stream():
            size += len(chunk)
            handle.write(chunk)
    os.replace(temporary, folder / 'source.bin')
    return {'ok': True, 'size': size}


@app.post('/video-variants/{job_id}/run')
def variant_run(job_id: str, spec: dict):
    folder = variant_dir(job_id)
    source = folder / 'source.bin'
    if not source.is_file():
        raise HTTPException(400, '缺少原视频')
    outputs = spec.get('outputs') or []
    if not outputs or len(outputs) > 4:
        raise HTTPException(400, '输出参数无效')
    results = {}
    with nvenc_slots:
        for output in outputs:
            name = str(output.get('name') or '')
            if not VARIANT_NAME_RE.match(name):
                raise HTTPException(400, '输出文件名无效')
            edge = int(output.get('shortEdge') or 0)
            if edge < 64 or edge > 4320:
                raise HTTPException(400, '短边无效')
            filters = [short_edge_scale(edge)]
            fps = output.get('fps')
            if fps:
                filters.append(f'fps={float(fps):g}')
            filters.append('format=yuv420p')
            maxrate = int(output.get('maxrateKbps') or 2000)
            command = [ffmpeg_exe(), '-hide_banner', '-nostdin', '-y', '-i', str(source),
                       '-map', '0:v:0', '-vf', ','.join(filters),
                       '-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr',
                       '-cq', str(int(output.get('cq') or 28)), '-b:v', '0',
                       '-maxrate', f'{maxrate}k', '-bufsize', f'{maxrate * 2}k', '-profile:v', 'high']
            if spec.get('hasAudio'):
                command += ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', f"{int(output.get('audioKbps') or 64)}k", '-ac', '2']
            else:
                command += ['-an']
            target = folder / name
            temporary = folder / (name + '.part.mp4')
            command += ['-movflags', '+faststart', str(temporary)]
            started = time.time()
            done = subprocess.run(command, capture_output=True, timeout=600,
                                  creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if done.returncode or not temporary.is_file():
                tail = done.stderr.decode('utf-8', 'replace')[-1200:]
                raise HTTPException(500, f'转码失败：{tail}')
            os.replace(temporary, target)
            results[name] = {'size': target.stat().st_size, 'seconds': round(time.time() - started, 2)}
    return {'ok': True, 'files': results}


@app.get('/video-variants/{job_id}/files/{name}')
def variant_file(job_id: str, name: str):
    if not VARIANT_NAME_RE.match(name):
        raise HTTPException(400, '文件名无效')
    target = variant_dir(job_id) / name
    if not target.is_file():
        raise HTTPException(404, '文件不存在')

    def stream():
        with target.open('rb') as handle:
            while chunk := handle.read(1024 * 1024):
                yield chunk

    return StreamingResponse(stream(), media_type='video/mp4', headers={'Content-Length': str(target.stat().st_size)})


@app.delete('/video-variants/{job_id}')
def variant_delete(job_id: str):
    shutil.rmtree(variant_dir(job_id), ignore_errors=True)
    return {'ok': True}


def cleanup_loop():
    while True:
        time.sleep(3600)
        for folder in VARIANTS.iterdir():
            try:
                if folder.is_dir() and folder.stat().st_mtime < time.time() - VARIANT_KEEP_SECONDS:
                    shutil.rmtree(folder, ignore_errors=True)
            except OSError:
                pass
        cutoff = time.time() - KEEP_SECONDS
        for folder in JOBS.iterdir():
            child = children.get(folder.name)
            if child and child.poll() is None:
                continue
            try:
                if folder.is_dir() and folder.stat().st_mtime < cutoff:
                    shutil.rmtree(folder, ignore_errors=True)
                    children.pop(folder.name, None)
            except OSError:
                pass


threading.Thread(target=cleanup_loop, daemon=True).start()

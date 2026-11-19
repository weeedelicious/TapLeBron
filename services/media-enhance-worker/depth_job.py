from __future__ import annotations

import os
import time
from pathlib import Path


PROVIDERS = {
    'video-depth-anything': {
        'root_env': 'VIDEO_DEPTH_ANYTHING_ROOT',
        'python_env': 'VIDEO_DEPTH_ANYTHING_PYTHON',
        'encoders': {'vits', 'vitb', 'vitl'},
        'model': {
            'vits': 'Video Depth Anything Small',
            'vitb': 'Video Depth Anything Base',
            'vitl': 'Video Depth Anything Large',
        },
    },
    'depthcrafter': {
        'root_env': 'DEPTHCRAFTER_ROOT',
        'python_env': 'DEPTHCRAFTER_PYTHON',
        'encoders': {'svd'},
        'model': {'svd': 'DepthCrafter'},
    },
}


def _progress_parser(line: str):
    if not line.startswith('PROGRESS '):
        return None
    try:
        return float(line.split(' ', 1)[1])
    except ValueError:
        return None


def execute_depth_job(job_id: str) -> None:
    import app as worker

    job = worker._job(job_id)
    job_dir = Path(job['jobDir'])
    input_path = Path(job['inputPath'])
    provider = str(job.get('depthProvider') or '')
    encoder = str(job.get('depthEncoder') or '')
    near = str(job.get('depthNear') or 'bright')
    max_res = int(job.get('maxRes') or 0)
    spec = PROVIDERS.get(provider)
    if job.get('cancelRequested'):
        worker._set_job(job_id, status='cancelled', phase='cancelled', progressPercent=0, error='视频转深度已取消', finishedAt=time.time())
        return
    try:
        if spec is None or encoder not in spec['encoders'] or near not in {'bright', 'dark'} or max_res not in {854, 1280, 1920}:
            raise RuntimeError('depth job settings are invalid')
        if not worker._configured_binary(worker.FFMPEG_BIN) or not worker._configured_binary(worker.FFPROBE_BIN):
            raise RuntimeError('FFmpeg or FFprobe is not installed')
        root = Path(os.environ.get(spec['root_env'], '')).expanduser()
        python_bin = Path(os.environ.get(spec['python_env'], '')).expanduser()
        if not python_bin.is_file():
            raise RuntimeError(provider + ' python is not configured')
        if not (root / 'run.py').is_file():
            raise RuntimeError(provider + ' repo is not installed. Run install_video_depth.ps1 on the worker')
        if provider == 'video-depth-anything':
            checkpoint = root / 'checkpoints' / ('video_depth_anything_' + encoder + '.pth')
            if not checkpoint.is_file():
                raise RuntimeError('Video Depth Anything checkpoint is missing: ' + checkpoint.name)
        worker._set_job(job_id, status='running', phase='probing', progressPercent=2)
        source = worker._probe(input_path, count_frames=True)
        gray_path = job_dir / 'depth-gray.mp4'
        final_path = job_dir / 'depth.mp4'
        cli = Path(__file__).with_name('depth_infer_cli.py')
        command = [
            str(python_bin),
            str(cli),
            '--provider', provider,
            '--repo', str(root),
            '--input', str(input_path),
            '--output', str(gray_path),
            '--encoder', encoder,
            '--max-res', str(max_res),
            '--near', near,
            '--input-size', os.environ.get('VIDEO_DEPTH_INPUT_SIZE', '518'),
            '--steps', os.environ.get('DEPTHCRAFTER_STEPS', '5'),
            '--guidance', os.environ.get('DEPTHCRAFTER_GUIDANCE', '1.0'),
            '--unet', os.environ.get('DEPTHCRAFTER_UNET', 'tencent/DepthCrafter'),
            '--pretrain', os.environ.get('DEPTHCRAFTER_PRETRAIN', 'stabilityai/stable-video-diffusion-img2vid-xt'),
        ]
        if os.environ.get('VIDEO_DEPTH_CPU', '').strip() in {'1', 'true', 'TRUE'}:
            command.append('--cpu')
        worker._run_command(
            job_id,
            command,
            phase='estimating-depth',
            start_progress=4,
            end_progress=88,
            parser=_progress_parser,
        )
        if not gray_path.is_file():
            raise RuntimeError('depth model did not write a video')
        encode = [
            str(worker.FFMPEG_BIN),
            '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
            '-i', str(gray_path),
            '-i', str(input_path),
            '-map', '0:v:0',
            '-map', '1:a:0?',
            '-c:v', 'libx264',
            '-preset', 'medium',
            '-crf', '18',
            '-profile:v', 'high',
            '-pix_fmt', 'yuv420p',
            '-color_range', 'pc',
            '-tag:v', 'avc1',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-shortest',
            '-movflags', '+faststart',
            '-progress', 'pipe:1',
            '-nostats',
            str(final_path),
        ]
        frames = int(source.get('frameCount') or 0)
        worker._run_command(
            job_id,
            encode,
            phase='encoding-mp4',
            start_progress=88,
            end_progress=98,
            parser=worker._ffmpeg_frame_parser(max(1, frames)) if frames else None,
        )
        output = worker._probe(final_path, count_frames=True)
        worker._set_job(
            job_id,
            status='succeeded',
            phase='completed',
            progressPercent=100,
            resultPath=str(final_path),
            resultFileName='depth.mp4',
            resultMimeType='video/mp4',
            resultByteSize=final_path.stat().st_size,
            metadata={
                'videoDepth': True,
                'provider': provider,
                'model': spec['model'][encoder],
                'encoder': encoder,
                'near': near,
                'maxRes': max_res,
                'sourceFps': source.get('fps'),
                'fps': output.get('fps'),
                'durationSec': output.get('durationSec'),
                'width': output.get('width'),
                'height': output.get('height'),
                'frameCount': output.get('frameCount'),
                'codecName': output.get('codecName'),
                'pixelFormat': output.get('pixelFormat'),
                'audioCodecName': output.get('audioCodecName'),
                'formatName': output.get('formatName'),
            },
            finishedAt=time.time(),
        )
    except worker.JobCancelled:
        worker._set_job(job_id, status='cancelled', phase='cancelled', progressPercent=0, error='视频转深度已取消', finishedAt=time.time())
    except Exception as error:
        worker._set_job(job_id, status='failed', phase='failed', progressPercent=0, error=worker._safe_error(str(error)), finishedAt=time.time())

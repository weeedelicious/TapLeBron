/**
 * 视频补帧工具的输出契约：补帧不是把视频“压小”，而是在保持原尺寸和音频的前提下
 * 增加帧，并交付 RV 能直接打开的 H.264/yuv420p MP4。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { vi } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const service = require('../server/services/VideoFrameInterpolationService.js') as typeof import('../server/services/VideoFrameInterpolationService.js')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = require('axios') as typeof import('axios')

function probe(filePath: string) {
  const raw = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,start_time,format_name:stream=index,codec_type,codec_name,profile,pix_fmt,width,height,avg_frame_rate,nb_frames,duration,start_time',
    '-of', 'json',
    filePath,
  ], { encoding: 'utf8', timeout: 30_000 })
  return JSON.parse(raw) as {
    format?: { duration?: string; start_time?: string; format_name?: string }
    streams?: Array<{
      index?: number
      codec_type?: string
      codec_name?: string
      profile?: string
      pix_fmt?: string
      width?: number
      height?: number
      avg_frame_rate?: string
      nb_frames?: string
      duration?: string
      start_time?: string
    }>
  }
}

function stream(payload: ReturnType<typeof probe>, type: string) {
  return payload.streams?.find((item) => item.codec_type === type)
}

function rational(value: string | undefined) {
  const [numerator, denominator] = String(value || '').split('/').map(Number)
  return denominator > 0 ? numerator / denominator : numerator
}

function aacPacketHash(filePath: string) {
  const bytes = execFileSync('ffmpeg', [
    '-nostdin', '-v', 'error', '-i', filePath,
    '-map', '0:a:0', '-c:a', 'copy', '-f', 'adts', 'pipe:1',
  ], { timeout: 30_000 })
  return createHash('sha1').update(bytes).digest('hex')
}

function frameSsim(leftPath: string, leftFrame: number, rightPath: string, rightFrame: number) {
  const graph = [
    `[0:v]select=eq(n\\,${leftFrame}),setpts=PTS-STARTPTS[left]`,
    `[1:v]select=eq(n\\,${rightFrame}),setpts=PTS-STARTPTS[right]`,
    '[left][right]ssim[comparison]',
  ].join(';')
  const result = spawnSync('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'info',
    '-i', leftPath,
    '-i', rightPath,
    '-filter_complex', graph,
    '-map', '[comparison]',
    '-frames:v', '1',
    '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
  if (result.status !== 0) {
    throw new Error(result.stderr || `ffmpeg SSIM exited with ${result.status}`)
  }
  const matches = [...String(result.stderr || '').matchAll(/All:([0-9.]+)/g)]
  return Number(matches.at(-1)?.[1] || 0)
}

describe('视频补帧参数', () => {
  it('只允许升帧，并固定使用质量优先的 RV 输出参数', () => {
    expect(() => service.validateInterpolationRequest({ sourceFps: 24, targetFps: 24 })).toThrow(/高于源视频/)
    expect(service.validateInterpolationRequest({ sourceFps: 23.976, targetFps: 30, durationSec: 4.2 })).toEqual({
      sourceFps: 23.976,
      targetFps: 30,
      durationSec: 4.2,
      method: 'quality',
      provider: 'ffmpeg-minterpolate',
      model: 'FFmpeg MCI 光流',
    })

    const args = service.buildFfmpegArgs('/tmp/source.mp4', '/tmp/output.mp4', 30, {
      crf: 12,
      preset: 'medium',
      audioBitrateKbps: 192,
      durationSec: 4.2,
    })
    const filterIndex = args.indexOf('-vf')
    expect(filterIndex).toBeGreaterThanOrEqual(0)
    const filter = String(args[filterIndex + 1] || '')
    expect(filter).toContain('minterpolate=fps=30:mi_mode=mci')
    expect(filter).toContain('tpad=stop_mode=clone:stop=2')
    expect(filter).toContain('trim=start=0:duration=4.2')
    expect(filter).toContain('setpts=PTS-STARTPTS')
    expect(filter).not.toContain('fps=fps=30:round=up')
    expect(args).not.toContain('-shortest')
    expect(args).not.toContain('-avoid_negative_ts')
    expect(args).toEqual(expect.arrayContaining([
      '-c:v', 'libx264',
      '-crf', '12',
      '-profile:v', 'high',
      '-pix_fmt', 'yuv420p',
      '-tag:v', 'avc1',
      '-vsync', '0',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
    ]))
    expect(service.compatibleFormat({
      extension: 'mp4',
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      codecName: 'h264',
      codecProfile: 'High',
      pixelFormat: 'yuv420p',
      audioCodecName: 'aac',
    })).toBe(true)
  })

  it('提供 OpenFlowFrames 与 Video2X 两种真实 RIFE 方法', () => {
    expect(service.validateInterpolationRequest({
      sourceFps: 24,
      targetFps: 30,
      durationSec: 2,
      method: 'openflowframes',
    })).toMatchObject({
      method: 'openflowframes',
      provider: 'openflowframes',
      model: 'OpenFlowFrames · RIFE 4.26',
    })
    expect(service.validateInterpolationRequest({
      sourceFps: 24,
      targetFps: 30,
      durationSec: 2,
      method: 'video2x',
    })).toMatchObject({
      method: 'video2x',
      provider: 'video2x',
      model: 'Video2X 6.4 · RIFE 4.26',
    })
    expect(() => service.validateInterpolationRequest({
      sourceFps: 24,
      targetFps: 30,
      method: 'made-up',
    })).toThrow(/补帧方法/)
  })

  it('AAC 音轨可以直通，避免补帧时再做一次有损压缩', () => {
    const args = service.buildFfmpegArgs('/tmp/source.mp4', '/tmp/output.mp4', 30, {
      copyAudio: true,
      durationSec: 2,
    })
    expect(args).toEqual(expect.arrayContaining(['-c:a', 'copy']))
    expect(args).not.toContain('-af')
  })
})

describe('真实 FFmpeg 24fps → 30fps', () => {
  let workDir = ''
  let sourcePath = ''
  let outputPath = ''

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'shotflow-frame-interpolation-'))
    sourcePath = join(workDir, 'source-24fps.mp4')
    outputPath = join(workDir, 'output-30fps.mp4')
    execFileSync('ffmpeg', [
      '-nostdin', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
      '-t', '2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      sourcePath,
    ], { timeout: 30_000 })
  })

  afterAll(() => {
    if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
  })

  it('增加帧率但保持尺寸、时长、音频和 RV 兼容编码', async () => {
    const sourceProbe = probe(sourcePath)
    const sourceVideo = stream(sourceProbe, 'video')
    const sourceAudio = stream(sourceProbe, 'audio')
    const sourceDuration = Number(sourceVideo?.duration || sourceProbe.format?.duration || 0)

    await service.interpolateVideo({
      inputPath: sourcePath,
      outputPath,
      sourceFps: rational(sourceVideo?.avg_frame_rate),
      targetFps: 30,
      durationSec: sourceDuration,
      crf: 12,
      preset: 'medium',
      copyAudio: sourceAudio?.codec_name === 'aac',
    })

    expect(statSync(outputPath).size).toBeGreaterThan(0)
    const outputProbe = probe(outputPath)
    const outputVideo = stream(outputProbe, 'video')
    const outputAudio = stream(outputProbe, 'audio')
    expect(outputProbe.format?.format_name?.split(',')).toContain('mp4')
    expect(outputVideo?.codec_name).toBe('h264')
    expect(outputVideo?.profile).toBe('High')
    expect(outputVideo?.pix_fmt).toBe('yuv420p')
    expect(outputVideo?.width).toBe(160)
    expect(outputVideo?.height).toBe(90)
    expect(rational(outputVideo?.avg_frame_rate)).toBeCloseTo(30, 3)
    expect(Number(outputVideo?.nb_frames || 0)).toBe(60)
    expect(Math.abs(Number(outputVideo?.start_time || 0))).toBeLessThan(0.001)
    expect(Math.abs(Number(outputProbe.format?.start_time || 0))).toBeLessThan(0.001)
    expect(Math.abs(Number(outputProbe.format?.duration || 0) - sourceDuration)).toBeLessThanOrEqual((1 / 30) + 0.005)
    const sourceFrameCount = Number(sourceVideo?.nb_frames || 0)
    const outputFrameCount = Number(outputVideo?.nb_frames || 0)
    expect(frameSsim(sourcePath, 0, outputPath, 0)).toBeGreaterThan(0.94)
    expect(frameSsim(sourcePath, sourceFrameCount - 1, outputPath, outputFrameCount - 1)).toBeGreaterThan(0.94)
    expect(outputAudio?.codec_name).toBe('aac')
    expect(aacPacketHash(outputPath)).toBe(aacPacketHash(sourcePath))
  }, 60_000)

  it('输出校验会拒绝改变尺寸或编码的结果', () => {
    const source = { width: 160, height: 90, durationSec: 2 }
    expect(service.validateInterpolationOutput(source, {
      extension: 'mp4',
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      codecName: 'h264',
      codecProfile: 'High',
      pixelFormat: 'yuv420p',
      width: 320,
      height: 180,
      fps: 30,
      durationSec: 2,
    }, 30)).toContain('宽度')
    expect(service.validateInterpolationOutput(source, {
      extension: 'mp4',
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      codecName: 'hevc',
      pixelFormat: 'yuv420p10le',
      width: 160,
      height: 90,
      fps: 30,
      durationSec: 2,
    }, 30)).toContain('RV')
  })

  it('OpenFlowFrames 会提交到 GPU Worker 并下载结果', async () => {
    const gpuOutput = join(workDir, 'gpu-worker-result.mp4')
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { jobId: 'worker-interpolation-1', progressPercent: 1 },
    })
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/result')) return { data: Readable.from(Buffer.from('gpu-result')) }
      return {
        data: {
          jobId: 'worker-interpolation-1',
          status: 'succeeded',
          progressPercent: 100,
          metadata: { model: 'OpenFlowFrames · RIFE 4.26' },
        },
      }
    })
    const remove = vi.spyOn(axios, 'delete').mockResolvedValue({ data: { status: 'deleted' } })
    try {
      const result = await service.interpolateVideo({
        inputPath: sourcePath,
        outputPath: gpuOutput,
        sourceFps: 24,
        targetFps: 30,
        durationSec: 2,
        method: 'openflowframes',
        serviceUrl: 'http://gpu-worker.test:8093',
        serviceToken: 'test-token',
      })
      expect(post).toHaveBeenCalledWith(
        'http://gpu-worker.test:8093/v1/interpolation-jobs',
        expect.anything(),
        expect.objectContaining({ maxBodyLength: Infinity }),
      )
      expect(get).toHaveBeenCalledWith(
        'http://gpu-worker.test:8093/v1/jobs/worker-interpolation-1/result',
        expect.objectContaining({ responseType: 'stream' }),
      )
      expect(remove).toHaveBeenCalled()
      expect(result).toMatchObject({
        provider: 'openflowframes',
        model: 'OpenFlowFrames · RIFE 4.26',
        targetFps: 30,
      })
      expect(statSync(gpuOutput).size).toBeGreaterThan(0)
    } finally {
      post.mockRestore()
      get.mockRestore()
      remove.mockRestore()
    }
  })
})

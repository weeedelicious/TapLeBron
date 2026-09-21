/**
 * AI 高清增强工具回归：普通视频没有 DLSS 的渲染缓冲，因此视频提供
 * NVIDIA 官方 VSR、SeedVR2 与 FlashVSR；图片保留 RealSR / SeedVR2。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mediaEnhanceService = require('../server/services/MediaEnhanceService.js') as typeof import('../server/services/MediaEnhanceService.js')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = require('axios') as typeof import('axios')

describe('MediaEnhanceService 输出合同', () => {
  it('只接受 2×/4×，并根据源尺寸计算精确输出尺寸', () => {
    expect(mediaEnhanceService.validateMediaEnhanceRequest({
      mediaType: 'image',
      scale: 2,
      sourceMeta: { width: 1920, height: 1080 },
    })).toMatchObject({
      enhanceMode: 'faithful',
      provider: 'realsr-ncnn-vulkan',
      model: 'RealSR DF2K',
      targetWidth: 3840,
      targetHeight: 2160,
    })

    expect(mediaEnhanceService.validateMediaEnhanceRequest({
      mediaType: 'image',
      enhanceMode: 'generative',
      scale: 2,
      sourceMeta: { width: 1920, height: 1080 },
    })).toMatchObject({
      enhanceMode: 'generative',
      provider: 'seedvr2',
      model: 'SeedVR2 7B Sharp FP8',
    })

    expect(mediaEnhanceService.validateMediaEnhanceRequest({
      mediaType: 'video',
      enhanceMode: 'nvidia-vsr',
      scale: 2,
      sourceMeta: { width: 1920, height: 1080, fps: 24, durationSec: 2 },
    })).toMatchObject({
      enhanceMode: 'nvidia-vsr',
      provider: 'nvidia-vfx',
      model: 'NVIDIA RTX Video Super Resolution',
    })

    expect(mediaEnhanceService.validateMediaEnhanceRequest({
      mediaType: 'video',
      enhanceMode: 'flashvsr',
      scale: 4,
      sourceMeta: { width: 640, height: 360, fps: 24, durationSec: 2 },
    })).toMatchObject({
      enhanceMode: 'flashvsr',
      provider: 'flashvsr',
      model: 'FlashVSR v1.1 Tiny Long',
      targetWidth: 2560,
      targetHeight: 1440,
    })

    expect(() => mediaEnhanceService.validateMediaEnhanceRequest({
      mediaType: 'image',
      enhanceMode: 'nvidia-vsr',
      scale: 2,
      sourceMeta: { width: 1920, height: 1080 },
    })).toThrow(/只支持视频节点/)

    expect(() => mediaEnhanceService.validateMediaEnhanceRequest({
      mediaType: 'image',
      enhanceMode: 'flashvsr',
      scale: 2,
      sourceMeta: { width: 1920, height: 1080 },
    })).toThrow(/只支持视频节点/)

    expect(() => mediaEnhanceService.validateMediaEnhanceRequest({
      mediaType: 'image',
      scale: 3,
      sourceMeta: { width: 1920, height: 1080 },
    })).toThrow(/2x.*4x/)

    expect(() => mediaEnhanceService.validateMediaEnhanceRequest({
      mediaType: 'image',
      enhanceMode: 'dlss5',
      scale: 2,
      sourceMeta: { width: 1920, height: 1080 },
    })).toThrow(/NVIDIA RTX 视频超分.*SeedVR2.*FlashVSR/)
  })

  it('视频必须保留帧率、音轨，并交付 RV 可读的 H.264 High/yuv420p MP4', () => {
    const sourceMeta = {
      kind: 'video',
      width: 160,
      height: 90,
      fps: 24,
      durationSec: 2,
      videoFrameCount: 48,
      audioCodecName: 'aac',
    }
    const validOutput = {
      kind: 'video',
      width: 320,
      height: 180,
      fps: 24,
      durationSec: 2,
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      codecName: 'h264',
      codecProfile: 'High',
      pixelFormat: 'yuv420p',
      audioCodecName: 'aac',
    }
    expect(mediaEnhanceService.validateMediaEnhanceOutput({
      mediaType: 'video',
      scale: 2,
      sourceMeta,
      outputMeta: validOutput,
      workerMetadata: { frameCount: 48, boundaryFramesVerified: true },
    })).toBe('')

    expect(mediaEnhanceService.validateMediaEnhanceOutput({
      mediaType: 'video',
      scale: 2,
      sourceMeta,
      outputMeta: { ...validOutput, codecName: 'hevc', pixelFormat: 'yuv420p10le' },
      workerMetadata: { frameCount: 48, boundaryFramesVerified: true },
    })).toContain('RV')

    expect(mediaEnhanceService.validateMediaEnhanceOutput({
      mediaType: 'video',
      scale: 2,
      sourceMeta,
      outputMeta: validOutput,
      workerMetadata: { frameCount: 48, boundaryFramesVerified: false },
    })).toContain('首尾帧')
  })
})

describe('MediaEnhanceService Worker 状态轮询容错', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('瞬时 ECONNRESET 后继续查询同一任务，不会重复创建任务', async () => {
    const get = vi.spyOn(axios, 'get')
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce({ data: { status: 'processing', progressPercent: 63 } })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(mediaEnhanceService.getWorkerJob('worker-job-1', {
      serviceUrl: 'http://127.0.0.1:8093',
      serviceToken: 'test-token',
      pollRetryBaseDelayMs: 0,
      pollRetryMaxDelayMs: 0,
    })).resolves.toMatchObject({ status: 'processing', progressPercent: 63 })

    expect(get).toHaveBeenCalledTimes(2)
    expect(get.mock.calls[0]?.[0]).toBe(get.mock.calls[1]?.[0])
  })

  it('鉴权失败不会重试', async () => {
    const get = vi.spyOn(axios, 'get').mockRejectedValue(Object.assign(new Error('unauthorized'), {
      response: { status: 401, data: { detail: 'unauthorized' } },
    }))

    await expect(mediaEnhanceService.getWorkerJob('worker-job-2', {
      serviceUrl: 'http://127.0.0.1:8093',
      serviceToken: 'test-token',
      pollRetryBaseDelayMs: 0,
      pollRetryMaxDelayMs: 0,
    })).rejects.toMatchObject({ code: 'MEDIA_ENHANCE_AUTH_FAILED' })

    expect(get).toHaveBeenCalledTimes(1)
  })
})

describe('SeedVR2 Worker 文件契约', () => {
  it('递归读取 CLI 为视频创建的 PNG 子目录', () => {
    const workerSource = readFileSync(
      join(process.cwd(), 'services/media-enhance-worker/app.py'),
      'utf8',
    )
    expect(workerSource).toContain('frames_generated.rglob("*.png")')
    expect(workerSource).toContain('generated_files = generated_files[SEEDVR2_PREPEND_FRAMES:]')
  })
})

describe('NVIDIA VSR Worker 文件契约', () => {
  it('使用官方 nvvfx VideoSuperRes，并绕开已知的 Windows close 阻塞', () => {
    const workerSource = readFileSync(
      join(process.cwd(), 'services/media-enhance-worker/app.py'),
      'utf8',
    )
    const cliSource = readFileSync(
      join(process.cwd(), 'services/media-enhance-worker/nvidia_vsr_cli.py'),
      'utf8',
    )
    expect(workerSource).toContain('"nvidia-vsr"')
    expect(workerSource).toContain('NVIDIA_VSR_QUALITY')
    expect(workerSource).toContain('setpts=PTS-STARTPTS')
    expect(workerSource).not.toContain('"-avoid_negative_ts"')
    expect(workerSource).toContain('enhanced video no longer starts at the first frame')
    expect(cliSource).toContain('from nvvfx import VideoSuperRes')
    expect(cliSource).toContain('effect.run(source)')
    expect(cliSource).toContain('os._exit(exit_code)')
    expect(cliSource).not.toContain('effect.close()')
  })
})

describe('FlashVSR Worker 文件契约', () => {
  it('使用官方 v1.1 Tiny Long、稀疏注意力和重叠长视频分块', () => {
    const workerSource = readFileSync(
      join(process.cwd(), 'services/media-enhance-worker/app.py'),
      'utf8',
    )
    const cliSource = readFileSync(
      join(process.cwd(), 'services/media-enhance-worker/flashvsr_cli.py'),
      'utf8',
    )
    const installerSource = readFileSync(
      join(process.cwd(), 'services/media-enhance-worker/install_flashvsr.ps1'),
      'utf8',
    )
    expect(workerSource).toContain('"flashvsr"')
    expect(workerSource).toContain('FLASHVSR_COMMIT')
    expect(workerSource).toContain('_enhance_video_flashvsr')
    expect(cliSource).toContain('FlashVSRTinyLongPipeline')
    expect(cliSource).toContain('chunk_overlap')
    expect(cliSource).toContain('mode="edge"')
    expect(installerSource).toContain('OpenImagingLab/FlashVSR.git')
    expect(installerSource).toContain('block_sparse_attn')
    expect(installerSource).toContain('cf910c61a60733e610e9c6e8b607f80c3a6c202b')
  })
})

describe('AI 高清增强弹窗', () => {
  let root: Root | null = null
  let host: HTMLDivElement | null = null

  afterEach(() => {
    if (root) act(() => root?.unmount())
    host?.remove()
    root = null
    host = null
  })

  it('提供 2×/4×，选择 4× 时显示预计尺寸并按 4×执行', async () => {
    const { MediaEnhanceModal } = await import('@/features/media-enhance/MediaEnhanceModal')
    const onConfirm = vi.fn()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(
        <MediaEnhanceModal
          mediaType="image"
          url="/assets/p/source.png"
          widthHint={1920}
          heightHint={1080}
          onCancel={() => undefined}
          onConfirm={onConfirm}
        />,
      )
    })

    const buttons = [...document.body.querySelectorAll('button')]
    const fourTimes = buttons.find((button) => button.textContent?.includes('4×'))
    expect(fourTimes).toBeTruthy()
    act(() => fourTimes?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(document.body.textContent).toContain('7680 × 4320')

    const execute = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('执行生成式增强'))
    act(() => execute?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onConfirm).toHaveBeenCalledWith('generative', 4)
  })

  it('生成式细节明确提示会重绘，并按 SeedVR2 模式执行', async () => {
    const { MediaEnhanceModal } = await import('@/features/media-enhance/MediaEnhanceModal')
    const onConfirm = vi.fn()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(
        <MediaEnhanceModal
          mediaType="video"
          url="/assets/p/source.mp4"
          widthHint={1920}
          heightHint={1080}
          fpsHint={24}
          durationHintSec={2}
          onCancel={() => undefined}
          onConfirm={onConfirm}
        />,
      )
    })

    const generative = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('生成式细节'))
    expect(generative).toBeTruthy()
    act(() => generative?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(document.body.textContent).toContain('皮肤、发丝、材质和自然光影')
    const execute = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('执行生成式增强'))
    act(() => execute?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onConfirm).toHaveBeenCalledWith('generative', 2)
  })

  it('视频默认提供 NVIDIA，并保留 SeedVR2 与 FlashVSR 选项', async () => {
    const { MediaEnhanceModal } = await import('@/features/media-enhance/MediaEnhanceModal')
    const onConfirm = vi.fn()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(
        <MediaEnhanceModal
          mediaType="video"
          url="/assets/p/source.mp4"
          widthHint={854}
          heightHint={480}
          fpsHint={24}
          durationHintSec={2}
          onCancel={() => undefined}
          onConfirm={onConfirm}
        />,
      )
    })

    expect(document.body.textContent).toContain('NVIDIA RTX 视频超分')
    expect(document.body.textContent).toContain('SeedVR2 生成式细节')
    expect(document.body.textContent).toContain('FlashVSR 电影级细节')
    expect(document.body.textContent).toContain('普通 MP4 没有游戏 DLSS 所需的深度和运动矢量')
    const execute = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('执行 NVIDIA 超分'))
    act(() => execute?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onConfirm).toHaveBeenCalledWith('nvidia-vsr', 2)
  })

  it('FlashVSR 明确显示官方 v1.1 与 4× 推荐，并按 FlashVSR 模式执行', async () => {
    const { MediaEnhanceModal } = await import('@/features/media-enhance/MediaEnhanceModal')
    const onConfirm = vi.fn()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(
        <MediaEnhanceModal
          mediaType="video"
          url="/assets/p/source.mp4"
          widthHint={640}
          heightHint={360}
          fpsHint={24}
          durationHintSec={2}
          onCancel={() => undefined}
          onConfirm={onConfirm}
        />,
      )
    })

    const flashVsr = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('FlashVSR 电影级细节'))
    expect(flashVsr).toBeTruthy()
    act(() => flashVsr?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(document.body.textContent).toContain('FlashVSR 官方 v1.1')
    expect(document.body.textContent).toContain('4× 是官方推荐档')
    const execute = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('执行 FlashVSR 增强'))
    act(() => execute?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onConfirm).toHaveBeenCalledWith('flashvsr', 2)
  })
})

describe('节点工具入口', () => {
  it.each(['ImageNode.tsx', 'VideoNode.tsx', 'UploadNode.tsx'])('%s 使用共用高清增强流程', (fileName) => {
    const source = readFileSync(
      join(__dirname, '..', 'src/canvas/components/nodes', fileName),
      'utf8',
    )
    expect(source).toContain('useMediaEnhance')
    expect(source).toContain("key: 'media-enhance'")
    expect(source).toContain('{mediaEnhance.modal}')
  })
})

const activeTasks = vi.fn(async () => [])
const recoverableTasks = vi.fn(async () => [])
const apply = vi.fn(async () => ({}))

vi.mock('@/lib/api', () => ({
  nodesApi: {
    upsert: vi.fn(async () => ({ ok: true, nodeVersion: 1, contentVersion: 'cv' })),
    deleteNode: vi.fn(async () => ({ ok: true, deleted: true })),
    delete: vi.fn(async () => ({ data: { contentVersion: 'cv' } })),
    batchSave: vi.fn(),
    events: vi.fn(async () => []),
  },
  projectsApi: { get: vi.fn(), saveDraft: vi.fn(async () => ({})) },
  generateApi: {
    poll: vi.fn(),
    apply: (...args: unknown[]) => apply(...(args as [])),
    orphan: vi.fn(async () => ({})),
    recover: vi.fn(async () => ({})),
    cancel: vi.fn(async () => ({})),
    activeTasks: (...args: unknown[]) => activeTasks(...(args as [])),
    recoverableTasks: (...args: unknown[]) => recoverableTasks(...(args as [])),
  },
  CANVAS_CLIENT_ID: 'test-client',
}))

const { useCanvasStore } = await import('@/store/canvasStore')
const { useTasksStore } = await import('@/store/tasksStore')

describe('高清增强任务刷新恢复', () => {
  beforeEach(() => {
    activeTasks.mockReset().mockResolvedValue([])
    recoverableTasks.mockReset().mockResolvedValue([])
    apply.mockReset().mockResolvedValue({})
    useCanvasStore.setState({ nodes: [], edges: [], projectUuid: '' })
    useTasksStore.setState({ tasks: {} })
  })

  it('恢复结果时保留倍率、尺寸、编码、画质和首尾帧校验信息', async () => {
    const node = useCanvasStore.getState().addNodeAt('video', 0, 0, {
      url: [],
      params: {
        ...({ model: 'RealSR DF2K', settings: { ratio: 'auto', resolution: '320x180', duration: 2 } }),
        mediaEnhance: {
          mediaType: 'video',
          scale: 2,
          sourceWidth: 160,
          sourceHeight: 90,
          targetWidth: 320,
          targetHeight: 180,
          sourceFps: 24,
          qualityMode: 'quality',
        },
      } as unknown as Record<string, unknown>,
    })
    useCanvasStore.setState({ persistNodesAndWait: (async () => true) as never })
    recoverableTasks.mockResolvedValue([{
      jobId: 'enhance-job',
      nodeKey: node.id,
      taskType: 'video',
      status: 2,
      progressPercent: 100,
      urls: ['/assets/p/enhanced.mp4'],
      providerStatus: { phaseLabel: 'AI 高清增强', scale: 2, fps: 24 },
      meta: {
        mode: 'media_enhance',
        model: 'RealSR DF2K',
        resolution: '320x180',
        generationVersion: 1,
        applyStatus: 'pending',
        outputs: [{
          index: 0,
          url: '/assets/p/enhanced.mp4',
          width: 320,
          height: 180,
          metadata: {
            mediaEnhance: true,
            enhanceProvider: 'realsr-ncnn-vulkan',
            enhanceModel: 'RealSR DF2K',
            scale: 2,
            sourceWidth: 160,
            sourceHeight: 90,
            sourceFps: 24,
            fps: 24,
            frameCount: 48,
            codecName: 'h264',
            codecProfile: 'High',
            pixelFormat: 'yuv420p',
            formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
            qualityMode: 'quality',
            crf: 12,
            preset: 'slow',
            boundaryFramesVerified: true,
          },
        }],
      },
    }])

    await useTasksStore.getState().restoreProjectTasks('p')

    const restored = useCanvasStore.getState().nodes.find((item) => item.id === node.id)
    const meta = restored?.data._assetGenerationMeta?.['/assets/p/enhanced.mp4']
    expect(restored?.data.url).toEqual(['/assets/p/enhanced.mp4'])
    expect(meta).toMatchObject({
      mediaEnhance: true,
      enhanceMode: 'faithful',
      enhanceProvider: 'realsr-ncnn-vulkan',
      enhanceModel: 'RealSR DF2K',
      scale: 2,
      sourceWidth: 160,
      sourceHeight: 90,
      outputWidth: 320,
      outputHeight: 180,
      sourceFps: 24,
      fps: 24,
      frameCount: 48,
      codecName: 'h264',
      codecProfile: 'High',
      pixelFormat: 'yuv420p',
      qualityMode: 'quality',
      crf: 12,
      preset: 'slow',
      boundaryFramesVerified: true,
      generativeDetails: false,
    })
    expect(apply).toHaveBeenCalledWith('enhance-job', expect.any(Array))
  })

  it('刷新后仍能识别 SeedVR2 生成式细节产物与参数', async () => {
    const node = useCanvasStore.getState().addNodeAt('image', 0, 0, {
      url: [],
      params: {
        model: 'SeedVR2 7B Sharp FP8',
        settings: { ratio: 'original', resolution: '2048x2048' },
        mediaEnhance: {
          enhanceMode: 'generative',
          provider: 'seedvr2',
          model: 'SeedVR2 7B Sharp FP8',
          mediaType: 'image',
          scale: 2,
          sourceWidth: 1024,
          sourceHeight: 1024,
          targetWidth: 2048,
          targetHeight: 2048,
          generativeDetails: true,
        },
      } as unknown as Record<string, unknown>,
    })
    useCanvasStore.setState({ persistNodesAndWait: (async () => true) as never })
    recoverableTasks.mockResolvedValue([{
      jobId: 'seedvr2-job',
      nodeKey: node.id,
      taskType: 'image',
      status: 2,
      progressPercent: 100,
      urls: ['/assets/p/seedvr2.png'],
      providerStatus: { phaseLabel: 'AI 生成式细节', enhanceMode: 'generative', scale: 2 },
      meta: {
        mode: 'media_enhance',
        model: 'SeedVR2 7B Sharp FP8',
        resolution: '2048x2048',
        generationVersion: 1,
        applyStatus: 'pending',
        outputs: [{
          index: 0,
          url: '/assets/p/seedvr2.png',
          width: 2048,
          height: 2048,
          metadata: {
            mediaEnhance: true,
            enhanceMode: 'generative',
            enhanceProvider: 'seedvr2',
            enhanceModel: 'SeedVR2 7B Sharp FP8',
            generativeDetails: true,
            colorCorrection: 'lab',
            batchSize: 1,
            seedvr2Commit: '4490bd1f482e026674543386bb2a4d176da245b9',
            contentFramesVerified: true,
          },
        }],
      },
    }])

    await useTasksStore.getState().restoreProjectTasks('p')

    const restored = useCanvasStore.getState().nodes.find((item) => item.id === node.id)
    expect(restored?.data._assetGenerationMeta?.['/assets/p/seedvr2.png']).toMatchObject({
      mediaEnhance: true,
      enhanceMode: 'generative',
      enhanceProvider: 'seedvr2',
      enhanceModel: 'SeedVR2 7B Sharp FP8',
      generativeDetails: true,
      colorCorrection: 'lab',
      batchSize: 1,
      seedvr2Commit: '4490bd1f482e026674543386bb2a4d176da245b9',
      contentFramesVerified: true,
    })
    expect(apply).toHaveBeenCalledWith('seedvr2-job', expect.any(Array))
  })

  it('刷新后仍能识别 NVIDIA RTX 视频超分产物与质量档', async () => {
    const node = useCanvasStore.getState().addNodeAt('video', 0, 0, {
      url: [],
      params: {
        model: 'NVIDIA RTX Video Super Resolution',
        settings: { ratio: 'auto', resolution: '1708x960', duration: 2 },
        mediaEnhance: {
          enhanceMode: 'nvidia-vsr',
          provider: 'nvidia-vfx',
          model: 'NVIDIA RTX Video Super Resolution',
          mediaType: 'video',
          scale: 2,
          nvidiaVfxVersion: '0.1.0.1',
          nvidiaVsrQuality: 'ULTRA',
        },
      } as unknown as Record<string, unknown>,
    })
    useCanvasStore.setState({ persistNodesAndWait: (async () => true) as never })
    recoverableTasks.mockResolvedValue([{
      jobId: 'nvidia-vsr-job',
      nodeKey: node.id,
      taskType: 'video',
      status: 2,
      progressPercent: 100,
      urls: ['/assets/p/nvidia-vsr.mp4'],
      providerStatus: { phaseLabel: 'NVIDIA RTX 视频超分', enhanceMode: 'nvidia-vsr', scale: 2 },
      meta: {
        mode: 'media_enhance',
        model: 'NVIDIA RTX Video Super Resolution',
        resolution: '1708x960',
        generationVersion: 1,
        applyStatus: 'pending',
        outputs: [{
          index: 0,
          url: '/assets/p/nvidia-vsr.mp4',
          width: 1708,
          height: 960,
          metadata: {
            mediaEnhance: true,
            enhanceMode: 'nvidia-vsr',
            enhanceProvider: 'nvidia-vfx',
            enhanceModel: 'NVIDIA RTX Video Super Resolution',
            nvidiaVfxVersion: '0.1.0.1',
            nvidiaVsrQuality: 'ULTRA',
            generativeDetails: false,
            boundaryFramesVerified: true,
          },
        }],
      },
    }])

    await useTasksStore.getState().restoreProjectTasks('p')

    expect(useCanvasStore.getState().nodes.find((item) => item.id === node.id)
      ?.data._assetGenerationMeta?.['/assets/p/nvidia-vsr.mp4']).toMatchObject({
      enhanceMode: 'nvidia-vsr',
      enhanceProvider: 'nvidia-vfx',
      enhanceModel: 'NVIDIA RTX Video Super Resolution',
      nvidiaVfxVersion: '0.1.0.1',
      nvidiaVsrQuality: 'ULTRA',
      generativeDetails: false,
      boundaryFramesVerified: true,
    })
    expect(apply).toHaveBeenCalledWith('nvidia-vsr-job', expect.any(Array))
  })
})

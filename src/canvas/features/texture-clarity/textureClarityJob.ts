import { textureClarityApi, type TextureClarityAssets, type TextureClarityRepair } from '@/lib/api'
import { useCanvasStore } from '@/store/canvasStore'
import { defaultImageParams } from '@/lib/nodeData'
import { serviceErrorLine } from '@/lib/serviceErrors'
import type { TaskInfo } from '@/lib/types'

/**
 * 细化纹理的生成执行器。**整条链**都在这里跑：准备控制素材 → 生成修复 → 写回节点。
 *
 * 为什么准备也在这里（2026-08-21 用户反馈"弹窗里要等很长时间"）：
 * 准备控制素材要跑 4090 上的语义分区和 MoGe-2 深度/法线，几十秒。原来这一步挂在弹窗打开时
 * 同步等，等完才让人点生成 —— 人就干瞪眼看着四个「准备中」。现在弹窗秒开，等待全部发生在
 * 画布上的新节点里，进度条按阶段报当前在干什么。
 *
 * 顺带省掉一次重复推理：服务端只缓存了素材**文件**，语义分区推理每次调用都会重跑
 * （requestSemanticParts 前面没有缓存判断）。原来"打开弹窗准备一次 + 点生成再跑一次"就是
 * 两次推理；现在只有真的要生成时才准备，跑一次。弹窗里主动点了「加载控制素材预览」的话，
 * 那份结果会带过来直接复用，同样只跑一次。
 *
 * 为什么不放在弹窗组件里：点「生成」之后弹窗就关了，这个请求不能挂在任何一个 React 组件的
 * 生命周期上 —— 节点组件会因为画布平移/虚拟化卸载重挂，弹窗更是马上就没了。这里用模块级
 * 函数 + store.getState() 写回，谁都不依赖。
 *
 * 每调用一次就新建一个节点，绝不覆盖上一次的结果：再点一次生成就是再多一个节点、多一条线。
 *
 * 已知代价：修复接口是同步请求-响应，服务端没有任务记录。所以**刷新页面会丢**结果的落点
 * （图其实已经生成并存进资产了，只是没有节点接住它）。要彻底解决得把 /texture-clarity/repair
 * 改成异步任务，那要动 generation_tasks 那套机制，不在这次范围里。
 */

const NODE_OFFSET_X = 700
/** 语义分区 + MoGe-2 深度法线的经验耗时。深度法线按源图哈希命中缓存时会快很多。 */
const PREP_ESTIMATED_MS = 45_000
/** 单次生图 + 本地融合的经验耗时。只用来画进度条，不是超时时间。 */
const REPAIR_ESTIMATED_MS = 75_000

export interface TextureClarityJobInput {
  projectUuid: string
  /** 源节点 id，用来建引用（引用一塞，边由 edgesFromNodeReferences 推导出来）。 */
  sourceNodeId: string
  sourceNodePos: { x: number; y: number } | null
  /** 新节点相对源节点的横向偏移。上传节点比图片节点宽，需要更大的偏移才不压在一起。 */
  offsetX?: number
  /** 源图地址。控制素材没预加载时，任务自己拿它去准备。 */
  sourceUrl: string
  /**
   * 弹窗里已经点过「加载控制素材预览」的话把那份结果带过来，任务直接复用、跳过准备阶段，
   * 免得语义分区白跑第二遍。没预览过就传 null / 不传。
   */
  assets?: TextureClarityAssets | null
  model: string
}

function textureClarityMeta(
  input: TextureClarityJobInput,
  assets: TextureClarityAssets | null,
  result?: TextureClarityRepair,
) {
  const { model } = input
  return {
    sourceNodeKey: input.sourceNodeId,
    sourceHash: assets?.sourceHash ?? null,
    assetVersion: assets?.assetVersion ?? null,
    fusionPolicy: assets?.fusionPolicy ?? null,
    requestModel: result?.requestModel ?? model,
    resolvedModel: result?.resolvedModel ?? null,
    semanticModelId: assets?.semantic.modelId || null,
    candidateUrl: result?.candidateUrl ?? null,
    outputWidth: assets?.source.width ?? null,
    outputHeight: assets?.source.height ?? null,
    generationCalls: result?.generationCalls ?? 0,
    passed: result?.passed ?? null,
    // failures 是"门禁为什么没过"的唯一记录。以前只存了 passed，于是对比界面只能说
    // "没通过"却说不出原因 —— 那等于没有诊断价值。
    failures: result?.failures ?? null,
    diagnostics: result?.diagnostics ?? null,
  }
}

/**
 * 立刻建一个「生成中」的图片节点并跑完整条链，返回新节点 id。
 * 不 await —— 调用方点完就可以关弹窗。
 */
export function startTextureClarityRepair(input: TextureClarityJobInput): string {
  const { projectUuid, sourceNodeId, sourceNodePos, model } = input
  const preloaded = input.assets ?? null
  const base = sourceNodePos || { x: 0, y: 0 }
  const offsetX = Number.isFinite(input.offsetX) ? Number(input.offsetX) : NODE_OFFSET_X
  const localTaskId = `texture-clarity-${Date.now()}`
  // 预览过就用规范化后的源图，否则用节点上的原图 —— 准备阶段自己会规范化。
  const sourceUrl = preloaded?.source.url || input.sourceUrl || ''
  // 要准备时是两步，直接复用预览结果时只有一步。步号如实反映，别写死 1/2。
  const needsPrep = !preloaded?.semantic.classMapUrl
  const prepLabel = '准备控制素材 1/2'
  const repairLabel = needsPrep ? '生成修复 2/2' : '生成修复'

  const runningTask = (phaseLabel: string, estimatedMs: number): TaskInfo => ({
    taskId: localTaskId,
    loading: true,
    status: 1,
    progressPercent: 0,
    quantity: 1,
    startedAtMs: Date.now(),
    estimatedMs,
    model,
    taskKind: 'image',
    phaseLabel,
  })

  const failedTask = (phaseLabel: string, message: string): TaskInfo => ({
    taskId: localTaskId,
    loading: false,
    status: 3,
    progressPercent: 0,
    quantity: 1,
    startedAtMs: Date.now(),
    estimatedMs: REPAIR_ESTIMATED_MS,
    model,
    taskKind: 'image',
    phaseLabel,
    error: message,
  })

  const created = useCanvasStore.getState().addNodeAt('image', base.x + offsetX, base.y, {
    name: `细化纹理_${String(Date.now()).slice(-4)}`,
    url: [],
    // 合成一个 taskInfo，直接复用节点上现成的 GenerationProgress，不另做一套等待样式。
    taskInfo: needsPrep
      ? runningTask(prepLabel, PREP_ESTIMATED_MS)
      : runningTask(repairLabel, REPAIR_ESTIMATED_MS),
    params: {
      ...defaultImageParams(),
      model,
      imageList: [{ nodeId: sourceNodeId, url: sourceUrl }],
      textureClarity: textureClarityMeta(input, preloaded),
    } as unknown as Record<string, unknown>,
  })

  void (async () => {
    let assets = preloaded
    // 当前阶段名，出错时报清楚是哪一步炸的
    let phase = needsPrep ? prepLabel : repairLabel
    try {
      if (needsPrep) {
        if (!sourceUrl) throw new Error('没有可用的源图')
        assets = await textureClarityApi.assets({
          projectUuid,
          nodeKey: sourceNodeId,
          sourceUrl,
        })
        // 语义类别图是融合支持区的唯一依据，没有它就没法保证"蒙版外像素等于原图"。
        // 这时候必须在**掏钱生图之前**停下 —— 生了也没法安全融合。
        if (!assets?.semantic.classMapUrl) {
          // reason 常常是 connect ETIMEDOUT 这类天书，翻成人话再抛（原文保留在后半截）
          throw new Error(
            `语义分区不可用，无法计算融合支持区${
              assets?.semantic.reason ? `：${serviceErrorLine(assets.semantic.reason)}` : ''
            }`,
          )
        }
        phase = repairLabel
        // 进准备好了，换成生成阶段的条：各阶段各自计时，比拿一个假的总百分比骗人好。
        useCanvasStore.getState().updateNodeData(created.id, {
          taskInfo: runningTask(repairLabel, REPAIR_ESTIMATED_MS),
        })
      }

      const ready = assets as TextureClarityAssets
      const result = await textureClarityApi.repair({
        projectUuid,
        nodeKey: sourceNodeId,
        model,
        sourceUrl: ready.source.url,
        classMapUrl: ready.semantic.classMapUrl as string,
        semanticUrl: ready.semantic.previewUrl,
        depthUrl: ready.geometry.depthUrl,
        normalUrl: ready.geometry.normalUrl,
      })
      const store = useCanvasStore.getState()
      store.updateNodeData(created.id, {
        url: [result.fusedUrl],
        taskInfo: undefined,
        params: {
          ...defaultImageParams(),
          model: result.requestModel || model,
          imageList: [{ nodeId: sourceNodeId, url: ready.source.url }],
          textureClarity: textureClarityMeta(input, ready, result),
        } as unknown as Record<string, unknown>,
      })
      void store.persistNodes()
    } catch (error) {
      // 失败也留着节点，把原因写在上面 —— 悄悄删掉节点等于让人不知道花了钱没拿到东西。
      // 报错走翻译：4090 的 worker 挂了时原文是 connect ETIMEDOUT，谁都看不出该找谁。
      const message = serviceErrorLine(error)
      const store = useCanvasStore.getState()
      store.updateNodeData(created.id, { taskInfo: failedTask(phase, message) })
      void store.persistNodes()
    }
  })()

  return created.id
}

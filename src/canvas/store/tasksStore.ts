import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import { generateApi, type ActiveGenerationTask } from '@/lib/api'
import { useCanvasStore } from './canvasStore'
import type { VideoParams, VideoHistoryItem, CanvasNodeData, ImageParams, TaskInfo, FailedGeneration } from '@/lib/types'
import { mergeAssetCreatedAtMap } from '@/lib/assetTimestamps'
import { estimateTaskFromNodeData } from '@/lib/generationProgress'

interface TaskEntry {
  jobId: string
  nodeKey: string
  generationVersion: number
  status: number
  progressPercent: number
  startedAtMs: number
  estimatedMs: number
  quantity?: number
  model?: string
  taskKind: TaskInfo['taskKind']
  error?: string
}

interface TasksState {
  tasks: Record<string, TaskEntry>
  addTask: (jobId: string, nodeKey: string, generationVersion?: number) => void
  startPolling: (jobId: string, projectUuid: string) => void
  restoreProjectTasks: (projectUuid: string) => Promise<void>
  removeTask: (jobId: string) => void
  cancelTask: (jobId: string, nodeKey?: string) => void
}

const intervals: Record<string, ReturnType<typeof setInterval>> = {}

function taskInfoFromEntry(entry: TaskEntry, patch: Partial<TaskInfo> = {}): TaskInfo {
  return {
    taskId: entry.jobId,
    generationVersion: entry.generationVersion,
    applyStatus: 'pending',
    loading: true,
    status: entry.status as 0 | 1 | 2 | 3,
    progressPercent: entry.progressPercent,
    quantity: entry.quantity,
    startedAtMs: entry.startedAtMs,
    estimatedMs: entry.estimatedMs,
    model: entry.model,
    taskKind: entry.taskKind,
    ...patch,
  }
}

function findNodeByKey(nodeKey: string) {
  return useCanvasStore.getState().nodes.find(node => node.id === nodeKey || node.data.nodeKey === nodeKey)
}

/**
 * 这个任务还算不算这个节点的？算就继续轮询并应用结果，不算就丢弃。
 *
 * 以前的判据是「必须等于节点当前的 taskInfo.taskId，且版本号要对得上」——那是
 * 「一个节点同时只有一次有效生成」的前端一半，点第二次生成就把第一次判死。
 * 现在改成：**只要还登记在 _pendingTasks 里就算数**，于是多条可以并存。
 * 版本号不再参与判定 —— 并发的本意就是旧的也要留下，用版本号卡等于又把它判死。
 * 没有 _pendingTasks 的老画布回落到原来的 taskId 比较，行为不变。
 */
function isTaskOwnedByNode(entry: TaskEntry, nodeData?: CanvasNodeData): boolean {
  const pending = nodeData?._pendingTasks
  if (pending && Object.prototype.hasOwnProperty.call(pending, entry.jobId)) return true
  if (pending && Object.keys(pending).length > 0) return false
  const taskInfo = nodeData?.taskInfo
  return Boolean(taskInfo && taskInfo.taskId === entry.jobId)
}

/** 失败记录最多留 10 条，够看就行，别把节点数据撑大。 */
function appendFailedGeneration(nodeData: CanvasNodeData | undefined, failed: FailedGeneration): FailedGeneration[] {
  const previous = Array.isArray(nodeData?._failedGenerations) ? nodeData._failedGenerations : []
  if (previous.some((item) => item.taskId === failed.taskId)) return previous
  return [...previous, failed].slice(-10)
}

/** 失败时顺手记下当时的设置，方便对照是哪一条挂的。 */
function failedGenerationSettings(nodeData: CanvasNodeData | undefined) {
  const params = (nodeData?.params ?? {}) as unknown as VideoParams
  const settings = (params.settings ?? {}) as Partial<VideoParams['settings']>
  return {
    resolution: settings.resolution,
    ratio: settings.ratio,
    durationSec: Number(settings.duration) || undefined,
    prompt: String(params.prompt ?? '').slice(0, 200) || undefined,
  }
}

/** 往 _pendingTasks 里登记 / 摘掉一个任务，不动其它任务。 */
function pendingTasksWith(
  nodeData: CanvasNodeData | undefined,
  jobId: string,
  info: TaskInfo | null,
): Record<string, TaskInfo> {
  const next = { ...((nodeData?._pendingTasks ?? {}) as Record<string, TaskInfo>) }
  if (info) next[jobId] = info
  else delete next[jobId]
  return next
}

function mergeResultUrls(newUrls: string[], oldUrls: unknown): string[] {
  const previous = Array.isArray(oldUrls)
    ? oldUrls.filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
    : []
  const seen = new Set<string>()
  return [...previous, ...newUrls]
    .filter((url) => {
      if (!url || seen.has(url)) return false
      seen.add(url)
      return true
    })
    .slice(-30)
}

function taskKindFromType(taskType: unknown, fallback: TaskInfo['taskKind']): TaskInfo['taskKind'] {
  if (taskType === 'image' || taskType === 'video' || taskType === 'text') return taskType
  return fallback ?? 'other'
}

function timeFromServer(value: unknown, fallback = Date.now()) {
  if (!value) return fallback
  const ms = Date.parse(String(value))
  return Number.isFinite(ms) ? ms : fallback
}

function recoveryOutputs(task: ActiveGenerationTask) {
  const urls = Array.isArray(task.urls) ? task.urls.filter((url): url is string => typeof url === 'string' && Boolean(url)) : []
  const outputs = Array.isArray(task.meta?.outputs) ? task.meta.outputs as Array<Record<string, unknown>> : []
  return urls.map((url, index) => ({
    ...(outputs.find(output => Number(output.index) === index || output.url === url) || {}),
    index,
    url,
    isPrimary: index === 0,
  }))
}

function restoredEntryFromNode(jobId: string, nodeKey: string, nodeData?: CanvasNodeData, serverTask?: ActiveGenerationTask): TaskEntry {
  const estimate = estimateTaskFromNodeData(nodeData)
  const taskInfo = nodeData?.taskInfo
  const generationVersion = Math.max(
    1,
    Number(serverTask?.meta?.generationVersion || 0) ||
      Number(taskInfo?.generationVersion || 0) ||
      Number(nodeData?._generationVersion || 0) ||
      1
  )
  return {
    jobId,
    nodeKey,
    generationVersion,
    status: Number(serverTask?.status || taskInfo?.status || 1),
    progressPercent: Math.max(0, Math.min(99, Number(serverTask?.progressPercent ?? taskInfo?.progressPercent ?? 0) || 0)),
    startedAtMs: Number(taskInfo?.startedAtMs || 0) || timeFromServer(serverTask?.meta?.createdAt),
    estimatedMs: Number(taskInfo?.estimatedMs || 0) || estimate.estimatedMs,
    quantity: Number(serverTask?.meta?.quantity || taskInfo?.quantity || estimate.quantity || 1),
    model: String(serverTask?.meta?.model || taskInfo?.model || estimate.model || ''),
    taskKind: taskKindFromType(serverTask?.taskType, taskInfo?.taskKind ?? estimate.taskKind),
    error: String(serverTask?.error || taskInfo?.error || ''),
  }
}

export const useTasksStore = create<TasksState>((set, get) => ({
  tasks: {},

  addTask: (jobId, nodeKey, serverGenerationVersion) => {
    const store = useCanvasStore.getState()
    const node = findNodeByKey(nodeKey)
    const estimate = estimateTaskFromNodeData(node?.data as CanvasNodeData | undefined)
    const previousVersion = Number((node?.data as CanvasNodeData | undefined)?._generationVersion || 0)
    const generationVersion = Math.max(1, Number(serverGenerationVersion || 0) || previousVersion + 1)
    const entry: TaskEntry = {
      jobId,
      nodeKey,
      generationVersion,
      status: 1,
      progressPercent: 0,
      startedAtMs: Date.now(),
      estimatedMs: estimate.estimatedMs,
      quantity: estimate.quantity,
      model: estimate.model,
      taskKind: estimate.taskKind,
    }

    set(s => ({
      tasks: { ...s.tasks, [jobId]: entry },
    }))
    const info = taskInfoFromEntry(entry)
    store.updateNodeData(nodeKey, {
      // taskInfo 仍然指最新那条（老代码和其它节点类型都还读它）；
      // 同时把这条登记进 _pendingTasks，前一条**不动**，于是两条并存。
      taskInfo: info,
      _pendingTasks: pendingTasksWith(node?.data as CanvasNodeData | undefined, jobId, info),
      _generationVersion: generationVersion,
    })
  },

  startPolling: (jobId: string, _projectUuid: string) => {
    if (intervals[jobId]) {
      clearInterval(intervals[jobId])
      delete intervals[jobId]
    }

    const { tasks } = get()
    const entry = tasks[jobId]
    if (!entry) return

    let errorCount = 0
    const MAX_ERRORS = 12
    const MAX_ATTEMPTS = 900

    let attempts = 0
    const interval = setInterval(async () => {
      attempts++
      const current = get().tasks[jobId]
      if (!current || attempts > MAX_ATTEMPTS) {
        clearInterval(interval)
        delete intervals[jobId]
        if (attempts > MAX_ATTEMPTS) get().removeTask(jobId)
        return
      }

      try {
        const res = await generateApi.poll(jobId)
        errorCount = 0
        if (!get().tasks[jobId]) {
          clearInterval(interval)
          delete intervals[jobId]
          return
        }

        const liveNode = findNodeByKey(current.nodeKey)
        if (!liveNode) {
          clearInterval(interval)
          delete intervals[jobId]
          get().removeTask(jobId)
          void generateApi.orphan(jobId).catch(() => undefined)
          return
        }
        const liveNodeData = liveNode.data as CanvasNodeData
        const serverSuperseded = res.meta?.shouldApply === false || res.meta?.applyStatus === 'superseded' || res.meta?.applyStatus === 'orphaned'
        if (!isTaskOwnedByNode(current, liveNodeData) || serverSuperseded) {
          clearInterval(interval)
          delete intervals[jobId]
          get().removeTask(jobId)
          return
        }

        let infoEntry: TaskEntry = current
        set(s => {
          infoEntry = {
            ...s.tasks[jobId],
            status: res.status,
            progressPercent: res.progressPercent,
            generationVersion: Number(res.meta?.generationVersion || s.tasks[jobId]?.generationVersion || current.generationVersion),
          }
          return { tasks: { ...s.tasks, [jobId]: infoEntry } }
        })

        const liveInfo = taskInfoFromEntry(infoEntry, {
          loading: res.status < 2,
          status: res.status as 0 | 1 | 2 | 3,
          progressPercent: res.progressPercent,
          error: res.error,
          generationVersion: infoEntry.generationVersion,
          applyStatus: res.meta?.applyStatus ?? 'pending',
        })
        useCanvasStore.getState().updateNodeData(current.nodeKey, {
          // 只有"最新那条"才写 taskInfo —— 否则一条旧任务的进度会把最新任务的 taskInfo 顶掉。
          ...(liveNodeData.taskInfo?.taskId === jobId ? { taskInfo: liveInfo } : {}),
          _pendingTasks: pendingTasksWith(liveNodeData, jobId, liveInfo),
        })

        if (res.status === 2 && res.urls?.length) {
          const completedAtMs = Date.now()
          const store = useCanvasStore.getState()
          const node = findNodeByKey(current.nodeKey)
          const nodeData = node?.data as CanvasNodeData | undefined
          if (!node || !isTaskOwnedByNode(infoEntry, nodeData)) {
            clearInterval(interval)
            delete intervals[jobId]
            get().removeTask(jobId)
            if (!node) void generateApi.orphan(jobId).catch(() => undefined)
            return
          }
          const assetCreatedAtMs = mergeAssetCreatedAtMap(nodeData?._assetCreatedAtMs, res.urls, completedAtMs)
          const completedTaskInfo = taskInfoFromEntry(infoEntry, {
            loading: false,
            status: 2,
            progressPercent: 100,
            completedAtMs,
            generationVersion: infoEntry.generationVersion,
            applyStatus: 'applied',
          })

          if (node && nodeData?.type === 'video') {
            const p = (nodeData.params ?? {}) as unknown as VideoParams
            const historyItem: VideoHistoryItem = {
              id: uuidv4(),
              timestamp: completedAtMs,
              url: res.urls[0],
              prompt: p.prompt ?? '',
              promptHtml: p.promptHtml,
              promptChips: p.promptChips,
              model: p.model ?? 'Seedance_2_0',
              modeType: (p.modeType as string) ?? 'omni',
              settings: { ...p.settings },
              imageList: [...(p.imageList ?? [])],
            }
            const prevHistory: VideoHistoryItem[] = p.history ?? []
            // 按产物存一份"这条视频是怎么生成的"。以前只有图片分支写这个，视频节点的查看器里
            // 模型 / 分辨率 / 生成时间全是「—」。比例、时长、提示词一起存，多条视频才分得清。
            const videoAssetMeta = { ...(nodeData._assetGenerationMeta ?? {}) }
            for (const [outputIndex, url] of res.urls.entries()) {
              videoAssetMeta[url] = {
                model: res.meta?.model || p.model || infoEntry.model,
                resolution: res.meta?.resolution || p.settings?.resolution,
                ratio: p.settings?.ratio,
                durationSec: Number(p.settings?.duration) || undefined,
                modeType: p.modeType as string | undefined,
                prompt: String(p.prompt ?? '').slice(0, 500) || undefined,
                createdAtMs: completedAtMs,
                taskId: jobId,
                generationVersion: infoEntry.generationVersion,
                outputIndex,
              }
            }
            store.updateNodeData(current.nodeKey, {
              url: mergeResultUrls(res.urls, nodeData.url),
              ...(nodeData.taskInfo?.taskId === jobId ? { taskInfo: completedTaskInfo } : {}),
              // 跑完就从"在跑的"里摘掉，它的进度条随之消失，别的任务不受影响
              _pendingTasks: pendingTasksWith(nodeData, jobId, null),
              params: { ...p, history: [historyItem, ...prevHistory].slice(0, 20) } as unknown as Record<string, unknown>,
              // 并发时"主视频"只认第一次落地的那条，后来的追加但不抢主位 —— 否则你正在看的
              // 主视频会被另一条刚跑完的顶掉。
              ...(nodeData._primaryAssetUrl ? {} : { _primaryAssetUrl: res.urls[0] }),
              _assetCreatedAtMs: assetCreatedAtMs,
              _assetGenerationMeta: videoAssetMeta,
              _updatedAtMs: completedAtMs,
            })
          } else if (node && nodeData?.type === 'image') {
            const imageParams = (nodeData.params ?? {}) as unknown as ImageParams
            const generatedAssetMeta = { ...(nodeData._assetGenerationMeta ?? {}) }
            const submittedModel = res.meta?.model || imageParams.model || current.model
            const submittedResolution = res.meta?.resolution || imageParams.settings?.resolution || '1K'
            for (const [outputIndex, url] of res.urls.entries()) {
              generatedAssetMeta[url] = {
                model: submittedModel,
                resolution: submittedResolution,
                createdAtMs: completedAtMs,
                taskId: jobId,
                generationVersion: infoEntry.generationVersion,
                outputIndex,
              }
            }
            store.updateNodeData(current.nodeKey, {
              url: mergeResultUrls(res.urls, nodeData.url),
              taskInfo: completedTaskInfo,
              _primaryAssetUrl: res.urls[0],
              _assetCreatedAtMs: assetCreatedAtMs,
              _assetGenerationMeta: generatedAssetMeta,
              _updatedAtMs: completedAtMs,
            })
          } else {
            store.updateNodeData(current.nodeKey, {
              url: res.urls,
              taskInfo: completedTaskInfo,
              _assetCreatedAtMs: assetCreatedAtMs,
              _updatedAtMs: completedAtMs,
            })
          }
          const outputs = res.urls.map((url, index) => {
            const persisted = res.meta?.outputs?.find(output => output.index === index || output.url === url)
            return {
              ...persisted,
              index,
              url,
              model: persisted?.model || res.meta?.model || infoEntry.model,
              resolution: persisted?.resolution || res.meta?.resolution,
              isPrimary: index === 0,
              metadata: {
                ...(persisted?.metadata || {}),
                appliedAtMs: completedAtMs,
              },
            }
          })
          const saved = await store.persistNodesAndWait()
          if (saved) {
            await generateApi.apply(jobId, outputs).catch(error => console.warn('mark task applied failed', error))
            clearInterval(interval)
            delete intervals[jobId]
            get().removeTask(jobId)
          } else {
            await generateApi.recover(_projectUuid, jobId).catch(error => console.warn('recover completed generation result failed', error))
          }
        } else if (res.status === 3) {
          const failedNode = findNodeByKey(current.nodeKey)
          const failedData = failedNode?.data as CanvasNodeData | undefined
          const message = String(res.error ?? '生成失败')
          const failedInfo = taskInfoFromEntry(infoEntry, { loading: false, status: 3, progressPercent: 0, error: message })
          useCanvasStore.getState().updateNodeData(current.nodeKey, {
            ...(failedData?.taskInfo?.taskId === jobId ? { taskInfo: failedInfo } : {}),
            _pendingTasks: pendingTasksWith(failedData, jobId, null),
            // 失败的这条在多视频列表里留一个空位 + 红色报错，别让它悄悄消失 ——
            // 并发之后同时可能有好几条在跑，光靠一个 taskInfo.error 根本说不清是哪条挂了。
            _failedGenerations: appendFailedGeneration(failedData, {
              taskId: jobId,
              error: message,
              createdAtMs: Date.now(),
              model: infoEntry.model,
              ...failedGenerationSettings(failedData),
            }),
          })
          clearInterval(interval)
          delete intervals[jobId]
          get().removeTask(jobId)
        }
      } catch (e) {
        errorCount++
        console.error('poll error', e)
        if (errorCount >= MAX_ERRORS) {
          useCanvasStore.getState().updateNodeData(current.nodeKey, {
            taskInfo: taskInfoFromEntry(current, { loading: false, status: 3, progressPercent: 0, error: '轮询超时，请重试' }),
          })
          clearInterval(interval)
          delete intervals[jobId]
          get().removeTask(jobId)
        }
      }
    }, 10000)

    intervals[jobId] = interval
  },

  restoreProjectTasks: async (projectUuid: string) => {
    if (!projectUuid) return
    const canvasStore = useCanvasStore.getState()
    const restoredJobIds = new Set<string>()

    const restoreEntry = (entry: TaskEntry, nodeData?: CanvasNodeData) => {
      if (!entry.jobId || restoredJobIds.has(entry.jobId)) return
      restoredJobIds.add(entry.jobId)
      set(s => ({
        tasks: { ...s.tasks, [entry.jobId]: entry },
      }))
      canvasStore.updateNodeData(entry.nodeKey, {
        taskInfo: taskInfoFromEntry(entry, {
          loading: true,
          status: entry.status as 0 | 1 | 2 | 3,
          progressPercent: entry.progressPercent,
          error: entry.error || nodeData?.taskInfo?.error,
          generationVersion: entry.generationVersion,
        }),
        _generationVersion: Math.max(
          Number(nodeData?._generationVersion || 0),
          Number(entry.generationVersion || 0)
        ),
      })
      get().startPolling(entry.jobId, projectUuid)
    }

    for (const node of canvasStore.nodes) {
      const nodeData = node.data as CanvasNodeData
      const taskId = nodeData.taskInfo?.loading ? String(nodeData.taskInfo.taskId || '') : ''
      if (!taskId) continue
      restoreEntry(restoredEntryFromNode(taskId, node.id, nodeData), nodeData)
    }

    let activeTasks: ActiveGenerationTask[] = []
    try {
      activeTasks = await generateApi.activeTasks(projectUuid)
    } catch (error) {
      console.warn('restore active generation tasks failed', error)
    }

    for (const activeTask of activeTasks) {
      const jobId = String(activeTask.jobId || '')
      const nodeKey = String(activeTask.nodeKey || '')
      if (!jobId || !nodeKey) continue
      const node = findNodeByKey(nodeKey)
      const nodeData = node?.data as CanvasNodeData | undefined
      if (!node || !nodeData) continue
      restoreEntry(restoredEntryFromNode(jobId, node.id, nodeData, activeTask), nodeData)
    }

    let recoverableTasks: ActiveGenerationTask[] = []
    try {
      recoverableTasks = await generateApi.recoverableTasks(projectUuid)
    } catch (error) {
      console.warn('restore completed generation results failed', error)
    }

    for (const task of recoverableTasks) {
      const jobId = String(task.jobId || '')
      const nodeKey = String(task.nodeKey || '')
      const urls = Array.isArray(task.urls) ? task.urls.filter((url): url is string => typeof url === 'string' && Boolean(url)) : []
      if (!jobId || !nodeKey || !urls.length) continue
      const node = findNodeByKey(nodeKey)
      const nodeData = node?.data as CanvasNodeData | undefined
      if (!node || !nodeData || (Array.isArray(nodeData.url) && nodeData.url.length > 0)) continue
      const serverVersion = Number(task.meta?.generationVersion || 0)
      const nodeVersion = Number(nodeData._generationVersion || nodeData.taskInfo?.generationVersion || 0)
      if (serverVersion && nodeVersion && serverVersion < nodeVersion) continue

      const completedAtMs = timeFromServer(task.meta?.updatedAt)
      const generatedAssetMeta = { ...(nodeData._assetGenerationMeta ?? {}) }
      for (const [outputIndex, url] of urls.entries()) {
        generatedAssetMeta[url] = {
          model: String(task.meta?.model || ''),
          resolution: String(task.meta?.resolution || ''),
          createdAtMs: completedAtMs,
          taskId: jobId,
          generationVersion: serverVersion,
          outputIndex,
        }
      }
      const entry = restoredEntryFromNode(jobId, node.id, nodeData, task)
      if (task.meta?.applyStatus === 'applied') {
        await generateApi.recover(projectUuid, jobId).catch(error => console.warn('recover completed generation result failed', error))
        continue
      }
      canvasStore.updateNodeData(node.id, {
        url: urls,
        taskInfo: taskInfoFromEntry(entry, {
          loading: false,
          status: 2,
          progressPercent: 100,
          completedAtMs,
          applyStatus: 'pending',
        }),
        _primaryAssetUrl: urls[0],
        _assetCreatedAtMs: mergeAssetCreatedAtMap(nodeData._assetCreatedAtMs, urls, completedAtMs),
        _assetGenerationMeta: generatedAssetMeta,
        _generationVersion: Math.max(nodeVersion, serverVersion),
        _updatedAtMs: completedAtMs,
      })
      const saved = await useCanvasStore.getState().persistNodesAndWait()
      if (saved) {
        await generateApi.apply(jobId, recoveryOutputs(task)).catch(error => console.warn('mark recovered task applied failed', error))
      } else {
        await generateApi.recover(projectUuid, jobId).catch(error => console.warn('recover completed generation result failed', error))
      }
    }

    /**
     * 打开画布时清一次僵尸条目：_pendingTasks 里凡是没被恢复成活任务的，一律摘掉。
     * 这些是历史遗留 —— 取消 / 被作废的任务没摘干净会留 loading:true（进度条永挂），
     * 图片任务跑完也没摘会留 loading:false（只是白占画布 JSON，一张画布已堆到 16 条）。
     * 走到这里说明该恢复的都恢复完了，剩下的就是垃圾。
     */
    const liveJobIds = new Set(Object.keys(get().tasks))
    for (const node of useCanvasStore.getState().nodes) {
      const nodeData = node.data as CanvasNodeData
      const pending = nodeData._pendingTasks
      if (!pending) continue
      const stale = Object.keys(pending).filter((jobId) => !liveJobIds.has(jobId))
      if (stale.length === 0) continue
      const next: Record<string, TaskInfo> = {}
      for (const [jobId, info] of Object.entries(pending)) {
        if (liveJobIds.has(jobId)) next[jobId] = info
      }
      useCanvasStore.getState().updateNodeData(node.id, {
        _pendingTasks: Object.keys(next).length > 0 ? next : undefined,
      })
    }
  },

  removeTask: (jobId) => {
    /**
     * 这里是**唯一收口**：任务无论以哪种方式退场（跑完 / 失败 / 被取消 / 被作废 / 轮询超时 /
     * 节点没了），都会走到 removeTask，所以把"从节点的在跑列表里摘掉"也放在这里。
     *
     * 之前只有"跑完"和"失败"两条路摘除，取消和被作废那两条没摘 —— 于是节点上留下一条
     * loading:true 的僵尸条目，那根进度条永远挂在下面、计时一直涨（2026-08-19 线上实证：
     * 画布 278 有 3 条 cancelled 的任务留着 loading=true）。图片分支也漏了，结果每生成一张图
     * 就往画布 JSON 里堆一条永不消失的 loading:false 条目（同一张画布已经堆了 16 条）。
     */
    const nodeKey = get().tasks[jobId]?.nodeKey
    if (nodeKey) {
      const node = findNodeByKey(nodeKey)
      const nodeData = node?.data as CanvasNodeData | undefined
      if (nodeData?._pendingTasks && Object.prototype.hasOwnProperty.call(nodeData._pendingTasks, jobId)) {
        useCanvasStore.getState().updateNodeData(nodeKey, {
          _pendingTasks: pendingTasksWith(nodeData, jobId, null),
        })
      }
    }
    set(s => {
      const t = { ...s.tasks }
      delete t[jobId]
      return { tasks: t }
    })
  },

  cancelTask: (jobId, nodeKey) => {
    if (intervals[jobId]) {
      clearInterval(intervals[jobId])
      delete intervals[jobId]
    }
    const entry = get().tasks[jobId]
    const store = useCanvasStore.getState()
    const targetNodeKeys = new Set<string>()
    if (entry?.nodeKey) targetNodeKeys.add(entry.nodeKey)
    if (nodeKey) targetNodeKeys.add(nodeKey)
    for (const node of store.nodes) {
      if ((node.data as CanvasNodeData).taskInfo?.taskId === jobId) targetNodeKeys.add(node.id)
    }
    for (const targetNodeKey of targetNodeKeys) {
      const node = findNodeByKey(targetNodeKey)
      const nodeData = node?.data as CanvasNodeData | undefined
      if (nodeData?.taskInfo?.taskId === jobId || (entry && isTaskOwnedByNode(entry, nodeData))) {
        store.updateNodeData(targetNodeKey, { taskInfo: undefined })
      }
    }
    void generateApi.cancel(jobId).catch(() => undefined)
    get().removeTask(jobId)
  },
}))

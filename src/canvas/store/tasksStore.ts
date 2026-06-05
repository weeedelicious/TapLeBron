import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import { generateApi } from '@/lib/api'
import { useCanvasStore } from './canvasStore'
import type { VideoParams, VideoHistoryItem, CanvasNodeData } from '@/lib/types'

interface TaskEntry {
  jobId: string
  nodeKey: string
  status: number
  progressPercent: number
  error?: string
}

interface TasksState {
  tasks: Record<string, TaskEntry>
  addTask: (jobId: string, nodeKey: string) => void
  startPolling: (jobId: string, projectUuid: string) => void
  removeTask: (jobId: string) => void
  cancelTask: (jobId: string) => void
}

// Store interval references outside Zustand (they're not serializable)
const intervals: Record<string, ReturnType<typeof setInterval>> = {}

export const useTasksStore = create<TasksState>((set, get) => ({
  tasks: {},

  addTask: (jobId, nodeKey) => {
    set(s => ({
      tasks: { ...s.tasks, [jobId]: { jobId, nodeKey, status: 1, progressPercent: 0 } }
    }))
    useCanvasStore.getState().updateNodeData(nodeKey, {
      taskInfo: { taskId: jobId, loading: true, status: 1, progressPercent: 0 }
    })
  },

  startPolling: (jobId: string, _projectUuid: string) => {
    // Clear any existing interval for this job
    if (intervals[jobId]) {
      clearInterval(intervals[jobId])
      delete intervals[jobId]
    }

    const { tasks } = get()
    const entry = tasks[jobId]
    if (!entry) return

    let errorCount = 0
    const MAX_ERRORS = 5
    const MAX_ATTEMPTS = 200

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
        errorCount = 0  // reset on success
        if (!get().tasks[jobId]) { clearInterval(interval); delete intervals[jobId]; return }
        set(s => ({
          tasks: { ...s.tasks, [jobId]: { ...s.tasks[jobId], status: res.status, progressPercent: res.progressPercent } }
        }))
        useCanvasStore.getState().updateNodeData(current.nodeKey, {
          taskInfo: { taskId: jobId, loading: res.status < 2, status: res.status as 0|1|2|3, progressPercent: res.progressPercent, error: res.error }
        })
        if (res.status === 2 && res.urls?.length) {
          // Save to history before updating the node URL
          const store = useCanvasStore.getState()
          const node = store.nodes.find(n => n.id === current.nodeKey || n.data.nodeKey === current.nodeKey)
          if (node && (node.data as CanvasNodeData).type === 'video') {
            const p = ((node.data as CanvasNodeData).params ?? {}) as unknown as VideoParams
            const historyItem: VideoHistoryItem = {
              id: uuidv4(),
              timestamp: Date.now(),
              url: res.urls[0],
              prompt: p.prompt ?? '',
              promptHtml: p.promptHtml,
              promptChips: p.promptChips,
              model: p.model ?? 'Seedance_2_0',
              modeType: (p.modeType as string) ?? 't2v',
              settings: { ...p.settings },
              imageList: [...(p.imageList ?? [])],
            }
            const prevHistory: VideoHistoryItem[] = p.history ?? []
            store.updateNodeData(current.nodeKey, {
              url: res.urls,
              taskInfo: { taskId: jobId, loading: false, status: 2, progressPercent: 100 },
              params: { ...p, history: [historyItem, ...prevHistory].slice(0, 20) } as unknown as Record<string, unknown>,
            })
          } else {
            store.updateNodeData(current.nodeKey, {
              url: res.urls,
              taskInfo: { taskId: jobId, loading: false, status: 2, progressPercent: 100 },
            })
          }
          clearInterval(interval)
          delete intervals[jobId]
          get().removeTask(jobId)
        } else if (res.status === 3) {
          useCanvasStore.getState().updateNodeData(current.nodeKey, {
            taskInfo: { taskId: jobId, loading: false, status: 3, progressPercent: 0, error: res.error ?? '生成失败' }
          })
          clearInterval(interval)
          delete intervals[jobId]
          get().removeTask(jobId)
        }
      } catch (e) {
        errorCount++
        console.error('poll error', e)
        // Stop polling after too many consecutive errors (server down / task expired)
        if (errorCount >= MAX_ERRORS) {
          useCanvasStore.getState().updateNodeData(current.nodeKey, {
            taskInfo: { taskId: jobId, loading: false, status: 3, progressPercent: 0, error: '轮询超时，请重试' }
          })
          clearInterval(interval)
          delete intervals[jobId]
          get().removeTask(jobId)
        }
      }
    }, 3000)

    intervals[jobId] = interval
  },

  removeTask: (jobId) => {
    set(s => {
      const t = { ...s.tasks }
      delete t[jobId]
      return { tasks: t }
    })
  },

  // Cancel a running task: stop interval + clear node state
  cancelTask: (jobId) => {
    if (intervals[jobId]) {
      clearInterval(intervals[jobId])
      delete intervals[jobId]
    }
    const entry = get().tasks[jobId]
    if (entry) {
      useCanvasStore.getState().updateNodeData(entry.nodeKey, { taskInfo: undefined })
    }
    get().removeTask(jobId)
  },
}))

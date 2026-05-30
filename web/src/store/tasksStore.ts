import { create } from 'zustand'
import { generateApi } from '@/lib/api'
import { useCanvasStore } from './canvasStore'

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

    const interval = setInterval(async () => {
      const current = get().tasks[jobId]
      if (!current) {
        // Task was cancelled, stop polling
        clearInterval(interval)
        delete intervals[jobId]
        return
      }
      try {
        const res = await generateApi.poll(jobId)
        // Re-check after await — task may have been cancelled while request was in flight
        if (!get().tasks[jobId]) {
          clearInterval(interval)
          delete intervals[jobId]
          return
        }
        set(s => ({
          tasks: { ...s.tasks, [jobId]: { ...s.tasks[jobId], status: res.status, progressPercent: res.progressPercent } }
        }))
        useCanvasStore.getState().updateNodeData(current.nodeKey, {
          taskInfo: { taskId: jobId, loading: res.status < 2, status: res.status as 0|1|2|3, progressPercent: res.progressPercent, error: res.error }
        })
        if (res.status === 2 && res.urls?.length) {
          useCanvasStore.getState().updateNodeData(current.nodeKey, {
            url: res.urls,
            taskInfo: { taskId: jobId, loading: false, status: 2, progressPercent: 100 }
          })
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
        console.error('poll error', e)
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

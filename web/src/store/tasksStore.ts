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
}

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
    const { tasks } = get()
    const entry = tasks[jobId]
    if (!entry) return

    const interval = setInterval(async () => {
      try {
        const res = await generateApi.poll(jobId)
        set(s => ({
          tasks: { ...s.tasks, [jobId]: { ...s.tasks[jobId], status: res.status, progressPercent: res.progressPercent } }
        }))
        useCanvasStore.getState().updateNodeData(entry.nodeKey, {
          taskInfo: { taskId: jobId, loading: res.status < 2, status: res.status as 0|1|2|3, progressPercent: res.progressPercent, error: res.error }
        })
        if (res.status === 2 && res.urls?.length) {
          useCanvasStore.getState().updateNodeData(entry.nodeKey, {
            url: res.urls,
            taskInfo: { taskId: jobId, loading: false, status: 2, progressPercent: 100 }
          })
          clearInterval(interval)
          get().removeTask(jobId)
        } else if (res.status === 3) {
          useCanvasStore.getState().updateNodeData(entry.nodeKey, {
            taskInfo: { taskId: jobId, loading: false, status: 3, progressPercent: 0, error: res.error ?? '生成失败' }
          })
          clearInterval(interval)
          get().removeTask(jobId)
        }
      } catch (e) {
        console.error('poll error', e)
      }
    }, 3000)
  },

  removeTask: (jobId) => {
    set(s => {
      const t = { ...s.tasks }
      delete t[jobId]
      return { tasks: t }
    })
  }
}))

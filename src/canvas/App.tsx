import { useState } from 'react'
import { Canvas } from './components/Canvas'
import { TopNav } from './components/TopNav'
import { LeftSidebar } from './components/LeftSidebar'
import { ProjectList } from './components/ProjectList'
import { projectsApi } from './lib/api'
import { useCanvasStore } from './store/canvasStore'
import './styles.css'

export interface CanvasUser {
  id: number
  username: string
  role: 'user' | 'admin'
}

interface Props {
  user: CanvasUser
  onLogout: () => void
}

export default function App({ user, onLogout }: Props) {
  const [view, setView] = useState<'home' | 'canvas'>('home')
  const { loadProject } = useCanvasStore()

  const openProject = async (uuid: string) => {
    const project = await projectsApi.get(uuid)
    loadProject(project)
    setView('canvas')
  }

  const goHome = () => setView('home')

  if (view === 'home') {
    return <ProjectList onOpen={openProject} user={user} onLogout={onLogout} />
  }

  return (
    <div className="flex flex-col" style={{ height: '100vh', background: '#0d0d0d' }}>
      <TopNav onHome={goHome} user={user} onLogout={onLogout} />
      <div className="flex-1 relative overflow-hidden">
        <LeftSidebar />
        <Canvas />
      </div>
    </div>
  )
}

import { useCanvasStore } from '@/store/canvasStore'

interface Props {
  onClose: () => void
}

const NODE_ITEMS = [
  { type: 'text', label: '文本', desc: '剧本、广告词、品牌文案', icon: '📝' },
  { type: 'image', label: '图片', desc: '海报、分镜、角色设计', icon: '🖼' },
  { type: 'video', label: '视频', desc: '创意广告、动画、电影', icon: '🎬' },
  { type: 'video_merge', label: '视频合成 Beta', desc: '多个视频片段合为一个', icon: '🎞' },
  { type: 'director_stage', label: '导演台 Beta', desc: '搭建 3D 场景，截图作为构图参考', icon: '🎭' },
  { type: 'audio', label: '音频', desc: '音效、配音、音乐', icon: '🎵' },
  { type: 'script', label: '脚本 Beta', desc: '创意脚本、生成故事板', icon: '📋' },
]

const RESOURCE_ITEMS = [
  { type: 'upload', label: '上传', desc: '可上传图片、视频、音频文件', icon: '⬆' },
]

export function AddNodeMenu({ onClose }: Props) {
  const { addNode } = useCanvasStore()

  const handleAdd = (type: string) => {
    addNode(type)
    onClose()
  }

  return (
    <div className="p-3">
      <div className="text-xs font-medium text-fg mb-3">添加节点</div>
      <div className="flex flex-col gap-1">
        {NODE_ITEMS.map(item => (
          <button
            key={item.type}
            className="text-left rounded p-2 transition-colors"
            style={{ border: 'none', background: 'transparent', cursor: 'pointer' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#2a2a2a')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            onClick={() => handleAdd(item.type)}
          >
            <div className="flex items-center gap-2">
              <span style={{ fontSize: 16 }}>{item.icon}</span>
              <div>
                <div className="text-xs text-fg">{item.label}</div>
                <div className="text-xs" style={{ color: '#8a8a8a' }}>{item.desc}</div>
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="text-xs font-medium text-fg my-3">添加资源</div>
      <div className="flex flex-col gap-1">
        {RESOURCE_ITEMS.map(item => (
          <button
            key={item.type}
            className="text-left rounded p-2 transition-colors"
            style={{ border: 'none', background: 'transparent', cursor: 'pointer' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#2a2a2a')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            onClick={() => handleAdd(item.type)}
          >
            <div className="flex items-center gap-2">
              <span style={{ fontSize: 16 }}>{item.icon}</span>
              <div>
                <div className="text-xs text-fg">{item.label}</div>
                <div className="text-xs" style={{ color: '#8a8a8a' }}>{item.desc}</div>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

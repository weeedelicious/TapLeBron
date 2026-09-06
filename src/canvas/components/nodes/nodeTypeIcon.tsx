import {
  AudioLines,
  Clapperboard,
  FileText,
  Columns2,
  GitMerge,
  Image as ImageIcon,
  MonitorPlay,
  ScrollText,
  SquareStack,
  Upload,
} from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import type { NodeType } from '@/lib/types'

interface NodeTypeIconProps extends Omit<LucideProps, 'ref'> {
  type: NodeType | 'upload'
}

export function NodeTypeIcon({ type, ...props }: NodeTypeIconProps) {
  switch (type) {
    case 'image':
      return <ImageIcon {...props} />
    case 'video':
      return <Clapperboard {...props} />
    case 'text':
      return <FileText {...props} />
    case 'audio':
      return <AudioLines {...props} />
    case 'script':
      return <ScrollText {...props} />
    case 'upload':
      return <Upload {...props} />
    case 'video_merge':
      return <GitMerge {...props} />
    case 'video_compare':
      return <Columns2 {...props} />
    case 'director_stage':
      return <MonitorPlay {...props} />
    case 'group':
      return <SquareStack {...props} />
    default:
      return <FileText {...props} />
  }
}

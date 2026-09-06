import { ImageNode } from './nodes/ImageNode'
import { VideoNode } from './nodes/VideoNode'
import { TextNode } from './nodes/TextNode'
import { AudioNode } from './nodes/AudioNode'
import { ScriptNode } from './nodes/ScriptNode'
import { VideoMergeNode } from './nodes/VideoMergeNode'
import { UploadNode } from './nodes/UploadNode'
import { DirectorStageNode } from './nodes/DirectorStageNode'
import { GroupNode } from './nodes/GroupNode'
import { AtmosphereTransferNode } from '../features/atmosphere-transfer/AtmosphereTransferNode'
import { PanoramaViewerNode } from '../features/panorama/PanoramaViewerNode'
import { ImageCompareNode } from '../features/image-compare/ImageCompareNode'
import { VideoCompareNode } from '../features/video-compare/VideoCompareNode'

export const nodeTypes = {
  image: ImageNode,
  video: VideoNode,
  text: TextNode,
  audio: AudioNode,
  script: ScriptNode,
  video_merge: VideoMergeNode,
  upload: UploadNode,
  director_stage: DirectorStageNode,
  group: GroupNode,
  atmosphere_transfer: AtmosphereTransferNode,
  panorama_viewer: PanoramaViewerNode,
  image_compare: ImageCompareNode,
  video_compare: VideoCompareNode,
}

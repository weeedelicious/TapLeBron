import ffmpeg from 'fluent-ffmpeg'
import path from 'path'

export async function concatVideos(inputPaths: string[], outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = ffmpeg()
    inputPaths.forEach(p => proc.input(p))
    proc
      .on('error', reject)
      .on('end', resolve)
      .mergeToFile(outputPath, path.dirname(outputPath))
  })
}

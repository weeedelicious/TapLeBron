import { describe, expect, it } from 'vitest'

import { prepareAssetForUpload } from '@/lib/uploadPrep'

function videoFileWithSize(size: number, name = 'clip.mp4') {
  return {
    name,
    type: 'video/mp4',
    size,
  } as File
}

describe('prepareAssetForUpload video size limit', () => {
  it('accepts a video exactly 150MB', async () => {
    const file = videoFileWithSize(150 * 1024 * 1024)

    await expect(prepareAssetForUpload(file)).resolves.toBe(file)
  })

  it('rejects a video larger than 150MB', async () => {
    const file = videoFileWithSize(150 * 1024 * 1024 + 1)

    await expect(prepareAssetForUpload(file)).rejects.toThrow('视频文件不能超过 150MB')
  })
})

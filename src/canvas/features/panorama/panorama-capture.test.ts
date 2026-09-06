import test from 'node:test'
import assert from 'node:assert/strict'
import {
  panoramaCaptureAspectRatio,
  panoramaCaptureDimensions,
  panoramaCaptureFileName,
} from './panorama-capture.ts'

test('uses 16:9 and 2K defaults as a 2048x1152 output', () => {
  assert.deepEqual(
    panoramaCaptureDimensions('16:9', '2K'),
    { width: 2048, height: 1152, aspectRatio: 16 / 9, ratio: '16:9', resolution: '2K' },
  )
})

test('uses the preset edge as height for portrait captures', () => {
  assert.deepEqual(
    panoramaCaptureDimensions('9:16', '1K'),
    { width: 576, height: 1024, aspectRatio: 9 / 16, ratio: '9:16', resolution: '1K' },
  )
})

test('uses 3840 pixels as the 4K long edge', () => {
  const dimensions = panoramaCaptureDimensions('21:9', '4K')
  assert.equal(dimensions.width, 3840)
  assert.equal(dimensions.height, 1646)
})

test('uses source aspect ratio and falls back to 16:9', () => {
  assert.equal(panoramaCaptureAspectRatio('source', 4000, 2000), 2)
  assert.equal(panoramaCaptureAspectRatio('source'), 16 / 9)
  assert.deepEqual(
    panoramaCaptureDimensions('source', '1K', 4000, 2000),
    { width: 1024, height: 512, aspectRatio: 2, ratio: 'source', resolution: '1K' },
  )
})

test('builds a filesystem-safe traceable capture name', () => {
  assert.equal(
    panoramaCaptureFileName('室内/全景.jpg', 44.6, -12.2, '16:9', '2K'),
    '室内_全景_机位_Y45_P-12_16x9_2K.png',
  )
})

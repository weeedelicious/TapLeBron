import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fitDistanceForBoundingSphere } from '../src/canvas/features/director-stage/DirectorStageThree'
import { repairImportedModelName } from '../src/canvas/features/director-stage/types'

describe('3ds Max import file validation', () => {
  it('repairs legacy UTF-8 filenames that multipart decoded as Latin-1', () => {
    const mojibake = Buffer.from('SSR_点晴女爵_粗模.fbx', 'utf8').toString('latin1')
    expect(repairImportedModelName(mojibake)).toBe('SSR_点晴女爵_粗模.fbx')
  })

  it('accepts a normal .max filename instead of requiring a backslash before the extension', () => {
    const source = readFileSync(
      join(__dirname, '..', 'src/canvas/features/director-stage/DirectorStageModal.tsx'),
      'utf8',
    )
    expect(source).toContain("if (!/\\.max$/i.test(file.name))")
    expect(source).not.toContain("if (!/\\\\.max$/i.test(file.name))")
  })

  it('separates upload progress from the long-running 3ds Max conversion phase', () => {
    const source = readFileSync(
      join(__dirname, '..', 'src/canvas/features/director-stage/DirectorStageModal.tsx'),
      'utf8',
    )
    expect(source).toContain("setModelImportPhase('converting')")
    expect(source).toContain('上传中 {modelProgress}%')
    expect(source).toContain('已上传，3ds Max 转换中…')
    expect(source).toContain('通常需要 30–90 秒')
    expect(source).not.toContain('转换中 {modelProgress}%')
  })

  it('hides the posing mannequin and frames only the imported model', () => {
    const source = readFileSync(
      join(__dirname, '..', 'src/canvas/features/director-stage/DirectorStageThree.tsx'),
      'utf8',
    )
    expect(source).toContain('runtime.figure.visible = false')
    expect(source).toContain('runtime.figure.visible = !hasImportedModel')
    expect(source).toContain('new THREE.Box3().setFromObject(runtime.modelGroup)')
    expect(source).not.toContain('bounds.expandByObject(runtime.figure)')
  })

  it('places the first imported model at the stage origin', () => {
    const source = readFileSync(
      join(__dirname, '..', 'src/canvas/features/director-stage/DirectorStageModal.tsx'),
      'utf8',
    )
    expect(source).toContain('position: [current.models.length * 0.35, 0, 0]')
    expect(source).not.toContain('position: [1.35 + current.models.length * 0.35, 0, 0]')
  })

  it('fits the complete 3D bounds and leaves safety padding in narrow panels', () => {
    const verticalFov = 30 * Math.PI / 180
    const wideDistance = fitDistanceForBoundingSphere(1, verticalFov, 16 / 9)
    const narrowDistance = fitDistanceForBoundingSphere(1, verticalFov, 9 / 16)
    expect(wideDistance).toBeGreaterThan(1 / Math.sin(verticalFov / 2))
    expect(narrowDistance).toBeGreaterThan(wideDistance)

    const source = readFileSync(
      join(__dirname, '..', 'src/canvas/features/director-stage/DirectorStageThree.tsx'),
      'utf8',
    )
    expect(source).toContain('bounds.getBoundingSphere(new THREE.Sphere())')
    expect(source).toContain('fitDistanceForBoundingSphere(sphere.radius, fov, aspect)')
    expect(source).not.toContain('const verticalDistance =')
  })
})

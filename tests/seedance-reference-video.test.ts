/**
 * 参考视频「没超上限就一点不压」（2026-08-24 用户反馈「感觉都压缩过了」）。
 *
 * 这条规则错一次的代价很隐蔽：用户所有参考视频都会被白压一遍，
 * **而且不会有任何报错**——只是生成出来的东西比该有的糊，谁也不知道为什么。
 *
 * 查出来的两个真问题，下面各有对应用例：
 *   ① 原来判定条件是 `!spec.validPixels`，而那个标志**同时管上下限** ——
 *      于是低于下限（<854×480）的小视频也会被重编码。ffmpeg 只能把它放大，
 *      放大加不回细节，纯粹多叠一层压缩伤害。
 *   ② `fps=24` 原来是无条件加的 —— 一个只是像素略微超限的 60fps 素材，
 *      会连帧率一起被削掉。
 *
 * 顺带记一笔背景：2.0 系列的 maxPixels 是 927,408（≈1280×720），
 * 所以 1080p 素材**确实**超限、确实要压。这个阈值没有出处注释，也没能从火山官方文档
 * 查到依据（文档页是 JS 渲染的抓不到正文），所以这次**没动它** —— 只修上面两条。
 */
import { describe, expect, it } from 'vitest'

for (const [key, value] of Object.entries({
  DB_USER: 'test',
  DB_PASSWORD: 'test',
  DB_NAME: 'test',
  SESSION_SECRET: 'test-secret',
  INITIAL_ADMIN_PASSWORD: 'test-only',
})) {
  if (!process.env[key]) process.env[key] = value
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const routes = require('../server/canvasRoutes.js')

/** 2.0 系列的真实规则：上限 ≈720p，下限 ≈480p，50MB */
const RULE_20 = {
  minPixels: 409600, maxPixels: 927408, maxBytes: 52428800,
  minAspectRatio: 0.4, maxAspectRatio: 2.5, targetBytesRatio: 0.9,
}
/** 2.5 的上限是 4K */
const RULE_25 = { ...RULE_20, maxPixels: 8295044, maxBytes: 209715200 }

const meta = (over: Record<string, unknown> = {}) => ({
  extension: 'mp4', width: 1280, height: 720, byteSize: 10 * 1024 * 1024, durationSec: 6, fps: 24,
  ...over,
})

const shouldPrepare = (m: Record<string, unknown>, rule = RULE_20) =>
  routes.shouldPrepareSeedanceReference(m, rule)

describe('没超上限 → 一点不压', () => {
  it('正好 720p、体积和容器都合规 → 不动', () => {
    expect(shouldPrepare(meta())).toBe(false)
  })

  it('刚好卡在像素上限上 → 不动（边界不能算超）', () => {
    // 1284×722 = 927,048，略低于 927,408
    expect(shouldPrepare(meta({ width: 1284, height: 722 }))).toBe(false)
  })

  it('mov 也是合规容器 → 不动', () => {
    expect(shouldPrepare(meta({ extension: 'mov' }))).toBe(false)
  })

describe('参考视频 URL 按画布 id 解析', () => {
  it('能从 /assets/{画布}/{文件} 读出源画布', () => {
    expect(routes.parseLocalAssetUrl('/assets/272/dd9680558583e8456173d3a55c7a3996b23ffa29.mp4')).toEqual({
      projectUuid: '272',
      storedName: 'dd9680558583e8456173d3a55c7a3996b23ffa29.mp4',
    })
  })

  it('当前画布自己的文件也认', () => {
    expect(routes.parseLocalAssetUrl('/assets/264/clip.mp4')).toEqual({
      projectUuid: '264',
      storedName: 'clip.mp4',
    })
  })

  it('不是标准资产路径就返回空', () => {
    expect(routes.parseLocalAssetUrl('https://cdn.example/a.mp4')).toBeNull()
    expect(routes.parseLocalAssetUrl('/assets/only-name.mp4')).toBeNull()
  })
})

  it('1080p 在 2.5 上不超限 → 不动（这就是 2.5 不糊的原因）', () => {
    expect(shouldPrepare(meta({ width: 1920, height: 1080 }), RULE_25)).toBe(false)
  })
})

describe('超了上限 → 才压', () => {
  it('1080p 在 2.0 上超限 → 压（这就是用户看到"都被压过"的原因）', () => {
    expect(shouldPrepare(meta({ width: 1920, height: 1080 }))).toBe(true)
  })

  it('体积超 50MB → 压', () => {
    expect(shouldPrepare(meta({ byteSize: 60 * 1024 * 1024 }))).toBe(true)
  })

  it('容器不是 mp4/mov → 压（provider 只认这两种）', () => {
    expect(shouldPrepare(meta({ extension: 'webm' }))).toBe(true)
    expect(shouldPrepare(meta({ extension: 'avi' }))).toBe(true)
  })
})

describe('① 低于下限的小视频不许重编码', () => {
  it('640×360（低于 480p 下限）→ 不动，放大加不回细节', () => {
    expect(shouldPrepare(meta({ width: 640, height: 360 }))).toBe(false)
  })

  it('极小的 320×240 也不动', () => {
    expect(shouldPrepare(meta({ width: 320, height: 240 }))).toBe(false)
  })

  it('但小视频要是体积或容器也不合规，该压还得压', () => {
    expect(shouldPrepare(meta({ width: 640, height: 360, extension: 'webm' }))).toBe(true)
    expect(shouldPrepare(meta({ width: 640, height: 360, byteSize: 99 * 1024 * 1024 }))).toBe(true)
  })

  it('读不出宽高时不因为像素而压（别拿 0 当"低于下限"）', () => {
    expect(shouldPrepare(meta({ width: 0, height: 0 }))).toBe(false)
    expect(shouldPrepare(meta({ width: undefined, height: undefined }))).toBe(false)
  })
})

describe('② fps=24 只在源帧率高于 24 时才加', () => {
  const filter = (m: Record<string, unknown>) => routes.ffmpegReferenceVideoFilter(RULE_20, m)

  it('源 60fps → 降到 24（降帧确实能帮着压体积）', () => {
    expect(filter({ fps: 60 })).toContain('fps=24')
  })

  it('源 30fps → 降到 24', () => {
    expect(filter({ fps: 30 })).toContain('fps=24')
  })

  it('源 24fps → **不加** fps 滤镜，不做多余的重采样', () => {
    expect(filter({ fps: 24 })).not.toContain('fps=')
  })

  it('源 12fps → 不加（绝不把帧率往上抬）', () => {
    expect(filter({ fps: 12 })).not.toContain('fps=')
  })

  it('读不出帧率 → 保守按老行为降到 24', () => {
    expect(filter({})).toContain('fps=24')
    expect(filter({ fps: 0 })).toContain('fps=24')
  })

  it('不管加不加 fps，缩放部分都在（而且是缩到刚好卡进上限，不一刀切）', () => {
    for (const m of [{ fps: 60 }, { fps: 24 }]) {
      const f = filter(m)
      expect(f).toContain('scale=')
      expect(f).toContain(String(RULE_20.maxPixels))
    }
  })
})

describe('spec 的边界判定', () => {
  it('宽高比超出 0.4–2.5 会被标为不合规（那是拒绝，不是压缩）', () => {
    const spec = routes.seedanceReferenceSpec(meta({ width: 2000, height: 400 }), RULE_20)
    expect(spec.validRatio).toBe(false)
  })

  it('正常宽高比合规', () => {
    expect(routes.seedanceReferenceSpec(meta(), RULE_20).validRatio).toBe(true)
  })
})

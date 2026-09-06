/**
 * 参考素材和模式不匹配时的说法（2026-08-26 用户反馈）。
 *
 * 起因：Seedance 2.5 的「视频编辑」模式里连了一张参考图 + 一条参考视频，
 * 提示词写着「1秒参考 @图片1」，点生成弹出
 *   「视频编辑最多支持 0 个图片参考」
 * 这句话有两个问题：读起来像 bug（"最多 0 个"），而且没说接下来该怎么办。
 *
 * 顺带发现参考视频那行说明是**写死**的「单个 2-15s，最多 3 个，总时长 ≤ 15s」——
 * 那是 Seedance 2.0 的数字。2.5 上是 2-30s / 10 条 / ≤30s，说明和实际校验对不上，
 * 按说明摆素材反而会被拦。
 *
 * 前后端各有一份实现（TS 给界面、JS 给服务端，读同一份 JSON），两边措辞必须一致 ——
 * 界面说一套、提交回来又是另一套，比不报错更让人困惑。
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const {
  getVideoRefRule,
  modesAcceptingRef,
  videoRefCountError,
  videoReferenceNote,
  validateVideoCapability,
  getVideoModelRule,
  getVideoModeOptions,
} = await import('@/lib/videoRules')

const require = createRequire(import.meta.url)
const serverRules = require('../server/videoRules.js')

const MODEL = 'Seedance_2_5'

describe('「不支持」不能写成「最多支持 0 个」', () => {
  it('文生视频连了参考图 → 说不支持，并指出该用哪个模式', () => {
    const message = videoRefCountError(MODEL, 't2v', 'images', 1)
    expect(message).toContain('不支持')
    expect(message).toContain('图片参考')
    expect(message).not.toContain('0 个')
    // 2.5 的多模态模式收图片，所以要被推荐出来
    expect(message).toContain('多模态')
  })

  it('延长视频连了参考图也是同一套说法（不是只修了一个模式）', () => {
    const message = videoRefCountError(MODEL, 'extend', 'images', 2)
    expect(message).toContain('不支持')
    expect(message).not.toMatch(/最多支持\s*0/)
  })

  it('Seedance 2.0 的文生视频仍然不收参考图 → 还是那句「不支持」', () => {
    const message = videoRefCountError('Seedance_2_0', 't2v', 'images', 1)
    expect(message).toContain('不支持')
    expect(message).not.toMatch(/最多支持\s*0/)
  })

  it('推荐的模式是从配置算出来的：收就列、不收就不列', () => {
    const listed = new Set(modesAcceptingRef(MODEL, 'images'))
    expect(listed.size).toBeGreaterThan(0)
    const labelOf = new Map(getVideoModeOptions(MODEL).map((option) => [option.key, option.label]))
    for (const mode of getVideoModelRule(MODEL).modes ?? []) {
      const accepts = getVideoRefRule(MODEL, mode, 'images').max > 0
      expect(listed.has(labelOf.get(mode) ?? mode), `${mode} accepts=${accepts}`).toBe(accepts)
    }
  })

  it('上限大于 0 只是超了 → 报上限，并带上当前有几个', () => {
    const message = videoRefCountError(MODEL, 'omni', 'images', 99)
    expect(message).toContain('最多支持 30 个图片参考')
    expect(message).toContain('当前有 99 个')
  })

  it('少于下限 → 报下限（图生视频至少要 1 张）', () => {
    expect(videoRefCountError(MODEL, 'i2v', 'images', 0)).toContain('至少需要 1 个图片参考')
  })

  it('数量合规 → 空串', () => {
    expect(videoRefCountError(MODEL, 'omni', 'images', 3)).toBe('')
    expect(videoRefCountError(MODEL, 'video_edit', 'images', 0)).toBe('')
  })

  it('整条校验链路用的是同一套措辞（不是只有那个小函数改了）', () => {
    const error = validateVideoCapability({
      model: MODEL, mode: 't2v', prompt: '改变视频的氛围和风格',
      imageCount: 1, videoCount: 0, audioCount: 0,
      ratio: 'adaptive', resolution: '480P', duration: 5, count: 1,
    })
    expect(error).toContain('不支持')
    expect(error).not.toMatch(/最多支持\s*0/)
  })
})

/*
 * 2026-08-26 用户反馈「Seedance 2.5 的视频编辑可以附加参考图」，当天在生产上对网关实测过：
 *
 *   1 视频 + 1 张 404 图 → 400 `content[1].image_url ... resource not found`
 *       （上游去下载那张图了，不是「这个模式不收图片」→ 图片槽位是认的）
 *   1 视频 + 11 张有效图 → 200 接受，任务 cgt-20260826153619-8kt5b 跑完出片
 *       （480p / 4s / seed 20934 / doubao-seedance-2-5-260628）
 *   1 视频 + 31 张图  → 400 `content ... must be less than or equal to 30 for
 *       model doubao-seedance-2-5 in r2v`；30 张则过 → 上限就是 30 张，
 *       且提示词与参考视频不占这个额度（text+30图+video 共 32 条 content 照样过张数校验）
 *
 * 所以这不是我们这边猜的数字，是上游自己报出来的。
 */
describe('Seedance 2.5 的视频编辑收参考图（2026-08-26 实测上游）', () => {
  it('1 张参考图不再被拦', () => {
    expect(videoRefCountError(MODEL, 'video_edit', 'images', 1)).toBe('')
  })

  it('上限是上游报的 30 张：30 过、31 报上限', () => {
    expect(getVideoRefRule(MODEL, 'video_edit', 'images').max).toBe(30)
    expect(videoRefCountError(MODEL, 'video_edit', 'images', 30)).toBe('')
    expect(videoRefCountError(MODEL, 'video_edit', 'images', 31)).toContain('最多支持 30 个图片参考')
  })

  it('参考视频还是只收 1 条（视频编辑改的就是这一条，不能顺手放开）', () => {
    expect(getVideoRefRule(MODEL, 'video_edit', 'videos')).toEqual({ min: 1, max: 1 })
    expect(videoRefCountError(MODEL, 'video_edit', 'videos', 2)).toContain('最多支持 1 个视频参考')
    expect(videoRefCountError(MODEL, 'video_edit', 'videos', 0)).toContain('至少需要 1 个视频参考')
  })

  it('整条校验链路放行「1 条视频 + 1 张图」', () => {
    expect(validateVideoCapability({
      model: MODEL, mode: 'video_edit', prompt: '改变视频的氛围和风格',
      imageCount: 1, videoCount: 1, audioCount: 0,
      ratio: 'adaptive', resolution: '480P', duration: -1, count: 1,
    })).toBe('')
  })

  it('服务端同样放行 —— 前端放开而服务端还拦，就变成点了生成才报错', () => {
    expect(() => serverRules.validateVideoCapabilities({
      model: MODEL, mode: 'video_edit', prompt: '改变视频的氛围和风格',
      imageCount: 1, videoCount: 1, audioCount: 0,
      ratio: 'adaptive', resolution: '480P', duration: -1, count: 1,
    })).not.toThrow()
  })

  it('走目录 id 的那几个别名继承同一套上限（提交时用的就是这些 id）', () => {
    for (const alias of ['bytedance/seedance-2.5', 'dreamina-seedance-2-5-260628']) {
      expect(getVideoRefRule(alias, 'video_edit', 'images').max, alias).toBe(30)
    }
  })

  it('视频编辑现在也会出现在「该去哪个模式」的推荐里', () => {
    expect(modesAcceptingRef(MODEL, 'images')).toContain('视频编辑')
  })
})

/*
 * 火山方舟《创建视频生成任务》在 2026-09-03 更新后明确写明：
 * Seedance 2.0 系列的全模态参考生视频可输入 0-9 张参考图，并支持编辑视频。
 * https://docs.volcengine.com/docs/82379/1520757
 *
 * 提交链的 video-edit 通用分支已经会把这些图片标成 reference_image；之前失败只是
 * 共享能力表仍把图片上限写成了 0，前后端在真正发请求之前就一起拦掉了。
 */
describe('Seedance 2.0 系列的视频编辑收参考图（官方能力表 2026-09-03）', () => {
  const MODELS = [
    'Seedance_2_0',
    'Seedance_2_0_Fast',
    'doubao-seedance-2-0-260128',
    'doubao-seedance-2-0-fast-260128',
  ]

  it.each(MODELS)('%s：1 张参考图不再被拦', (model) => {
    expect(videoRefCountError(model, 'video_edit', 'images', 1)).toBe('')
  })

  it.each(MODELS)('%s：上限 9 张，10 张会报清楚', (model) => {
    expect(getVideoRefRule(model, 'video_edit', 'images')).toEqual({ min: 0, max: 9 })
    expect(videoRefCountError(model, 'video_edit', 'images', 9)).toBe('')
    expect(videoRefCountError(model, 'video_edit', 'images', 10)).toContain('最多支持 9 个图片参考')
  })

  it.each(['Seedance_2_0', 'Seedance_2_0_Fast'])('%s：前端整条校验放行 1 视频 + 1 图', (model) => {
    expect(validateVideoCapability({
      model, mode: 'video_edit', prompt: '只替换人物外观，保持原视频动作和镜头',
      imageCount: 1, videoCount: 1, audioCount: 0,
      ratio: '16:9', resolution: '480P', duration: 4, count: 1,
    })).toBe('')
  })

  it.each(['Seedance_2_0', 'Seedance_2_0_Fast'])('%s：服务端整条校验也放行', (model) => {
    expect(() => serverRules.validateVideoCapabilities({
      model, mode: 'video_edit', prompt: '只替换人物外观，保持原视频动作和镜头',
      imageCount: 1, videoCount: 1, audioCount: 0,
      ratio: '16:9', resolution: '480P', duration: 4, count: 1,
    })).not.toThrow()
  })

  it('仍然只允许 1 条待编辑视频，不能把全模态的 3 条上限误套进来', () => {
    expect(getVideoRefRule('Seedance_2_0', 'video_edit', 'videos')).toEqual({ min: 1, max: 1 })
    expect(videoRefCountError('Seedance_2_0', 'video_edit', 'videos', 2)).toContain('最多支持 1 个视频参考')
  })
})

describe('服务端和前端说的话一致', () => {
  const CASES: Array<[string, string, 'images' | 'videos' | 'audios', number]> = [
    [MODEL, 'video_edit', 'images', 1],
    [MODEL, 'video_edit', 'images', 31],
    [MODEL, 'video_edit', 'videos', 2],
    [MODEL, 't2v', 'images', 2],
    [MODEL, 'extend', 'images', 1],
    [MODEL, 'omni', 'images', 99],
    [MODEL, 'i2v', 'images', 0],
    [MODEL, 'omni', 'videos', 0],
    ['Seedance_2_0', 'video_edit', 'images', 1],
    ['Seedance_2_0', 'video_edit', 'images', 10],
    ['bytedance/seedance-2.5', 'video_edit', 'images', 31],
  ]

  it.each(CASES)('%s / %s / %s × %i 两边一字不差', (model, mode, kind, count) => {
    expect(serverRules.videoRefCountError(model, mode, kind, count))
      .toBe(videoRefCountError(model, mode, kind, count))
  })

  it('服务端也是抛「不支持」而不是「最多支持 0 个」', () => {
    expect(() => serverRules.validateVideoCapabilities({
      model: MODEL, mode: 't2v', prompt: '改风格',
      imageCount: 1, videoCount: 0, audioCount: 0,
      ratio: 'adaptive', resolution: '480P', duration: 5, count: 1,
    })).toThrow(/不支持/)
  })
})

describe('参考视频那行说明要跟着模型走', () => {
  it('Seedance 2.5 的多模态：2-30s、最多 10 条、总时长 ≤ 30s', () => {
    const note = videoReferenceNote(MODEL, 'omni')
    expect(note).toContain('2-30s')
    expect(note).toContain('最多 10 个')
    expect(note).toContain('总时长 ≤ 30s')
  })

  it('不再出现写死的 2.0 数字', () => {
    const note = videoReferenceNote(MODEL, 'omni')
    expect(note).not.toContain('最多 3 个')
    expect(note).not.toContain('2-15s')
  })

  it('条数按「模型上限 ∩ 模式上限」取小 —— 视频编辑只收 1 条，不能报 10 条', () => {
    expect(getVideoRefRule(MODEL, 'video_edit', 'videos').max).toBe(1)
    expect(videoReferenceNote(MODEL, 'video_edit')).toContain('最多 1 个')
  })

  it('只能放 1 条时不再重复说「总时长」（和单个时长是同一件事）', () => {
    expect(videoReferenceNote(MODEL, 'video_edit')).not.toContain('总时长')
  })

  it('这个模式压根不收视频（文生视频）→ 不出说明', () => {
    expect(videoReferenceNote(MODEL, 't2v')).toBe('')
  })

  it('Seedance 2.0 报的是它自己的数字，不是 2.5 的', () => {
    const rule20 = getVideoModelRule('Seedance_2_0').referenceVideo
    const note = videoReferenceNote('Seedance_2_0', 'omni')
    if (rule20) {
      expect(note).toContain(`单个 ${rule20.minDurationSec}-${rule20.maxDurationSec}s`)
    }
  })

  it('模型没有参考视频规则时不抛、返回空串', () => {
    expect(() => videoReferenceNote('不存在的模型', 'omni')).not.toThrow()
  })
})

describe('节点上点生成之前就看得见', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src/canvas/components/nodes/VideoNode.tsx'),
    'utf8',
  ) as string

  it('说明文字来自 videoReferenceNote，不再写死在组件里', () => {
    expect(source).toContain('videoReferenceNote(model, mode)')
    expect(source, '写死的 2.0 数字还在').not.toContain('单个 2-15s，最多 3 个')
  })

  it('不匹配的提示渲染在参考行下面（refKindWarning）', () => {
    expect(source).toContain('const refKindWarning')
    // 渲染和条件都要断言：只留一个，另一个被改掉照样静默失效
    expect(source).toContain('{refKindWarning}')
    expect(source).toContain('{refKindWarning && (')
  })

  it('图片和视频缩略图各自都会在用不上时置灰（不能只做一边）', () => {
    expect(source).toContain('unusableRefKinds')
    expect(source).toContain("unusableRefKinds.images ? { filter: 'grayscale(1)'")
    expect(source).toContain("unusableRefKinds.videos ? { filter: 'grayscale(1)'")
  })
})

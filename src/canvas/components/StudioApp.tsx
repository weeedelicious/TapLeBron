import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, FolderOpen, ImagePlus, ListChecks, Loader2, Palette, Plus, RefreshCw, Send, Trash2, Users, Wand2 } from 'lucide-react'
import { studioApi, type StudioBrief, type StudioProject } from '@/lib/api'
import { FavoriteLibraryPanel } from './FavoriteLibraryPanel'
import type { FavoriteLibraryItem } from '@/lib/types'
import { prepareAssetForUpload } from '@/lib/uploadPrep'
// 分镜绘制这几个口会带回服务端的具体原因（比如"一次最多画 9 张"），
// 不要像旧代码那样一律吞成固定文案 —— 那样用户不知道该怎么改
import { errorToText } from '@/lib/display'
import {
  renumberShots,
  storyboardDurationDelta,
  storyboardTotalSeconds,
  studioConceptGenerationCost,
  STUDIO_CAMERA_MOVES,
  STUDIO_CONCEPT_BATCH_LIMIT,
  STUDIO_CONCEPT_GROUPS,
  STUDIO_CONCEPT_LIMIT,
  STUDIO_CONCEPT_RATIO_BY_GROUP,
  STUDIO_DURATION_OPTIONS,
  STUDIO_MAX_ROWS,
  STUDIO_PROJECT_OPTIONS,
  STUDIO_RATIO_OPTIONS,
  STUDIO_REFERENCE_GROUPS,
  STUDIO_REFERENCE_LIMIT,
  STUDIO_RESOLUTION_OPTIONS,
  STUDIO_BOARD_METHODS,
  STUDIO_BOARD_REFERENCE_LIMIT,
  STUDIO_BOARD_STYLES,
  STUDIO_BOARD_TWEAKS,
  STUDIO_VIDEO_DURATIONS,
  STUDIO_VIDEO_RESOLUTIONS,
  STUDIO_VIDEO_STAGES,
  STUDIO_VIDEO_TWEAKS,
  emptyVideoStage,
  hasRunningVideos,
  videoGenerationCost,
  videoStatusLabel,
  type StudioVideoItem,
  type StudioVideoStage,
  type StudioVideoStageData,
  STUDIO_SHOT_SIZES,
  STUDIO_STYLE_OPTIONS,
  boardGenerationCost,
  boardKindLabel,
  formatTagList,
  parseTagList,
  type StudioBoardItem,
  type StudioBoardSettings,
  type StudioBoards,
  type StudioConceptItem,
  type StudioStoryboardRow,
} from '@/lib/studio'
import './StudioApp.css'

/**
 * AI 出片 · 第一阶段（到文字分镜表）。
 *
 * 流程：建项目（自动在自己的「测试」分类里建一个 ai_xxxxxx 画布）→ 填项目 / 大纲 /
 * 风格 / 时长 / 比例 / 参考资料 → 生成文字分镜 → 在这张表上改。
 *
 * 分镜表的真源是服务端 studio_projects.storyboard；画布里那份是投影，点「同步到画布」
 * 才写。表格改动走本地状态 + 手动保存，不做每敲一个字就发一次请求。
 */

function newRowId() {
  return `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function emptyRow(): StudioStoryboardRow {
  return {
    id: newRowId(), shot: '1', content: '', shotSize: '中景', movement: '固定', seconds: 3,
    // 一览三项手插的新行给空数组，不是 undefined —— 渲染时要直接 join
    roles: [], scenes: [], props: [],
  }
}

function emptyConcept(): StudioConceptItem {
  return {
    id: newRowId(),
    group: 'scene',
    name: '',
    prompt: '',
    reason: '',
    imageUrl: '',
    nodeKey: '',
    status: 'pending',
    error: '',
  }
}

interface Props {
  onBack: () => void
}

export function StudioApp({ onBack }: Props) {
  const [projects, setProjects] = useState<StudioProject[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // 上传是异步的：中途切了项目就不能再往新项目上追加，所以处理函数读 ref 而不是闭包值。
  const activeIdRef = useRef<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<
    '' | 'create' | 'rename' | 'canvas' | 'save' | 'generate' | 'push' | 'plan' | 'draw' | 'pushConcepts'
    | 'planBoards' | 'drawBoards' | 'pushBoards'
    | 'planVideo' | 'renderVideo' | 'pushVideo'
  >('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [brief, setBrief] = useState<StudioBrief | null>(null)
  const [rows, setRows] = useState<StudioStoryboardRow[]>([])
  const [dirty, setDirty] = useState(false)
  /**
   * 项目名的独立草稿。名字不跟「保存修改」走，只由旁边的「确定」提交 ——
   * 因为提交名字有副作用（连带改画布名），不该被别的保存动作顺手触发。
   */
  const [nameDraft, setNameDraft] = useState('')
  // 概念图。勾选状态只在本地，不入库 —— 它是"这次要画哪几张"的一次性意图，不是项目数据。
  const [concepts, setConcepts] = useState<StudioConceptItem[]>([])
  const [pickedConcepts, setPickedConcepts] = useState<Set<string>>(new Set())
  const [conceptRedraw, setConceptRedraw] = useState(false)
  /**
   * 分镜画（第三阶段）。跟概念图同一套：清单入库，勾选状态只在本地
   * （"这次要画哪几张"是一次性意图，不是项目数据）。
   */
  const [boards, setBoards] = useState<StudioBoards>(() => ({
    settings: { styles: ['描线'], method: 'main', referenceUrls: [] },
    items: [],
  }))
  const [pickedBoards, setPickedBoards] = useState<Set<string>>(new Set())
  const [boardRedraw, setBoardRedraw] = useState(false)
  /**
   * 动态分镜（第四）与成片（第五）。两个阶段并存 —— 用户会想留着草样和成片对比，
   * 所以各存一份，不共用一个 state。
   */
  const [videoStages, setVideoStages] = useState<Record<StudioVideoStage, StudioVideoStageData>>(() => ({
    motion: emptyVideoStage('motion'),
    film: emptyVideoStage('film'),
  }))
  const [pickedVideos, setPickedVideos] = useState<Record<StudioVideoStage, Set<string>>>({
    motion: new Set(), film: new Set(),
  })
  const [videoRedraw, setVideoRedraw] = useState<Record<StudioVideoStage, boolean>>({
    motion: false, film: false,
  })
  const noticeTimer = useRef<number | undefined>(undefined)

  const active = useMemo(
    () => projects.find((item) => item.id === activeId) ?? null,
    [projects, activeId],
  )

  const flash = useCallback((text: string) => {
    setNotice(text)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(''), 3200)
  }, [])

  /**
   * 右侧的资产库 / 共享空间停靠栏。用的就是画布上那份 FavoriteLibraryPanel，
   * 容器样式也复用 .shotflow-asset-dock（只是靠右，所以描边换到左边）。
   *
   * 出片页没有画布，所以"点一个资产"不能像画布那样插入节点 —— 这里做成**复制地址**，
   * 非破坏性，写脚本时想引用某张图直接粘地址。要改成别的行为（比如插进分镜某一行）随时说。
   */
  const [assetDock, setAssetDock] = useState<'assets' | 'shared' | null>(null)
  const toggleAssetDock = useCallback((mode: 'assets' | 'shared') => {
    setAssetDock((current) => (current === mode ? null : mode))
  }, [])
  const handleAssetPick = useCallback((item: FavoriteLibraryItem) => {
    const url = item.previewUrl || ''
    if (!url) {
      flash('这个条目没有可复制的地址')
      return
    }
    void navigator.clipboard?.writeText(url)
      .then(() => flash(`已复制地址：${item.title || url}`))
      .catch(() => flash('复制失败，可右键图片自行复制'))
  }, [flash])

  const adopt = useCallback((project: StudioProject) => {
    setBrief(project.brief)
    setNameDraft(project.name)
    setRows(project.storyboard.rows)
    // 默认勾上还没有图的那些：最常见的动作就是"把缺的补齐"，而且这样默认不会花钱重画已有的
    const items = project.concepts?.items ?? []
    setConcepts(items)
    setPickedConcepts(new Set(items.filter((item) => !item.imageUrl).map((item) => item.id)))
    setConceptRedraw(false)
    // 分镜画同理：默认勾上还没有图的那些，这样默认动作是"把缺的补齐"，不会重复花钱
    const nextBoards = project.boards ?? { settings: { styles: ['描线'], method: 'main', referenceUrls: [] }, items: [] }
    setBoards(nextBoards)
    setPickedBoards(new Set(nextBoards.items.filter((item) => !item.imageUrl).map((item) => item.id)))
    setBoardRedraw(false)
    const nextStages = {
      motion: project.motion ?? emptyVideoStage('motion'),
      film: project.film ?? emptyVideoStage('film'),
    }
    setVideoStages(nextStages)
    // 默认勾上还没有视频的：默认动作是"把缺的补齐"，不会重复花钱
    setPickedVideos({
      motion: new Set(nextStages.motion.items.filter((i) => !i.videoUrl).map((i) => i.id)),
      film: new Set(nextStages.film.items.filter((i) => !i.videoUrl).map((i) => i.id)),
    })
    setVideoRedraw({ motion: false, film: false })
    setDirty(false)
  }, [])

  const load = useCallback(async (preferId?: string) => {
    setLoading(true)
    setError('')
    try {
      const list = await studioApi.list()
      setProjects(list)
      const target = list.find((item) => item.id === preferId) ?? list[0] ?? null
      setActiveId(target?.id ?? null)
      if (target) adopt(target)
      else { setBrief(null); setRows([]) }
    } catch {
      setError('项目列表加载失败')
    } finally {
      setLoading(false)
    }
  }, [adopt])

  useEffect(() => { void load() }, [load])
  useEffect(() => () => window.clearTimeout(noticeTimer.current), [])

  const selectProject = useCallback((project: StudioProject) => {
    // 名字草稿也算未保存改动：输了名字没点「确定」就切走，切换会把它丢掉，得先问一声
    const nameUncommitted = Boolean(active && nameDraft.trim() && nameDraft.trim() !== active.name)
    if ((dirty || nameUncommitted) && !window.confirm('当前项目有未保存的修改，切换会丢掉，确定切换？')) return
    setActiveId(project.id)
    adopt(project)
  }, [active, adopt, dirty, nameDraft])

  const replaceProject = useCallback((project: StudioProject) => {
    setProjects((list) => list.map((item) => (item.id === project.id ? project : item)))
    adopt(project)
  }, [adopt])

  const handleCreate = useCallback(async () => {
    setBusy('create')
    setError('')
    try {
      const created = await studioApi.create({ name: '未命名出片项目' })
      const list = await studioApi.list()
      setProjects(list)
      setActiveId(created.id)
      adopt(list.find((item) => item.id === created.id) ?? created)
      flash(created.canvasTitle ? `已建项目，画布 ${created.canvasTitle}` : '已建项目（画布稍后可补）')
    } catch {
      setError('新建项目失败')
    } finally {
      setBusy('')
    }
  }, [adopt, flash])

  const handleDelete = useCallback(async (project: StudioProject) => {
    if (!window.confirm(`删除出片项目「${project.name}」？\n画布${project.canvasTitle ? ` ${project.canvasTitle} ` : ''}不会被删。`)) return
    try {
      await studioApi.remove(project.id)
      await load()
      flash('项目已删除，画布保留')
    } catch {
      setError('删除失败')
    }
  }, [flash, load])

  /** 草稿跟已存的名字不一样才让「确定」可点；空名字不算改动（服务端会退回原名，点了等于白点）。 */
  const nameChanged = Boolean(active && nameDraft.trim() && nameDraft.trim() !== active.name)

  /**
   * 提交项目名。服务端会在名字**真的变了**时把对应画布的标题也改成同一个，
   * 所以这里成功之后要用返回的 project 覆盖本地（canvasTitle 才会跟着更新）。
   */
  const handleRename = useCallback(async () => {
    if (!active) return
    const next = nameDraft.trim()
    if (!next) { setError('项目名称不能为空'); return }
    if (next === active.name) return
    setBusy('rename')
    setError('')
    try {
      const saved = await studioApi.update(active.id, { name: next })
      replaceProject(saved)
      flash(saved.canvasTitle ? `已改名，画布也改成了「${saved.canvasTitle}」` : '已改名（画布还没建）')
    } catch {
      setError('改名失败')
    } finally {
      setBusy('')
    }
  }, [active, flash, nameDraft, replaceProject])

  /**
   * 补建画布。没有画布的项目**什么都干不了** —— 上传设定图会 409、同步到画布会 502、
   * 概念图也画不了。所以缺画布时在界面上摆一个显眼的补建按钮，而不是等用户撞到报错。
   */
  const handleEnsureCanvas = useCallback(async () => {
    if (!active) return
    setBusy('canvas')
    setError('')
    try {
      const saved = await studioApi.ensureCanvas(active.id)
      replaceProject(saved)
      flash(saved.canvasTitle ? `画布已就绪：${saved.canvasTitle}` : '画布已就绪')
    } catch {
      setError('补建画布失败')
    } finally {
      setBusy('')
    }
  }, [active, flash, replaceProject])

  // ── 分镜绘制（第三阶段）────────────────────────────────────────────────

  /** 这一次「画选中的」要花几次生图。按钮上必须写出来。 */
  const boardCost = useMemo(
    () => boardGenerationCost(boards.items, pickedBoards, boardRedraw),
    [boardRedraw, boards.items, pickedBoards],
  )

  const patchBoardSettings = useCallback((patch: Partial<StudioBoardSettings>) => {
    setBoards((current) => ({ ...current, settings: { ...current.settings, ...patch } }))
    setDirty(true)
  }, [])

  const patchBoardItem = useCallback((id: string, patch: Partial<StudioBoardItem>) => {
    setBoards((current) => ({
      ...current,
      items: current.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }))
    setDirty(true)
  }, [])

  const toggleBoardStyle = useCallback((style: string) => {
    setBoards((current) => {
      const has = current.settings.styles.includes(style)
      const styles = has
        ? current.settings.styles.filter((item) => item !== style)
        : [...current.settings.styles, style]
      // 一个都不留会让服务端兜底成「描线」，那用户看到的和存的不一致 —— 直接挡住
      if (styles.length === 0) return current
      return { ...current, settings: { ...current.settings, styles } }
    })
    setDirty(true)
  }, [])

  /** 列清单。零成本，但会覆盖没画过的条目的提示词，所以有图的那些要提示一声。 */
  const handlePlanBoards = useCallback(async () => {
    if (!active) return
    if (rows.length === 0) { setError('先生成文字分镜'); return }
    if (boards.items.length > 0
      && !window.confirm('重列清单会按当前画风和绘制方法重写提示词。\n已经画好的图会保留（按镜号和类型对上的那些），继续？')) return
    setBusy('planBoards')
    setError('')
    try {
      const saved = await studioApi.planBoards(active.id, { settings: boards.settings })
      replaceProject(saved)
      flash(`分镜画清单已列出：${saved.boards.items.length} 条`)
    } catch (error) {
      setError(errorToText(error) || '列分镜画清单失败')
    } finally {
      setBusy('')
    }
  }, [active, boards.items.length, boards.settings, flash, replaceProject, rows.length])

  /** 画选中的。付费步骤，所以先落一次盘（免得改完提示词没保存就拿旧的去画）。 */
  const handleGenerateBoards = useCallback(async () => {
    if (!active) return
    const ids = boards.items.filter((item) => pickedBoards.has(item.id)).map((item) => item.id)
    if (ids.length === 0) { setError('先勾选要画的分镜'); return }
    if (boardCost === 0) { setError('勾中的都已经有图了 —— 想重画请勾上「重画已有的」'); return }
    if (!window.confirm(`这次会调用 ${boardCost} 次生图（每次都花钱），继续？`)) return
    setBusy('drawBoards')
    setError('')
    try {
      if (dirty) await studioApi.saveBoards(active.id, { settings: boards.settings, items: boards.items })
      const saved = await studioApi.generateBoards(active.id, { ids, redraw: boardRedraw })
      replaceProject(saved)
      const failed = saved.boards.items.filter((item) => item.status === 'failed').length
      flash(failed > 0 ? `画完了，其中 ${failed} 条失败（原因写在那一行）` : '分镜画都画好了')
    } catch (error) {
      setError(errorToText(error) || '画分镜失败')
    } finally {
      setBusy('')
    }
  }, [active, boardCost, boardRedraw, boards.items, boards.settings, dirty, flash, pickedBoards, replaceProject])

  const handlePushBoards = useCallback(async () => {
    if (!active) return
    setBusy('pushBoards')
    setError('')
    try {
      const saved = await studioApi.pushBoards(active.id)
      replaceProject(saved)
      flash('分镜画已同步到画布')
    } catch (error) {
      setError(errorToText(error) || '同步分镜画失败')
    } finally {
      setBusy('')
    }
  }, [active, flash, replaceProject])

  /** 画风参考图：复用设定图那个上传口（都落在这个项目的画布资产区里）。 */
  const uploadBoardReferences = useCallback(async (files: File[]) => {
    if (!active || files.length === 0) return
    setBusy('planBoards')
    setError('')
    try {
      const urls: string[] = []
      for (const file of files.slice(0, STUDIO_BOARD_REFERENCE_LIMIT)) {
        const prepared = await prepareAssetForUpload(file)
        const asset = await studioApi.uploadReference(active.id, prepared)
        if (asset?.url) urls.push(asset.url)
      }
      if (urls.length) {
        patchBoardSettings({
          referenceUrls: Array.from(new Set([...boards.settings.referenceUrls, ...urls]))
            .slice(0, STUDIO_BOARD_REFERENCE_LIMIT),
        })
        flash(`加了 ${urls.length} 张画风参考图`)
      }
    } catch (error) {
      setError(errorToText(error) || '参考图上传失败')
    } finally {
      setBusy('')
    }
  }, [active, boards.settings.referenceUrls, flash, patchBoardSettings])


  // ── 动态分镜（第四）与成片（第五）────────────────────────────────────

  const patchVideoStage = useCallback((stage: StudioVideoStage, patch: Partial<StudioVideoStageData>) => {
    setVideoStages((current) => ({ ...current, [stage]: { ...current[stage], ...patch } }))
    setDirty(true)
  }, [])

  const patchVideoItem = useCallback((stage: StudioVideoStage, id: string, patch: Partial<StudioVideoItem>) => {
    setVideoStages((current) => ({
      ...current,
      [stage]: {
        ...current[stage],
        items: current[stage].items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      },
    }))
    setDirty(true)
  }, [])

  const handlePlanVideo = useCallback(async (stage: StudioVideoStage) => {
    if (!active) return
    setBusy('planVideo')
    setError('')
    try {
      const saved = await studioApi.planVideoStage(active.id, stage, { settings: videoStages[stage].settings })
      replaceProject(saved)
      flash(`清单已列出：${saved[stage].items.length} 镜`)
    } catch (error) {
      setError(errorToText(error) || '列清单失败')
    } finally {
      setBusy('')
    }
  }, [active, flash, replaceProject, videoStages])

  /**
   * 提交生成。**只提交不等结果** —— 一条视频几分钟，同步等必被网关掐断。
   * 提交成功后 providerTaskId 就落库了，之后靠轮询收；页面关了也不丢。
   */
  const handleGenerateVideo = useCallback(async (stage: StudioVideoStage) => {
    if (!active) return
    const data = videoStages[stage]
    const ids = data.items.filter((item) => pickedVideos[stage].has(item.id)).map((item) => item.id)
    const cost = videoGenerationCost(data.items, pickedVideos[stage], videoRedraw[stage])
    if (ids.length === 0) { setError('先勾选要生成的镜头'); return }
    if (cost === 0) { setError('勾中的要么正在生成、要么已经有视频了（想重做请勾上「重做已有的」）'); return }
    if (!window.confirm(`这次会提交 ${cost} 条视频生成（每条都花钱），继续？`)) return
    setBusy('renderVideo')
    setError('')
    try {
      if (dirty) await studioApi.saveVideoStage(active.id, stage, { settings: data.settings, items: data.items })
      const saved = await studioApi.generateVideoStage(active.id, stage, { ids, redraw: videoRedraw[stage] })
      replaceProject(saved)
      flash(`已提交 ${cost} 条，生成中 —— 结果会自动刷出来，这个页面可以先去做别的`)
    } catch (error) {
      setError(errorToText(error) || '提交失败')
    } finally {
      setBusy('')
    }
  }, [active, dirty, flash, pickedVideos, replaceProject, videoRedraw, videoStages])

  const handlePushVideo = useCallback(async (stage: StudioVideoStage) => {
    if (!active) return
    setBusy('pushVideo')
    setError('')
    try {
      const saved = await studioApi.pushVideoStage(active.id, stage)
      replaceProject(saved)
      flash('已同步到画布')
    } catch (error) {
      setError(errorToText(error) || '同步失败')
    } finally {
      setBusy('')
    }
  }, [active, flash, replaceProject])

  /**
   * 轮询收结果。只在真有 running 条目时跑，没有就完全不发请求。
   *
   * 注意这里用的是 activeIdRef 而不是闭包里的 active：定时器活着的时候用户可能已经切了项目，
   * 拿闭包值会把结果写到错误的项目上。
   */
  useEffect(() => {
    const running = (['motion', 'film'] as StudioVideoStage[]).filter(
      (stage) => hasRunningVideos(videoStages[stage].items),
    )
    if (running.length === 0) return undefined
    const timer = window.setInterval(() => {
      const projectId = activeIdRef.current
      if (!projectId) return
      for (const stage of running) {
        void studioApi.pollVideoStage(projectId, stage)
          .then((saved) => {
            // 期间切了项目就丢弃这次结果，别覆盖别人的
            if (activeIdRef.current !== projectId) return
            replaceProject(saved)
          })
          .catch(() => { /* 轮询失败静默重试，不要往界面上刷红字 */ })
      }
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [replaceProject, videoStages])

  const handleSave = useCallback(async () => {
    if (!active || !brief) return
    setBusy('save')
    setError('')
    try {
      const saved = await studioApi.update(active.id, {
        brief,
        storyboard: { rows },
        concepts: { items: concepts },
      })
      replaceProject(saved)
      flash('已保存')
    } catch {
      setError('保存失败')
    } finally {
      setBusy('')
    }
  }, [active, brief, concepts, flash, replaceProject, rows])

  const handleGenerate = useCallback(async () => {
    if (!active || !brief) return
    if (!brief.outline.trim()) { setError('先填故事大纲'); return }
    if (rows.length > 0 && !window.confirm('重新生成会覆盖现在这张分镜表，继续？')) return
    setBusy('generate')
    setError('')
    try {
      // 先把当前填写内容存下来，再让服务端按它生成 —— 否则生成用的是上次保存的版本
      const saved = await studioApi.update(active.id, { brief })
      replaceProject(saved)
      const project = await studioApi.generateStoryboard(active.id)
      replaceProject(project)
      flash(`生成了 ${project.storyboard.rows.length} 个镜头`)
    } catch (cause) {
      const message = (cause as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(message || '生成失败，稍后重试')
    } finally {
      setBusy('')
    }
  }, [active, brief, flash, replaceProject, rows.length])

  const handlePush = useCallback(async () => {
    if (!active) return
    setBusy('push')
    setError('')
    try {
      if (dirty) {
        const saved = await studioApi.update(active.id, { brief: brief ?? undefined, storyboard: { rows } })
        replaceProject(saved)
      }
      const project = await studioApi.pushStoryboard(active.id)
      replaceProject(project)
      flash(`已同步到画布 ${project.canvasTitle ?? ''}`)
    } catch (cause) {
      const message = (cause as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(message || '同步到画布失败')
    } finally {
      setBusy('')
    }
  }, [active, brief, dirty, flash, replaceProject, rows])

  // ── 概念图 ──────────────────────────────────────────────────────────────

  const patchConcept = useCallback((id: string, patch: Partial<StudioConceptItem>) => {
    setConcepts((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)))
    setDirty(true)
  }, [])

  const removeConcept = useCallback((id: string) => {
    setConcepts((list) => list.filter((item) => item.id !== id))
    setPickedConcepts((picked) => {
      const next = new Set(picked)
      next.delete(id)
      return next
    })
    setDirty(true)
  }, [])

  const addConcept = useCallback(() => {
    setConcepts((list) => (list.length >= STUDIO_CONCEPT_LIMIT ? list : [...list, emptyConcept()]))
    setDirty(true)
  }, [])

  const toggleConcept = useCallback((id: string) => {
    setPickedConcepts((picked) => {
      const next = new Set(picked)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const allConceptsPicked = concepts.length > 0 && concepts.every((item) => pickedConcepts.has(item.id))

  const toggleAllConcepts = useCallback(() => {
    setPickedConcepts((picked) => {
      const everyPicked = concepts.length > 0 && concepts.every((item) => picked.has(item.id))
      return everyPicked ? new Set<string>() : new Set(concepts.map((item) => item.id))
    })
  }, [concepts])

  /** 这次点「画选中的」要花几次生图。口径跟服务端筛选一致，见 studio.ts。 */
  const conceptCost = studioConceptGenerationCost(concepts, pickedConcepts, conceptRedraw)

  const handlePlanConcepts = useCallback(async () => {
    if (!active) return
    if (rows.length === 0) { setError('先生成文字分镜'); return }
    if (concepts.length > 0
      && !window.confirm('重新列清单会按当前分镜重排条目。\n\n已经画好的图会按名称接回去（不会白花钱），但你手改过的提示词会被覆盖。继续？')) return
    setBusy('plan')
    setError('')
    try {
      // 先存：清单是按库里那份分镜和大纲列的，不存的话用的是上次保存的版本
      if (dirty) {
        const saved = await studioApi.update(active.id, {
          brief: brief ?? undefined,
          storyboard: { rows },
          concepts: { items: concepts },
        })
        replaceProject(saved)
      }
      const project = await studioApi.planConcepts(active.id)
      replaceProject(project)
      flash(`列了 ${project.concepts.items.length} 条概念图（还没花钱，勾选后再画）`)
    } catch (cause) {
      const message = (cause as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(message || '列清单失败，稍后重试')
    } finally {
      setBusy('')
    }
  }, [active, brief, concepts, dirty, flash, replaceProject, rows])

  const handleDrawConcepts = useCallback(async () => {
    if (!active) return
    const ids = concepts.filter((item) => pickedConcepts.has(item.id)).map((item) => item.id)
    if (ids.length === 0) { setError('先勾选要画的条目'); return }
    if (conceptCost === 0) {
      setError('勾中的条目要么缺提示词、要么已经有图了（想重画请勾上「重画已有的」）')
      return
    }
    if (conceptCost > STUDIO_CONCEPT_BATCH_LIMIT) {
      setError(`一次最多画 ${STUDIO_CONCEPT_BATCH_LIMIT} 张，现在勾了 ${conceptCost} 张，请分批`)
      return
    }
    if (!window.confirm(`要画 ${conceptCost} 张概念图，这会产生 ${conceptCost} 次生图费用。继续？`)) return
    setBusy('draw')
    setError('')
    try {
      // 必须先存：服务端是按库里那份提示词画的，你刚在表格里改的字不存就白改了
      if (dirty) {
        const saved = await studioApi.update(active.id, {
          brief: brief ?? undefined,
          storyboard: { rows },
          concepts: { items: concepts },
        })
        replaceProject(saved)
      }
      const project = await studioApi.generateConcepts(active.id, { ids, redraw: conceptRedraw })
      replaceProject(project)
      const failed = project.concepts.items.filter((item) => item.status === 'failed')
      flash(failed.length > 0
        ? `画完了，其中 ${failed.length} 条失败（原因在那一行里）`
        : `画完了 ${conceptCost} 张`)
    } catch (cause) {
      const message = (cause as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(message || '生成概念图失败，稍后重试')
    } finally {
      setBusy('')
    }
  }, [active, brief, conceptCost, conceptRedraw, concepts, dirty, flash, pickedConcepts, replaceProject, rows])

  const handlePushConcepts = useCallback(async () => {
    if (!active) return
    setBusy('pushConcepts')
    setError('')
    try {
      const project = await studioApi.pushConcepts(active.id)
      replaceProject(project)
      flash(`概念图已落到画布 ${project.canvasTitle ?? ''}`)
    } catch (cause) {
      const message = (cause as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(message || '同步概念图失败')
    } finally {
      setBusy('')
    }
  }, [active, flash, replaceProject])

  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  const patchBrief = useCallback((patch: Partial<StudioBrief>) => {
    setBrief((current) => (current ? { ...current, ...patch } : current))
    setDirty(true)
  }, [])

  // ── 设定图：拖入 / 粘贴 / 点选上传 ──────────────────────────────────────
  // 三个入口都汇到 uploadReferenceFiles。文件先过 prepareAssetForUpload（跟画布上传
  // 同一套：超大图自动压到 10MB 以内，视频超 150MB 直接拒），再上传，成功后往对应
  // 分组追加一条、地址填好。
  const [refDragGroup, setRefDragGroup] = useState<string | null>(null)
  const [refFocusGroup, setRefFocusGroup] = useState<string | null>(null)
  const [refUploading, setRefUploading] = useState<Record<string, number>>({})
  const [refError, setRefError] = useState('')
  const refFileInputRef = useRef<HTMLInputElement | null>(null)
  const refPickGroupRef = useRef<string>('')

  // 必须走函数式更新读 current：一次拖进多张时是顺序 await 的循环，
  // 用闭包里的 brief 会让后面几张覆盖掉前面几张。
  const appendReference = useCallback((group: string, url: string) => {
    setBrief((current) => {
      if (!current) return current
      if (current.references.length >= STUDIO_REFERENCE_LIMIT) return current
      return { ...current, references: [...current.references, { group, label: '', url }] }
    })
    setDirty(true)
  }, [])

  const uploadReferenceFiles = useCallback(async (group: string, files: File[]) => {
    const activeProjectId = activeIdRef.current
    if (!activeProjectId) return
    const media = files.filter((file) => file.type.startsWith('image/') || file.type.startsWith('video/'))
    if (media.length === 0) {
      setRefError('只收图片和视频')
      return
    }
    setRefError('')
    setRefUploading((prev) => ({ ...prev, [group]: (prev[group] || 0) + media.length }))
    for (const file of media) {
      try {
        const prepared = await prepareAssetForUpload(file)
        const asset = await studioApi.uploadReference(activeProjectId, prepared)
        if (asset.url) appendReference(group, asset.url)
      } catch (uploadError) {
        setRefError(uploadError instanceof Error ? uploadError.message : String(uploadError))
      } finally {
        setRefUploading((prev) => {
          const left = (prev[group] || 1) - 1
          const next = { ...prev }
          if (left > 0) next[group] = left
          else delete next[group]
          return next
        })
      }
    }
  }, [appendReference])

  const handleRefDrop = useCallback((group: string, event: React.DragEvent) => {
    event.preventDefault()
    setRefDragGroup(null)
    const files = Array.from(event.dataTransfer?.files || [])
    if (files.length) void uploadReferenceFiles(group, files)
  }, [uploadReferenceFiles])

  // onPasteCapture：点进分组里的输入框时焦点在 input 上，挂在外层的 onPaste 收不到。
  // 剪贴板里有图就拦下来走上传，只有文本就放行，让它照常粘进输入框。
  const handleRefPaste = useCallback((group: string, event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.files || [])
      .filter((file) => file.type.startsWith('image/') || file.type.startsWith('video/'))
    if (files.length === 0) return
    event.preventDefault()
    void uploadReferenceFiles(group, files)
  }, [uploadReferenceFiles])

  const toggleStyle = useCallback((style: string) => {
    setBrief((current) => {
      if (!current) return current
      const has = current.styles.includes(style)
      return { ...current, styles: has ? current.styles.filter((item) => item !== style) : [...current.styles, style] }
    })
    setDirty(true)
  }, [])

  const patchRow = useCallback((id: string, patch: Partial<StudioStoryboardRow>) => {
    setRows((list) => list.map((row) => (row.id === id ? { ...row, ...patch } : row)))
    setDirty(true)
  }, [])

  // 加减行之后镜号自动重排（手填的合并镜号如 4/5 会保留，见 studio.ts）
  const insertRowAfter = useCallback((index: number) => {
    setRows((list) => {
      if (list.length >= STUDIO_MAX_ROWS) return list
      const next = [...list]
      next.splice(index + 1, 0, emptyRow())
      return renumberShots(next)
    })
    setDirty(true)
  }, [])

  const removeRow = useCallback((id: string) => {
    setRows((list) => renumberShots(list.filter((row) => row.id !== id)))
    setDirty(true)
  }, [])

  const total = storyboardTotalSeconds(rows)
  const delta = brief ? storyboardDurationDelta(rows, brief.seconds) : 0

  return (
    <div className="studio-page">
      <header className="studio-topbar">
        <button type="button" className="studio-back" onClick={onBack}>
          <ArrowLeft size={15} />返回画布管理
        </button>
        <h1>AI 出片</h1>
        <span className="studio-stage">第一阶段 · 剧本创作与文字分镜</span>
        <div className="studio-topbar-right">
          {notice ? <span className="studio-notice">{notice}</span> : null}
          {error ? <span className="studio-error">{error}</span> : null}
          <button
            type="button"
            className={`studio-btn${assetDock === 'assets' ? ' is-active' : ''}`}
            title="资产库：浏览自己收藏的节点与素材，点一下复制地址"
            onClick={() => toggleAssetDock('assets')}
          >
            <FolderOpen size={14} />资产库
          </button>
          <button
            type="button"
            className={`studio-btn${assetDock === 'shared' ? ' is-active' : ''}`}
            title="共享空间：浏览团队共享的素材，点一下复制地址"
            onClick={() => toggleAssetDock('shared')}
          >
            <Users size={14} />共享空间
          </button>
          <button type="button" className="studio-btn" onClick={() => void load(activeId ?? undefined)}>
            <RefreshCw size={14} />刷新
          </button>
        </div>
      </header>

      <div className="studio-body">
        <aside className="studio-projects">
          <div className="studio-projects-head">
            <span>我的出片项目<em>{projects.length}</em></span>
            <button type="button" className="studio-btn is-primary" disabled={busy === 'create'} onClick={() => void handleCreate()}>
              {busy === 'create' ? <Loader2 size={14} className="studio-spin" /> : <Plus size={14} />}新建
            </button>
          </div>
          {loading ? (
            <div className="studio-empty">正在加载…</div>
          ) : projects.length === 0 ? (
            <div className="studio-empty">还没有项目。点「新建」会自动在你的「测试」分类下建一个 ai_xxxxxx 画布。</div>
          ) : (
            <ul className="studio-project-list">
              {projects.map((project) => (
                <li key={project.id}>
                  <button
                    type="button"
                    className={`studio-project${project.id === activeId ? ' is-active' : ''}`}
                    onClick={() => selectProject(project)}
                  >
                    <strong>{project.name}</strong>
                    <small>
                      {project.canvasTitle || '画布未创建'}
                      {' · '}
                      {project.storyboard.rows.length > 0 ? `${project.storyboard.rows.length} 镜` : '未生成分镜'}
                    </small>
                  </button>
                  <button type="button" className="studio-project-del" title="删除项目" onClick={() => void handleDelete(project)}>
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {!active || !brief ? (
          <main className="studio-main studio-main-empty">
            <p>左边选一个项目，或者新建一个。</p>
          </main>
        ) : (
          <main className="studio-main">
            <section className="studio-card">
              <h2>1 · 剧本创作</h2>

              {/*
                没有画布的项目什么都干不了：设定图放不进去、分镜同步不过去、概念图也画不了。
                以前用户只能一个个撞到 409 / 502 才知道，所以这里直接摆出来并给一键补建。
              */}
              {!active.canvasId ? (
                <div className="studio-canvas-missing">
                  <div>
                    <strong>这个项目还没有对应的画布。</strong>
                    设定图、同步分镜、概念图都需要画布，补建之后就能用了。
                  </div>
                  <button
                    type="button"
                    className="studio-btn is-primary"
                    disabled={busy === 'canvas'}
                    onClick={() => void handleEnsureCanvas()}
                  >
                    {busy === 'canvas' ? '补建中' : '补建画布'}
                  </button>
                </div>
              ) : null}

              <label className="studio-field">
                <span>项目名称</span>
                {/*
                  名字走独立草稿 + 「确定」提交，不跟着「保存修改」走。
                  改这里之前：输入框只改本地 state，而 handleSave 压根不发 name —— 打了字直接丢。
                  确定之后会连带把对应画布改成同一个名字。
                */}
                <div className="studio-name-row">
                  <input
                    value={nameDraft}
                    maxLength={120}
                    placeholder="给这个出片项目起个名字"
                    onChange={(event) => setNameDraft(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') { event.preventDefault(); void handleRename() }
                    }}
                  />
                  <button
                    type="button"
                    className="studio-btn is-primary"
                    disabled={!nameChanged || busy === 'rename'}
                    title={
                      nameChanged
                        ? (active.canvasTitle ? `同时把画布 ${active.canvasTitle} 改成这个名字` : '画布还没建，先只改项目名')
                        : '名字没变'
                    }
                    onClick={() => void handleRename()}
                  >
                    {busy === 'rename' ? '保存中' : '确定'}
                  </button>
                </div>
              </label>

              <label className="studio-field">
                <span>选项目（IP）</span>
                <select value={brief.project} onChange={(event) => patchBrief({ project: event.currentTarget.value })}>
                  <option value="">未指定</option>
                  {STUDIO_PROJECT_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </label>

              <label className="studio-field is-block">
                <span>故事大纲</span>
                <textarea
                  rows={6}
                  value={brief.outline}
                  placeholder="一段话说清主角、处境、发生了什么、结局。分镜只会按这段来，不会自己加情节。"
                  onChange={(event) => patchBrief({ outline: event.currentTarget.value })}
                />
              </label>

              <div className="studio-field is-block">
                <span>故事风格（多选，第一个是主调）</span>
                <div className="studio-chips">
                  {STUDIO_STYLE_OPTIONS.map((style) => (
                    <button
                      key={style}
                      type="button"
                      className={`studio-chip${brief.styles.includes(style) ? ' is-on' : ''}`}
                      onClick={() => toggleStyle(style)}
                    >
                      {style}
                    </button>
                  ))}
                </div>
              </div>

              <div className="studio-field-row">
                <label className="studio-field">
                  <span>时长</span>
                  <select
                    value={brief.seconds}
                    onChange={(event) => patchBrief({ seconds: Number(event.currentTarget.value) })}
                  >
                    {STUDIO_DURATION_OPTIONS.map((option) => (
                      <option key={option} value={option}>{option} 秒</option>
                    ))}
                  </select>
                </label>
                <label className="studio-field">
                  <span>画面比例</span>
                  <select value={brief.ratio} onChange={(event) => patchBrief({ ratio: event.currentTarget.value })}>
                    {STUDIO_RATIO_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                </label>
                <label className="studio-field">
                  <span>分辨率</span>
                  <select
                    value={brief.resolution}
                    onChange={(event) => patchBrief({ resolution: event.currentTarget.value })}
                  >
                    {STUDIO_RESOLUTION_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                </label>
              </div>

              <div className="studio-field is-block">
                <span>
                  设定图与参考资料
                  <em className="studio-ref-tip">拖图片进对应分组，或点一下分组再 Ctrl+V 粘贴；也可以直接填地址</em>
                </span>
                {refError ? <div className="studio-error">{refError}</div> : null}
                <input
                  ref={refFileInputRef}
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(event) => {
                    const files = Array.from(event.currentTarget.files || [])
                    // 清空 value：不清的话同一个文件第二次选不会触发 change
                    event.currentTarget.value = ''
                    const group = refPickGroupRef.current
                    if (files.length && group) void uploadReferenceFiles(group, files)
                  }}
                />
                <div className="studio-refs">
                  {STUDIO_REFERENCE_GROUPS.map((group) => {
                    const items = brief.references.filter((item) => item.group === group.key)
                    return (
                      <div
                        key={group.key}
                        className={[
                          'studio-ref-group',
                          refDragGroup === group.key ? 'is-drop' : '',
                          refFocusGroup === group.key ? 'is-armed' : '',
                        ].filter(Boolean).join(' ')}
                        tabIndex={0}
                        onFocus={() => setRefFocusGroup(group.key)}
                        onBlur={() => setRefFocusGroup((current) => (current === group.key ? null : current))}
                        onPasteCapture={(event) => handleRefPaste(group.key, event)}
                        onDragEnter={(event) => { event.preventDefault(); setRefDragGroup(group.key) }}
                        onDragOver={(event) => { event.preventDefault(); setRefDragGroup(group.key) }}
                        onDragLeave={(event) => {
                          // 拖过子元素也会冒泡出 dragleave，不判 contains 的话高亮一直闪
                          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                          setRefDragGroup((current) => (current === group.key ? null : current))
                        }}
                        onDrop={(event) => handleRefDrop(group.key, event)}
                      >
                        <div className="studio-ref-head">
                          {group.label}
                          <span className="studio-ref-head-actions">
                            <button
                              type="button"
                              className="studio-btn is-mini"
                              title="选文件上传"
                              onClick={() => {
                                refPickGroupRef.current = group.key
                                refFileInputRef.current?.click()
                              }}
                            >
                              <ImagePlus size={12} />上传
                            </button>
                            <button
                              type="button"
                              className="studio-btn is-mini"
                              title="只填地址，不上传文件"
                              onClick={() => patchBrief({
                                references: [...brief.references, { group: group.key, label: '', url: '' }],
                              })}
                            >
                              <Plus size={12} />加一条
                            </button>
                          </span>
                        </div>
                        {refUploading[group.key] ? (
                          <em className="studio-ref-uploading">
                            <Loader2 size={12} className="studio-spin" />
                            正在上传 {refUploading[group.key]} 个
                          </em>
                        ) : null}
                        {items.length === 0 && !refUploading[group.key] ? (
                          <em className="studio-ref-empty">
                            {refFocusGroup === group.key ? '已选中，Ctrl+V 可直接粘贴图片' : '未添加 · 可把图片拖进来'}
                          </em>
                        ) : null}
                        {brief.references.map((item, index) => (
                          item.group !== group.key ? null : (
                            <div
                              key={`${group.key}-${index}`}
                              className={`studio-ref-row${item.url ? ' has-thumb' : ''}`}
                            >
                              {item.url ? (
                                <a
                                  className="studio-ref-thumb"
                                  href={item.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  title="打开原文件"
                                >
                                  {/\.(mp4|mov|webm|m4v)(\?|$)/i.test(item.url)
                                    ? <span className="studio-ref-thumb-video">▶</span>
                                    : <img src={item.url} alt="" loading="lazy" />}
                                </a>
                              ) : null}
                              <input
                                value={item.label}
                                placeholder="称呼（分镜里会用这个名字）"
                                onChange={(event) => {
                                  const next = [...brief.references]
                                  next[index] = { ...item, label: event.currentTarget.value }
                                  patchBrief({ references: next })
                                }}
                              />
                              <input
                                value={item.url}
                                placeholder="图片 / 视频地址"
                                onChange={(event) => {
                                  const next = [...brief.references]
                                  next[index] = { ...item, url: event.currentTarget.value }
                                  patchBrief({ references: next })
                                }}
                              />
                              <button
                                type="button"
                                className="studio-ref-del"
                                title="移除"
                                onClick={() => patchBrief({ references: brief.references.filter((_, i) => i !== index) })}
                              >
                                ×
                              </button>
                            </div>
                          )
                        ))}
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="studio-actions">
                <button type="button" className="studio-btn is-primary" disabled={busy === 'generate'} onClick={() => void handleGenerate()}>
                  {busy === 'generate' ? <Loader2 size={14} className="studio-spin" /> : <Wand2 size={14} />}
                  {rows.length > 0 ? '重新生成文字分镜' : '生成文字分镜'}
                </button>
                <button type="button" className="studio-btn" disabled={busy === 'save' || !dirty} onClick={() => void handleSave()}>
                  {busy === 'save' ? <Loader2 size={14} className="studio-spin" /> : null}
                  {dirty ? '保存修改' : '已保存'}
                </button>
                {busy === 'generate' ? <span className="studio-hint">模型生成中，通常十几到几十秒…</span> : null}
              </div>
            </section>

            <section className="studio-card">
              <div className="studio-card-head">
                <h2>1.5 · 文字分镜</h2>
                <span className={`studio-total${Math.abs(delta) > brief.seconds * 0.1 ? ' is-off' : ''}`}>
                  {rows.length} 镜 · 合计 {total}s / 目标 {brief.seconds}s
                  {delta === 0 ? '' : delta > 0 ? `（超 ${delta}s）` : `（差 ${-delta}s）`}
                </span>
                <button type="button" className="studio-btn" disabled={busy === 'push' || rows.length === 0} onClick={() => void handlePush()}>
                  {busy === 'push' ? <Loader2 size={14} className="studio-spin" /> : <Send size={14} />}同步到画布
                </button>
              </div>

              {rows.length === 0 ? (
                <div className="studio-empty">还没有分镜。填好上面的内容，点「生成文字分镜」。</div>
              ) : (
                <div className="studio-table-wrap">
                  <table className="studio-table">
                    <thead>
                      <tr>
                        <th style={{ width: 64 }}>镜号</th>
                        <th>内容</th>
                        <th style={{ width: 176 }} title="这一镜出场的角色、地点和有戏的道具。后面准备设定图、检查连贯性都看这一列">
                          角色 / 场景 / 道具
                        </th>
                        <th style={{ width: 104 }}>景别</th>
                        <th style={{ width: 104 }}>镜头运动</th>
                        <th style={{ width: 82 }}>时间</th>
                        <th style={{ width: 74 }}>加减</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, index) => (
                        <tr key={row.id}>
                          <td>
                            <input
                              className="studio-cell is-shot"
                              value={row.shot}
                              title="手填「4/5」这种合并镜号会被保留，加减行时不会被冲掉"
                              onChange={(event) => patchRow(row.id, { shot: event.currentTarget.value })}
                            />
                          </td>
                          <td>
                            <textarea
                              className="studio-cell is-content"
                              rows={2}
                              value={row.content}
                              onChange={(event) => patchRow(row.id, { content: event.currentTarget.value })}
                            />
                          </td>
                          {/*
                            一览列：三项各一格，输入时用中英文逗号 / 顿号分隔都行
                            （parseTagList 全都认）。存的是数组，显示时用「、」拼回去。
                          */}
                          <td>
                            <div className="studio-inventory">
                              {([
                                ['roles', '角色'],
                                ['scenes', '场景'],
                                ['props', '道具'],
                              ] as const).map(([field, label]) => (
                                <label key={field} className="studio-inventory-item">
                                  <span>{label}</span>
                                  <input
                                    className="studio-cell"
                                    value={formatTagList(row[field])}
                                    placeholder="—"
                                    onChange={(event) =>
                                      patchRow(row.id, { [field]: parseTagList(event.currentTarget.value) })
                                    }
                                  />
                                </label>
                              ))}
                            </div>
                          </td>
                          <td>
                            <input
                              className="studio-cell"
                              list="studio-shot-sizes"
                              value={row.shotSize}
                              onChange={(event) => patchRow(row.id, { shotSize: event.currentTarget.value })}
                            />
                          </td>
                          <td>
                            <input
                              className="studio-cell"
                              list="studio-camera-moves"
                              value={row.movement}
                              onChange={(event) => patchRow(row.id, { movement: event.currentTarget.value })}
                            />
                          </td>
                          <td>
                            <input
                              className="studio-cell is-seconds"
                              type="number"
                              min={0.5}
                              max={120}
                              step={0.5}
                              value={row.seconds}
                              onChange={(event) => patchRow(row.id, { seconds: Number(event.currentTarget.value) })}
                            />
                          </td>
                          <td className="studio-row-actions">
                            <button type="button" title="在下面插入一镜" onClick={() => insertRowAfter(index)}>＋</button>
                            <button type="button" title="删除这一镜" onClick={() => removeRow(row.id)}>－</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <datalist id="studio-shot-sizes">
                    {STUDIO_SHOT_SIZES.map((option) => <option key={option} value={option} />)}
                  </datalist>
                  <datalist id="studio-camera-moves">
                    {STUDIO_CAMERA_MOVES.map((option) => <option key={option} value={option} />)}
                  </datalist>
                </div>
              )}

              {rows.length > 0 ? (
                <div className="studio-actions">
                  <button type="button" className="studio-btn is-primary" disabled={busy === 'save' || !dirty} onClick={() => void handleSave()}>
                    {busy === 'save' ? <Loader2 size={14} className="studio-spin" /> : null}
                    {dirty ? '保存分镜' : '已保存'}
                  </button>
                  <span className="studio-hint">
                    分镜表存在出片项目库里；「同步到画布」才会写进 {active.canvasTitle || '对应画布'}。
                  </span>
                </div>
              ) : null}
            </section>

            <section className="studio-card">
              <div className="studio-card-head">
                <h2>2 · 概念图绘制</h2>
                <span className="studio-total">
                  {concepts.length === 0
                    ? '未列清单'
                    : `${concepts.length} 条 · 已画 ${concepts.filter((item) => item.imageUrl).length} · 待画 ${concepts.filter((item) => !item.imageUrl).length}`}
                </span>
                <button
                  type="button"
                  className="studio-btn"
                  disabled={busy === 'plan' || rows.length === 0}
                  title={rows.length === 0 ? '先生成文字分镜' : '只调模型列清单，不生图，不花钱'}
                  onClick={() => void handlePlanConcepts()}
                >
                  {busy === 'plan' ? <Loader2 size={14} className="studio-spin" /> : <ListChecks size={14} />}
                  {concepts.length > 0 ? '重新列清单' : '列概念图清单'}
                </button>
                <button
                  type="button"
                  className="studio-btn"
                  disabled={busy === 'pushConcepts' || !concepts.some((item) => item.imageUrl && !item.nodeKey)}
                  title="把已经画好、还没落到画布的概念图建成上传节点"
                  onClick={() => void handlePushConcepts()}
                >
                  {busy === 'pushConcepts' ? <Loader2 size={14} className="studio-spin" /> : <Send size={14} />}
                  同步概念图到画布
                </button>
              </div>

              {concepts.length === 0 ? (
                <div className="studio-empty">
                  还没有概念图清单。先生成文字分镜，再点「列概念图清单」——
                  这一步只让模型挑对象、写提示词，<strong>不生图、不花钱</strong>。
                </div>
              ) : (
                <>
                  <div className="studio-table-wrap">
                    <table className="studio-table studio-concept-table">
                      <thead>
                        <tr>
                          <th style={{ width: 34 }}>
                            <input
                              type="checkbox"
                              checked={allConceptsPicked}
                              title="全选 / 全不选"
                              onChange={toggleAllConcepts}
                            />
                          </th>
                          <th style={{ width: 92 }}>分组</th>
                          <th style={{ width: 150 }}>名称</th>
                          <th>生图提示词</th>
                          <th style={{ width: 88 }}>镜号</th>
                          <th style={{ width: 118 }}>结果</th>
                          <th style={{ width: 74 }}>加减</th>
                        </tr>
                      </thead>
                      <tbody>
                        {concepts.map((item) => (
                          <tr key={item.id} className={item.status === 'failed' ? 'is-failed' : undefined}>
                            <td>
                              <input
                                type="checkbox"
                                checked={pickedConcepts.has(item.id)}
                                onChange={() => toggleConcept(item.id)}
                              />
                            </td>
                            <td>
                              <select
                                className="studio-cell"
                                value={item.group}
                                title={`会画成 ${STUDIO_CONCEPT_RATIO_BY_GROUP[item.group] || '16:9'}`}
                                onChange={(event) => patchConcept(item.id, { group: event.currentTarget.value })}
                              >
                                {STUDIO_CONCEPT_GROUPS.map((group) => (
                                  <option key={group.key} value={group.key}>{group.label}</option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <input
                                className="studio-cell"
                                value={item.name}
                                placeholder="名称要跟分镜里一致"
                                onChange={(event) => patchConcept(item.id, { name: event.currentTarget.value })}
                              />
                            </td>
                            <td>
                              <textarea
                                className="studio-cell is-content"
                                rows={3}
                                value={item.prompt}
                                placeholder="设定图口径：单体 / 中性姿态 / 干净背景 / 看清细节"
                                onChange={(event) => patchConcept(item.id, { prompt: event.currentTarget.value })}
                              />
                            </td>
                            <td>
                              <input
                                className="studio-cell"
                                value={item.reason}
                                onChange={(event) => patchConcept(item.id, { reason: event.currentTarget.value })}
                              />
                            </td>
                            <td className="studio-concept-result">
                              {item.imageUrl ? (
                                <a href={item.imageUrl} target="_blank" rel="noreferrer" title={item.nodeKey ? '已在画布上' : '还没同步到画布'}>
                                  <img src={item.imageUrl} alt={item.name || '概念图'} loading="lazy" />
                                  <em>{item.nodeKey ? '已在画布' : '待同步'}</em>
                                </a>
                              ) : item.status === 'failed' ? (
                                <span className="studio-concept-failed" title={item.error}>失败</span>
                              ) : (
                                <span className="studio-concept-idle">未画</span>
                              )}
                            </td>
                            <td className="studio-row-actions">
                              <button type="button" title="删除这一条" onClick={() => removeConcept(item.id)}>－</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* 失败原因单独列一遍：表格里那一格太窄，只放得下"失败"两个字 */}
                  {concepts.filter((item) => item.status === 'failed' && item.error).map((item) => (
                    <div key={`err-${item.id}`} className="studio-concept-error">
                      {item.name || '未命名'}：{item.error}
                    </div>
                  ))}

                  <div className="studio-actions">
                    <button
                      type="button"
                      className="studio-btn is-primary"
                      disabled={busy === 'draw' || conceptCost === 0}
                      onClick={() => void handleDrawConcepts()}
                    >
                      {busy === 'draw' ? <Loader2 size={14} className="studio-spin" /> : <Palette size={14} />}
                      画选中的（{conceptCost} 次生图）
                    </button>
                    <label className="studio-concept-redraw" title="默认只画还没有图的；勾上才会把已经有图的重画一遍（会重复花钱）">
                      <input
                        type="checkbox"
                        checked={conceptRedraw}
                        onChange={(event) => setConceptRedraw(event.currentTarget.checked)}
                      />
                      重画已有的
                    </label>
                    <button type="button" className="studio-btn" disabled={concepts.length >= STUDIO_CONCEPT_LIMIT} onClick={addConcept}>
                      <Plus size={14} />加一条
                    </button>
                    <button type="button" className="studio-btn" disabled={busy === 'save' || !dirty} onClick={() => void handleSave()}>
                      {busy === 'save' ? <Loader2 size={14} className="studio-spin" /> : null}
                      {dirty ? '保存清单' : '已保存'}
                    </button>
                  </div>
                  <span className="studio-hint">
                    比例按分组自动定：主角 / 配角 3:4、场景 16:9、道具 1:1，不跟成片比例走。
                    一次最多画 {STUDIO_CONCEPT_BATCH_LIMIT} 张。改完提示词直接点「画选中的」就行，会先自动保存。
                    重画会换一张新图，画布上的旧节点不会自动删 —— 需要的话自己去画布里删。
                  </span>
                  {busy === 'draw' ? <span className="studio-hint">正在生图，每张十几到几十秒，三张并行…</span> : null}
                </>
              )}
            </section>

            <section className="studio-card is-later">
              <h2>3 · 分镜绘制</h2>
              <div className="studio-card-head">
                <span className="studio-muted">
                  {boards.items.length === 0
                    ? '按镜画画面。会自动把这一镜的角色 / 场景 / 道具对应的概念图当参考图喂进去。'
                    : `${boards.items.length} 条 · 已画 ${boards.items.filter((item) => item.imageUrl).length} · 待画 ${boards.items.filter((item) => !item.imageUrl).length}`}
                </span>
                <button
                  type="button"
                  className="studio-btn"
                  disabled={busy === 'planBoards' || rows.length === 0}
                  onClick={() => void handlePlanBoards()}
                >
                  {busy === 'planBoards' ? '列清单中' : boards.items.length > 0 ? '重列清单' : '列分镜画清单'}
                </button>
                <button
                  type="button"
                  className="studio-btn"
                  disabled={busy === 'pushBoards' || !boards.items.some((item) => item.imageUrl && !item.nodeKey)}
                  onClick={() => void handlePushBoards()}
                >
                  {busy === 'pushBoards' ? '同步中' : '同步到画布'}
                </button>
              </div>

              {/* 画风多选 + 绘制方法。这两项决定提示词怎么写、以及一镜画几张 */}
              <div className="studio-field is-block">
                <span>画风（多选，第一个是主调）</span>
                <div className="studio-chips">
                  {STUDIO_BOARD_STYLES.map((style) => (
                    <button
                      key={style}
                      type="button"
                      className={`studio-chip${boards.settings.styles.includes(style) ? ' is-on' : ''}`}
                      onClick={() => toggleBoardStyle(style)}
                    >
                      {style}
                    </button>
                  ))}
                </div>
              </div>

              <div className="studio-field is-block">
                <span>绘制方法</span>
                <div className="studio-chips">
                  {STUDIO_BOARD_METHODS.map((method) => (
                    <button
                      key={method.key}
                      type="button"
                      className={`studio-chip${boards.settings.method === method.key ? ' is-on' : ''}`}
                      title={method.hint}
                      onClick={() => patchBoardSettings({ method: method.key })}
                    >
                      {method.label}
                      <em className="studio-chip-note">
                        {rows.length > 0 ? ` ${rows.length * method.perShot} 张` : ` ×${method.perShot}`}
                      </em>
                    </button>
                  ))}
                </div>
              </div>

              {/* 画风参考图。跟画风词是两个维度：词管风格倾向，图管具体笔触 */}
              <div className="studio-field is-block">
                <span>
                  画风参考图
                  <em className="studio-ref-tip">可选。上传后会跟概念图一起喂进每一次生图</em>
                </span>
                <div className="studio-board-refs">
                  {boards.settings.referenceUrls.map((url) => (
                    <div key={url} className="studio-board-ref">
                      <img src={url} alt="" loading="lazy" />
                      <button
                        type="button"
                        title="移除"
                        onClick={() => patchBoardSettings({
                          referenceUrls: boards.settings.referenceUrls.filter((item) => item !== url),
                        })}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {boards.settings.referenceUrls.length < STUDIO_BOARD_REFERENCE_LIMIT ? (
                    <label className="studio-board-ref is-add" title="选图片上传">
                      ＋
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        style={{ display: 'none' }}
                        onChange={(event) => {
                          const files = Array.from(event.currentTarget.files || [])
                          event.currentTarget.value = ''
                          if (files.length) void uploadBoardReferences(files)
                        }}
                      />
                    </label>
                  ) : null}
                </div>
              </div>

              {boards.items.length === 0 ? (
                <div className="studio-empty">
                  {rows.length === 0
                    ? '先生成文字分镜，分镜画要按镜来画。'
                    : '选好画风和绘制方法，点「列分镜画清单」。这一步只写提示词，不花钱。'}
                </div>
              ) : (
                <>
                  <div className="studio-table-wrap">
                    <table className="studio-table studio-board-table">
                      <thead>
                        <tr>
                          <th style={{ width: 34 }}>
                            <input
                              type="checkbox"
                              title="全选 / 全不选"
                              checked={pickedBoards.size > 0 && pickedBoards.size === boards.items.length}
                              onChange={(event) => setPickedBoards(
                                event.currentTarget.checked
                                  ? new Set(boards.items.map((item) => item.id))
                                  : new Set(),
                              )}
                            />
                          </th>
                          <th style={{ width: 64 }}>镜号</th>
                          <th style={{ width: 68 }}>类型</th>
                          <th>生图提示词</th>
                          <th style={{ width: 96 }}>参考图</th>
                          <th style={{ width: 118 }}>结果</th>
                        </tr>
                      </thead>
                      <tbody>
                        {boards.items.map((item) => (
                          <tr key={item.id} className={item.status === 'failed' ? 'is-failed' : undefined}>
                            <td>
                              <input
                                type="checkbox"
                                checked={pickedBoards.has(item.id)}
                                onChange={(event) => setPickedBoards((current) => {
                                  const next = new Set(current)
                                  if (event.currentTarget.checked) next.add(item.id)
                                  else next.delete(item.id)
                                  return next
                                })}
                              />
                            </td>
                            <td><span className="studio-cell is-static">{item.shot}</span></td>
                            <td><span className="studio-cell is-static">{boardKindLabel(item.kind)}</span></td>
                            <td>
                              <textarea
                                className="studio-cell is-content"
                                rows={3}
                                value={item.prompt}
                                onChange={(event) => patchBoardItem(item.id, { prompt: event.currentTarget.value })}
                              />
                              {/* 文档「修改构图 / 角色pose / 透视 / 相机角度 / 角色位置」：
                                  机制就是改提示词再重画，所以做成往末尾追加的快捷词 */}
                              <div className="studio-tweaks">
                                {STUDIO_BOARD_TWEAKS.map((tweak) => (
                                  <button
                                    key={tweak}
                                    type="button"
                                    className="studio-tweak"
                                    title={`在提示词末尾加一句「${tweak}：」，自己补上要改成什么`}
                                    onClick={() => patchBoardItem(item.id, {
                                      prompt: `${item.prompt}${item.prompt.endsWith('。') || !item.prompt ? '' : '。'}${tweak}：`,
                                    })}
                                  >
                                    {tweak}
                                  </button>
                                ))}
                              </div>
                            </td>
                            <td>
                              <span className="studio-muted" title={item.referenceUrls.join('\n')}>
                                {item.referenceUrls.length > 0 ? `${item.referenceUrls.length} 张` : '生成时自动匹配'}
                              </span>
                            </td>
                            {/* 结果格复用概念图那套类名（studio-concept-result 等），不另造一份样式 */}
                            <td className="studio-concept-result">
                              {item.imageUrl ? (
                                <a href={item.imageUrl} target="_blank" rel="noreferrer" title={item.nodeKey ? '已在画布上' : '还没同步到画布'}>
                                  <img src={item.imageUrl} alt={`分镜 ${item.shot}`} loading="lazy" />
                                  <em>{item.nodeKey ? '已在画布' : '待同步'}</em>
                                </a>
                              ) : item.status === 'failed' ? (
                                <span className="studio-concept-failed" title={item.error}>失败</span>
                              ) : (
                                <span className="studio-concept-idle">未画</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="studio-actions">
                    <button
                      type="button"
                      className="studio-btn is-primary"
                      disabled={busy === 'drawBoards' || boardCost === 0}
                      onClick={() => void handleGenerateBoards()}
                    >
                      {busy === 'drawBoards' ? '画图中' : `画选中的（${boardCost} 次生图）`}
                    </button>
                    <label className="studio-concept-redraw" title="默认只画还没有图的；勾上才会把已经有图的重画一遍（会重复花钱）">
                      <input
                        type="checkbox"
                        checked={boardRedraw}
                        onChange={(event) => setBoardRedraw(event.currentTarget.checked)}
                      />
                      重画已有的
                    </label>
                    <button
                      type="button"
                      className="studio-btn"
                      disabled={busy === 'save' || !dirty}
                      onClick={() => void handleSave()}
                    >
                      {dirty ? '保存修改' : '已保存'}
                    </button>
                  </div>
                  <p className="studio-hint">
                    一次最多画 9 张。每一镜的角色 / 场景 / 道具会自动去概念图里按名字找参考图 ——
                    所以概念图先画好，11 镜里的人才会是同一个人。
                    重画会换一张新图，画布上的旧节点不会自动删。
                  </p>
                </>
              )}
            </section>

            {STUDIO_VIDEO_STAGES.map((stageDef, stageIndex) => {
              const stage = stageDef.key
              const data = videoStages[stage]
              const picked = pickedVideos[stage]
              const cost = videoGenerationCost(data.items, picked, videoRedraw[stage])
              const runningCount = data.items.filter((item) => item.status === 'running').length
              const boardsReady = boards.items.some((item) => item.imageUrl)
              return (
                <section className="studio-card" key={stage}>
                  <h2>{4 + stageIndex} · {stageDef.label}</h2>
                  <div className="studio-card-head">
                    <span className="studio-muted">
                      {data.items.length === 0
                        ? '按镜生成视频，拿分镜画当首帧。' + stageDef.hint
                        : data.items.length + ' 镜 · 已好 ' + data.items.filter((i) => i.videoUrl).length
                          + (runningCount > 0 ? ' · 生成中 ' + runningCount : '')}
                    </span>
                    <button
                      type="button"
                      className="studio-btn"
                      disabled={busy === 'planVideo' || !boardsReady}
                      title={boardsReady ? undefined : '先把分镜画好 —— 要拿它当首帧'}
                      onClick={() => void handlePlanVideo(stage)}
                    >
                      {busy === 'planVideo' ? '列清单中' : data.items.length > 0 ? '重列清单' : '列清单'}
                    </button>
                    <button
                      type="button"
                      className="studio-btn"
                      disabled={busy === 'pushVideo' || !data.items.some((i) => i.videoUrl && !i.nodeKey)}
                      onClick={() => void handlePushVideo(stage)}
                    >
                      {busy === 'pushVideo' ? '同步中' : '同步到画布'}
                    </button>
                  </div>

                  <div className="studio-field-row">
                    <label className="studio-field">
                      <span>分辨率</span>
                      <select
                        value={data.settings.resolution}
                        onChange={(e) => patchVideoStage(stage, {
                          settings: { ...data.settings, resolution: e.currentTarget.value },
                        })}
                      >
                        {STUDIO_VIDEO_RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </label>
                    <label className="studio-field">
                      <span>默认时长</span>
                      <select
                        value={data.settings.durationSec}
                        onChange={(e) => patchVideoStage(stage, {
                          settings: { ...data.settings, durationSec: Number(e.currentTarget.value) },
                        })}
                      >
                        {STUDIO_VIDEO_DURATIONS.map((d) => <option key={d} value={d}>{d} 秒</option>)}
                      </select>
                    </label>
                  </div>
                  <p className="studio-hint">
                    每一镜的实际时长跟分镜表那一镜走；上面这个只在分镜表的秒数不在可用档位时兜底。
                  </p>

                  {data.items.length === 0 ? (
                    <div className="studio-empty">
                      {boardsReady ? '点「列清单」，这一步不花钱。' : '先把分镜画好（第 3 步），它是视频的首帧。'}
                    </div>
                  ) : (
                    <>
                      <div className="studio-table-wrap">
                        <table className="studio-table">
                          <thead>
                            <tr>
                              <th style={{ width: 34 }}>
                                <input
                                  type="checkbox"
                                  title="全选 / 全不选"
                                  checked={picked.size > 0 && picked.size === data.items.length}
                                  onChange={(e) => setPickedVideos((cur) => ({
                                    ...cur,
                                    [stage]: e.currentTarget.checked
                                      ? new Set(data.items.map((i) => i.id))
                                      : new Set<string>(),
                                  }))}
                                />
                              </th>
                              <th style={{ width: 56 }}>镜号</th>
                              <th style={{ width: 62 }}>首帧</th>
                              <th>提示词</th>
                              <th style={{ width: 66 }}>时长</th>
                              <th style={{ width: 112 }}>结果</th>
                            </tr>
                          </thead>
                          <tbody>
                            {data.items.map((item) => (
                              <tr key={item.id} className={item.status === 'failed' ? 'is-failed' : undefined}>
                                <td>
                                  <input
                                    type="checkbox"
                                    checked={picked.has(item.id)}
                                    onChange={(e) => setPickedVideos((cur) => {
                                      const next = new Set(cur[stage])
                                      if (e.currentTarget.checked) next.add(item.id)
                                      else next.delete(item.id)
                                      return { ...cur, [stage]: next }
                                    })}
                                  />
                                </td>
                                <td><span className="studio-cell is-static">{item.shot}</span></td>
                                <td>
                                  {item.sourceImageUrl ? (
                                    <img
                                      className="studio-video-frame"
                                      src={item.sourceImageUrl}
                                      alt={'第 ' + item.shot + ' 镜首帧'}
                                      loading="lazy"
                                      title={item.endImageUrl ? '有首帧和尾帧（走首尾帧模式）' : '只有首帧'}
                                    />
                                  ) : (
                                    <span className="studio-muted" title="没有首帧图就是纯文生视频，角色会漂">无</span>
                                  )}
                                </td>
                                <td>
                                  <textarea
                                    className="studio-cell is-content"
                                    rows={2}
                                    value={item.prompt}
                                    onChange={(e) => patchVideoItem(stage, item.id, { prompt: e.currentTarget.value })}
                                  />
                                  {/* 文档「修改：面部 | pose | 局部画面 | 特效」——机制是改提示词再重做 */}
                                  <div className="studio-tweaks">
                                    {STUDIO_VIDEO_TWEAKS.map((tweak) => (
                                      <button
                                        key={tweak}
                                        type="button"
                                        className="studio-tweak"
                                        title={'在提示词末尾加一句「' + tweak + '：」，自己补上要改成什么'}
                                        onClick={() => patchVideoItem(stage, item.id, {
                                          prompt: item.prompt
                                            + (item.prompt && !item.prompt.endsWith('。') ? '。' : '')
                                            + tweak + '：',
                                        })}
                                      >
                                        {tweak}
                                      </button>
                                    ))}
                                  </div>
                                </td>
                                <td><span className="studio-cell is-static">{item.durationSec}s</span></td>
                                <td className="studio-concept-result">
                                  {item.videoUrl ? (
                                    <a
                                      href={item.videoUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      title={item.nodeKey ? '已在画布上' : '还没同步到画布'}
                                    >
                                      <video src={item.videoUrl} muted playsInline preload="metadata" />
                                      <em>{videoStatusLabel(item)}</em>
                                    </a>
                                  ) : item.status === 'running' ? (
                                    <span className="studio-muted" title="提交过了，正在生成 —— 结果会自动刷出来">
                                      <Loader2 size={12} className="studio-spin" /> 生成中
                                    </span>
                                  ) : item.status === 'failed' ? (
                                    <span className="studio-concept-failed" title={item.error}>失败</span>
                                  ) : (
                                    <span className="studio-concept-idle">未生成</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <div className="studio-actions">
                        <button
                          type="button"
                          className="studio-btn is-primary"
                          disabled={busy === 'renderVideo' || cost === 0}
                          onClick={() => void handleGenerateVideo(stage)}
                        >
                          {busy === 'renderVideo' ? '提交中' : '生成选中的（' + cost + ' 条）'}
                        </button>
                        <label
                          className="studio-concept-redraw"
                          title="默认只生成还没有视频的；勾上才会把已有的重做一遍（会重复花钱）"
                        >
                          <input
                            type="checkbox"
                            checked={videoRedraw[stage]}
                            onChange={(e) => setVideoRedraw((cur) => ({ ...cur, [stage]: e.currentTarget.checked }))}
                          />
                          重做已有的
                        </label>
                        <button
                          type="button"
                          className="studio-btn"
                          disabled={busy === 'save' || !dirty}
                          onClick={() => void handleSave()}
                        >
                          {dirty ? '保存修改' : '已保存'}
                        </button>
                      </div>
                      <p className="studio-hint">
                        一次最多提交 9 条。提交后可以关掉这个页面 ——
                        任务号已经存下来了，回来会自动把结果收回来，不会重复花钱。
                        {runningCount > 0 ? ' 正在生成的每 15 秒自动刷一次。' : ''}
                      </p>
                    </>
                  )}
                </section>
              )
            })}
          </main>
        )}

        {/* 资产库 / 共享空间：占布局的一条，不盖在内容上（跟画布上的停靠栏同一套样式） */}
        {assetDock ? (
          <div className="shotflow-asset-dock studio-asset-dock is-open">
            <FavoriteLibraryPanel
              mode={assetDock}
              onClose={() => setAssetDock(null)}
              onInsert={handleAssetPick}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}

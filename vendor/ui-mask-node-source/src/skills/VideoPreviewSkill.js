import { BaseNode } from '../node-editor/BaseNode.js';
import { mapBlend, mapDuplicateSource } from '../elements/VideoElement.js';

/** 秒 → mm:ss（剪辑软件习惯的时间码显示） */
function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Skill: 视频预览节点
 * 检查上游「转换后视频」复合对象：
 *   - 节点内嵌预览：游标驱动逐帧渲染转换效果（播放/暂停、可拖进度条、时间码、音量静音）
 *   - 节点下方信息区：文件名 / 分辨率·帧率·时长 / 转换模式
 *   - 输出端口「预览视频」：透传上游转换后视频复合对象，可直接接入「视频导出」等下游 skill
 *
 * 关键设计：预览使用「独立解码 video」（同一文件的独立 blob URL），所有 seek 都发生在
 * 独立元素上，绝不触碰视频卡片正在播放的源 video —— 预览与卡片互不干扰。
 */
export class VideoPreviewSkill extends BaseNode {
  static nodeId = 'video_preview';
  static nodeName = '视频预览';

  constructor(id, x, y) {
    super(id, 'video_preview', x, y);

    this.addInput('视频源', 'video');
    // 输出：预览视频（video 类型，透传上游复合对象，可接导出）
    this.addOutput('预览视频', 'video');

    this.previewHeight = 150;
    this.width = 320;

    this._canvas = null;
    this._infoArea = null;
    this._raf = null;
    this._ui = null;          // 控制条几何（供命中检测）
    this._scrubbing = false;  // 进度条拖动中
    // 播放器状态：真实播放（零 seek，流畅）+ 暂停时单次精确帧渲染（低频 seek）
    this._playing = false;    // 播放状态
    this._pendingRender = true; // 需要渲染一帧精确转换帧（初次/暂停/拖动后）
    // 独立解码 video（与源卡片 video 完全分离）
    this._previewVideo = null;
    this._previewSrcKey = null;
    this._onMove = null;
    this._onUp = null;
    this._resizeObserver = null;
  }

  getHeight() {
    return super.getHeight() + this.previewHeight + 16;
  }

  execute() {
    // 输出「预览视频」：透传上游转换后视频复合对象（供视频导出等下游使用）
    const stream = this.getInput('视频源');
    this.outputData = {
      '预览视频': stream || null
    };
  }

  /** 当前视频源复合对象 */
  _getStream() {
    return this.getInput('视频源');
  }

  /**
   * 获取/创建独立解码 video。
   * 同一视频文件复用同一元素；文件变化时重建。
   * @returns {HTMLVideoElement|null}
   */
  _getPreviewVideo() {
    const stream = this._getStream();
    if (!stream) return null;
    const srcFile = stream.sourceFile || stream.source?.sourceFile || stream.video?.sourceFile || null;
    const srcUrl = srcFile ? null : (stream.source?.src || stream.video?.src || null);
    // 源标识：文件用 name+size，无文件用 URL
    const key = srcFile ? `${srcFile.name}:${srcFile.size}` : (srcUrl || '');

    if (this._previewVideo && this._previewSrcKey === key) return this._previewVideo;

    // 释放旧元素
    if (this._previewVideo) {
      try { this._previewVideo.pause(); this._previewVideo.src = ''; } catch (e) { /* ignore */ }
      this._previewVideo = null;
    }

    let src = srcUrl;
    if (srcFile) src = URL.createObjectURL(srcFile);
    if (!src) return null;

    const v = document.createElement('video');
    v.src = src;
    v.muted = false;          // 默认开启声音：创作者需要在预览里听到转换后的效果
    v.volume = 1;
    v.playsInline = true;
    // 只预载元数据，不解码画面帧 —— 避免与视频素材卡片同时占用硬件解码器导致卡顿；
    // 仅真正播放/渲染帧时才按需解码（单视频解码，互不干扰）
    v.preload = 'metadata';
    v.loop = true;  // 循环播放：创作者预览时可以反复看效果，不用每次手动重播
    this._previewVideo = v;
    this._previewSrcKey = key;
    return v;
  }

  /**
   * 在独立 video 上渲染当前游标对应的帧（转换逻辑与 FpsConvertSkill 一致）。
   * 所有 seek 只发生在 _previewVideo 上，源卡片视频零干扰。
   */
  _renderPreviewFrame(ctx, stream, time) {
    const v = this._previewVideo;
    if (!v || !v.videoWidth) return;

    const width = v.videoWidth;
    const height = v.videoHeight;
    const targetFps = stream?.targetFps;
    const originalFps = stream?.originalFps || 24;
    const mode = stream?.mode || 'none';

    if (targetFps && (mode === 'duplicate' || mode === 'blend')) {
      // 转换帧渲染（3:2 帧复制 / 帧混合），seek 独立 video
      const targetFrameIndex = Math.max(0, Math.floor(time * targetFps + 1e-4));
      const duration = v.duration;
      const maxFrame = Number.isFinite(duration) && duration > 0
        ? Math.max(0, Math.round(duration * originalFps) - 1)
        : 0;
      const clamp = (index) => Math.max(0, Math.min(index, maxFrame));
      ctx.globalAlpha = 1;

      if (mode === 'blend') {
        const { frameIndex, alpha } = mapBlend(targetFrameIndex, originalFps, targetFps);
        const prevIdx = clamp(frameIndex);
        const nextIdx = clamp(frameIndex + 1);
        v.currentTime = prevIdx / originalFps;
        ctx.drawImage(v, 0, 0, width, height);
        if (alpha > 0 && nextIdx !== prevIdx) {
          v.currentTime = nextIdx / originalFps;
          ctx.globalAlpha = alpha;
          ctx.drawImage(v, 0, 0, width, height);
          ctx.globalAlpha = 1;
        }
      } else {
        const dupIndex = clamp(mapDuplicateSource(targetFrameIndex, originalFps, targetFps));
        v.currentTime = dupIndex / originalFps;
        ctx.drawImage(v, 0, 0, width, height);
      }
    } else {
      // 无转换：直接画独立 video 当前帧
      const dur = Number.isFinite(v.duration) ? v.duration : time;
      v.currentTime = Math.max(0, Math.min(time, dur));
      ctx.drawImage(v, 0, 0, width, height);
    }
  }

  /** 节点内嵌预览（原生video控制条）+ 下方信息区 */
  onRendered() {
    if (!this.element || this.element.querySelector('.fps-preview-canvas')) return;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._previewVideo?.pause();
    this._liveSourceKey = null;

    const tryMount = () => {
      const wrap = this.element.querySelector('.preview-wrap');
      if (!wrap) {
        requestAnimationFrame(tryMount);
        return;
      }

      // 清空wrap，改用原生video元素（带完整控制条：播放/暂停/进度/音量）
      wrap.innerHTML = '';
      wrap.style.height = 'auto';
      wrap.style.background = '#000';

      const video = document.createElement('video');
      video.className = 'fps-preview-canvas';
      video.controls = true;
      video.playsInline = true;
      video.loop = true;
      video.style.cssText = 'width:100%; display:block; background:#000;';
      wrap.appendChild(video);
      this._canvas = video;
      this._previewVideo = video;

      // 画布尺寸跟随容器
      const fit = () => {
        // 原生video自动适配宽度，不需要手动设置尺寸
      };
      fit();

      // 2) 信息区（端口区之前）：转换结果信息
      const info = document.createElement('div');
      info.className = 'video-preview-info';
      info.style.cssText = `
        margin: 8px 12px;
        padding: 6px 10px;
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.05);
        border-radius: 6px;
      `;
      const nameLine = document.createElement('div');
      nameLine.className = 'preview-name-line';
      nameLine.style.cssText = 'color:#ddd; font-size:11px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
      nameLine.textContent = '未连接视频源';
      const metaLine = document.createElement('div');
      metaLine.className = 'preview-meta-line';
      metaLine.style.cssText = 'color:#888; font-size:10px; margin-top:2px; font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
      metaLine.textContent = '请连接视频源';
      const modeLine = document.createElement('div');
      modeLine.className = 'preview-mode-line';
      modeLine.style.cssText = 'color:#7fdca0; font-size:10px; margin-top:2px; font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
      modeLine.textContent = '';
      info.appendChild(nameLine);
      info.appendChild(metaLine);
      info.appendChild(modeLine);

      const portArea = this.element.querySelector(':scope > div:last-child');
      if (portArea && portArea !== wrap) portArea.before(info);
      else wrap.after(info);
      this._infoArea = info;

      // 视频源在下方同步循环中加载，修复任务完成后也能自动切换。

      // 4) 信息区同步
      let lastMeta = '';
      let lastMode = '';
      let lastName = '';
      const tick = () => {
        const stream = this._getStream();
        const pv = this._previewVideo;
        const blocked = stream?.hudState && stream.hudState !== 'ready';
        const sourceFile = blocked ? null : stream?.sourceFile;
        const sourceUrl = blocked ? '' : (stream?.processedAsset?.url || stream?.video?.src || '');
        const sourceKey = sourceFile || sourceUrl;
        if (this._liveSourceKey !== sourceKey) {
          this._liveSourceKey = sourceKey;
          pv.pause();
          if (this._liveObjectUrl) URL.revokeObjectURL(this._liveObjectUrl);
          this._liveObjectUrl = sourceFile ? URL.createObjectURL(sourceFile) : null;
          if (this._liveObjectUrl || sourceUrl) pv.src = this._liveObjectUrl || sourceUrl;
          else { pv.removeAttribute('src'); pv.load(); }
        }

        if (!stream || blocked) {
          if (nameLine.textContent !== '未连接视频源') nameLine.textContent = '未连接视频源';
          metaLine.textContent = blocked ? (stream.message || '等待遮罩视频生成') : '请连接视频源';
          if (modeLine.textContent !== '') modeLine.textContent = '';
          lastMeta = ''; lastMode = ''; lastName = '';
        } else {
          const w = stream.videoWidth || pv?.videoWidth || 0;
          const h = stream.videoHeight || pv?.videoHeight || 0;
          const dur = Number.isFinite(stream.duration) ? stream.duration
            : Number.isFinite(pv?.duration) ? pv.duration : 0;
          const mm = Math.floor(dur / 60);
          const ss = Math.floor(dur % 60);
          const fps = stream.targetFps || stream.originalFps || 0;
          const modeLabel = stream.mode === 'blend' ? '帧混合（轻微模糊）'
            : stream.mode === 'duplicate' ? '帧复制（画质无损）'
            : '无转换';
          const isConverted = !!stream.targetFps;

          const fname = stream.sourceFile?.name || stream.processedAsset?.filename || (isConverted ? '转换后视频' : '源视频');
          if (nameLine.textContent !== fname) nameLine.textContent = fname;

          const fpsText = fps ? fps + 'fps' : '--';
          let meta = w + '×' + h + ' · ' + fpsText + ' · ' + mm + ':' + String(ss).padStart(2, '0');
          const audioInfo = stream?.audio;
          if (audioInfo && audioInfo.hasAudio) {
            const khz = audioInfo.samplerate ? ' ' + (audioInfo.samplerate / 1000).toFixed(1) + 'kHz' : '';
            const ch = audioInfo.channels ? ' ' + audioInfo.channels + 'ch' : '';
            meta += ' · 音轨✓' + khz + ch;
          } else if (audioInfo === null) {
            meta += ' · 无音轨';
          }
          if (lastMeta !== meta) {
            metaLine.textContent = meta;
            lastMeta = meta;
          }
          const mode = isConverted ? `转换模式：${modeLabel}` : `原始帧率：${stream.originalFps || 24}fps`;
          if (lastMode !== mode) {
            modeLine.textContent = mode;
            lastMode = mode;
          }
        }

        this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    };
    requestAnimationFrame(tryMount);
  }

  /** 节点被删除时释放：停止预览循环 + 释放独立 video */
  dispose() {
    if (this._liveObjectUrl) URL.revokeObjectURL(this._liveObjectUrl);
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    if (this._previewVideo) {
      try { this._previewVideo.pause(); this._previewVideo.src = ''; } catch (e) { /* ignore */ }
      this._previewVideo = null;
      this._previewSrcKey = null;
    }
    this._canvas = null;
    this._infoArea = null;
    this._ui = null;
  }
}

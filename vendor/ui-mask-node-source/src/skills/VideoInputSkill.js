import { BaseNode } from '../node-editor/BaseNode.js';
import { probeAudioTrack } from '../exporters/VideoFrameDecoder.js';
import { saveFile, getFile } from '../utils/db.js';
import { randomUUID } from '../utils/randomUUID.js';

/**
 * Skill: 视频输入（视频卡片 · 复合视频源）
 * 视频拖入后画面直接内嵌在这张卡片里播放（ComfyUI Load Video / LibTV 风格）。
 * 卡片只有一个输出端口「视频源」，位于卡片右边缘垂直居中；
 * 该端口输出一个「复合视频源对象」，把视频的所有内容封装在一起：
 *   { video, source, sourceFile, originalFps, resolution, duration, fpsConvertMode, renderFrameAtTime }
 * 下游节点（帧率转换 / 导出）从这一个端口取走全部信息，无需单独连接帧率/分辨率/时长。
 */
export class VideoInputSkill extends BaseNode {
  static nodeId = 'video_input'; // 固定身份证ID，永远不变
  static nodeName = '视频素材';

  constructor(id, x, y) {
    super(id, 'video_input', x, y);

    // 唯一输出端口：视频源（复合对象）
    this.addOutput('视频源', 'video');

    this.addParam('fileName', '当前文件', '未选择', 'text');
    this.addParam('originalFps', '原始帧率', 24, 'number');

    this.videoElement = null;
    this._videoFile = null;
    this.mediaKey = null;
    this.media = null;
    this._mediaSaving = false;
    this._mediaSaveError = false;
    this._mediaRestoreError = false;
    this._disposed = false;
    this._audioProbe = null; // 音轨探测结果：null=未探测/无音轨，对象=有音轨
    // 视频卡片：画面为主体
    this.baseHeight = 0;
    this.width = 320;
    this._videoSlot = null;
    this._nameLine = null;
    this._metaLine = null;
  }

  execute() {
    const v = this.videoElement;
    const fps = this.getParam('originalFps') || 24;
    if (!v || !v.videoWidth) {
      this.outputData = { '视频源': null };
      return;
    }

    const duration = v.duration || 0;
    const resolution = { w: v.videoWidth, h: v.videoHeight };
    const self = this;

    // 复合视频源对象：一个输出端口带走视频的全部内容
    this.outputData = {
      '视频源': {
        kind: 'video-source',
        video: v,
        source: v,                       // 兼容旧代码：FpsConvert/导出读 .source
        sourceFile: this._videoFile || v.sourceFile || null,
        originalFps: fps,
        fpsConvertMode: 'none',
        targetFps: null,
        resolution,
        duration,
        // 音轨信息（探测结果）：null=无音轨；{hasAudio,codec,samplerate,channels}=有音轨
        audio: this._audioProbe,
        get videoWidth() { return v.videoWidth; },
        get videoHeight() { return v.videoHeight; },
        // 统一渲染接口：下游节点（画布预览/导出）按时间取帧
        renderFrameAtTime(ctx, time) {
          if (!v || v.readyState < 2) return;
          const w = v.videoWidth;
          const h = v.videoHeight;
          if (!w || !h) return;
          const t = Math.max(0, Math.min(time, Number.isFinite(v.duration) ? v.duration : time));
          v.currentTime = t;
          ctx.drawImage(v, 0, 0, w, h);
        }
      }
    };
  }

  /**
   * @param {File} file
   * @param {HTMLVideoElement} [video] 已加载的 video 元素（InfiniteCanvas.loadVideo 创建）
   */
  async setVideoFile(file, video, { persist = true, reuseCanvasVideo = true } = {}) {
    this._videoFile = file;
    this._mediaRestoreError = false;
    this._mediaSaveError = false;
    this.media = { name: file.name, size: file.size, lastModified: file.lastModified };
    this.setParam('fileName', file.name);
    if (this._nameLine) {
      this._nameLine.textContent = file.name;
      this._nameLine.title = file.name;
    }
    const nameInput = this.element?.querySelector('[data-key="fileName"]');
    if (nameInput) nameInput.value = file.name;

    // File IDs survive node-code changes. Replacing a file keeps old backups usable.
    if (persist) {
      const mediaKey = `media_${randomUUID()}`;
      this.mediaKey = mediaKey;
      this._mediaSaving = true;
      window.editor?._scheduleSave?.();
      try { await saveFile(mediaKey, file); }
      catch (error) {
        if (this._videoFile === file) this._mediaSaveError = true;
        console.warn('素材保存失败，节点工作流仍保留', error);
      } finally {
        if (this._videoFile === file) this._mediaSaving = false;
        window.editor?._scheduleSave?.();
      }
    }
    if (this._disposed || this._videoFile !== file) return;

    let v = video || (reuseCanvasVideo ? window.infiniteCanvas?.currentVideo : null);
    if (v?.sourceFile !== file) {
      v = await openVideoFile(file);
    }
    if (this._disposed || this._videoFile !== file) {
      v.pause();
      if (v.src.startsWith('blob:')) URL.revokeObjectURL(v.src);
      return;
    }

    this.videoElement = v;
    this.executed = false;
    if (this._videoSlot) {
      this._mountVideo(v);
    }
    window.editor?.resetDownstream(this);
    window.editor?.onNodeChange?.(this);
    window.editor?._scheduleSave?.();

    // 音轨探测（只读 moov，快）：让创作者一眼知道源有没有声音，
    // 避免「导出来没声音」误以为是导出 bug——源没音轨导出必然无声。
    this._audioProbe = null;
    try {
      const buffer = await file.arrayBuffer();
      if (this._videoFile !== file) return; // 期间换了文件，丢弃过期结果
      const probe = await probeAudioTrack(buffer, fps => {
        if (!this._disposed && this._videoFile === file) v._hudSourceFps = fps;
      });
      if (this._videoFile !== file) return;
      this._audioProbe = probe; // null=无音轨；对象=有音轨（含采样率/声道）
      // 探测结果挂到 video 元素上，导出节点（同一实例）可直接读取提示用户
      if (v) v._audioProbe = probe;
    } catch (e) { /* 探测失败不阻断加载 */ }
  }

  /** 把 video 挂进卡片画面槽 */
  _mountVideo(v) {
    const slot = this._videoSlot;
    if (!slot) return;
    slot.innerHTML = '';
    v.controls = true; // 用原生控制条，稳定不bug
    v.style.cssText = 'width:100%; height:100%; object-fit:contain; display:block; background:#000;';
    slot.appendChild(v);
    v.pause();
  }

  /**
   * 渲染为「视频卡片」：
   * 画面内嵌 + 文件名/元数据 + 唯一输出端口（右边缘垂直居中）。
   */
  onRendered() {
    if (!this.element || this.element.querySelector('.video-card-slot')) return;
    const card = this.element;
    card.classList.add('video-card-node');

    // 1) 卡片整体样式
    card.style.width = this.width + 'px';
    card.style.minHeight = 'auto';
    card.style.background = 'rgba(24,24,42,0.97)';
    card.style.borderRadius = '10px';
    card.style.boxShadow = '0 8px 28px rgba(0,0,0,0.55)';
    card.style.border = '1px solid #3a3a58';
    card.style.overflow = 'visible'; // 端口突出到右边缘

    // 2) 视频画面主体
    const slot = document.createElement('div');
    slot.className = 'video-card-slot';
    slot.style.cssText = `
      position: relative;
      aspect-ratio: 16 / 9;
      background: #000;
      cursor: pointer;
      overflow: hidden;
    `;
    const playBadge = document.createElement('div');
    playBadge.className = 'video-card-badge';
    playBadge.textContent = '▶';
    playBadge.style.cssText = `
      position: absolute;
      left: 50%; top: 50%;
      transform: translate(-50%, -50%);
      width: 44px; height: 44px;
      border-radius: 50%;
      background: rgba(12,12,20,0.55);
      border: 2px solid rgba(255,255,255,0.7);
      color: #fff;
      font-size: 18px;
      display: none; /* 原生控制条自带播放按钮，不需要中间徽标 */
      align-items: center; justify-content: center;
      pointer-events: none;
      transition: opacity .2s;
    `;
    slot.appendChild(playBadge);

    slot.addEventListener('mousedown', (e) => e.stopPropagation());
    // 原生控制条自带播放/暂停/进度条/音量，不需要再自己处理点击事件

    // 3) 信息条：文件名 + 元数据（右端预留端口/加号操作区）
    const info = document.createElement('div');
    info.className = 'video-card-info';
    info.style.cssText = `
      position: relative;
      padding: 6px 40px 8px 12px;
      background: #2a2a46;
      border-top: 1px solid #3a3a58;
    `;
    const nameLine = document.createElement('div');
    nameLine.style.cssText = 'color:#fff; font-size:11px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
    nameLine.textContent = this.getParam('fileName') || '未选择视频';
    nameLine.title = nameLine.textContent;
    const metaLine = document.createElement('div');
    metaLine.className = 'video-card-meta';
    metaLine.style.cssText = 'color:#9aa; font-size:10px; margin-top:2px; font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
    metaLine.textContent = '等待视频…';
    info.appendChild(nameLine);
    info.appendChild(metaLine);

    // 替换文件按钮：放在节点顶部标题栏右侧（ComfyUI LoadVideo 风格）
    // header 是节点根元素的第一个子元素（「视频素材」标题栏）
    const header = this.element?.children?.[0];
    if (header) {
      const replaceBtn = document.createElement('button');
      replaceBtn.type = 'button';
      replaceBtn.className = 'replace-file-btn';
      replaceBtn.title = '替换素材文件';
      replaceBtn.setAttribute('aria-label', '替换素材文件');
      replaceBtn.style.cssText = `
        position: absolute;
        right: 10px;
        top: 50%;
        transform: translateY(-50%);
        height: 24px;
        padding: 0 10px;
        border: 0;
        border-radius: 5px;
        background: rgba(255,255,255,0.12);
        color: #ddd;
        font-family: inherit;
        font-size: 11px;
        font-weight: 600;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        z-index: 30;
        transition: background .15s;
      `;
      replaceBtn.textContent = '📁 替换';
      replaceBtn.addEventListener('mouseenter', () => {
        replaceBtn.style.background = 'rgba(74,144,226,0.6)';
        replaceBtn.style.color = '#fff';
      });
      replaceBtn.addEventListener('mouseleave', () => {
        replaceBtn.style.background = 'rgba(255,255,255,0.12)';
        replaceBtn.style.color = '#ddd';
      });
      // Stop the press before the title-bar drag handler can capture the pointer.
      // Keep the default button behavior so mouse, Enter and Space all open the picker.
      replaceBtn.addEventListener('pointerdown', e => e.stopPropagation());
      replaceBtn.addEventListener('mousedown', e => e.stopPropagation());
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'video/*';
      input.hidden = true;
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file || this._disposed) return;
        replaceBtn.disabled = true;
        replaceBtn.textContent = '⏳ 加载中';
        try {
          await this.setVideoFile(file);
        } catch (err) {
          alert('替换视频失败：' + err.message);
        } finally {
          replaceBtn.disabled = false;
          replaceBtn.textContent = '📁 替换';
        }
      });
      replaceBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (this._disposed || replaceBtn.disabled) return;
        input.value = ''; // Choosing the same file again must still fire change.
        input.click(); // Synchronous user activation is required by the browser.
      });
      // header 需要 relative 定位，按钮才能绝对定位在右上角
      header.style.position = 'relative';
      header.appendChild(replaceBtn);
      header.appendChild(input);
    }

    // 4) 隐藏原生参数行
    card.querySelectorAll('[data-key]').forEach((el) => {
      const row = el.closest('div');
      if (row) row.style.display = 'none';
    });

    // 5) 输出端操作区：唯一「视频源」端口 + 加号（工作流串联入口）
    //    位置：信息条右端垂直中线（半埋式贴在卡片右边缘，完全不挡画面）
    const portArea = card.lastElementChild; // renderNode 生成的端口区
    const dots = card.querySelectorAll('.output-port');
    // 移除所有原生端口行（避免与自绘端口在 DOM 顺序上混淆连线定位）
    for (const dot of Array.from(dots)) {
      const row = dot.closest('div');
      if (row) row.remove();
    }

    // 加号按钮：hover 变蓝 → 弹 skill 菜单（帧率转换/视频导出）→ 自动建节点连线
    const plusBtn = document.createElement('div');
    plusBtn.className = 'add-node-btn';
    plusBtn.dataset.portIndex = '0';
    plusBtn.textContent = '+';
    plusBtn.title = '添加处理节点（帧率转换 / 视频导出）';
    plusBtn.style.cssText = `
      position: absolute;
      right: 18px;
      top: 50%;
      transform: translateY(-50%);
      width: 18px; height: 18px;
      border-radius: 50%;
      background: #3a3a5a;
      color: #fff;
      font-size: 14px; line-height: 16px;
      text-align: center;
      cursor: pointer;
      border: 1px solid #555;
      font-weight: bold;
      z-index: 30;
      transition: background .15s, transform .15s, box-shadow .15s;
    `;
    plusBtn.addEventListener('mouseenter', () => {
      plusBtn.style.background = '#4a90e2';
      plusBtn.style.transform = 'translateY(-50%) scale(1.15)';
      plusBtn.style.boxShadow = '0 0 8px rgba(74,144,226,0.6)';
    });
    plusBtn.addEventListener('mouseleave', () => {
      plusBtn.style.background = '#3a3a5a';
      plusBtn.style.transform = 'translateY(-50%) scale(1)';
      plusBtn.style.boxShadow = 'none';
    });
    plusBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    plusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const editor = window.editor;
      if (editor) editor.showSkillMenu(this, 0, plusBtn);
    });

    // 输出端口：半埋式绿点（视频类型色，与连线同色=类型安全），hover 放大发光
    const outPort = document.createElement('div');
    outPort.className = 'port output-port video-card-out-port';
    outPort.dataset.portIndex = '0';
    outPort.dataset.portType = 'output';
    outPort.title = '视频源（复合：视频+帧率+分辨率+时长）';
    outPort.style.cssText = `
      position: absolute;
      right: -7px;
      top: 50%;
      transform: translateY(-50%);
      width: 15px; height: 15px;
      border-radius: 50%;
      background: #50c878;
      border: 3px solid #1e1e2e;
      box-shadow: 0 0 0 1.5px rgba(127,220,160,0.9), 0 2px 6px rgba(0,0,0,0.4);
      cursor: crosshair;
      z-index: 30;
      transition: transform .15s, box-shadow .15s;
    `;
    outPort.addEventListener('mouseenter', () => {
      outPort.style.transform = 'translateY(-50%) scale(1.3)';
      outPort.style.boxShadow = '0 0 0 1.5px rgba(127,220,160,0.9), 0 0 12px rgba(80,200,120,0.7)';
    });
    outPort.addEventListener('mouseleave', () => {
      outPort.style.transform = 'translateY(-50%) scale(1)';
      outPort.style.boxShadow = '0 0 0 1.5px rgba(127,220,160,0.9), 0 2px 6px rgba(0,0,0,0.4)';
    });
    // 复用编辑器连线：从该端口拖出（index 0 对应「视频源」输出）
    outPort.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const editor = window.editor;
      if (editor) editor.startWireDrag(this, 0, e);
    });
    info.appendChild(plusBtn);
    info.appendChild(outPort);

    // 6) 组装：画面 → 信息条（端口/加号绝对定位在信息条内，不占布局）
    if (portArea) {
      card.insertBefore(slot, portArea);
      card.insertBefore(info, portArea);
      portArea.style.display = 'none'; // 原生端口区隐藏（用自绘端口）
    } else {
      card.appendChild(slot);
      card.appendChild(info);
    }

    this._videoSlot = slot;
    this._nameLine = nameLine;
    this._metaLine = metaLine;

    // 7) RAF：元数据 + 播放徽标同步
    const tick = () => {
      if (this._disposed) return;
      const v = this.videoElement;
      if (v?.videoWidth) {
        const dur = Number.isFinite(v.duration) ? v.duration : 0;
        const mm = Math.floor(dur / 60);
        const ss = Math.floor(dur % 60);
        const fps = this.getParam('originalFps') || 24;
        let text = `${v.videoWidth}×${v.videoHeight} · ${fps}fps · ${mm}:${String(ss).padStart(2, '0')}`;
        // 音轨状态：源有声/无声一目了然（探测完成后显示）
        if (this._audioProbe) {
          const khz = this._audioProbe.samplerate ? `${(this._audioProbe.samplerate / 1000).toFixed(1)}kHz` : '';
          const ch = this._audioProbe.channels ? `${this._audioProbe.channels}ch` : '';
          text += ` · 音轨✓${khz ? ' ' + khz : ''}${ch ? ' ' + ch : ''}`;
        } else if (this._audioProbe === null && this._videoFile) {
          // 已探测完成且确实无音轨
          text += ' · 无音轨（导出无声）';
        }
        if (this._mediaSaving) text += ' · 素材保存中';
        else if (this._mediaSaveError) text += ' · 素材未保存，请重新替换';
        if (metaLine.textContent !== text) metaLine.textContent = text;
        playBadge.style.opacity = v.paused ? '1' : '0';
        if (!slot.querySelector('video') && this.videoElement) {
          this._mountVideo(this.videoElement);
        }
      } else {
        metaLine.textContent = this._mediaRestoreError
          ? '素材未找到，请用“替换”重新关联原片（连线已保留）'
          : this.mediaKey ? '正在恢复素材…' : '等待视频…';
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // 自动从本地IndexedDB恢复之前存的视频文件，刷新后不用重新选
    (async () => {
      const key = this.mediaKey;
      if (!key || this._videoFile) return;
      try {
        const savedFile = await getFile(key);
        if (this._disposed || this._videoFile || this.mediaKey !== key) return;
        if (!savedFile) throw new Error('本机缓存中未找到该素材');
        if (!this.media && this.getParam('fileName') !== '未选择' && savedFile.name !== this.getParam('fileName')) {
          throw new Error('旧版素材缓存与文件名不匹配');
        }
        if (this.media && (savedFile.name !== this.media.name || savedFile.size !== this.media.size
          || savedFile.lastModified !== this.media.lastModified)) throw new Error('素材缓存与工作流记录不匹配');
        await this.setVideoFile(savedFile, null, { persist: false });
      } catch (e) {
        if (this._disposed || this._videoFile || this.mediaKey !== key) return;
        this._mediaRestoreError = true;
        console.warn('恢复本地视频失败', e);
        window.editor?._scheduleSave?.();
      }
    })();
  }

  /** 节点被删除时释放资源：停止视频播放 */
  dispose() {
    this._disposed = true;
    const v = this.videoElement;
    if (v) {
      const sourceUrl = v.getAttribute('src');
      try { v.pause(); } catch (e) { /* ignore */ }
      try { v.removeAttribute('src'); v.load(); } catch (e) { /* ignore */ }
      if (sourceUrl?.startsWith('blob:')) URL.revokeObjectURL(sourceUrl);
    }
    this.videoElement = null;
    this._videoSlot = null;
    this._nameLine = null;
  }

  getSourceFile() {
    return this._videoFile;
  }
}

function openVideoFile(file) {
  // 文件为空就直接返回空video，不要报错
  if (!file) {
    const emptyVideo = document.createElement('video');
    return Promise.resolve(emptyVideo);
  }
  const video = document.createElement('video');
  video.src = URL.createObjectURL(file);
  video.muted = false; // 带声音播放
  video.playsInline = true;
  video.preload = 'auto';
  video.sourceFile = file;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled || !video.videoWidth) return;
      settled = true;
      resolve(video);
    };
    video.onloadedmetadata = finish;
    video.onloadeddata = finish;
    video.onerror = () => {
      if (settled) return;
      settled = true;
      // 视频加载失败也resolve空video，不报错
      resolve(video);
    };
  });
}

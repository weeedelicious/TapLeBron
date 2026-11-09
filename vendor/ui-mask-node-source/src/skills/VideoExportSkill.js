import { BaseNode } from '../node-editor/BaseNode.js';
import { VideoElement } from '../elements/VideoElement.js';
import { VideoExporter } from '../exporters/VideoExporter.js';
import { demuxAudio } from '../exporters/VideoFrameDecoder.js';
import { videoSourceFile as hudSourceFile } from '../utils/LocalVideo.js';

/**
 * Skill: 视频导出节点
 * 节点底部的按钮写出 30fps 标准 MP4。
 */
export class VideoExportSkill extends BaseNode {
  static nodeId = 'video_export';
  static nodeName = '视频导出';

  /**
   * 创作者常用导出格式（调研自 CapCut / Premiere / 2025-2026 格式指南）：
   * - mp4：通用之王，全平台兼容，平台默认格式（当前引擎完整支持）
   * - mov：苹果生态 + 专业剪辑常用（当前引擎以 QuickTime brand 封装支持）
   * - webm：网页播放优化（即将支持，需要 VP9 编码器）
   * - mkv：高清存档 / 多音轨字幕（即将支持，需要 Matroska 封装）
   */
  static FORMATS = [
    { value: 'mp4', label: 'MP4', ext: '.mp4', desc: '通用最佳 · 全平台兼容（推荐）', mime: 'video/mp4', supported: true },
    { value: 'mov', label: 'MOV', ext: '.mov', desc: '苹果生态 · 专业剪辑', mime: 'video/quicktime', supported: true },
    { value: 'webm', label: 'WebM', ext: '.webm', desc: '网页播放优化（即将支持）', mime: 'video/webm', supported: false },
    { value: 'mkv', label: 'MKV', ext: '.mkv', desc: '高清存档 · 多轨字幕（即将支持）', mime: 'video/x-matroska', supported: false }
  ];

  constructor(id, x, y) {
    super(id, 'video_export', x, y);

    this.addInput('视频源', 'video');
    // 目标帧率/模式等信息均从「视频源」复合对象继承，不再单独开端口

    this.addParam('bitrate', '比特率(Mbps，0=自动)', 0, 'number');
    // 文件名只存「主体」，后缀由格式选择器单独控制
    this.addParam('filename', '输出文件名', 'converted_30fps', 'text');
    this.addParam('format', '输出格式', 'mp4', 'text');

    this._exporter = new VideoExporter();
    this._exporting = false;
    this.exportBtn = null;
    this.progressTip = null;
    this.pathTip = null;
    this._dirHandle = null;
    this._dirName = '';
    /** 本地后端写入的完整绝对路径（如 D:\Temp\AI_输出测试），优先于仅目录名 */
    this._dirPath = '';
    this._backendChecked = false;
    this._backendOk = false;
    this._pickDirInFlight = false;
  }

  /**
   * 探测本地写盘后端（Vite dev server 中间件）是否可用。
   * 浏览器环境无法静默写任意磁盘路径，只有本地后端能真正写到用户指定盘符。
   * @returns {Promise<boolean>}
   */
  /**
   * 探测本地写盘后端（/api/health）。
   * - 只认「JSON + ok:true」；SPA fallback 返回的 HTML 视为后端不可用；
   * - 失败不永久缓存：每次关键操作前可强制重探，避免旧进程/未就绪的误判。
   * @param {boolean} force 强制重新探测（默认复用已成功的结果）
   */
  async isBackendAvailable(force = false) {
    if (this._backendOk && !force) return true;
    const probe = async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        const res = await fetch('/api/health', { signal: controller.signal });
        clearTimeout(timer);
        const ct = res.headers.get('content-type') || '';
        if (!res.ok || !ct.includes('json')) return false;
        const data = await res.json();
        return !!(data && data.ok);
      } catch {
        return false;
      }
    };
    this._backendOk = await probe();
    if (!this._backendOk) {
      // dev server 刚重启的 1-2 秒内 health 可能还没就绪：重试一次再判定，
      // 避免把「刚重启」误判成「后端不可用」而降级
      await new Promise((resolve) => setTimeout(resolve, 800));
      this._backendOk = await probe();
    }
    return this._backendOk;
  }

  /** 完整文件名 = 主体 + 所选格式后缀 */
  getFullFilename() {
    const base = this.getParam('filename') || 'converted_30fps';
    const fmt = VideoExportSkill.FORMATS.find((f) => f.value === this.getParam('format')) || VideoExportSkill.FORMATS[0];
    return base + fmt.ext;
  }

  execute() {
    this.outputData = { ready: this._exporter.supported };
  }

  onRendered() {
    if (!this.element || this.exportBtn) return;

    const btnWrap = document.createElement('div');
    btnWrap.style.cssText = 'padding: 0 14px 12px;';

    this.exportBtn = document.createElement('button');
    this.exportBtn.type = 'button';
    this.exportBtn.textContent = '执行导出';
    this.exportBtn.style.cssText = `
      width: 100%;
      padding: 8px;
      background: #50c878;
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
    `;
    this.exportBtn.addEventListener('mouseenter', () => {
      if (!this.exportBtn.disabled) this.exportBtn.style.background = '#45b06a';
    });
    this.exportBtn.addEventListener('mouseleave', () => {
      this.exportBtn.style.background = '#50c878';
    });
    this.exportBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    this.exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.doExport();
    });

    this.progressTip = document.createElement('div');
    this.progressTip.style.cssText = 'margin-top: 6px; font-size: 11px; color: #aaa; text-align: center; min-height: 14px;';

    this.pathTip = document.createElement('div');
    this.pathTip.style.cssText = `
      margin-top: 4px;
      font-size: 12px;
      font-weight: 600;
      color: #6ab0ff;
      text-align: center;
      min-height: 16px;
      word-break: break-all;
      line-height: 1.5;
    `;
    this.refreshPathTip();

    const dirRow = document.createElement('div');
    dirRow.style.cssText = 'display:flex; align-items:center; justify-content:center; gap:6px; margin-top: 8px;';
    const dirLabel = document.createElement('span');
    dirLabel.style.cssText = 'font-size: 11px; color: #aaa; flex-shrink: 0;';
    dirLabel.textContent = '输出位置';
    dirLabel.title = '可点击「选择目录」用系统对话框选择，也可直接在上方输入框手动填写目录路径';
    const dirInput = document.createElement('input');
    dirInput.type = 'text';
    dirInput.value = this._dirPath || this._dirName || '';
    dirInput.placeholder = '点击按钮选择，或输入完整路径（含盘符，如 D:\\输出目录）';
    dirInput.style.cssText = `
      flex: 1;
      min-width: 0;
      width: 100%;
      padding: 5px 8px;
      background: #2a2a3a;
      border: 1px solid #444;
      border-radius: 4px;
      color: #fff;
      font-size: 11px;
      outline: none;
    `;
    // 输入框悬停显示完整路径（长路径在窄框内截断，title 补全）
    const syncInputTitle = () => {
      dirInput.title = (this._dirPath || this._dirName || '')
        ? `输出目录：${this._dirPath || this._dirName}（悬停查看完整路径）`
        : '点击按钮选择，或输入完整路径（含盘符）';
    };
    syncInputTitle();
    dirInput.addEventListener('mousedown', (e) => e.stopPropagation());
    dirInput.addEventListener('input', (e) => {
      // 手动输入路径同样实时生效。
      // 若输入的是完整绝对路径（含盘符或斜杠），视为本地后端可写路径；
      // 否则仅作为目录名展示（拿不到写权限，导出时弹保存框）。
      const value = e.target.value.trim();
      this._dirHandle = null;
      this._dirName = value;
      const isFullPath = /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\');
      this._dirPath = isFullPath ? value : '';
      if (!isFullPath && value && this.pathTip) {
        this.pathTip.textContent = '当前输入未包含盘符（如 D:\\），导出时将弹系统保存框确认位置';
        this.pathTip.style.color = '#ffb84d';
        setTimeout(() => this.refreshPathTip(), 2200);
      } else {
        this.refreshPathTip();
      }
      syncInputTitle();
    });
    const dirBtn = document.createElement('button');
    dirBtn.type = 'button';
    dirBtn.textContent = this._dirName ? '重新选择' : '选择目录';
    dirBtn.style.cssText = `
      flex-shrink: 0;
      padding: 6px 8px;
      background: #2a2a3a;
      color: #fff;
      border: 1px solid #444;
      border-radius: 6px;
      cursor: pointer;
      font-size: 11px;
      text-align: center;
    `;
    dirBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    dirBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.pickOutputDir(dirBtn, dirInput);
    });

    dirRow.appendChild(dirLabel);
    dirRow.appendChild(dirInput);
    dirRow.appendChild(dirBtn);

    btnWrap.appendChild(this.exportBtn);
    btnWrap.appendChild(this.progressTip);
    btnWrap.appendChild(this.pathTip);
    btnWrap.appendChild(dirRow);
    this.element.appendChild(btnWrap);

    // ── 导出按钮状态实时联动：视频源连接状态一眼可见 ──
    // 连线变化不会触发节点重渲染，用 400ms 轻量轮询驱动按钮文案/颜色，
    // 未连视频源时按钮变红并写明缺什么，杜绝「点导出没反应/被弹窗关闭」。
    this._syncBtnTimer = setInterval(() => this._syncExportBtnState(), 400);
    this._syncExportBtnState();

    // ── 文件名编辑区：主体与格式分离，点主体弹大编辑弹窗 ──
    // 隐藏 NodeEditor 渲染的原始单行输入框（它把名字和后缀混在一起）
    const originalFilenameInput = this.element.querySelector('[data-key="filename"]');
    if (originalFilenameInput) {
      // 隐藏「输出格式」参数的原始文本框行，格式由格式按钮接管
      const originalFormatInput = this.element.querySelector('[data-key="format"]');
      if (originalFormatInput) {
        const fmtRow = originalFormatInput.closest('div');
        if (fmtRow) fmtRow.style.display = 'none';
      }
      originalFilenameInput.style.display = 'none';
      const filenameRow = originalFilenameInput.closest('div');
      const filenameLabel = filenameRow?.querySelector('span');
      if (filenameLabel) filenameLabel.textContent = '输出文件名';

      // 文件名主体按钮（点击弹出大编辑弹窗）
      const nameBtn = document.createElement('button');
      nameBtn.type = 'button';
      nameBtn.textContent = this.getParam('filename') || 'converted_30fps';
      nameBtn.title = '点击编辑文件名（大弹窗）';
      nameBtn.style.cssText = `
        flex: 1;
        min-width: 0;
        padding: 6px 8px;
        background: #2a2a3a;
        color: #fff;
        border: 1px solid #444;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        text-align: left;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      `;
      nameBtn.addEventListener('mousedown', (e) => e.stopPropagation());
      nameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openFilenameModal(nameBtn);
      });
      filenameRow.appendChild(nameBtn);

      // 格式选择按钮（点击弹出格式菜单）
      const fmtBtn = document.createElement('button');
      fmtBtn.type = 'button';
      fmtBtn.dataset.role = 'fmt-btn';
      const currentFmt = VideoExportSkill.FORMATS.find((f) => f.value === this.getParam('format')) || VideoExportSkill.FORMATS[0];
      fmtBtn.textContent = currentFmt.ext;
      fmtBtn.title = '选择导出格式';
      fmtBtn.style.cssText = `
        flex-shrink: 0;
        padding: 6px 10px;
        background: #2a2a3a;
        color: #8fd0ff;
        border: 1px solid #444;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        text-align: center;
      `;
      fmtBtn.addEventListener('mousedown', (e) => e.stopPropagation());
      fmtBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openFormatMenu(fmtBtn);
      });
      filenameRow.appendChild(fmtBtn);
      this._fmtBtn = fmtBtn;
      this._nameBtn = nameBtn;
    }

    this.refreshPathTip();
  }

  /**
   * 打开「大弹窗」编辑文件名主体 + 选择格式。
   * 弹窗居中、输入框大、格式选项带说明，符合创作者导出面板习惯。
   */
  openFilenameModal(nameBtn) {
    if (this._filenameModal) this.closeFilenameModal();

    const fmt = VideoExportSkill.FORMATS.find((f) => f.value === this.getParam('format')) || VideoExportSkill.FORMATS[0];

    const overlay = document.createElement('div');
    overlay.className = 'filename-modal-overlay';
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
    `;

    const modal = document.createElement('div');
    modal.className = 'filename-modal';
    modal.style.cssText = `
      width: min(440px, calc(100vw - 48px));
      background: #1e1e2e;
      border: 1px solid #3a3a4e;
      border-radius: 14px;
      padding: 22px;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
      color: #fff;
      font-family: system-ui, sans-serif;
    `;

    const title = document.createElement('div');
    title.textContent = '输出文件名';
    title.style.cssText = 'font-size: 16px; font-weight: 700; margin-bottom: 16px;';

    // 文件名主体大输入框
    const inputLabel = document.createElement('div');
    inputLabel.textContent = '文件名';
    inputLabel.style.cssText = 'font-size: 12px; color: #aaa; margin-bottom: 6px;';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = this.getParam('filename') || 'converted_30fps';
    nameInput.style.cssText = `
      width: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      background: #12121d;
      border: 1px solid #444;
      border-radius: 8px;
      color: #fff;
      font-size: 16px;
      outline: none;
      margin-bottom: 14px;
    `;
    nameInput.addEventListener('mousedown', (e) => e.stopPropagation());
    // 弹窗内暂存格式选择，点「确定」才真正提交（取消则回滚）
    let pendingFmt = fmt.value;
    // 弹窗内实时预览：改文件名时下方路径跟着变（格式取弹窗暂存值）
    nameInput.addEventListener('input', () => {
      this.refreshPathTip(nameInput.value.trim(), pendingFmt);
    });

    // 格式选择区
    const fmtLabel = document.createElement('div');
    fmtLabel.textContent = '导出格式';
    fmtLabel.style.cssText = 'font-size: 12px; color: #aaa; margin-bottom: 8px;';
    const fmtGrid = document.createElement('div');
    fmtGrid.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 18px;';

    const fmtButtons = [];
    for (const option of VideoExportSkill.FORMATS) {
      const card = document.createElement('button');
      card.type = 'button';
      card.style.cssText = `
        padding: 10px 12px;
        background: ${option.value === fmt.value ? '#2b4a6e' : '#2a2a3a'};
        border: 1px solid ${option.value === fmt.value ? '#4a90e2' : '#444'};
        border-radius: 8px;
        color: #fff;
        text-align: left;
        cursor: ${option.supported ? 'pointer' : 'not-allowed'};
        opacity: ${option.supported ? 1 : 0.55};
        font-size: 12px;
        line-height: 1.5;
      `;
      const nameLine = document.createElement('div');
      nameLine.textContent = `${option.label} ${option.ext}`;
      nameLine.style.cssText = 'font-weight: 700; font-size: 13px;';
      const descLine = document.createElement('div');
      descLine.textContent = option.desc;
      descLine.style.cssText = 'color: #bbb; font-size: 11px; margin-top: 2px;';
      card.appendChild(nameLine);
      card.appendChild(descLine);
      card.addEventListener('mousedown', (e) => e.stopPropagation());
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!option.supported) {
          alert(`「${option.label}」格式即将支持（需 ${option.value === 'webm' ? 'VP9 编码器' : 'Matroska 封装器'}），当前请选择 MP4 或 MOV`);
          return;
        }
        // 仅更新弹窗内选中态与路径预览，不落参数
        pendingFmt = option.value;
        for (let i = 0; i < fmtButtons.length; i++) {
          const isActive = VideoExportSkill.FORMATS[i].value === option.value;
          fmtButtons[i].style.background = isActive ? '#2b4a6e' : '#2a2a3a';
          fmtButtons[i].style.borderColor = isActive ? '#4a90e2' : '#444';
        }
        this.refreshPathTip(nameInput.value.trim(), pendingFmt);
      });
      fmtGrid.appendChild(card);
      fmtButtons.push(card);
    }

    // 底部按钮
    const footer = document.createElement('div');
    footer.style.cssText = 'display: flex; justify-content: flex-end; gap: 10px;';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = '取消';
    cancelBtn.style.cssText = `
      padding: 8px 18px;
      background: #2a2a3a;
      color: #ccc;
      border: 1px solid #444;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
    `;
    cancelBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeFilenameModal();
    });
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.textContent = '确定';
    okBtn.style.cssText = `
      padding: 8px 22px;
      background: #4a90e2;
      color: #fff;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
    `;
    okBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    okBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const value = nameInput.value.trim();
      if (!value) {
        alert('文件名不能为空');
        return;
      }
      this.setParam('filename', value);
      this.setParam('format', pendingFmt);
      if (nameBtn) nameBtn.textContent = value;
      if (this._fmtBtn) {
        const f = VideoExportSkill.FORMATS.find((o) => o.value === pendingFmt) || VideoExportSkill.FORMATS[0];
        this._fmtBtn.textContent = f.ext;
      }
      this.refreshPathTip();
      this.closeFilenameModal();
    });

    footer.appendChild(cancelBtn);
    footer.appendChild(okBtn);

    modal.appendChild(title);
    modal.appendChild(inputLabel);
    modal.appendChild(nameInput);
    modal.appendChild(fmtLabel);
    modal.appendChild(fmtGrid);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // 点击遮罩空白处关闭；Esc 关闭
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) this.closeFilenameModal();
    });
    const onKey = (e) => {
      if (e.key === 'Escape') this.closeFilenameModal();
    };
    document.addEventListener('keydown', onKey);

    this._filenameModal = overlay;
    this._filenameModalKeyHandler = onKey;
    this._filenameInput = nameInput;
    setTimeout(() => {
      nameInput.focus();
      nameInput.select();
    }, 30);
  }

  closeFilenameModal() {
    if (!this._filenameModal) return;
    this._filenameModal.remove();
    this._filenameModal = null;
    if (this._filenameModalKeyHandler) {
      document.removeEventListener('keydown', this._filenameModalKeyHandler);
      this._filenameModalKeyHandler = null;
    }
  }

  /**
   * 打开格式小菜单（节点内格式按钮点击）。
   */
  openFormatMenu(fmtBtn) {
    this.closeFormatMenu();
    const rect = fmtBtn.getBoundingClientRect();

    const menu = document.createElement('div');
    menu.className = 'fmt-menu';
    menu.style.cssText = `
      position: fixed;
      left: ${rect.left}px;
      top: ${rect.bottom + 4}px;
      min-width: 220px;
      background: #24243a;
      border: 1px solid #3a3a4e;
      border-radius: 10px;
      padding: 6px;
      z-index: 10000;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    `;

    for (const option of VideoExportSkill.FORMATS) {
      const item = document.createElement('button');
      item.type = 'button';
      item.style.cssText = `
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 10px;
        background: transparent;
        border: none;
        border-radius: 6px;
        color: #fff;
        cursor: ${option.supported ? 'pointer' : 'not-allowed'};
        opacity: ${option.supported ? 1 : 0.55};
        font-size: 12px;
        text-align: left;
      `;
      item.addEventListener('mouseenter', () => {
        if (option.supported) item.style.background = '#2e2e46';
      });
      item.addEventListener('mouseleave', () => {
        item.style.background = 'transparent';
      });
      item.addEventListener('mousedown', (e) => e.stopPropagation());
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!option.supported) {
          alert(`「${option.label}」格式即将支持，当前请选择 MP4 或 MOV`);
          return;
        }
        this.setParam('format', option.value);
        if (fmtBtn) fmtBtn.textContent = option.ext;
        this.refreshPathTip();
        this.closeFormatMenu();
      });

      const left = document.createElement('span');
      left.textContent = `${option.label} ${option.ext}`;
      left.style.cssText = 'font-weight: 600;';
      const right = document.createElement('span');
      right.textContent = option.desc;
      right.style.cssText = 'color: #bbb; font-size: 11px;';
      item.appendChild(left);
      item.appendChild(right);
      menu.appendChild(item);
    }

    document.body.appendChild(menu);
    this._fmtMenu = menu;
    this._fmtMenuCleanup = () => this.closeFormatMenu();
    setTimeout(() => {
      document.addEventListener('mousedown', this._fmtMenuCleanup);
    }, 10);
  }

  closeFormatMenu() {
    if (this._fmtMenuCleanup) {
      document.removeEventListener('mousedown', this._fmtMenuCleanup);
      this._fmtMenuCleanup = null;
    }
    this._fmtMenu?.remove();
    this._fmtMenu = null;
  }

  /**
   * 导出按钮状态与「视频源」连接实时同步：
   * 未连接 → 红色「⚠ 未连接视频源」（title 写明连线步骤）
   * 已连接 → 绿色「执行导出」
   * 节点被移除时自动停止轮询。
   */
  _syncExportBtnState() {
    if (!this.element || !this.element.isConnected || !this.exportBtn) {
      if (this._syncBtnTimer) {
        clearInterval(this._syncBtnTimer);
        this._syncBtnTimer = null;
      }
      return;
    }
    let hasSource;
    try {
      hasSource = !!this.getInput('视频源');
    } catch (error) {
      this._btnSourceOk = null;
      this.exportBtn.textContent = '⚠ 视频源状态异常';
      this.exportBtn.style.background = '#c0392b';
      this.exportBtn.title = error.message || '无法读取上游视频';
      return;
    }
    if (hasSource === this._btnSourceOk) return; // 状态未变不重绘
    this._btnSourceOk = !!hasSource;
    if (hasSource) {
      this.exportBtn.textContent = '执行导出';
      this.exportBtn.style.background = '#50c878';
      this.exportBtn.title = '点击开始转码并导出 MP4（先确认输出目录已选）';
    } else {
      this.exportBtn.textContent = '⚠ 未连接视频源';
      this.exportBtn.style.background = '#c0392b';
      this.exportBtn.title = '步骤：1) 把视频文件拖到画布生成视频卡片；2) 从卡片右侧绿点拖线连到本节点「视频源」输入端口；3) 按钮变绿后点导出';
    }
  }

  /**
   * 刷新节点下方显示的输出路径：
   * - 已选完整路径：绿色显示真实盘符落点（如 D:\Temp\AI_输出测试\xxx.mp4）；
   * - 仅目录名（无盘符）：橙色警告，明确"导出时将弹系统保存框确认位置"；
   * - 未选目录：蓝色提示。
   * @param {string} [baseOverride] 文件名主体的实时值，优先于参数里的旧值
   * @param {string} [fmtValueOverride] 格式的临时预览值（弹窗内未提交时用）
   */
  refreshPathTip(baseOverride, fmtValueOverride) {
    if (!this.pathTip) return;
    const base = baseOverride ?? this.getParam('filename') ?? 'converted_30fps';
    const fmt = VideoExportSkill.FORMATS.find((f) => f.value === (fmtValueOverride ?? this.getParam('format'))) || VideoExportSkill.FORMATS[0];
    const filename = base + fmt.ext;
    if (this._dirPath) {
      // 本地后端拿到完整绝对路径：显示真实盘符落点（如 D:\Temp\AI_输出测试\xxx.mp4）
      this.pathTip.textContent = `输出路径：${this._dirPath}\\${filename}`;
      this.pathTip.style.color = '#50c878';
      this.pathTip.title = `${this._dirPath}\\${filename}`;
    } else if (this._dirHandle) {
      // File System Access API 选的目录：有句柄可直接写入，显示绿色正常状态
      this.pathTip.textContent = `输出目录：${this._dirName}\\${filename}`;
      this.pathTip.style.color = '#50c878';
      this.pathTip.title = `导出时将直接写入「${this._dirName}」目录`;
    } else if (this._dirName) {
      // 仅目录名（无句柄无盘符）：明确警告，避免误导
      this.pathTip.textContent = `输出目录：${this._dirName}\\${filename}（导出时将弹系统保存框确认位置）`;
      this.pathTip.style.color = '#ffb84d';
      this.pathTip.title = '导出时将弹系统保存框确认保存位置';
    } else {
      this.pathTip.textContent = '输出路径：未选择，导出时将弹窗选择';
      this.pathTip.style.color = '#6ab0ff';
      this.pathTip.title = '';
    }
  }

  /**
   * 选择输出目录，落地方案（全网调研结论 + 实测修正）：
   *
   * 调研证据：
   * - showDirectoryPicker 仅 Chromium 系支持（Chrome/Edge 86+，Firefox/Safari 不支持），
   *   且存在"对话框弹出后 promise 挂起/不返回"的已知问题（部分内嵌浏览器环境必现，
   *   实测你的环境即如此）。强行优先它 + 超时自动降级 = 弹两个对话框，体验崩溃。
   * - <input webkitdirectory> 全浏览器稳定、必回调，但只拿得到目录名，拿不到
   *   写权限句柄，也无法知道完整绝对路径（如 D:\Temp\AI_输出测试）。
   * - ComfyUI 能写盘靠的是本地后端。本项目用 Vite dev server 中间件提供
   *   /api/pick-dir（弹 Windows 原生目录框返回完整路径）+ /api/save-video（fs 直写）。
   *
   * 因此优先级：
   * 1) 本地后端（npm run dev）-> 弹原生目录框 -> 拿到「完整绝对路径」-> 导出直写该盘符
   * 2) webkitdirectory（后端不可用时）-> 仅目录名，导出时弹保存框确认
   * 3) showDirectoryPicker（仅 webkitdirectory 不可用时兜底）
   * 4) 手动输入（终极兜底）
   */
  async pickOutputDir(dirBtn, dirInput) {
    // 点击立即反馈：绝不出现"点了没反应"
    if (this.pathTip) {
      this.pathTip.textContent = '正在打开目录选择…';
      this.pathTip.style.color = '#ffb84d';
    }

    // 第一优先：本地后端（npm run dev 模式）——弹 Windows 原生目录框，返回完整绝对路径
    if (await this.isBackendAvailable(true)) {
      this._pickDirViaBackend(dirBtn, dirInput);
      return;
    }

    // 第二优先：File System Access API（Chrome/Edge 单文件模式）——弹原生目录框
    if (typeof window.showDirectoryPicker === 'function') {
      try {
        const dirHandle = await window.showDirectoryPicker({
          id: 'wxhb-export-dir',
          mode: 'readwrite'
        });
        this._dirHandle = dirHandle;
        this._dirName = dirHandle.name;
        this._dirPath = ''; // 清空后端路径，用句柄写
        if (dirInput) dirInput.value = dirHandle.name;
        if (dirBtn) dirBtn.title = `输出目录：${dirHandle.name}（导出时直接写入该目录）`;
        if (this.pathTip) {
          this.pathTip.textContent = `✓ 已选择目录：${dirHandle.name}（导出时直接写入该目录）`;
          this.pathTip.style.color = '#7fdca0';
        }
        return;
      } catch (err) {
        // 用户取消选择
        if (err?.name === 'AbortError') {
          if (this.pathTip) {
            this.pathTip.textContent = '已取消选择';
            this.pathTip.style.color = '#6ab0ff';
          }
          return;
        }
        // 其他错误：继续走下载回退
        console.warn('showDirectoryPicker 失败，回退浏览器下载:', err);
      }
    }

    // 兜底：不支持 File System Access API 的浏览器 → 浏览器下载
    if (this.pathTip) {
      this.pathTip.textContent = '💡 当前浏览器不支持选目录导出，将自动保存到浏览器默认下载文件夹（可在浏览器设置里改默认下载位置）';
      this.pathTip.style.color = '#7fdca0';
    }
    this._dirHandle = null;
    this._dirPath = '';
    this._dirName = '';
    if (dirInput) dirInput.value = '浏览器下载';
  }

  /**
   * 本地后端选目录：调用 Vite dev server 的 /api/pick-dir，
   * 弹 Windows 原生目录选择框，拿到完整绝对路径（如 D:\Temp\AI_输出测试）。
   */
  async _pickDirViaBackend(dirBtn, dirInput) {
    // 防重入：同一时刻只弹一个目录框，防止连点/重复触发导致多个对话框叠一起
    if (this._pickDirInFlight) {
      if (this.pathTip) {
        this.pathTip.textContent = '已有目录选择框打开，请先选择或关闭它';
        this.pathTip.style.color = '#6ab0ff';
      }
      return;
    }
    this._pickDirInFlight = true;
    try {
      const res = await fetch('/api/pick-dir');
      const data = await res.json();
      if (data && data.ok && data.dir) {
        this._dirPath = data.dir;
        // 提取最后一段目录名用于展示
        const parts = String(data.dir).split(/[\\/]/).filter(Boolean);
        const dirName = parts[parts.length - 1] || data.dir;
        this._applyDirSelection(dirName, dirBtn, dirInput, data.dir);
        if (dirBtn) {
          dirBtn.title = `输出目录：${data.dir}（导出时直接写入该目录）`;
        }
      } else if (data && data.cancelled) {
        if (this.pathTip) {
          this.pathTip.textContent = '已取消选择，未更改输出目录';
          this.pathTip.style.color = '#6ab0ff';
          setTimeout(() => this.refreshPathTip(), 1800);
        }
      } else if (data && data.busy) {
        if (this.pathTip) {
          this.pathTip.textContent = '已有目录选择框打开，请先关闭它再试';
          this.pathTip.style.color = '#ffb84d';
        }
      } else {
        if (this.pathTip) {
          this.pathTip.textContent = `目录选择失败：${data?.error || '未知错误'}，可直接在「输出位置」输入框手动填写`;
          this.pathTip.style.color = '#ffb84d';
        }
      }
    } catch (err) {
      if (this.pathTip) {
        this.pathTip.textContent = `目录选择失败：${err.message}，可直接在「输出位置」输入框手动填写`;
        this.pathTip.style.color = '#ffb84d';
      }
    } finally {
      this._pickDirInFlight = false;
    }
  }

  /**
   * 检测浏览器是否支持 webkitdirectory 目录选择。
   * @returns {boolean}
   */
  _supportsWebkitDirectory() {
    try {
      const probe = document.createElement('input');
      return 'webkitdirectory' in probe;
    } catch {
      return false;
    }
  }

  /**
   * webkitdirectory 主方案：弹系统文件夹选择框（全浏览器支持），
   * 选中后从 file.webkitRelativePath 提取目录名。拿不到读写句柄，
   * 导出时仍弹系统保存对话框确认最终路径。
   *
   * 注意：兜底计时器只提示、绝不销毁 input / onchange——
   * 用户选目录可能超过 8 秒，销毁回调会导致"选了没反应"。
   */
  _pickDirViaWebkitdirectory(dirBtn, dirInput) {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.style.display = 'none';
    document.body.appendChild(input);

    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      input.remove();
      input.onchange = null;
      clearTimeout(failTimer);
    };

    // 兜底提示：若长时间无回调（浏览器拦截/用户未选择），只提示引导，
    // 不销毁回调——用户之后点完仍能正常落地
    const failTimer = setTimeout(() => {
      if (!settled && this.pathTip) {
        this.pathTip.textContent = '目录选择框未弹出或未选择，可直接在「输出位置」输入框手动填写目录路径';
        this.pathTip.style.color = '#ffb84d';
      }
    }, 12000);

    input.onchange = () => {
      if (settled) return;
      clearTimeout(failTimer);
      const first = input.files?.[0];
      if (first?.webkitRelativePath) {
        // webkitRelativePath 形如「目录名/子路径/文件.ext」，第一段即目录名
        const dirName = first.webkitRelativePath.split('/')[0] || '已选择目录';
        this._dirHandle = null; // webkitdirectory 拿不到读写句柄
        this._applyDirSelection(dirName, dirBtn, dirInput);
      } else {
        if (this.pathTip) {
          this.pathTip.textContent = '未识别到所选目录，可直接在「输出位置」输入框手动填写';
          this.pathTip.style.color = '#ffb84d';
        }
      }
      cleanup();
    };

    // 关键：每次复用同一 input 选同一目录不会触发 change，先清空 value
    input.value = '';
    input.click();
  }

  /**
   * 目录选择成功后的统一落地：
   * 更新输入框值（有完整路径则显示完整路径，含盘符）+ 按钮文字 + 下方路径提示。
   * @param {string} dirName 目录名（展示用）
   * @param {HTMLElement|null} dirBtn
   * @param {HTMLElement|null} dirInput
   * @param {string} [fullPath] 本地后端返回的完整绝对路径（如 D:\Temp\AI_输出测试）
   */
  _applyDirSelection(dirName, dirBtn, dirInput, fullPath = '') {    // 只认完整盘符绝对路径（D:\... 或 UNC \\...）；拿不到完整路径就不算「已选目录」，
    // 杜绝「只有目录名」的假成功状态导致导出落不了盘。
    const isFullPath = /^[a-zA-Z]:[\\/]/.test(fullPath) || fullPath.startsWith('\\\\');
    this._dirName = dirName;
    this._dirPath = isFullPath ? fullPath : '';
    // 输入框显示完整绝对路径（含盘符），不再只显示目录名；title 补全长路径
    if (dirInput) {
      dirInput.value = isFullPath ? fullPath : (dirName || '');
      dirInput.title = (this._dirPath || this._dirName)
        ? `输出目录：${this._dirPath || this._dirName}`
        : '点击按钮选择，或输入完整路径（含盘符）';
    }
    if (dirBtn) {
      dirBtn.textContent = isFullPath ? '重新选择' : '选择目录';
      dirBtn.title = isFullPath ? `输出目录：${fullPath}` : `输出目录：${dirName}（未获取完整盘符路径）`;
    }
    this.refreshPathTip();
  }

  async doExport() {
    if (this._exporting) return;

    const states = [];
    let temporaryVideo = null;
    let temporaryUrl = null;
    try {
      this._exporting = true;
      this.exportBtn.disabled = true;
      this.exportBtn.style.opacity = '0.7';
      this.progressTip.style.color = '';
      this.progressTip.textContent = '准备中...';
      const videoSource = this.getInput('视频源');
      if (videoSource?.hudState && videoSource.hudState !== 'ready') {
        throw new Error(videoSource.message || '请先完成上游遮罩视频生成，再导出');
      }
      const targetFps = this.getInput('目标帧率') || videoSource?.targetFps
        || (videoSource?.processedAsset ? videoSource.originalFps : 30);
      const bitrate = this.getParam('bitrate') * 1_000_000;
      const filename = this.getFullFilename();
      const fmt = VideoExportSkill.FORMATS.find((f) => f.value === this.getParam('format')) || VideoExportSkill.FORMATS[0];
      const mode = videoSource?.mode || videoSource?.fpsConvertMode || 'duplicate';
      let sourceFile = videoSource?.sourceFile
        || videoSource?.source?.sourceFile
        || (videoSource?.hudState ? null : this._findSourceFile())
        || null;
      const copyProcessed = !!videoSource?.processedAsset && !videoSource.targetFps && !this.getInput('目标帧率')
        && bitrate === 0 && fmt.value === 'mp4';

      if (!sourceFile && !videoSource?.processedAsset) {
        throw new Error('请先将视频素材或已生成的遮罩视频连接到本节点的“视频源”端口');
      }
      if (!copyProcessed && !this._exporter.supported) {
        throw new Error('当前浏览器不支持 WebCodecs 导出，请使用 Chrome 或 Edge');
      }
      if (!fmt.supported) {
        throw new Error(`「${fmt.label}」格式即将支持，当前请选择 MP4 或 MOV 导出`);
      }

      let videoElement = videoSource instanceof VideoElement ? videoSource : null;
      let htmlVideo = videoElement?.video || null;
      // 兜底找HTMLVideoElement：不管上游传什么结构，把里面的video元素挖出来
      if (videoSource instanceof HTMLVideoElement) {
        htmlVideo = videoSource;
      } else {
        // 遍历对象找里面的HTMLVideoElement
        const findVideo = (obj, depth = 0) => {
          if (!obj || depth > 3) return null;
          if (obj instanceof HTMLVideoElement) return obj;
          for (const key of ['video', 'source', 'element', 'videoElement']) {
            if (obj[key] instanceof HTMLVideoElement) return obj[key];
          }
          return null;
        };
        htmlVideo ||= findVideo(videoSource);
      }
      if (!videoElement && htmlVideo) {
        videoElement = new VideoElement(0, 0, htmlVideo);
        videoElement.setFpsConvertMode(mode === 'none' ? 'duplicate' : mode);
      }
      if (!videoElement && !videoSource?.processedAsset) {
        throw new Error('导出节点需要先接到视频');
      }
      if (videoElement) {
        videoElement.sourceFile = sourceFile;
        videoElement.originalFps = videoSource?.originalFps || videoElement.originalFps;
        videoElement.targetFps = targetFps;
      }

      const players = copyProcessed ? [] : this._previewPlayers();
      states.push(...players.map((player) => ({
        player,
        playing: !!player.playing,
        time: player.playTime || 0
      })));

      for (const state of states) {
        state.player.exporting = true;
        state.player.pause();
      }

      // ESC 立即终止导出，恢复到正常操作环境（不锁画布）
      const abortController = new AbortController();
      this._exportAbort = abortController;
      this._onExportEsc = (e) => {
        if (e.key === 'Escape' || e.key === 'Esc') {
          if (this._exporting) {
            abortController.abort();
            this.progressTip.textContent = '正在终止导出...';
          }
        }
      };
      document.addEventListener('keydown', this._onExportEsc, true);

      if (videoSource?.processedAsset) {
        this.progressTip.textContent = '读取已生成的视频文件…';
        sourceFile = await hudSourceFile(videoSource, abortController.signal);
        // 遮罩节点只传文件描述。原样保存无需播放器；转码才创建独立解码元素。
        if (!copyProcessed && !videoElement) {
          temporaryVideo = document.createElement('video');
          temporaryVideo.preload = 'metadata';
          temporaryVideo.muted = true;
          temporaryUrl = URL.createObjectURL(sourceFile);
          temporaryVideo.src = temporaryUrl;
          htmlVideo = temporaryVideo;
          videoElement = new VideoElement(0, 0, htmlVideo);
          videoElement.setFpsConvertMode(mode === 'none' ? 'duplicate' : mode);
          videoElement.originalFps = videoSource.originalFps || videoElement.originalFps;
          videoElement.targetFps = targetFps;
        }
        if (videoElement) videoElement.sourceFile = sourceFile;
        if (!copyProcessed && htmlVideo.readyState < 1) {
          await new Promise((resolve, reject) => {
            const done = error => {
              clearTimeout(timer);
              htmlVideo.removeEventListener('loadedmetadata', loaded);
              htmlVideo.removeEventListener('error', failed);
              abortController.signal.removeEventListener('abort', aborted);
              error ? reject(error) : resolve();
            };
            const loaded = () => done();
            const failed = () => done(new Error('无法读取已生成视频的元数据'));
            const aborted = () => done(new DOMException('已取消导出', 'AbortError'));
            const timer = setTimeout(() => done(new Error('读取已生成视频超时')), 15000);
            htmlVideo.addEventListener('loadedmetadata', loaded, { once: true });
            htmlVideo.addEventListener('error', failed, { once: true });
            abortController.signal.addEventListener('abort', aborted, { once: true });
            if (abortController.signal.aborted) aborted();
            else if (htmlVideo.error) failed();
            else if (htmlVideo.readyState >= 1) loaded();
          });
        }
        if (videoElement) {
          videoElement.width = videoSource.resolution?.w || htmlVideo.videoWidth;
          videoElement.height = videoSource.resolution?.h || htmlVideo.videoHeight;
        }
      }

      // 源音轨状态提示：探测过且无音轨 → 提前告知纯视频，避免导出完才发现无声
      if (videoElement?._audioProbe === null && this.progressTip) {
        this.progressTip.textContent = '源视频无音轨，导出为纯视频（不含声音）';
      } else if (videoElement?._audioProbe && this.progressTip) {
        const p = videoElement._audioProbe;
        this.progressTip.textContent = `已检测到音轨（${p.samplerate ? (p.samplerate / 1000).toFixed(1) + 'kHz' : ''} ${p.channels ? p.channels + 'ch' : ''}），将随视频一起导出`;
      }

      const blob = copyProcessed ? sourceFile : await this._exporter.export(videoElement, {
        mode: mode === 'none' ? 'duplicate' : mode,
        targetFps,
        bitrate,
        format: fmt.value,
        signal: abortController.signal,
        onProgress: (progress) => {
          const ratio = progress > 1 ? progress / 100 : progress;
          // 预估剩余时间：按已耗时/进度比例推算，让用户知道要等多久
          if (!this._exportStartAt) this._exportStartAt = performance.now();
          let remain = '';
          if (ratio > 0.05) {
            const elapsedSec = (performance.now() - this._exportStartAt) / 1000;
            const totalEst = elapsedSec / ratio;
            const remainSec = Math.max(0, Math.round(totalEst - elapsedSec));
            if (remainSec > 0) remain = `，预计还需约 ${Math.ceil(remainSec / 60)} 分 ${remainSec % 60} 秒`;
          }
          // 明确告知：转码阶段数据暂存内存，完成后才写入磁盘
          this.progressTip.textContent = `转码中 ${Math.round(ratio * 100)}%${remain}（完成后写入磁盘）`;
        }
      });

      // 写盘前音频回读诊断：确认导出的 blob 是否真的含音轨。
      // 源有音轨却导出无声时，这一步直接给出「丢在哪」的证据。
      this._lastExportAudio = null;
      try {
        const blobAb = await blob.arrayBuffer();
        blobAb.fileStart = 0;
        const audioBack = await demuxAudio(blobAb);
        this._lastExportAudio = audioBack;
        if (audioBack && audioBack.samples && audioBack.samples.length) {
          this.progressTip.textContent = `已混流音轨 ${audioBack.samples.length} 样本（${audioBack.samplerate}Hz ${audioBack.channels}ch），正在写入磁盘...`;
        } else {
          this.progressTip.textContent = videoSource?.audio?.hasAudio
            ? '⚠ 导出文件未检测到原有音轨，请检查结果'
            : '导出文件无音轨，正在写入磁盘…';
        }
      } catch (e) {
        this.progressTip.textContent = '正在写入磁盘（大文件需要几秒到几十秒，请稍候）...';
      }

      const result = await this.saveBlob(blob, filename, fmt.mime, abortController.signal);
      if (result.cancelled) {
        this.progressTip.textContent = '已取消保存';
        this.pathTip.textContent = '';
      } else if (result.downloaded) {
        // 保存框挂起/不支持：回退下载，明确告知真实落点（浏览器下载目录）
        this.progressTip.textContent = '导出完成（已下载）';
        this.pathTip.textContent = '浏览器未能弹保存框，文件已保存到「浏览器下载目录」，可在浏览器下载栏查看';
      } else if (result.path) {
        this.progressTip.textContent = '导出完成';
        // 写盘确认 + 音轨诊断合并显示（诊断结果不再被覆盖）
        let diskText = result.verified
          ? `已确认写入磁盘：${result.path}（${(result.size / 1024 / 1024).toFixed(1)} MB）`
          : `已保存：${result.path}`;
        const ab = this._lastExportAudio;
        if (ab && ab.samples && ab.samples.length) {
          diskText += ` ｜ 含音轨 ${ab.samples.length} 样本（${ab.samplerate}Hz ${ab.channels}ch）`;
        } else if (this._lastExportAudio === null && videoElement?._audioProbe) {
          diskText += ' ｜ ⚠ 音频混流失败，文件为纯视频';
        }
        this.pathTip.textContent = diskText;
      } else {
        this.progressTip.textContent = '导出完成';
        this.pathTip.textContent = '已保存到本地（浏览器下载栏可查看）';
      }
      setTimeout(() => {
        if (this.progressTip?.textContent === '导出完成' || this.progressTip?.textContent === '导出完成（已下载）') {
          this.progressTip.textContent = '';
        }
      }, 2500);
    } catch (err) {
      if (err?.name === 'AbortError') {
        // 用户按 ESC 终止导出：静默恢复，不弹报错框
        this.progressTip.textContent = '已终止导出';
        setTimeout(() => {
          if (this.progressTip?.textContent === '已终止导出') this.progressTip.textContent = '';
        }, 2500);
      } else {
        // 错误持久显示在节点上（红色），不再只靠 alert——弹窗一关错误就消失，
        // 用户无法知道为什么没生成文件。
        console.error('[导出失败]', err);
        this.progressTip.style.color = '#ff5b5b';
        this.progressTip.textContent = `导出失败：${err.message}`;
        this.pathTip.textContent = '请截图此错误反馈；也可打开浏览器 F12 控制台查看完整错误';
        this.pathTip.style.color = '#ffb84d';
        alert(`导出失败: ${err.message}`);
      }
    } finally {
      if (this._onExportEsc) {
        document.removeEventListener('keydown', this._onExportEsc, true);
        this._onExportEsc = null;
      }
      this._exportAbort = null;
      this._exportStartAt = null;
      if (temporaryVideo) {
        temporaryVideo.pause();
        temporaryVideo.removeAttribute('src');
        temporaryVideo.load();
      }
      if (temporaryUrl) URL.revokeObjectURL(temporaryUrl);
      for (const state of states) {
        state.player.exporting = false;
        state.player.seek?.(state.time);
        if (state.playing) state.player.play();
      }
      this._exporting = false;
      if (this.exportBtn) {
        this.exportBtn.disabled = false;
        this.exportBtn.style.opacity = '1';
      }
      // 导出结束后重置导出器实例：让本次转码累积的帧样本/MP4 buffer/Blob（可达数百 MB）
      // 整体脱离引用，尽早交给 GC 回收，避免导出完成后内存峰值滞留导致系统卡顿
      try {
        this._exporter = new VideoExporter();
      } catch (e) { /* 实例化失败不影响后续 */ }
      this._syncExportBtnState();
    }
  }

  /**
   * 保存导出结果（真实落点）：
   * 1) 有真实目录句柄（showDirectoryPicker 成功）-> 直接写入该目录；
   * 2) 仅记录了目录名（webkitdirectory 拿不到写权限）-> 弹系统保存框，
   *    由用户在框里确认最终路径（可导航到之前选的目录）；
   * 3) 保存框挂起/浏览器不支持 -> 回退普通下载到浏览器下载目录。
   * @param {Blob} blob
   * @param {string} filename
   * @param {string} [mime]
   * @param {AbortSignal} [signal] ESC 终止时取消保存
   * @returns {Promise<{cancelled: boolean, path?: string, downloaded?: boolean}>}
   */
  async saveBlob(blob, filename, mime = 'video/mp4', signal = null) {
    if (signal?.aborted) throw new DOMException('导出已取消', 'AbortError');

    // 1) 本地后端 + 完整路径：二进制直传 fs 写盘（最可靠，npm run dev 模式）
    if (this._dirPath && (await this.isBackendAvailable(true))) {
      if (signal?.aborted) throw new DOMException('导出已取消', 'AbortError');
      if (this.progressTip) this.progressTip.textContent = '正在写入磁盘…';
      try {
        const controller = new AbortController();
        const abortHandler = () => controller.abort();
        if (signal) {
          if (signal.aborted) throw new DOMException('导出已取消', 'AbortError');
          signal.addEventListener('abort', abortHandler, { once: true });
        }
        // 二进制直传（octet-stream）：避免 base64 大字符串内存爆炸（4K 视频可达数百 MB）
        const res = await fetch('/api/save-video', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Filename': encodeURIComponent(filename),
            'X-Dir': encodeURIComponent(this._dirPath)
          },
          body: blob,
          signal: controller.signal
        });
        if (signal) signal.removeEventListener('abort', abortHandler);
        const data = await res.json();
        if (data && data.ok && data.path) {
          // 二次确认：文件真实落在磁盘上才提示成功（杜绝「界面说完成、盘上没文件」）
          try {
            const checkUrl = `/api/check-file?path=${encodeURIComponent(data.path)}`;
            const check = await fetch(checkUrl, { signal: controller.signal });
            const checkData = await check.json();
            if (checkData && checkData.ok && checkData.size > 0) {
              return { cancelled: false, path: data.path, verified: true, size: checkData.size };
            }
            // 确认失败：文件可能没写全，改走浏览器下载兜底
            if (this.progressTip) this.progressTip.textContent = '写盘校验未通过，改用浏览器下载';
            const dl = await this._exporter.saveToDisk(blob, filename, { mime });
            if (dl.cancelled) return { cancelled: true };
            return dl.fallbackToDownload
              ? { cancelled: false, downloaded: true }
              : { cancelled: false, path: `${this._dirPath}\\${dl.name}` };
          } catch (checkErr) {
            // 校验接口失败（旧后端）不阻断，直接按写入成功提示
            return { cancelled: false, path: data.path };
          }
        }
        throw new Error(data?.error || '本地写盘失败');
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        if (this.progressTip) {
          this.progressTip.textContent = '写盘失败，改用保存框';
        }
        // 降级：弹系统保存框
        const result = await this._exporter.saveToDisk(blob, filename, { mime });
        if (result.cancelled) return { cancelled: true };
        if (result.fallbackToDownload) return { cancelled: false, downloaded: true };
        const shownPath = result.usedPicker
          ? (this._dirPath ? `${this._dirPath}\\${result.name}` : result.name)
          : '';
        return { cancelled: false, path: shownPath };
      }
    }

    // 2) 真实目录句柄：直写该目录
    if (this._dirHandle && typeof this._dirHandle.getFileHandle === 'function') {
      try {
        if (signal?.aborted) throw new DOMException('导出已取消', 'AbortError');
        const fileHandle = await this._dirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        if (signal?.aborted) {
          await writable.close().catch(() => {});
          throw new DOMException('导出已取消', 'AbortError');
        }
        await writable.write(blob);
        await writable.close();
        return { cancelled: false, path: `${this._dirName}\\${filename}` };
      } catch (error) {
        // AbortError（ESC 终止）继续向上抛，由 doExport 统一显示「已终止导出」
        if (error?.name === 'AbortError') throw error;
        this.pathTip.textContent = '';
        throw error;
      }
    }

    // 3) 无真句柄（webkitdirectory 只有目录名，或未选目录）：
    //    弹系统保存框确认最终路径；挂起/不支持则回退下载。
    if (this.progressTip) this.progressTip.textContent = '正在写入磁盘，请在保存框确认保存位置…';
    const result = await this._exporter.saveToDisk(blob, filename, { mime });
    if (result.cancelled) return { cancelled: true };
    if (result.fallbackToDownload) return { cancelled: false, downloaded: true };
    // 用户通过保存框确认落点；若有已选目录名，拼出直观路径
    const shownPath = result.usedPicker
      ? (this._dirName ? `${this._dirName}\\${result.name}` : result.name)
      : '';
    return { cancelled: false, path: shownPath };
  }

  _findSourceFile() {
    const seen = new Set();
    const find = (node) => {
      if (!node || seen.has(node)) return null;
      seen.add(node);
      // 处理节点边界不能回退到未处理的原片。
      if (node.type === 'hud_removal' || node.type === 'ui_mask') return null;
      if (typeof node.getSourceFile === 'function') {
        const file = node.getSourceFile();
        if (file) return file;
      }
      if (node.videoElement?.sourceFile) return node.videoElement.sourceFile;
      for (const input of node.inputs || []) {
        const found = find(input.connectedFrom?.node);
        if (found) return found;
      }
      return null;
    };
    return find(this);
  }

  _previewPlayers() {
    const players = (window.editor?.nodes || [])
      .map((node) => node._videoElement)
      .filter(Boolean);
    const canvasPlayer = window.infiniteCanvas?.renderer?.videoElement;
    if (canvasPlayer && !players.includes(canvasPlayer)) players.push(canvasPlayer);
    return players;
  }
}

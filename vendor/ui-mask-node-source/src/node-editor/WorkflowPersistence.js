import { WORKFLOW_KEY, BACKUP_KEY, snapshotWorkflow, parseWorkflow, instantiateWorkflow } from './WorkflowDocument.js';

export const AUTOSAVE_KEY = 'wxhb_canvas_autosave';

export class WorkflowPersistence {
  constructor(editor, registry) {
    this.editor = editor;
    this.registry = registry;
    this.ready = false;
    this.expectedRaw = null;
    this.lastContent = null;
    this.notice = '';
    this.timer = null;
    // Existing workflow documents do not opt customers into automatic saving.
    this.autosaveEnabled = false;
    try { this.autosaveEnabled = localStorage.getItem(AUTOSAVE_KEY) === 'true'; } catch { /* default off */ }
    this.syncAutosaveControl();
    window.addEventListener('pagehide', () => this.saveAutomatically());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.saveAutomatically();
    });
    window.addEventListener('beforeunload', event => {
      if (!this.ready) return;
      const saved = this.autosaveEnabled ? this.saveAutomatically() : !this.hasChanges();
      if (!saved || editor.nodes.some(node => node._mediaSaving || node._mediaSaveError || node.dirty || node.saving)) {
        event.preventDefault(); event.returnValue = '';
      }
    });
    window.addEventListener('storage', event => {
      if (event.key === AUTOSAVE_KEY) {
        this.autosaveEnabled = event.newValue === 'true';
        clearTimeout(this.timer); this.timer = null;
        this.syncAutosaveControl();
        if (this.ready) this.autosaveEnabled ? this.schedule() : this.showManualStatus();
      }
      if (event.key === WORKFLOW_KEY && event.newValue !== this.expectedRaw) {
        clearTimeout(this.timer);
        this.ready = false;
        this.status('另一页面已更新工作流', 'warning', '已暂停本页保存，防止互相覆盖。可导出本页副本，再刷新加载最新工作流。');
      }
    });
  }

  status(text, tone = '', detail = '') {
    const element = this.editor._saveStatus;
    if (!element) return;
    element.textContent = text;
    element.dataset.tone = tone;
    element.title = detail || text;
  }

  syncAutosaveControl() {
    if (this.editor._autosaveToggle) this.editor._autosaveToggle.checked = this.autosaveEnabled;
  }

  setAutosaveEnabled(enabled) {
    this.autosaveEnabled = enabled === true;
    clearTimeout(this.timer); this.timer = null;
    try { localStorage.setItem(AUTOSAVE_KEY, String(this.autosaveEnabled)); }
    catch { this.editor.toast('自动保存选项暂时无法记住，仅本次页面有效'); }
    this.syncAutosaveControl();
    if (this.ready) this.autosaveEnabled ? this.schedule() : this.showManualStatus();
  }

  hasChanges() {
    try { return JSON.stringify(snapshotWorkflow(this.editor)) !== this.lastContent; }
    catch { return true; }
  }

  showManualStatus() {
    const changed = this.hasChanges();
    this.status(changed ? '有未保存更改 · 自动保存已关闭' : '自动保存已关闭',
      changed || this.notice ? 'warning' : '', this.notice || '修改后请点击“立即保存”，或导出工作流副本。');
  }

  saveAutomatically() {
    if (!this.autosaveEnabled) return false;
    return this.save({ automatic: true });
  }

  schedule() {
    if (!this.ready) return;
    clearTimeout(this.timer);
    if (!this.autosaveEnabled) {
      this.showManualStatus();
      this.timer = setTimeout(() => this.publishShared(), 800);
      return;
    }
    this.status('正在保存…');
    this.timer = setTimeout(() => this.saveAutomatically(), 250);
  }

  save({ automatic = false } = {}) {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.ready) return false;
    try {
      const content = JSON.stringify(snapshotWorkflow(this.editor));
      const current = localStorage.getItem(WORKFLOW_KEY);
      if (current !== this.expectedRaw) {
        this.ready = false;
        this.status('保存已暂停', 'warning', '另一页面更新了工作流。请先导出本页副本，再刷新加载。');
        return false;
      }
      if (content !== this.lastContent) {
        const raw = JSON.stringify({ ...JSON.parse(content), savedAt: new Date().toISOString() });
        parseWorkflow(raw);
        // Keep the previous complete document. A failed write never clears the primary.
        if (current) localStorage.setItem(BACKUP_KEY, current);
        localStorage.setItem(WORKFLOW_KEY, raw);
        this.expectedRaw = raw;
        this.lastContent = content;
        this.publishShared(raw);
      }
      const pending = this.editor.nodes.some(node => node._mediaSaving);
      const mediaError = this.editor.nodes.some(node => node._mediaSaveError || node._mediaRestoreError);
      if (pending) this.status('工作流已保存 · 素材保存中', 'warning', '请等素材保存完成后再刷新。');
      else if (mediaError) this.status('工作流已保存 · 素材需处理', 'warning', '节点和连线已保存；请查看素材节点提示，通过“替换”重新关联原片。');
      else if (this.notice) this.status(`${automatic ? '已自动保存' : '已保存'} · 有待恢复节点或连线`, 'warning', this.notice);
      else this.status(automatic ? '已自动保存' : '已保存', '', '节点、连线、参数、已提交遮罩和画布视角已保存到本机浏览器。');
      return true;
    } catch (error) {
      console.warn('保存工作流失败，保留原有数据', error);
      this.status('保存失败 · 请导出副本', 'error', error.message || '浏览器存储不可用');
      return false;
    }
  }

  publishShared(raw) {
    try {
      const canvas = raw || JSON.stringify({ ...snapshotWorkflow(this.editor), savedAt: new Date().toISOString() });
      parseWorkflow(canvas);
      fetch('/api/ui-mask/shared-canvas', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ canvas }) }).catch(() => {});
    } catch { /* 本地稿仍可用，共享失败不阻断当前操作 */ }
  }

  async restore() {
    // Startup only: never append the same document to an existing graph.
    if (this.editor.nodes.length || this.ready) return;
    try {
      const response = await fetch('/api/ui-mask/shared-canvas');
      if (response.ok) {
        const data = await response.json();
        const shared = data.canvas || null;
        const local = localStorage.getItem(WORKFLOW_KEY);
        const stamp = text => { try { return Date.parse(JSON.parse(text).savedAt) || 0; } catch { return 0; } };
        if (shared && stamp(shared) >= stamp(local)) localStorage.setItem(WORKFLOW_KEY, shared);
      }
    } catch { /* 共享稿读不到时继续用本机稿 */ }
    const editor = this.editor;
    let staged;
    try {
      this.expectedRaw = localStorage.getItem(WORKFLOW_KEY);
      if (!this.expectedRaw) {
        this.lastContent = JSON.stringify(snapshotWorkflow(editor));
        this.ready = true;
        this.status(this.autosaveEnabled ? '自动保存已开启' : '自动保存已关闭',
          '', this.autosaveEnabled ? '修改工作流后会自动保存到本机浏览器。' : '修改后请点击“立即保存”，也可自行开启自动保存。');
        return;
      }
      const data = parseWorkflow(this.expectedRaw);
      staged = instantiateWorkflow(data, this.registry);
      // Build every card before committing. Rendering failure leaves the saved document intact.
      for (const node of staged.nodes) editor.renderNode(node);
      editor.nodes = staged.nodes;
      editor.connections = staged.connections;
      editor._unresolvedConnections = staged.unresolved;
      editor.nodeIdCounter = Math.max(Number.isSafeInteger(data.nodeIdCounter) ? data.nodeIdCounter : 0,
        ...data.nodes.map(n => Number(/^node_(\d+)$/.exec(n.id)?.[1] || 0)));
      if (data.viewport && editor.viewport) {
        const { panX, panY, zoom } = data.viewport;
        Object.assign(editor.viewport, { panX, panY, zoom });
        editor.viewport.minZoom = Math.min(editor.viewport.minZoom, data.viewport.zoom);
        editor.viewport.maxZoom = Math.max(editor.viewport.maxZoom, data.viewport.zoom);
      }
      editor.setMultiSelected(editor.nodes.filter(n => data.selectedNodeIds?.includes(n.id)));
      editor.syncViewport();
      this.lastContent = JSON.stringify(snapshotWorkflow(editor));
      this.ready = true;
      this.notice = staged.unavailable || staged.unresolved.length
        ? `${staged.unavailable} 个节点暂不可用，${staged.unresolved.length} 条连线待恢复；原始数据已保留。` : '';
      this.status(this.notice ? '工作流已恢复 · 部分待处理' : `已恢复 ${editor.nodes.length} 个节点`, this.notice ? 'warning' : '', this.notice);
      this.publishShared();
      // All edges must exist before any preview starts reading its upstream nodes.
      for (const node of editor.nodes) {
        try { node.onRendered?.(); }
        catch (error) {
          console.warn('节点界面初始化失败，工作流数据仍保留', node.id, error);
          this.notice = '部分节点界面初始化失败，节点数据仍已保留。';
          this.status('工作流已恢复 · 节点需检查', 'warning', this.notice);
        }
      }
      requestAnimationFrame(() => editor.updateConnections());
    } catch (error) {
      for (const node of staged?.nodes || []) node.element?.remove();
      editor.nodes = []; editor.connections = [];
      this.ready = false;
      console.warn('恢复工作流失败，保留原始存档', error);
      this.status('恢复失败 · 原存档已保留', 'error', `${error.message}。可导出原存档或点击“恢复备份”。`);
    }
  }

  recoverBackup() {
    try {
      const raw = localStorage.getItem(BACKUP_KEY);
      if (!raw) { this.editor.toast('还没有上一份备份'); return; }
      const data = parseWorkflow(raw);
      const when = data.savedAt ? new Date(data.savedAt).toLocaleString() : '旧版存档';
      this.replaceDocument(raw, `恢复备份（${when}，${data.nodes.length} 个节点）`);
    } catch (error) {
      this.editor.toast(`备份无法恢复：${error.message}，原存档未清空`);
    }
  }

  replaceDocument(raw, description) {
    parseWorkflow(raw);
    if (!window.confirm(`${description}？\n当前工作流将保留为备份，页面会重新加载。`)) return;
    if (this.ready && !this.save()) throw new Error('当前工作流尚未成功保存，请先导出副本');
    const current = localStorage.getItem(WORKFLOW_KEY);
    if (current) localStorage.setItem(BACKUP_KEY, current);
    localStorage.setItem(WORKFLOW_KEY, raw);
    // Unload saving must not overwrite the document the user just chose to open.
    this.ready = false;
    clearTimeout(this.timer);
    window.location.reload();
  }

  openCopy() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const raw = await file.text();
        const data = parseWorkflow(raw);
        this.replaceDocument(raw, `打开“${file.name}”（${data.nodes.length} 个节点）`);
      } catch (error) { this.editor.toast(`打开工作流失败：${error.message}`); }
    };
    input.click();
  }

  exportCopy() {
    try {
      // A failed restore can still export the untouched raw document for repair.
      const raw = this.editor.nodes.length || this.ready
        ? JSON.stringify({ ...snapshotWorkflow(this.editor), savedAt: new Date().toISOString() }, null, 2)
        : localStorage.getItem(WORKFLOW_KEY);
      if (!raw) { this.editor.toast('还没有可导出的工作流'); return; }
      const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `工作流-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { this.editor.toast(`导出工作流失败：${error.message}`); }
  }
}

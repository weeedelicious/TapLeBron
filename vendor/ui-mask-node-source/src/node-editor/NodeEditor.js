import { maskRangesFor } from '../ui/MaskTiming.js';
import { graphInputBlocked, isTextInput, startEditorGesture, cancelEditorGesture, hasEditorGesture } from '../ui/EditorInteraction.js';
import { SkillRegistry } from '../skills/index.js';
import { WorkflowPersistence } from './WorkflowPersistence.js';
import { NodeClipboard } from './NodeClipboard.js';

/**
 * 节点编辑器
 * 浮在无限画布上面。空白处不接事件，平移、缩放和拖放都交给底层画布。
 */
export class NodeEditor {
  constructor(container, viewport = null) {
    this.container = container;
    this.viewport = viewport;
    this.nodes = [];
    this.connections = [];
    this.selectedNode = null;
    this.selectedNodes = [];   // 框选多选：所有被框住的节点
    this.selectedConnection = null;
    this.nodeIdCounter = 0;
    this.skillMenu = null;

    this.isWireDrag = false;
    this.wireFrom = { node: null, portIndex: 0 };
    this.wireMouse = { x: 0, y: 0 };
    this.previewPath = null;
    this.snapEl = null;
    this.onNodeChange = null;

    // 撤销/重做历史栈：记录操作类型，简单反向执行
    this.undoStack = [];
    this.redoStack = [];
    this.maxHistory = 30;

    this.createOverlay();
    this.clipboard = new NodeClipboard(this, SkillRegistry.list);
    this.bindGlobalEvents();
    this.bindKeyboard();

    // 持久化：默认手动保存，可选择自动保存；页面加载时恢复已有工作流。
    this._initAutoPersistence();
  }

  _initAutoPersistence() {
    this.persistence = new WorkflowPersistence(this, SkillRegistry.list);
    this._scheduleSave = () => this.persistence.schedule();
  }

  _saveState() { return this.persistence.save(); }
  _restoreState() { return this.persistence.restore(); }

  /** 记录一个操作到历史栈 */
  pushHistory(action) {
    this.undoStack.push(action);
    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this._scheduleSave?.();
  }

  _detachHistoryNode(action) {
    const node = action.node;
    action.snapshot = {
      Class: node.constructor, id: node.id, x: node.x, y: node.y,
      params: Object.fromEntries(Object.entries(node.params).map(([key, p]) => [key, p.value])),
      maskRanges: structuredClone(maskRangesFor(node.masks || [], node.maskRanges)),
      masks: JSON.parse(JSON.stringify(node.masks || [])), hudJob: node.hudJob || null,
      hudComparison: node.hudComparison || null,
      hudStructurePreview: node.hudStructurePreview || null,
      hudReferenceKeyframe: node.hudReferenceKeyframe || null,
      hudReferenceVideo: node.hudReferenceVideo || null,
      hudAnalysis: node.hudAnalysis || null,
      file: node.getSourceFile?.() || null, mediaKey: node.mediaKey, media: node.media,
      mediaNeedsSave: node._mediaSaving || node._mediaSaveError,
      savedNodeData: { ...node._savedNodeData, ports: {
        inputs: node.inputs.map(({ name, type }) => ({ name, type })),
        outputs: node.outputs.map(({ name, type }) => ({ name, type }))
      } }, savedType: node._savedType
    };
    action.connections = this.connections.filter(c => c.from.node === node || c.to.node === node)
      .map(c => ({ from: c.from.node.id, fromPort: c.from.port, to: c.to.node.id, toPort: c.to.port }));
    this.deleteNode(node);
  }

  _restoreHistoryNode(action, { deferConnections = false, select = true } = {}) {
    const snapshot = action.snapshot;
    if (!snapshot) return;
    const previous = action.node;
    const node = snapshot.savedType
      ? new snapshot.Class(snapshot.savedNodeData, [])
      : new snapshot.Class(snapshot.id, snapshot.x, snapshot.y);
    node.x = snapshot.x; node.y = snapshot.y;
    node._savedNodeData = snapshot.savedNodeData;
    node.mediaKey = snapshot.mediaKey; node.media = snapshot.media;
    for (const [key, value] of Object.entries(snapshot.params)) if (node.params[key]) node.params[key].value = value;
    if ('masks' in node) {
      node.masks = JSON.parse(JSON.stringify(snapshot.masks));
      node.maskRanges = structuredClone(maskRangesFor(node.masks, snapshot.maskRanges));
    }
    node.hudJob = snapshot.hudJob;
    node.hudComparison = snapshot.hudComparison || null;
    node.hudStructurePreview = snapshot.hudStructurePreview || null;
    node.hudReferenceKeyframe = snapshot.hudReferenceKeyframe || null;
    node.hudReferenceVideo = snapshot.hudReferenceVideo || null;
    node.hudAnalysis = snapshot.hudAnalysis || null;
    // Other undo entries can refer to the same logical node; update their instance.
    for (const item of [...this.undoStack, ...this.redoStack, action]) {
      for (const entry of [item, ...(item.entries || [])]) if (entry.node === previous) entry.node = node;
    }
    this.nodes.push(node); this.renderNode(node);
    setTimeout(() => { if (this.nodes.includes(node)) node.onRendered?.(); }, 0);
    if (!deferConnections) this._restoreHistoryConnections(action.connections);
    if (snapshot.file && node.setVideoFile) {
      node.setVideoFile(snapshot.file, null, { persist: !!snapshot.mediaNeedsSave, reuseCanvasVideo: false })
        .then(() => { if (this.nodes.includes(node)) this.resetDownstream(node); }).catch(error => this.toast(error.message));
    }
    if (select) this.selectNode(node);
  }

  _restoreHistoryConnections(connections = []) {
    for (const c of connections) {
      const from = this.nodes.find(n => n.id === c.from), to = this.nodes.find(n => n.id === c.to);
      if (!from?.outputs[c.fromPort] || !to?.inputs[c.toPort] || to.inputs[c.toPort].connectedFrom) continue;
      this.connections.push({ from: { node: from, port: c.fromPort }, to: { node: to, port: c.toPort } });
      to.inputs[c.toPort].connectedFrom = { node: from, portName: from.outputs[c.fromPort].name };
      this.resetDownstream(to);
    }
  }

  _detachHistoryGroup(action) {
    const selected = new Set(action.entries.map(entry => entry.node.id));
    // Capture all edges before deleting the first node. Internal edges otherwise disappear too early.
    action.connections = this.connections.filter(c => selected.has(c.from.node.id) || selected.has(c.to.node.id))
      .map(c => ({ from: c.from.node.id, fromPort: c.from.port, to: c.to.node.id, toPort: c.to.port }));
    action.unresolved = (this._unresolvedConnections || []).filter(c => selected.has(c.fromNodeId) || selected.has(c.toNodeId));
    for (const entry of action.entries) this._detachHistoryNode(entry);
    this._unresolvedConnections = (this._unresolvedConnections || []).filter(c => !selected.has(c.fromNodeId) && !selected.has(c.toNodeId));
  }

  _restoreHistoryGroup(action) {
    for (const entry of action.entries) this._restoreHistoryNode(entry, { deferConnections: true, select: false });
    this._restoreHistoryConnections(action.connections);
    this._unresolvedConnections = [...(this._unresolvedConnections || []), ...(action.unresolved || [])];
    this.setMultiSelected(action.entries.map(entry => entry.node));
  }

  _applyHistoryPositions(positions) {
    for (const p of positions) {
      const node = this.nodes.find(n => n.id === p.id);
      if (!node) continue;
      node.x = p.x; node.y = p.y; this.applyNodeScreen(node);
    }
  }

  undo() {
    if (graphInputBlocked() || !this.undoStack.length) return;
    cancelEditorGesture('undo');
    const pending = this.undoStack[this.undoStack.length-1];
    if (pending.type === 'applyHudReview') {
      try { pending.apply(pending.node, pending.before); }
      catch (error) { this.toast(error.message); return; }
    }
    const action = this.undoStack.pop(); this.redoStack.push(action);
    if (action.type === 'addNode') this._detachHistoryNode(action);
    else if (action.type === 'pasteNodes') this._detachHistoryGroup(action);
    else if (action.type === 'deleteNode') this._restoreHistoryNode(action);
    else if (action.type === 'moveNodes') this._applyHistoryPositions(action.before);
    else if (action.type === 'editMasks') {
      action.node.masks = JSON.parse(JSON.stringify(action.before));
      action.node.maskRanges = structuredClone(maskRangesFor(action.node.masks, action.beforeRanges));
      action.node._selectedMask = -1;
      action.node._masksChanged();
    }
    this.updateConnections(); this._scheduleSave?.();
  }

  redo() {
    if (graphInputBlocked() || !this.redoStack.length) return;
    cancelEditorGesture('redo');
    const pending = this.redoStack[this.redoStack.length-1];
    if (pending.type === 'applyHudReview') {
      try { pending.apply(pending.node, pending.after); }
      catch (error) { this.toast(error.message); return; }
    }
    const action = this.redoStack.pop(); this.undoStack.push(action);
    if (action.type === 'addNode') this._restoreHistoryNode(action);
    else if (action.type === 'pasteNodes') this._restoreHistoryGroup(action);
    else if (action.type === 'deleteNode') this._detachHistoryNode(action);
    else if (action.type === 'moveNodes') this._applyHistoryPositions(action.after);
    else if (action.type === 'editMasks') {
      action.node.masks = JSON.parse(JSON.stringify(action.after));
      action.node.maskRanges = structuredClone(maskRangesFor(action.node.masks, action.afterRanges));
      action.node._selectedMask = -1;
      action.node._masksChanged();
    }
    this.updateConnections(); this._scheduleSave?.();
  }

  /** Navigation changes only the viewport, never node positions or graph layout. */
  frameNodes(nodes = this.nodes) {
    if (graphInputBlocked() || !this.viewport) return;
    cancelEditorGesture('frame');
    const valid = nodes.filter(n => n.element?.isConnected && Number.isFinite(n.x) && Number.isFinite(n.y));
    if (!valid.length) { this.toast('请先选中节点，或使用“查看全部”'); return; }
    const left = Math.min(...valid.map(n => n.x));
    const top = Math.min(...valid.map(n => n.y));
    const right = Math.max(...valid.map(n => n.x + (n.element.offsetWidth || n.width)));
    const bottom = Math.max(...valid.map(n => n.y + (n.element.offsetHeight || n.getHeight())));
    const width = this.container.clientWidth, height = this.container.clientHeight;
    const zoom = Math.min(1, Math.max(80, width-128)/Math.max(1, right-left), Math.max(80, height-128)/Math.max(1, bottom-top));
    this.viewport.minZoom = Math.min(this.viewport.minZoom, zoom);
    this.viewport.zoom = zoom;
    this.viewport.panX = width/(2*zoom) - (left+right)/2;
    this.viewport.panY = height/(2*zoom) - (top+bottom)/2;
    this.syncViewport();
  }

  createNavigation() {
    const nav = document.createElement('div');
    nav.className = 'canvas-navigation';
    nav.setAttribute('role', 'toolbar'); nav.setAttribute('aria-label', '画布导航');
    const button = (label, title, action) => {
      const el = document.createElement('button');
      el.type = 'button'; el.textContent = label; el.title = title; el.setAttribute('aria-label', title);
      el.onclick = () => { if (!graphInputBlocked()) action(); };
      nav.appendChild(el); return el;
    };
    const zoomBy = factor => {
      if (hasEditorGesture()) return;
      this.viewport.zoomAt(this.container.clientWidth/2, this.container.clientHeight/2, factor);
      this.syncViewport();
    };
    button('−', '缩小画布', () => zoomBy(1/1.2));
    this._zoomLabel = button('100%', '恢复 100% 缩放', () => zoomBy(1/this.viewport.zoom));
    button('+', '放大画布', () => zoomBy(1.2));
    const divider = document.createElement('span'); divider.className = 'editor-divider'; nav.appendChild(divider);
    button('查看全部', '查看全部节点 · Home', () => this.frameNodes());
    button('聚焦选中', '聚焦选中节点 · F / .', () => this.frameNodes(this.selectedNodes));
    const editDivider = document.createElement('span'); editDivider.className = 'editor-divider'; nav.appendChild(editDivider);
    this._copyNodesButton = button('复制', '复制选中节点及内部连线 · Ctrl+C', () => this.clipboard.copy());
    button('粘贴', '粘贴节点到当前画布 · Ctrl+V', () => this.clipboard.paste());
    this._duplicateNodesButton = button('复制一份', '在选中节点旁复制一份 · Ctrl+D', () => this.clipboard.duplicate());
    this._selectionStatus = document.createElement('span'); this._selectionStatus.className = 'canvas-selection-status';
    this._selectionStatus.title = '框选多个节点，或 Shift / Ctrl 点选增减选择；Ctrl+A 全选';
    nav.appendChild(this._selectionStatus); this._updateSelectionTools();
    nav.addEventListener('pointerdown', e => e.stopPropagation());
    nav.addEventListener('mousedown', e => e.stopPropagation());
    this.overlay.appendChild(nav);
  }

  createOverlay() {
    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 10;
    `;
    this.container.appendChild(this.overlay);

    const btnWrap = document.createElement('div');
    btnWrap.className = 'canvas-file-tools';
    this._saveStatus = document.createElement('span');
    this._saveStatus.className = 'workflow-save-status';
    this._saveStatus.setAttribute('role', 'status');
    this._saveStatus.textContent = '正在恢复工作流…';
    btnWrap.appendChild(this._saveStatus);
    const autosaveLabel = document.createElement('label');
    autosaveLabel.className = 'workflow-autosave';
    autosaveLabel.title = '默认关闭；开启后自动保存工作流，选择会在本机浏览器记住';
    const autosave = this._autosaveToggle = document.createElement('input');
    autosave.type = 'checkbox';
    autosave.setAttribute('role', 'switch');
    autosave.onchange = () => {
      if (graphInputBlocked()) { this.persistence.syncAutosaveControl(); return; }
      this.persistence.setAutosaveEnabled(autosave.checked);
    };
    autosaveLabel.append(autosave, '自动保存');
    btnWrap.appendChild(autosaveLabel);
    for (const [label, title, action] of [
      ['立即保存', '手动保存当前工作流，自动保存关闭时也可使用', () => this._saveState()],
      ['恢复备份', '恢复上一份完整工作流', () => this.persistence.recoverBackup()],
      ['导出副本', '导出工作流 JSON（不包含视频文件）', () => this.persistence.exportCopy()],
      ['打开副本', '打开之前导出的工作流 JSON', () => this.persistence.openCopy()]
    ]) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = label; button.title = title;
      button.onclick = () => { if (!graphInputBlocked()) action(); };
      btnWrap.appendChild(button);
    }
    btnWrap.addEventListener('pointerdown', e => e.stopPropagation());
    btnWrap.addEventListener('mousedown', e => e.stopPropagation());
    this.overlay.appendChild(btnWrap);

    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    `;
    this.overlay.appendChild(this.svg);

    this.nodeLayer = document.createElement('div');
    this.nodeLayer.tabIndex = -1;
    this.nodeLayer.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    `;
    this.overlay.appendChild(this.nodeLayer);

    // 框选矩形（半透明蓝底 + 蓝色边框，参考 ComfyUI/Blender）
    this.selectBox = document.createElement('div');
    this.selectBox.style.cssText = `
      position: absolute;
      display: none;
      border: 1px solid #4a9eff;
      background: rgba(74, 158, 255, 0.15);
      pointer-events: none;
      z-index: 100;
    `;
    this.overlay.appendChild(this.selectBox);
    this.createNavigation();
  }

  /**
   * 挂接无限画布的框选回调：左键拖空白 = 框选节点。
   * 由 main.js 在创建 InfiniteCanvas 后调用。
   */
  attachBoxSelect(infiniteCanvas) {
    let startSX = 0;
    let startSY = 0;

    infiniteCanvas.onBoxSelectStart = (sx, sy) => {
      // Leave parameter editing when the user returns to selecting the graph.
      this.nodeLayer.focus({ preventScroll: true });
      window.getSelection()?.removeAllRanges();
      startSX = sx;
      startSY = sy;
      this.selectBox.style.display = 'block';
      this.selectBox.style.left = sx + 'px';
      this.selectBox.style.top = sy + 'px';
      this.selectBox.style.width = '0px';
      this.selectBox.style.height = '0px';
    };

    infiniteCanvas.onBoxSelectCancel = () => { this.selectBox.style.display = 'none'; };

    infiniteCanvas.onBoxSelectMove = (sx, sy) => {
      const x = Math.min(startSX, sx);
      const y = Math.min(startSY, sy);
      const w = Math.abs(sx - startSX);
      const h = Math.abs(sy - startSY);
      this.selectBox.style.left = x + 'px';
      this.selectBox.style.top = y + 'px';
      this.selectBox.style.width = w + 'px';
      this.selectBox.style.height = h + 'px';
    };

    infiniteCanvas.onBoxSelectEnd = (sx, sy) => {
      this.selectBox.style.display = 'none';
      const x1 = Math.min(startSX, sx);
      const y1 = Math.min(startSY, sy);
      const x2 = Math.max(startSX, sx);
      const y2 = Math.max(startSY, sy);
      // 拖拽距离太小视为点击空白：清空选择
      if (x2 - x1 < 4 && y2 - y1 < 4) {
        this.deselectAll();
        return;
      }
      // 找出所有节点卡片，判断屏幕矩形是否相交
      const zoom = this.viewport?.zoom ?? 1;
      const rect = infiniteCanvas.canvas.getBoundingClientRect();
      const hitNodes = [];
      for (const node of this.nodes) {
        if (!node.element) continue;
        const nw = (node.width || 160) * zoom;
        const nh = (node.element.offsetHeight || 80) * zoom;
        const screen = this.viewport
          ? this.viewport.worldToScreen(node.x, node.y)
          : { x: node.x, y: node.y };
        // 节点屏幕矩形 vs 框选屏幕矩形
        if (screen.x < x2 && screen.x + nw > x1 &&
            screen.y < y2 && screen.y + nh > y1) {
          hitNodes.push(node);
        }
      }
      this.setMultiSelected(hitNodes);
    };
  }

  /** 多选设置：高亮所有命中节点，其余恢复默认边框。 */
  setMultiSelected(nodes) {
    // 清除旧高亮
    for (const n of this.nodes) {
      if (n.element) n.element.style.borderColor = '#333';
    }
    this.selectedNodes = nodes.slice();
    this.selectedNode = nodes.length === 1 ? nodes[0] : null;
    this.selectedConnection = null;
    for (const n of nodes) {
      if (n.element) n.element.style.borderColor = '#4a9eff';
    }
    this._updateSelectionTools();
    this.updateConnections();
    this._scheduleSave?.();
  }

  createNode(NodeClass, x, y) {
    const id = this.allocateNodeId();
    const node = new NodeClass(id, x, y);
    this.nodes.push(node);
    this.renderNode(node);
    if (typeof node.onRendered === 'function') {
      setTimeout(() => node.onRendered(), 0);
    }
    this.pushHistory({ type: 'addNode', node: node });
    this._scheduleSave?.();
    return node;
  }

  allocateNodeId() {
    if (!Number.isSafeInteger(this.nodeIdCounter) || this.nodeIdCounter < 0 || this.nodeIdCounter >= Number.MAX_SAFE_INTEGER) this.nodeIdCounter = 0;
    let id;
    do { id = 'node_' + (++this.nodeIdCounter); } while (this.nodes.some(node => node.id === id));
    return id;
  }

  _updateSelectionTools() {
    const count = this.selectedNodes.length;
    if (this._copyNodesButton) this._copyNodesButton.disabled = !count;
    if (this._duplicateNodesButton) this._duplicateNodesButton.disabled = !count;
    if (this._selectionStatus) this._selectionStatus.textContent = count ? `已选 ${count} 个` : '点选 / 框选节点';
  }

  /**
   * 把节点的世界坐标换算成屏幕坐标，并按视口 zoom 整体缩放节点。
   * 与底层视频、网格使用同一套 worldToScreen 变换，保证方向一致。
   */
  applyNodeScreen(node) {
    if (!node?.element) return;
    const el = node.element;
    const zoom = this.viewport?.zoom ?? 1;
    const screen = this.viewport ? this.viewport.worldToScreen(node.x, node.y) : { x: node.x, y: node.y };
    el.style.left = screen.x + 'px';
    el.style.top = screen.y + 'px';
    el.style.transformOrigin = '0 0';
    el.style.transform = `scale(${zoom})`;
  }

  renderNode(node) {
    const el = document.createElement('div');
    el.className = 'node-card';
    el.tabIndex = -1;
    el.dataset.nodeId = node.id;
    el.style.cssText = `
      position: absolute;
      width: ${node.width}px;
      min-height: ${node.getHeight()}px;
      background: rgba(30, 30, 46, 0.94);
      border: 1px solid #333;
      border-radius: 10px;
      color: #fff;
      font-family: system-ui, sans-serif;
      font-size: 12px;
      cursor: default;
      user-select: none;
      box-shadow: 0 6px 20px rgba(0,0,0,0.4);
      overflow: visible;
      pointer-events: auto;
      will-change: transform;
    `;
    node.element?.remove();
    node.element = el;
    this.applyNodeScreen(node);

    const header = document.createElement('div');
    header.className = 'node-drag-handle';
    header.style.cssText = `
      padding: 10px 14px;
      background: #2a2a40;
      font-weight: 600;
      font-size: 13px;
      border-bottom: 1px solid #333;
      border-radius: 9px 9px 0 0;
    `;
    header.textContent = node.constructor.nodeName || node.type;
    el.appendChild(header);

    const paramBody = document.createElement('div');
    paramBody.style.cssText = 'padding: 10px 14px; border-bottom: 1px solid #2a2a2a;';

    for (const key in node.params) {
      const param = node.params[key];
      const row = document.createElement('div');
      row.style.cssText = 'margin-bottom:10px; display:flex; align-items:center; justify-content:space-between; gap:10px;';

      const label = document.createElement('span');
      label.style.cssText = 'color:#aaa; font-size:12px; flex-shrink:0;';
      label.textContent = param.label;
      row.appendChild(label);

      let input;
      if (param.control === 'select') {
        input = document.createElement('select');
        param.options.forEach(opt => {
          const option = document.createElement('option');
          option.value = String(opt.value);
          option.textContent = opt.label;
          if (String(opt.value) === String(param.value)) option.selected = true;
          input.appendChild(option);
        });
      } else if (param.control === 'number') {
        input = document.createElement('input');
        input.type = 'number';
        input.value = param.value;
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.value = param.value ?? '';
        if (key === 'fileName') input.disabled = true;
      }

      input.dataset.key = key;
      input.style.cssText = `
        flex: 1;
        min-width: 0;
        width: 100%;
        padding: 5px 8px;
        background: #2a2a3a;
        border: 1px solid #444;
        border-radius: 4px;
        color: #fff;
        font-size: 12px;
        outline: none;
        ${key === 'fileName' ? 'opacity: 0.7;' : ''}
      `;
      input.addEventListener('mousedown', (e) => e.stopPropagation());
      input.addEventListener('change', (e) => {
        let value = e.target.value;
        if (e.target.type === 'number') value = parseFloat(value);
        if (value === 'true') value = true;
        if (value === 'false') value = false;
        node.setParam(key, value);
        this.resetDownstream(node);
        this.onNodeChange?.(node);
        this._scheduleSave?.();
      });
      row.appendChild(input);
      paramBody.appendChild(row);
    }
    el.appendChild(paramBody);

    if (node.previewHeight) {
      const previewWrap = document.createElement('div');
      previewWrap.className = 'preview-wrap';
      previewWrap.style.cssText = `
        margin: 10px 14px 8px;
        height: ${node.previewHeight}px;
        background: #0a0a0f;
        border-radius: 6px;
        overflow: hidden;
        border: 1px solid #2a2a2a;
      `;
      el.appendChild(previewWrap);
    }

    const portArea = document.createElement('div');
    portArea.style.cssText = 'position: relative; padding: 8px 0;';

    node.inputs.forEach((port, i) => {
      portArea.appendChild(this._createInputPort(port, i));
    });
    node.outputs.forEach((port, i) => {
      portArea.appendChild(this._createOutputPort(node, port, i));
    });
    el.appendChild(portArea);

    this.nodeLayer.appendChild(el);
    this.bindNodeDrag(node, el);
  }

  _createInputPort(port, index) {
    const row = document.createElement('div');
    row.style.cssText = 'position:relative; height:28px; display:flex; align-items:center; padding-left:18px;';

    const dot = document.createElement('div');
    dot.className = 'port input-port';
    dot.dataset.portIndex = String(index);
    dot.dataset.portType = 'input';
    dot.style.cssText = `
      position: absolute; left: -7px;
      width: 14px; height: 14px;
      border-radius: 50%;
      background: #4a90e2;
      border: 2px solid #fff;
      cursor: crosshair;
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      z-index: 20;
    `;
    dot.addEventListener('mouseenter', () => {
      if (dot !== this.snapEl) dot.style.transform = 'scale(1.3)';
    });
    dot.addEventListener('mouseleave', () => {
      if (dot !== this.snapEl) dot.style.transform = 'scale(1)';
    });
    row.appendChild(dot);

    const label = document.createElement('span');
    label.style.cssText = 'color:#ccc; font-size:11px;';
    label.textContent = port.name;
    row.appendChild(label);
    return row;
  }

  _createOutputPort(node, port, index) {
    const row = document.createElement('div');
    row.style.cssText = 'position:relative; height:28px; display:flex; align-items:center; justify-content:flex-end; padding-right:48px;';

    const label = document.createElement('span');
    label.style.cssText = 'color:#ccc; font-size:11px;';
    label.textContent = port.name;
    row.appendChild(label);

    const dot = document.createElement('div');
    dot.className = 'port output-port';
    dot.dataset.portIndex = String(index);
    dot.dataset.portType = 'output';
    dot.style.cssText = `
      position: absolute; right: -7px;
      width: 14px; height: 14px;
      border-radius: 50%;
      background: #50c878;
      border: 2px solid #fff;
      cursor: crosshair;
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      z-index: 20;
    `;
    dot.addEventListener('mouseenter', () => {
      dot.style.transform = 'scale(1.3)';
    });
    dot.addEventListener('mouseleave', () => {
      dot.style.transform = 'scale(1)';
    });
    dot.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.startWireDrag(node, index, e);
    });
    row.appendChild(dot);

    const plusBtn = document.createElement('div');
    plusBtn.className = 'add-node-btn';
    plusBtn.dataset.portIndex = String(index);
    plusBtn.textContent = '+';
    plusBtn.style.cssText = `
      position: absolute; right: 22px;
      width: 20px; height: 20px;
      border-radius: 50%;
      background: #3a3a5a;
      color: #fff;
      font-size: 16px; line-height: 18px;
      text-align: center;
      cursor: pointer;
      border: 1px solid #555;
      font-weight: bold;
      z-index: 20;
    `;
    plusBtn.addEventListener('mouseenter', () => {
      plusBtn.style.background = '#4a90e2';
      plusBtn.style.transform = 'scale(1.15)';
    });
    plusBtn.addEventListener('mouseleave', () => {
      plusBtn.style.background = '#3a3a5a';
      plusBtn.style.transform = 'scale(1)';
    });
    plusBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    plusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showSkillMenu(node, index, plusBtn);
    });
    row.appendChild(plusBtn);
    return row;
  }

  startWireDrag(node, portIndex, e) {
    if (e.button !== 0 || graphInputBlocked(e)) return;
    if (!startEditorGesture(e, {
      element: e.currentTarget,
      move: next => { this.wireMouse = { x: next.clientX, y: next.clientY }; this.updateWirePreview(); },
      end: next => this.endWireDrag(next),
      cancel: () => { this.clearWireDrag(); this.updateConnections(); }
    })) return;
    this.deselectAll();
    this.isWireDrag = true;
    this.wireFrom.node = node;
    this.wireFrom.portIndex = portIndex;
    this.wireMouse = { x: e.clientX, y: e.clientY };

    this.previewPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    this.previewPath.setAttribute('stroke', '#50c878');
    this.previewPath.setAttribute('stroke-width', '2');
    this.previewPath.setAttribute('fill', 'none');
    this.previewPath.setAttribute('stroke-dasharray', '6 4');
    this.previewPath.style.pointerEvents = 'none';
    this.svg.appendChild(this.previewPath);
    this.updateWirePreview();
  }

  updateWirePreview() {
    if (!this.isWireDrag || !this.previewPath || !this.wireFrom.node?.element) return;
    const fromEl = this.wireFrom.node.element.querySelectorAll('.output-port')[this.wireFrom.portIndex];
    if (!fromEl) return;

    const rect = this.overlay.getBoundingClientRect();
    const fromRect = fromEl.getBoundingClientRect();
    const x1 = fromRect.left + fromRect.width / 2 - rect.left;
    const y1 = fromRect.top + fromRect.height / 2 - rect.top;
    const x2 = this.wireMouse.x - rect.left;
    const y2 = this.wireMouse.y - rect.top;
    const dx = Math.abs(x2 - x1) * 0.5;
    this.previewPath.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);

    const output = this.wireFrom.node.outputs[this.wireFrom.portIndex];
    const target = this.hitTestPort(this.wireMouse.x, this.wireMouse.y, 30);
    const compatible = !!(
      target &&
      target.type === 'input' &&
      target.node !== this.wireFrom.node &&
      this.portsCompatible(output, target.node.inputs[target.portIndex])
    );
    this.previewPath.setAttribute('stroke', target && target.type === 'input' && !compatible ? '#e24a4a' : '#50c878');
    this.setSnapTarget(compatible ? target.el : null);
  }

  clearWireDrag() {
    this.previewPath?.remove();
    this.previewPath = null;
    this.isWireDrag = false;
    this.wireFrom.node = null;
    this.setSnapTarget(null);
  }

  endWireDrag(e) {
    if (!this.isWireDrag) return;
    const fromNode = this.wireFrom.node;
    const fromPort = this.wireFrom.portIndex;
    const target = this.hitTestPort(e?.clientX ?? this.wireMouse.x, e?.clientY ?? this.wireMouse.y, 30);
    this.clearWireDrag();

    const output = fromNode?.outputs[fromPort];
    const input = target ? target.node.inputs[target.portIndex] : null;
    if (!fromNode || !target || target.type !== 'input' || target.node === fromNode || !this.portsCompatible(output, input)) {
      this.updateConnections();
      return;
    }
    this.connect(fromNode, fromPort, target.node, target.portIndex);
  }

  portsCompatible(output, input) {
    if (!output || !input) return false;
    if (!output.type || !input.type) return true;
    return output.type === input.type;
  }

  hitTestPort(x, y, radius = 20) {
    let best = null;
    let bestDist = radius;
    for (const portEl of this.nodeLayer.querySelectorAll('.port')) {
      const rect = portEl.getBoundingClientRect();
      const dist = Math.hypot(x - (rect.left + rect.width / 2), y - (rect.top + rect.height / 2));
      if (dist >= bestDist) continue;
      const nodeEl = portEl.closest('.node-card');
      const node = this.nodes.find(item => item.id === nodeEl?.dataset.nodeId);
      if (!node) continue;
      bestDist = dist;
      best = {
        node,
        portIndex: parseInt(portEl.dataset.portIndex, 10),
        type: portEl.dataset.portType,
        el: portEl
      };
    }
    return best;
  }

  setSnapTarget(el) {
    if (this.snapEl === el) return;
    if (this.snapEl) {
      this.snapEl.style.transform = 'scale(1)';
      this.snapEl.style.boxShadow = '0 2px 4px rgba(0,0,0,0.3)';
    }
    this.snapEl = el;
    if (!el) return;
    el.style.transform = 'scale(1.35)';
    el.style.boxShadow = '0 0 0 3px rgba(80,200,120,0.55)';
  }

  connect(fromNode, fromPortIndex, toNode, toPortIndex) {
    const input = toNode.inputs[toPortIndex];
    const output = fromNode.outputs[fromPortIndex];
    if (!input || !output || fromNode === toNode || !this.portsCompatible(output, input)) return;

    const exists = this.connections.some(conn =>
      conn.from.node === fromNode && conn.from.port === fromPortIndex &&
      conn.to.node === toNode && conn.to.port === toPortIndex
    );
    if (exists) {
      this.onNodeChange?.(toNode);
      return;
    }

    this.clearInputPort(toNode, toPortIndex);
    this.connections.push({
      from: { node: fromNode, port: fromPortIndex },
      to: { node: toNode, port: toPortIndex }
    });
    input.connectedFrom = {
      node: fromNode,
      portName: output.name || 'default'
    };
    this.updateConnections();
    this.resetDownstream(toNode);
    this.onNodeChange?.(toNode);
    this._scheduleSave?.();
  }

  clearInputPort(node, portIndex) {
    this._unresolvedConnections = (this._unresolvedConnections || []).filter(c =>
      c.toNodeId !== node.id || (c.toPortName != null ? c.toPortName !== node.inputs[portIndex]?.name : c.toPort !== portIndex));
    const removed = this.connections.filter(conn => conn.to.node === node && conn.to.port === portIndex);
    if (removed.length === 0) return;
    if (node.inputs[portIndex]) node.inputs[portIndex].connectedFrom = null;
    this.connections = this.connections.filter(conn => !removed.includes(conn));
    if (removed.includes(this.selectedConnection)) this.selectedConnection = null;
    this.resetDownstream(node);
    this._scheduleSave?.();
  }

  deleteConnection(conn) {
    if (!conn) return;
    const input = conn.to.node.inputs[conn.to.port];
    if (input?.connectedFrom?.node === conn.from.node) input.connectedFrom = null;
    this.connections = this.connections.filter(item => item !== conn);
    if (this.selectedConnection === conn) this.selectedConnection = null;
    this.updateConnections();
    this.resetDownstream(conn.to.node);
    this.onNodeChange?.(null);
    this._scheduleSave?.();
  }

  updateConnections() {
    for (const child of [...this.svg.children]) {
      if (child !== this.previewPath) child.remove();
    }
    const rect = this.overlay.getBoundingClientRect();

    for (const conn of this.connections) {
      const fromEl = conn.from.node.element?.querySelectorAll('.output-port')[conn.from.port];
      const toEl = conn.to.node.element?.querySelectorAll('.input-port')[conn.to.port];
      if (!fromEl?.isConnected || !toEl?.isConnected) continue;
      if (!this.nodes.includes(conn.from.node) || !this.nodes.includes(conn.to.node)) continue;

      const fromRect = fromEl.getBoundingClientRect();
      const toRect = toEl.getBoundingClientRect();
      const x1 = fromRect.left + fromRect.width / 2 - rect.left;
      const y1 = fromRect.top + fromRect.height / 2 - rect.top;
      const x2 = toRect.left + toRect.width / 2 - rect.left;
      const y2 = toRect.top + toRect.height / 2 - rect.top;
      const dx = Math.abs(x2 - x1) * 0.5;
      const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      const selected = conn === this.selectedConnection;

      const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hitPath.setAttribute('d', d);
      hitPath.setAttribute('stroke', 'transparent');
      hitPath.setAttribute('stroke-width', '14');
      hitPath.setAttribute('fill', 'none');
      hitPath.style.pointerEvents = 'stroke';
      hitPath.style.cursor = 'pointer';

      const visualPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      visualPath.setAttribute('d', d);
      visualPath.setAttribute('stroke', selected ? '#ffcc00' : '#4a90e2');
      visualPath.setAttribute('stroke-width', selected ? '3' : '2');
      visualPath.setAttribute('fill', 'none');
      visualPath.style.pointerEvents = 'none';

      hitPath.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.selectConnection(conn);
      });
      hitPath.addEventListener('mouseenter', () => {
        if (conn !== this.selectedConnection) {
          visualPath.setAttribute('stroke', '#6ab0ff');
          visualPath.setAttribute('stroke-width', '3');
        }
      });
      hitPath.addEventListener('mouseleave', () => {
        if (conn !== this.selectedConnection) {
          visualPath.setAttribute('stroke', '#4a90e2');
          visualPath.setAttribute('stroke-width', '2');
        }
      });

      conn.hitPath = hitPath;
      conn.visualPath = visualPath;
      this.svg.appendChild(hitPath);
      this.svg.appendChild(visualPath);
    }

    if (this.previewPath) this.svg.appendChild(this.previewPath);
  }

  selectConnection(conn) {
    this.deselectAll();
    this.selectedConnection = conn;
    this.updateConnections();
  }

  deselectAll() {
    if (this.selectedNode?.element) this.selectedNode.element.style.borderColor = '#333';
    for (const n of this.selectedNodes) {
      if (n?.element) n.element.style.borderColor = '#333';
    }
    const hadConnection = this.selectedConnection != null;
    this.selectedNode = null;
    this.selectedNodes = [];
    this.selectedConnection = null;
    this._updateSelectionTools();
    if (hadConnection) this.updateConnections();
    this._scheduleSave?.();
  }

  bindNodeDrag(node, el) {
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0 || graphInputBlocked(e)) return;
      if (e.target.closest('input, select, textarea, button, a, video, canvas, [contenteditable], .port, .add-node-btn, .preview-wrap')) return;
      el.focus({ preventScroll: true });
      window.getSelection()?.removeAllRanges();
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        this.setMultiSelected(this.selectedNodes.includes(node)
          ? this.selectedNodes.filter(item => item !== node) : [...this.selectedNodes, node]);
        e.preventDefault(); e.stopPropagation(); return;
      }
      this.selectNode(node);
      if (!e.target.closest('.node-drag-handle')) return;
      const group = this.selectedNodes.map(n => ({ node: n, x: n.x, y: n.y }));
      const zoom = this.viewport?.zoom || 1;
      const startX = e.clientX, startY = e.clientY;
      let moved = false;
      const finish = reason => {
        el.classList.remove('is-dragging');
        if (reason === 'escape') {
          for (const item of group) { item.node.x = item.x; item.node.y = item.y; this.applyNodeScreen(item.node); }
          this.updateConnections();
        } else if (moved && group.some(p => p.node.x !== p.x || p.node.y !== p.y)) {
          this.pushHistory({ type: 'moveNodes',
            before: group.map(p => ({ id: p.node.id, x: p.x, y: p.y })),
            after: group.map(p => ({ id: p.node.id, x: p.node.x, y: p.node.y })) });
          this._scheduleSave?.();
        }
      };
      if (startEditorGesture(e, {
        element: el,
        move: next => {
          const dx = next.clientX - startX, dy = next.clientY - startY;
          if (!moved && Math.hypot(dx, dy) < 4) return;
          moved = true; el.classList.add('is-dragging');
          for (const item of group) {
            item.node.x = item.x + dx / zoom; item.node.y = item.y + dy / zoom;
            this.applyNodeScreen(item.node);
          }
          this.updateConnections();
        },
        end: () => finish('up'), cancel: finish
      })) e.stopPropagation();
    });
  }

  selectNode(node) {
    // 如果点的节点已在框选集合里，保留多选（拖动时整组移动）
    if (this.selectedNodes.includes(node)) {
      this.selectedNode = node;
      return;
    }
    // 否则清空多选，只选这个
    if (this.selectedNode?.element && this.selectedNode !== node) {
      this.selectedNode.element.style.borderColor = '#333';
    }
    for (const n of this.selectedNodes) {
      if (n?.element && n !== node) n.element.style.borderColor = '#333';
    }
    this.selectedNodes = [node];
    this._updateSelectionTools();
    const hadConnection = this.selectedConnection != null;
    this.selectedConnection = null;
    this.selectedNode = node;
    node.element.style.borderColor = '#4a90e2';
    if (hadConnection) this.updateConnections();
    this._scheduleSave?.();
  }

  /**
   * 视口平移/缩放后调用：把每个节点的世界坐标重新换算成屏幕坐标并整体缩放，
   * 让节点像底层视频一样跟随无限画布运动；连线基于 DOM 实时位置，一并重绘。
   */
  syncViewport() {
    if (!this.viewport) return;
    if (this._zoomLabel) this._zoomLabel.textContent = `${Math.round(this.viewport.zoom * 100)}%`;
    for (const node of this.nodes) {
      this.applyNodeScreen(node);
    }
    this.updateConnections();
    this._scheduleSave?.();
  }

  deleteNode(node) {
    if (!node) return;
    cancelEditorGesture('node-delete');
    const downstream = [];
    for (const other of this.nodes) {
      if (other === node) continue;
      let detached = false;
      for (const input of other.inputs) {
        if (input.connectedFrom?.node === node) {
          input.connectedFrom = null;
          detached = true;
        }
      }
      if (detached) downstream.push(other);
    }

    node.dispose?.();
    node._videoElement?.pause?.();
    node.element?.remove();
    this.connections = this.connections.filter(conn => conn.from.node !== node && conn.to.node !== node);
    this.nodes = this.nodes.filter(item => item !== node);
    if (this.selectedNode === node) this.selectedNode = null;
    this.selectedNodes = this.selectedNodes.filter(n => n !== node);
    this._updateSelectionTools();
    if (this.selectedConnection && (this.selectedConnection.from.node === node || this.selectedConnection.to.node === node)) {
      this.selectedConnection = null;
    }
    for (const child of downstream) this.resetDownstream(child);
    this.closeSkillMenu();
    this.updateConnections();
    this.onNodeChange?.(null);
    this._scheduleSave?.();
  }

  resetDownstream(node, seen = new Set()) {
    if (!node || seen.has(node)) return;
    seen.add(node);
    node.reset();
    for (const conn of this.connections) {
      if (conn.from.node === node) this.resetDownstream(conn.to.node, seen);
    }
  }

  showSkillMenu(fromNode, fromPortIndex, btnElement) {
    this.closeSkillMenu();
    const outputType = fromNode.outputs[fromPortIndex]?.type;
    // 支持节点声明排除项（如视频卡片隐藏「视频预览」备用节点，保持工作流干净）
    const exclude = fromNode.constructor.menuExclude || [];
    const availableSkills = SkillRegistry.getByOutputType(outputType).filter(s => !exclude.includes(s.name));
    if (availableSkills.length === 0) return;

    const menu = document.createElement('div');
    menu.className = 'skill-menu';
    const rect = btnElement.getBoundingClientRect();
    menu.style.cssText = `
      position: fixed;
      top: ${rect.bottom + 6}px;
      left: ${rect.left}px;
      background: #1e1e2e;
      border: 1px solid #444;
      border-radius: 8px;
      padding: 6px;
      z-index: 1000;
      min-width: 150px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.6);
      pointer-events: auto;
    `;

    availableSkills.forEach(skill => {
      // 父菜单节点（有children的）
      const hasChildren = skill.children && skill.children.length > 0;
      // 子节点（有parent的）不直接显示在主菜单里
      if (skill.parent) return;

      const item = document.createElement('div');
      item.style.cssText = 'padding: 8px 12px; border-radius: 6px; cursor: pointer; color: #fff; font-size: 13px; margin-bottom: 2px; display:flex; justify-content:space-between; align-items:center;';
      item.innerHTML = `<span>${skill.name}</span>${hasChildren ? '<span style="color:#888; font-size:10px;">▶</span>' : ''}`;
      item.addEventListener('mouseenter', () => {
        item.style.background = '#2a2a4a';
        // 有子菜单的，悬停弹出子菜单
        if (hasChildren) {
          this._showSubMenu(item, skill.children, availableSkills, fromNode, fromPortIndex);
        } else {
          this._closeSubMenu();
        }
      });
      item.addEventListener('mouseleave', () => {
        item.style.background = 'transparent';
      });
      item.addEventListener('click', () => {
        if (hasChildren) return; // 有子菜单的点击不触发创建
        this.addSkillAfterNode(fromNode, fromPortIndex, skill);
        this.closeSkillMenu();
      });
      menu.appendChild(item);
    });

    document.body.appendChild(menu);
    this.skillMenu = menu;
  }

  closeSkillMenu() {
    this.skillMenu?.remove();
    this.skillMenu = null;
    this._closeSubMenu();
  }

  /** 显示子菜单 */
  _showSubMenu(parentItem, childNames, allSkills, fromNode, fromPortIndex) {
    this._closeSubMenu();
    const subMenu = document.createElement('div');
    subMenu.className = 'skill-sub-menu';
    const rect = parentItem.getBoundingClientRect();
    subMenu.style.cssText = `
      position: fixed;
      top: ${rect.top}px;
      left: ${rect.right + 4}px;
      background: #1e1e2e;
      border: 1px solid #444;
      border-radius: 8px;
      padding: 6px;
      z-index: 1001;
      min-width: 150px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.6);
      pointer-events: auto;
    `;

    childNames.forEach(childName => {
      const childSkill = allSkills.find(s => s.name === childName);
      if (!childSkill) return;
      const childItem = document.createElement('div');
      childItem.style.cssText = 'padding: 8px 12px; border-radius: 6px; cursor: pointer; color: #fff; font-size: 13px; margin-bottom: 2px;';
      childItem.textContent = childSkill.name;
      childItem.addEventListener('mouseenter', () => {
        childItem.style.background = '#2a2a4a';
      });
      childItem.addEventListener('mouseleave', () => {
        childItem.style.background = 'transparent';
      });
      childItem.addEventListener('click', () => {
        this.addSkillAfterNode(fromNode, fromPortIndex, childSkill);
        this.closeSkillMenu();
      });
      subMenu.appendChild(childItem);
    });

    document.body.appendChild(subMenu);
    this._subMenu = subMenu;
  }

  /** 关闭子菜单 */
  _closeSubMenu() {
    this._subMenu?.remove();
    this._subMenu = null;
  }

  findOpenSpot(fromNode) {
    let x = fromNode.x + fromNode.width + 80;
    let y = fromNode.y;
    const width = 380;
    const height = 280;
    for (let i = 0; i < 8; i++) {
      const blocked = this.nodes.some(node => {
        const nodeHeight = node.element?.offsetHeight || node.getHeight();
        return x < node.x + node.width + 20 && x + width > node.x
          && y < node.y + nodeHeight + 20 && y + height > node.y;
      });
      if (!blocked) break;
      y += 300;
    }
    return { x, y };
  }

  /**
   * 计算新节点的世界坐标。
   * 优先放在当前视口中心（ComfyUI 式：从菜单添加的节点始终出现在可见区域中央）；
   * 没有视口时退回源节点右侧的空位查找。
   */
  spotForNewNode(fromNode) {
    if (this.viewport) {
      const rect = this.overlay.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return this.viewport.screenToWorld(rect.width / 2, rect.height / 2);
      }
    }
    return this.findOpenSpot(fromNode);
  }

  addSkillAfterNode(fromNode, fromPortIndex, skill) {
    const spot = this.spotForNewNode(fromNode);
    const newNode = this.createNode(skill.class, spot.x, spot.y);
    if (newNode.inputs.length > 0) this.connect(fromNode, fromPortIndex, newNode, 0);
    this.updateConnections();
  }

  bindGlobalEvents() {
    document.addEventListener('mousedown', (e) => {
      if (graphInputBlocked(e) || !this.container.contains(e.target)) return;
      if (e.target.closest?.('.node-card') || 
          e.target.closest?.('.skill-menu') || 
          e.target.closest?.('.skill-sub-menu') || 
          e.target.closest?.('svg')) return;
      this.closeSkillMenu();
      this.deselectAll();
    });

    document.addEventListener('click', (e) => {
      if (graphInputBlocked(e)) return;
      if (!e.target.closest('.skill-menu') && 
          !e.target.closest('.skill-sub-menu') && 
          !e.target.closest('.add-node-btn')) {
        this.closeSkillMenu();
      }
    });
  }

  bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (graphInputBlocked(e) || isTextInput(e.target) || hasEditorGesture()) return;

      // Native copy/paste events own Ctrl+C / Ctrl+V, leaving text editing intact.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        if (e.key.toLowerCase() === 'a') { e.preventDefault(); this.setMultiSelected(this.nodes); return; }
        if (e.key.toLowerCase() === 'd') { e.preventDefault(); if (!e.repeat) this.clipboard.duplicate(); return; }
      }

      if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (e.key === 'Home') { e.preventDefault(); this.frameNodes(); return; }
        if (e.key.toLowerCase() === 'f' || e.key === '.') {
          e.preventDefault(); this.frameNodes(this.selectedNodes.length ? this.selectedNodes : this.nodes); return;
        }
      }

      // Ctrl+Z 撤销
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        this.undo();
        return;
      }

      // Ctrl+Shift+Z 重做
      if ((e.ctrlKey || e.metaKey) && ((e.shiftKey && e.key.toLowerCase() === 'z') || e.key.toLowerCase() === 'y')) {
        e.preventDefault();
        this.redo();
        return;
      }

      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (!this.selectedConnection && this.selectedNodes.length === 0 && !this.selectedNode) return;
      e.preventDefault();
      if (this.selectedConnection) {
        this.deleteConnection(this.selectedConnection);
        return;
      }
      // 框选多选：批量删除所有选中节点
      const toDelete = this.selectedNodes.length > 0
        ? this.selectedNodes.slice()
        : (this.selectedNode ? [this.selectedNode] : []);
      for (const node of toDelete) {
        const action = { type: 'deleteNode', node };
        this.pushHistory(action);
        this._detachHistoryNode(action);
      }
      this.selectedNodes = [];
      this._scheduleSave?.();
    });

    // F5：局部重算选中节点的上下游链路（对标 ComfyUI/Nuke 的局部刷新），
    // 普通 F5 保留局部重算；Ctrl+F5 允许整页刷新，由工作流持久化负责恢复。
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'F5' && e.code !== 'F5') return;
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      if (graphInputBlocked(e) || isTextInput(e.target) || hasEditorGesture()) return;
      e.preventDefault(); // 无论是否选中节点，一律拦截浏览器整页刷新
      const targets = this.selectedNodes.length > 0
        ? this.selectedNodes.slice()
        : (this.selectedNode ? [this.selectedNode] : []);
      if (targets.length === 0) {
        console.warn('[刷新] 未选中节点，F5 已拦截（画布未清空）。请先点击选中要刷新的节点。');
        this.toast?.('请先选中要刷新的节点，再按 F5');
        return;
      }
      this.refreshNodes(targets);
    });
  }

  /** 轻量提示条：右下角浮动显示，2.5 秒后自动消失 */
  toast(msg) {
    try {
      let el = document.getElementById('node-editor-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'node-editor-toast';
        el.style.cssText = `
          position: fixed; right: 20px; bottom: 24px; z-index: 99999;
          background: rgba(30,30,46,0.96); color: #fff; border: 1px solid #4a9eff;
          border-radius: 8px; padding: 10px 16px; font-size: 13px;
          box-shadow: 0 6px 20px rgba(0,0,0,0.5); pointer-events: none;
          transition: opacity 0.3s; max-width: 320px;
        `;
        document.body.appendChild(el);
      }
      el.textContent = msg;
      el.style.opacity = '1';
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2500);
    } catch (e) { /* 提示失败不影响功能 */ }
  }

  /**
   * 局部重算：重置选中节点的上游+自身+下游，并强制重新执行。
   * 预览节点的 rAF 循环下一帧自动读到新数据。
   */
  refreshNodes(targets) {
    const allUpstream = new Set();
    const collectUpstream = (node, seen = new Set()) => {
      for (const conn of this.connections) {
        if (conn.to.node === node && !seen.has(conn.from.node)) {
          seen.add(conn.from.node);
          allUpstream.add(conn.from.node);
          collectUpstream(conn.from.node, seen);
        }
      }
    };

    for (const node of targets) {
      // 1. 收集上游节点（递归）
      collectUpstream(node);
      // 2. 重置选中节点及所有下游
      this.resetDownstream(node);
    }

    // 3. 重置上游节点
    for (const up of allUpstream) up.reset();

    // 4. 强制重算：上游先执行，再执行选中节点（getOutput 会触发 execute）
    for (const up of allUpstream) up.getOutput();
    for (const node of targets) node.getOutput();

    console.log(`[刷新] 重算 ${targets.length} 个选中节点 + ${allUpstream.size} 个上游节点，下游已失效等待重算`);
    this.onNodeChange?.(null);
    this._scheduleSave?.();
  }
}

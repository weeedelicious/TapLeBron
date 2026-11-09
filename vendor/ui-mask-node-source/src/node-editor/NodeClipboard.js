import { snapshotWorkflow, parseWorkflow, instantiateWorkflow } from './WorkflowDocument.js';
import { graphInputBlocked, hasEditorGesture, isTextInput } from '../ui/EditorInteraction.js';

const PREFIX = 'WXHB_NODES_V1\n';
const MAX_TEXT = 8 * 1024 * 1024;
const MAX_NODES = 1000;
const clone = value => JSON.parse(JSON.stringify(value));

/** Versioned graph data only. File bytes, DOM and running jobs never enter the OS clipboard. */
export function readNodeClipboard(text) {
  if (!text?.startsWith(PREFIX)) return null;
  if (text.length > MAX_TEXT) throw new Error('复制的节点数据超过 8 MB，请分批复制');
  const payload = JSON.parse(text.slice(PREFIX.length));
  if (payload.format !== 'wxhb-node-selection' || payload.version !== 1) throw new Error('节点剪贴板版本不兼容');
  const data = parseWorkflow(JSON.stringify(payload.workflow));
  if (!data.nodes.length || data.nodes.length > MAX_NODES) throw new Error('一次可粘贴 1～1000 个节点');
  if (data.connections.length > MAX_NODES * 256) throw new Error('复制的连线数据过大');
  // These are new node instances, not another owner of a source node's job.
  for (const node of data.nodes) {
    if (node.maskTask) node.maskTask = { ...node.maskTask, exportId: null, confirmedRevision: null, forkOnEdit: true };
    if(node.modelMaskTask?.edit)node.modelMaskTask.edit={...node.modelMaskTask.edit,exportId:null,confirmedRevision:null,forkOnEdit:true};
    node.hudJob = null; node.hudComparison = null; node.hudAnalysis = null; node.hudStructurePreview = null;
    node.hudReferenceKeyframe = null; node.hudReferenceVideo = null;
  }
  return data;
}

export class NodeClipboard {
  constructor(editor, registry) {
    this.editor = editor; this.registry = registry;
    this.local = null; this.lastPaste = null; this.pointer = null;
    editor.container.addEventListener('pointermove', event => {
      if (graphInputBlocked(event) || event.target.closest?.('.canvas-navigation, .canvas-file-tools, .skill-menu, .skill-sub-menu')) return;
      const rect = editor.container.getBoundingClientRect();
      this.pointer = { x: event.clientX-rect.left, y: event.clientY-rect.top };
    });
    editor.container.addEventListener('pointerleave', () => { this.pointer = null; });
    document.addEventListener('copy', event => {
      if (!this.allowed(event) || window.getSelection()?.toString() || !this.selection().length) return;
      try {
        const local = this.capture();
        event.clipboardData.setData('text/plain', local.text);
        event.preventDefault(); this.copiedNotice(local);
      } catch (error) { editor.toast(`复制失败：${error.message}`); }
    });
    document.addEventListener('paste', event => {
      if (!this.allowed(event)) return;
      const text = event.clipboardData?.getData('text/plain');
      if (!text?.startsWith(PREFIX)) return;
      event.preventDefault(); this.pasteText(text);
    });
  }

  allowed(event) {
    return !graphInputBlocked(event) && !isTextInput(event?.target || document.activeElement) && !hasEditorGesture();
  }

  selection() {
    const editor = this.editor;
    return editor.selectedNodes.filter(node => editor.nodes.includes(node));
  }

  capture() {
    const editor = this.editor, nodes = this.selection();
    if (!nodes.length) throw new Error('请先点选、Shift 点选或框选节点');
    if (nodes.length > MAX_NODES) throw new Error('一次最多复制 1000 个节点，请分批选择');
    const selected = new Set(nodes.map(node => node.id));
    const workflow = clone(snapshotWorkflow({ nodes, selectedNodes: nodes, nodeIdCounter: 0, viewport: null,
      connections: editor.connections.filter(edge => selected.has(edge.from.node.id) && selected.has(edge.to.node.id)),
      _unresolvedConnections: (editor._unresolvedConnections || []).filter(edge => selected.has(edge.fromNodeId) && selected.has(edge.toNodeId)) }));
    for (const node of workflow.nodes) {
      node.hudJob = null; node.hudComparison = null; node.hudAnalysis = null; node.hudStructurePreview = null;
      node.hudReferenceKeyframe = null; node.hudReferenceVideo = null;
    }
    const text = PREFIX+JSON.stringify({ format: 'wxhb-node-selection', version: 1, workflow });
    readNodeClipboard(text);
    // File objects are immutable and shared only as source bytes. Each pasted node opens its own video element.
    const files = new Map(nodes.filter(node => node.getSourceFile?.()).map(node => [node.id, {
      file: node.getSourceFile(), persist: !node.mediaKey || !!(node._mediaSaving || node._mediaSaveError)
    }]));
    this.local = { text, files, nodeCount: nodes.length, connectionCount: workflow.connections.length };
    this.lastPaste = null;
    return this.local;
  }

  copiedNotice(local, fallback = false) {
    this.editor.toast(`已复制 ${local.nodeCount} 个节点、${local.connectionCount} 条内部连线${fallback ? '；系统剪贴板不可用，请点画布“粘贴”' : ''}`);
  }

  async copy() {
    if (!this.allowed()) return;
    let local;
    try { local = this.capture(); }
    catch (error) { this.editor.toast(error.message); return; }
    try { await navigator.clipboard.writeText(local.text); this.copiedNotice(local); }
    catch { local.localOnly = true; this.copiedNotice(local, true); }
  }

  async paste() {
    if (!this.allowed() || this.reading) return;
    this.reading = true;
    try {
      let text;
      try { text = this.local?.localOnly ? this.local.text : await navigator.clipboard.readText(); }
      catch {
        if (!this.local) { this.editor.toast('请先复制节点，再用 Ctrl+V 粘贴'); return; }
        text = this.local.text;
      }
      if (!this.allowed()) return;
      if (!text?.startsWith(PREFIX)) { this.editor.toast('剪贴板中没有本画布的节点，请先复制节点'); return; }
      this.pasteText(text);
    } finally { this.reading = false; }
  }

  duplicate() {
    if (!this.allowed()) return;
    // Quick duplication does not replace the user's copy/paste buffer.
    const previous = this.local, lastPaste = this.lastPaste;
    try {
      const captured = this.capture();
      this.pasteText(captured.text, { duplicate: true });
    } catch (error) { this.editor.toast(error.message); }
    finally { this.local = previous; this.lastPaste = lastPaste; }
  }

  pasteText(text, { duplicate = false } = {}) {
    if (!this.allowed()) return;
    const editor = this.editor;
    let staged;
    try {
      const data = readNodeClipboard(text);
      if (!data) return;
      const files = text === this.local?.text ? this.local.files : new Map();
      const idMap = new Map(), pastedFiles = new Map();
      const left = Math.min(...data.nodes.map(n => n.x)), top = Math.min(...data.nodes.map(n => n.y));
      let dx = 40, dy = 40;
      if (!duplicate) {
        const width = editor.container.clientWidth, height = editor.container.clientHeight;
        const point = this.pointer || { x: width/2, y: height/2 };
        const previous = this.lastPaste;
        const count = previous?.text === text && Math.abs(previous.x-point.x) < 2 && Math.abs(previous.y-point.y) < 2
          ? previous.count+1 : 0;
        const screen = {
          x: 24+((Math.max(0, point.x-24)+count*32) % Math.max(32, width-80)),
          y: 64+((Math.max(0, point.y-64)+count*32) % Math.max(32, height-160))
        };
        const world = editor.viewport?.screenToWorld(screen.x, screen.y) || screen;
        dx = world.x-left; dy = world.y-top;
        this.lastPaste = { text, x: point.x, y: point.y, count };
      }
      for (const saved of data.nodes) {
        const id = editor.allocateNodeId();
        idMap.set(saved.id, id);
        if (files.has(saved.id)) pastedFiles.set(id, files.get(saved.id));
        saved.id = id; saved.x += dx; saved.y += dy;
        if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) throw new Error('节点位置超出有效范围，请调整画布后重试');
      }
      data.connections = data.connections.map(edge => ({ ...edge,
        fromNodeId: idMap.get(edge.fromNodeId), toNodeId: idMap.get(edge.toNodeId) }));
      staged = instantiateWorkflow(data, this.registry);
      // Render first; a render error must not leave half of a pasted graph committed.
      for (const node of staged.nodes) editor.renderNode(node);
      editor.nodes.push(...staged.nodes); editor.connections = editor.connections.concat(staged.connections);
      editor._unresolvedConnections = [...(editor._unresolvedConnections || []), ...staged.unresolved];
      editor.pushHistory({ type: 'pasteNodes', entries: staged.nodes.map(node => ({ node })) });
      editor.setMultiSelected(staged.nodes);
      // All nodes and edges exist before a preview can start reading its input.
      for (const node of staged.nodes) {
        const source = pastedFiles.get(node.id);
        if (source && node.setVideoFile) {
          node.setVideoFile(source.file, null, { persist: source.persist, reuseCanvasVideo: false })
            .catch(error => { node._mediaRestoreError = true; editor.toast(`素材加载失败：${error.message}`); });
        }
        try { node.onRendered?.(); }
        catch (error) { console.warn('粘贴后的节点界面需检查', node.id, error); editor.toast('节点已粘贴，部分预览初始化失败；配置与连线已保留'); }
      }
      editor.updateConnections(); editor._scheduleSave?.();
      requestAnimationFrame(() => editor.updateConnections());
      editor.toast(`已${duplicate ? '复制' : '粘贴'} ${staged.nodes.length} 个节点、${staged.connections.length} 条内部连线${staged.unresolved.length ? `；${staged.unresolved.length} 条连线待恢复` : ''}；Ctrl+Z 可整组撤销`);
    } catch (error) {
      for (const node of staged?.nodes || []) {
        if (!editor.nodes.includes(node)) { node.dispose?.(); node.element?.remove(); }
      }
      editor.toast(`粘贴失败：${error.message}`);
    }
  }
}

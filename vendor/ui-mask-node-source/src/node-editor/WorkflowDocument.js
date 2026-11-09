import { maskRangesFor, validateMaskRanges } from '../ui/MaskTiming.js';
import { BaseNode } from './BaseNode.js';

export const WORKFLOW_KEY = 'wxhb_canvas_state';
export const BACKUP_KEY = 'wxhb_canvas_state_backup';
export const WORKFLOW_VERSION = 3;
const clone = value => JSON.parse(JSON.stringify(value));
const record = value => value && typeof value === 'object' && !Array.isArray(value);

// Persist document data only. DOM, video elements and model code belong to the runtime.
export function snapshotWorkflow(editor) {
  return {
    version: WORKFLOW_VERSION,
    nodes: editor.nodes.map(node => ({
      ...node._savedNodeData,
      id: node.id,
      nodeId: node._savedType || node.constructor.nodeId || node.type,
      title: node._savedNodeData?.title || node.constructor.nodeName,
      x: node.x, y: node.y,
      params: { ...node._savedNodeData?.params,
        ...Object.fromEntries(Object.entries(node.params).map(([key, param]) => [key, param.value])) },
      masks: clone(node.masks || node._savedNodeData?.masks || []),
      maskRanges: clone(maskRangesFor(node.masks || node._savedNodeData?.masks || [], node.maskRanges || node._savedNodeData?.maskRanges)),
      hudJob: node.hudJob || null,
      hudComparison: node.hudComparison || null,
      hudStructurePreview: node.hudStructurePreview || null,
      hudReferenceKeyframe: clone(node.hudReferenceKeyframe || null),
      hudReferenceVideo: clone(node.hudReferenceVideo || null),
      hudAnalysis: node.hudAnalysis || null,
      maskTask: clone(node.maskTask || null),
      modelMaskTask: clone(node.modelMaskTask || null),
      legacyMasks: clone(node.legacyMasks || null),
      legacyRanges: clone(node.legacyRanges || null),
      legacyWindow: clone(node.legacyWindow || null),
      mediaKey: node.mediaKey || null,
      media: node.media || null,
      ports: {
        inputs: node.inputs.map(({ name, type }) => ({ name, type })),
        outputs: node.outputs.map(({ name, type }) => ({ name, type }))
      }
    })),
    connections: [
      ...editor.connections.map(c => ({
        fromNodeId: c.from.node.id, fromPort: c.from.port,
        fromPortName: c.from.node.outputs[c.from.port].name,
        toNodeId: c.to.node.id, toPort: c.to.port,
        toPortName: c.to.node.inputs[c.to.port].name
      })),
      ...(editor._unresolvedConnections || []).filter(c =>
        editor.nodes.some(n => n.id === c.fromNodeId) && editor.nodes.some(n => n.id === c.toNodeId))
    ],
    nodeIdCounter: editor.nodeIdCounter,
    viewport: editor.viewport ? {
      panX: editor.viewport.panX, panY: editor.viewport.panY, zoom: editor.viewport.zoom
    } : null,
    selectedNodeIds: editor.selectedNodes.map(node => node.id)
  };
}

export function parseWorkflow(raw) {
  const data = JSON.parse(raw);
  if (!record(data) || !Array.isArray(data.nodes) || !Array.isArray(data.connections)) {
    throw new Error('工作流数据不完整');
  }
  if (data.version != null && (!Number.isInteger(data.version) || data.version < 1 || data.version > WORKFLOW_VERSION)) {
    throw new Error('工作流版本不兼容，请保留备份并使用对应版本');
  }
  const ids = new Set();
  for (const node of data.nodes) {
    if (!record(node) || typeof node.id !== 'string' || !node.id || ids.has(node.id)
      || !Number.isFinite(node.x) || !Number.isFinite(node.y) || !record(node.params)) {
      throw new Error('节点数据不完整或存在重复编号');
    }
    if (node.masks != null && (!Array.isArray(node.masks) || node.masks.some(mask =>
      !Array.isArray(mask) || mask.some(point => !record(point) || !Number.isFinite(point.x) || !Number.isFinite(point.y))))) {
      throw new Error('遮罩数据不完整');
    }
    validateMaskRanges(node.masks || [], node.maskRanges);
    if (node.ports != null && (!record(node.ports) || ['inputs', 'outputs'].some(direction =>
      !Array.isArray(node.ports[direction]) || node.ports[direction].length > 256
      || node.ports[direction].some(port => !record(port) || typeof port.name !== 'string' || typeof port.type !== 'string')))) {
      throw new Error('节点端口数据不完整');
    }
    ids.add(node.id);
  }
  for (const edge of data.connections) {
    if (!record(edge) || typeof edge.fromNodeId !== 'string' || typeof edge.toNodeId !== 'string'
      || !ids.has(edge.fromNodeId) || !ids.has(edge.toNodeId)
      || !Number.isInteger(edge.fromPort) || edge.fromPort < 0 || edge.fromPort >= 256
      || !Number.isInteger(edge.toPort) || edge.toPort < 0 || edge.toPort >= 256) {
      throw new Error('连线数据不完整');
    }
  }
  if (data.selectedNodeIds != null && (!Array.isArray(data.selectedNodeIds) || data.selectedNodeIds.some(id => typeof id !== 'string'))) {
    throw new Error('节点选择数据不完整');
  }
  if (data.viewport != null && (!record(data.viewport) || !Number.isFinite(data.viewport.panX)
    || !Number.isFinite(data.viewport.panY) || !Number.isFinite(data.viewport.zoom) || data.viewport.zoom <= 0)) {
    throw new Error('画布视角数据不完整');
  }
  return data;
}

function legacyType(data) {
  // Older saves omitted static nodeId for some classes. Only infer unambiguous types.
  if (data.nodeId) return data.nodeId;
  if ('targetFps' in data.params) return 'fps_convert';
  if ('filename' in data.params && 'format' in data.params) return 'video_export';
  if ('fileName' in data.params && 'originalFps' in data.params) return 'video_input';
  return 'unknown_legacy';
}

class UnavailableNode extends BaseNode {
  static nodeName = '待恢复节点';
  constructor(data, connections) {
    super(data.id, 'unavailable', data.x, data.y);
    this._savedType = legacyType(data);
    for (const [direction, add, idKey, indexKey, nameKey] of [
      ['inputs', 'addInput', 'toNodeId', 'toPort', 'toPortName'],
      ['outputs', 'addOutput', 'fromNodeId', 'fromPort', 'fromPortName']
    ]) {
      const ports = data.ports?.[direction] || [];
      const edges = connections.filter(c => c[idKey] === data.id);
      const count = Math.max(ports.length, ...edges.map(c => c[indexKey] + 1), 0);
      for (let i = 0; i < count; i++) {
        this[add](ports[i]?.name || edges.find(c => c[indexKey] === i)?.[nameKey] || `端口 ${i + 1}`, ports[i]?.type || 'video');
      }
    }
  }
  onRendered() {
    const note = document.createElement('p');
    note.className = 'workflow-node-warning';
    note.textContent = `${this._savedNodeData.title || this._savedType} 暂不可用；参数和连线已保留，恢复对应代码后可继续。`;
    this.element.appendChild(note);
  }
}

export function instantiateWorkflow(data, registry) {
  // Migrate stored geometry and wires; no retired repair controller is instantiated.
  data = clone(data);
  const removed = new Set(), previews = new Set();
  for (const saved of data.nodes) {
    if (legacyType(saved) === 'hud_removal') {
      removed.add(saved.id);
      saved.nodeId = 'ui_mask'; saved.title = 'UI遮罩';
      saved.legacyMasks = saved.masks || []; saved.legacyRanges = saved.maskRanges || null;
      saved.legacyWindow = { start: Math.max(0, Number(saved.params.start) || 0), end: Number(saved.params.end) > 0 ? Number(saved.params.end) : null };
      saved.masks = []; saved.maskRanges = []; saved.params = { dynamicMode: 'follow', outputCategory: 'static' };
      saved.ports = { inputs: [{ name: '视频源', type: 'video' }], outputs: [{ name: '遮罩视频', type: 'video' }] };
      for (const key of Object.keys(saved)) if (key.startsWith('hud')) delete saved[key];
    } else if (legacyType(saved) === 'hud_preview') {
      previews.add(saved.id); saved.nodeId = 'video_preview'; saved.title = '视频预览'; saved.params = {};
      saved.ports = { inputs: [{ name: '视频源', type: 'video' }], outputs: [{ name: '预览视频', type: 'video' }] };
      for (const key of Object.keys(saved)) if (key.startsWith('hud')) delete saved[key];
    }
  }
  for (const edge of data.connections) {
    if (removed.has(edge.fromNodeId)) edge.fromPortName = '遮罩视频';
    if (previews.has(edge.fromNodeId)) edge.fromPortName = '预览视频';
    if (previews.has(edge.toNodeId)) edge.toPortName = '视频源';
  }
  const nodes = [], map = new Map(), connections = [], unresolved = [];
  let unavailable = 0;
  for (const saved of data.nodes) {
    const type = legacyType(saved);
    const Class = registry.find(skill => skill.class?.nodeId === type)?.class;
    const node = Class ? new Class(saved.id, saved.x, saved.y) : new UnavailableNode(saved, data.connections);
    if (!Class) unavailable++;
    node._savedNodeData = clone(saved);
    for (const [key, value] of Object.entries(saved.params)) {
      if (Object.hasOwn(node.params, key)) node.params[key].value = value;
    }
    if (saved.masks) node.masks = clone(saved.masks);
    if (node.masks) node.maskRanges = clone(maskRangesFor(node.masks, saved.maskRanges));
    node.hudJob = saved.hudJob || null;
    node.hudComparison = saved.hudComparison || null;
    node.hudStructurePreview = saved.hudStructurePreview || null;
    node.hudReferenceKeyframe = clone(saved.hudReferenceKeyframe || null);
    node.hudReferenceVideo = clone(saved.hudReferenceVideo || null);
    node.hudAnalysis = saved.hudAnalysis || null;
    node.maskTask = clone(saved.maskTask || null);
    node.modelMaskTask = clone(saved.modelMaskTask || null);
    node.legacyMasks = clone(saved.legacyMasks || null);
    node.legacyRanges = clone(saved.legacyRanges || null);
    node.legacyWindow = clone(saved.legacyWindow || null);
    // Version 1 stored media by node ID. New documents use an independent media ID.
    node.mediaKey = saved.mediaKey || ((data.version || 1) < 2 && type === 'video_input' ? saved.id : null);
    node.media = saved.media || null;
    nodes.push(node); map.set(node.id, node);
  }
  for (const saved of data.connections) {
    const from = map.get(saved.fromNodeId), to = map.get(saved.toNodeId);
    const fromPort = saved.fromPortName != null ? from?.outputs.findIndex(p => p.name === saved.fromPortName) : saved.fromPort;
    const toPort = saved.toPortName != null ? to?.inputs.findIndex(p => p.name === saved.toPortName) : saved.toPort;
    const output = from?.outputs[fromPort], input = to?.inputs[toPort];
    if (!output || !input || input.connectedFrom || (output.type !== input.type && output.type !== 'any' && input.type !== 'any')) {
      unresolved.push(saved); continue;
    }
    input.connectedFrom = { node: from, portName: output.name };
    connections.push({ from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
  }
  return { nodes, connections, unresolved, unavailable };
}

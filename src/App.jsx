import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addEdge,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState
} from '@xyflow/react';
import {
  Check,
  Circle,
  CopyPlus,
  AudioLines,
  FileText,
  ImageIcon,
  KeyRound,
  LayoutDashboard,
  LogOut,
  PanelRightOpen,
  Plus,
  Shield,
  Trash2,
  UserRound,
  Users,
  Video,
  X
} from 'lucide-react';
import CanvasApp from './canvas/App';

const kindMeta = {
  input: { label: '输入', tone: 'teal' },
  prompt: { label: '提示词', tone: 'amber' },
  model: { label: '模型', tone: 'blue' },
  review: { label: '审核', tone: 'rose' },
  output: { label: '输出', tone: 'green' },
  text: { label: '文本', tone: 'amber' },
  image: { label: '图片', tone: 'blue' },
  video: { label: '视频', tone: 'rose' },
  audio: { label: '音频', tone: 'teal' }
};

const toolbarKinds = ['input', 'prompt', 'model', 'review', 'output'];

const nodeChoices = [
  { kind: 'text', label: '文本', description: '脚本、广告词、品牌文案', icon: FileText },
  { kind: 'image', label: '图片', description: '', icon: ImageIcon },
  { kind: 'video', label: '视频', description: '', icon: Video },
  { kind: 'audio', label: '音频', description: '', icon: AudioLines }
];

const imageModelOptions = [
  { value: 'nano-banana-pro', label: 'Nano-banana Pro' },
  { value: 'gpt-image-2', label: 'GPT image 2.0' }
];

const imageRatioOptions = ['1:1', '16:9', '9:16', '4:3', '3:4'];
const imageQualityOptions = ['1K', '2K', '4K'];

const seedanceModes = [
  { value: 'text_to_video', label: '文生视频' },
  { value: 'first_frame', label: '首帧图生视频' },
  { value: 'first_last_frame', label: '首尾帧' },
  { value: 'reference', label: '多模态参考' },
  { value: 'edit', label: '编辑视频' },
  { value: 'extend', label: '延长视频' }
];

const seedanceRatios = ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'];
const seedanceResolutions = ['480p', '720p'];

function defaultNodeConfig(kind) {
  if (kind === 'image') {
    return {
      model: 'nano-banana-pro',
      prompt: '',
      ratio: '1:1',
      quality: '2K',
      assetUrl: ''
    };
  }

  if (kind === 'video') {
    return {
      provider: 'jimeng-seedance-2',
      model: 'doubao-seedance-2-0-260128',
      mode: 'text_to_video',
      prompt: '',
      ratio: '16:9',
      resolution: '720p',
      duration: 5,
      generateAudio: true,
      watermark: false,
      webSearch: false,
      imageRefs: '',
      videoRefs: '',
      audioRefs: ''
    };
  }

  return {};
}

function nodeConfig(kind, data) {
  return { ...defaultNodeConfig(kind), ...(data.config || {}) };
}

function splitRefs(value) {
  return String(value || '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildSeedancePayload(config) {
  const content = [];
  const prompt = String(config.prompt || '').trim();
  if (prompt) {
    content.push({ type: 'text', text: prompt });
  }

  splitRefs(config.imageRefs).forEach((url, index) => {
    let role = 'reference_image';
    if (config.mode === 'first_frame') role = 'first_frame';
    if (config.mode === 'first_last_frame') role = index === 0 ? 'first_frame' : 'last_frame';
    content.push({ type: 'image_url', image_url: { url }, role });
  });

  splitRefs(config.videoRefs).forEach((url) => {
    content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' });
  });

  splitRefs(config.audioRefs).forEach((url) => {
    content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' });
  });

  return {
    model: config.model,
    content,
    generate_audio: Boolean(config.generateAudio),
    resolution: config.resolution,
    ratio: config.ratio,
    duration: Number(config.duration) || 5,
    watermark: Boolean(config.watermark),
    ...(config.webSearch ? { tools: [{ type: 'web_search' }] } : {})
  };
}

async function api(path, options = {}) {
  const headers = options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers;
  const response = await fetch(path, {
    credentials: 'include',
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || '请求失败');
    error.payload = payload;
    throw error;
  }
  return payload;
}

function uid(prefix = 'node') {
  if (crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatLastUsedAt(value) {
  if (!value) return '未使用';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未使用';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function WorkflowNode({ data, selected }) {
  const meta = kindMeta[data.kind] || kindMeta.input;

  if (data.kind === 'image' || data.kind === 'video') {
    const config = nodeConfig(data.kind, data);
    const isVideo = data.kind === 'video';
    const Icon = isVideo ? Video : ImageIcon;
    const modelLabel = isVideo
      ? '即梦 Seedance 2.0'
      : imageModelOptions.find((option) => option.value === config.model)?.label || 'Nano-banana Pro';
    const prompt = config.prompt || data.description || '';
    const metaLine = isVideo
      ? `${seedanceModes.find((mode) => mode.value === config.mode)?.label || '文生视频'} · ${config.ratio} · ${
          config.resolution
        } · ${config.duration}s${config.generateAudio ? ' · 有声' : ' · 无声'}`
      : `${config.ratio} · ${config.quality}`;

    return (
      <div className={`media-workflow-node ${selected ? 'is-selected' : ''}`} data-media={data.kind}>
        <Handle type="target" position={Position.Left} />
        <div className="media-node-heading">
          <span>
            <Icon size={14} />
            {isVideo ? 'Video' : 'Image'}
          </span>
          <span className="media-upload-chip">上传</span>
        </div>
        <div className="media-preview-box">
          <Icon size={34} />
        </div>
        <div className="media-prompt-panel">
          <div className="media-prompt-actions">
            <span className="media-square-action">✦</span>
            <span className="media-square-action">+</span>
          </div>
          <div className="media-prompt-text">{prompt || '描述任何你想要生成的内容'}</div>
          <div className="media-meta-row">
            <strong>{modelLabel}</strong>
            <span>{metaLine}</span>
          </div>
        </div>
        <Handle type="source" position={Position.Right} />
      </div>
    );
  }

  return (
    <div className={`workflow-node ${selected ? 'is-selected' : ''}`} data-tone={meta.tone}>
      <Handle type="target" position={Position.Left} />
      <div className="node-topline">
        <span className="node-kind">{meta.label}</span>
        <Circle size={12} />
      </div>
      <div className="node-title">{data.label || '未命名节点'}</div>
      <div className="node-desc">{data.description || ' '}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { workflow: WorkflowNode };

function CanvasContextMenu({ menu, onUpload, onAddAsset, onOpenNodePicker, onSelectNodeType, onAddTool }) {
  if (!menu) return null;

  if (menu.mode === 'node-picker') {
    return (
      <div
        className="canvas-context-menu node-picker-menu"
        style={{ left: menu.x, top: menu.y }}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div className="node-picker-title">添加节点</div>
        <div className="node-choice-list">
          {nodeChoices.map((choice, index) => {
            const Icon = choice.icon;
            return (
              <button
                key={choice.kind}
                className={`node-choice-item ${index === 0 ? 'is-active' : ''}`}
                onClick={() => onSelectNodeType(choice)}
              >
                <span className="node-choice-icon">
                  <Icon size={18} />
                </span>
                <span className="node-choice-copy">
                  <strong>{choice.label}</strong>
                  {choice.description ? <small>{choice.description}</small> : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div
      className="canvas-context-menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button className="context-menu-item is-primary" onClick={onUpload}>
        上传
      </button>
      <button className="context-menu-item" onClick={onAddAsset}>
        添加资产
      </button>
      <div className="context-menu-separator" />
      <button className="context-menu-item" onClick={onOpenNodePicker}>
        添加节点
      </button>
      <button className="context-menu-item" onClick={onAddTool}>
        添加辅助工具
      </button>
      <div className="context-menu-separator" />
      <button className="context-menu-item" disabled>
        <span>撤销</span>
        <kbd>CtrlZ</kbd>
      </button>
      <button className="context-menu-item" disabled>
        <span>重做</span>
        <kbd>ShiftCtrlZ</kbd>
      </button>
      <div className="context-menu-separator" />
      <button className="context-menu-item" disabled>
        <span>粘贴</span>
        <kbd>CtrlV</kbd>
      </button>
    </div>
  );
}

function Login({ onLogin }) {
  const [users, setUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [password, setPassword] = useState('');
  const [setupUser, setSetupUser] = useState(null);
  const [setupPassword, setSetupPassword] = useState('');
  const [setupConfirm, setSetupConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const selectedUser = users.find((user) => String(user.id) === String(selectedUserId));

  async function loadLoginUsers() {
    try {
      const data = await api('/api/auth/users');
      setUsers(data.users);
      setSelectedUserId((current) => current || String(data.users[0]?.id || ''));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadLoginUsers();
  }, []);

  async function submit(event) {
    event.preventDefault();
    setError('');

    if (!selectedUser) {
      setError('请选择账号');
      return;
    }

    if (!selectedUser.hasPassword) {
      setSetupUser(selectedUser);
      setSetupPassword('');
      setSetupConfirm('');
      return;
    }

    setLoading(true);
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: { username: selectedUser.username, password }
      });
      onLogin(data.user);
    } catch (err) {
      if (err.payload?.requiresPasswordSetup) {
        setSetupUser(err.payload.user);
        setSetupPassword('');
        setSetupConfirm('');
        return;
      }
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function submitSetupPassword(event) {
    event.preventDefault();
    setError('');

    if (setupPassword !== setupConfirm) {
      setError('两次输入的密码不一致');
      return;
    }

    setLoading(true);
    try {
      const data = await api('/api/auth/setup-password', {
        method: 'POST',
        body: { userId: setupUser.id, password: setupPassword }
      });
      onLogin(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel" aria-label="登录">
        <div className="brand-lockup">
          <div className="brand-mark">
            <LayoutDashboard size={26} />
          </div>
          <div>
            <h1>画布工作台</h1>
            <p>节点式创意流程</p>
          </div>
        </div>
        <form onSubmit={submit} className="login-form">
          <label>
            <span>账号</span>
            <select
              value={selectedUserId}
              onChange={(event) => {
                setSelectedUserId(event.target.value);
                setPassword('');
                setError('');
              }}
              autoFocus
            >
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.username}
                  {user.hasPassword ? '' : '（未设密码）'}
                </option>
              ))}
            </select>
          </label>
          {selectedUser?.hasPassword ? (
            <label>
              <span>密码</span>
              <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" />
            </label>
          ) : null}
          {error && !setupUser ? <div className="form-error">{error}</div> : null}
          <button type="submit" className="primary-button" disabled={loading || !selectedUser}>
            <Check size={18} />
            {loading ? '处理中' : '登录'}
          </button>
        </form>
      </section>
      {setupUser ? (
        <section className="setup-overlay" aria-label="设置密码">
          <form className="setup-dialog" onSubmit={submitSetupPassword}>
            <div className="admin-header">
              <div className="panel-title">
                <KeyRound size={18} />
                设置密码
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={() => {
                  setSetupUser(null);
                  setError('');
                }}
                title="关闭"
              >
                <X size={18} />
              </button>
            </div>
            <div className="setup-user">{setupUser.username}</div>
            <label className="field">
              <span>新密码</span>
              <input
                value={setupPassword}
                onChange={(event) => setSetupPassword(event.target.value)}
                type="password"
                autoFocus
              />
            </label>
            <label className="field">
              <span>确认密码</span>
              <input
                value={setupConfirm}
                onChange={(event) => setSetupConfirm(event.target.value)}
                type="password"
              />
            </label>
            {error ? <div className="form-error">{error}</div> : null}
            <button className="primary-button" type="submit" disabled={loading}>
              <Check size={18} />
              {loading ? '设置中' : '设置并登录'}
            </button>
          </form>
        </section>
      ) : null}
    </main>
  );
}

function CanvasList({ canvases, activeId, onOpen, onCreate, onDelete }) {
  return (
    <div className="canvas-list">
      <button className="primary-button compact" onClick={onCreate}>
        <Plus size={17} />
        新建画布
      </button>
      <div className="canvas-scroll">
        {canvases.map((canvas) => (
          <button
            key={canvas.id}
            className={`canvas-row ${String(activeId) === String(canvas.id) ? 'active' : ''}`}
            onClick={() => onOpen(canvas.id)}
          >
            <span>
              <strong>{canvas.title}</strong>
              <small>
                {canvas.nodeCount} 节点 / {canvas.edgeCount} 连线
              </small>
            </span>
            <Trash2
              size={16}
              onClick={(event) => {
                event.stopPropagation();
                onDelete(canvas.id);
              }}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

function Inspector({ canvas, selectedNode, onTitleChange, onNodeChange, onDeleteNode }) {
  if (!canvas) {
    return (
      <aside className="inspector">
        <div className="empty-state">
          <LayoutDashboard size={34} />
          <strong>选择或新建画布</strong>
        </div>
      </aside>
    );
  }

  if (selectedNode) {
    const meta = kindMeta[selectedNode.data.kind] || kindMeta.input;
    const isImageNode = selectedNode.data.kind === 'image';
    const isVideoNode = selectedNode.data.kind === 'video';

    if (isImageNode || isVideoNode) {
      const config = nodeConfig(selectedNode.data.kind, selectedNode.data);
      const updateConfig = (patch) => {
        const nextConfig = { ...config, ...patch };
        onNodeChange({
          config: nextConfig,
          ...(patch.prompt !== undefined ? { description: patch.prompt } : {})
        });
      };

      return (
        <aside className="inspector media-inspector">
          <div className="panel-title">
            {isVideoNode ? <Video size={18} /> : <ImageIcon size={18} />}
            {isVideoNode ? '视频节点' : '图片节点'}
          </div>
          <label className="field">
            <span>标题</span>
            <input value={selectedNode.data.label || ''} onChange={(event) => onNodeChange({ label: event.target.value })} />
          </label>
          {isImageNode ? (
            <>
              <label className="field">
                <span>模型</span>
                <select value={config.model} onChange={(event) => updateConfig({ model: event.target.value })}>
                  {imageModelOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>提示词</span>
                <textarea
                  value={config.prompt}
                  onChange={(event) => updateConfig({ prompt: event.target.value })}
                  rows={7}
                />
              </label>
              <div className="field-grid two">
                <label className="field">
                  <span>比例</span>
                  <select value={config.ratio} onChange={(event) => updateConfig({ ratio: event.target.value })}>
                    {imageRatioOptions.map((ratio) => (
                      <option key={ratio} value={ratio}>
                        {ratio}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>清晰度</span>
                  <select value={config.quality} onChange={(event) => updateConfig({ quality: event.target.value })}>
                    {imageQualityOptions.map((quality) => (
                      <option key={quality} value={quality}>
                        {quality}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="field">
                <span>参考图 URL / 素材</span>
                <input value={config.assetUrl} onChange={(event) => updateConfig({ assetUrl: event.target.value })} />
              </label>
            </>
          ) : (
            <>
              <label className="field">
                <span>模型</span>
                <select value="jimeng-seedance-2" onChange={() => {}}>
                  <option value="jimeng-seedance-2">即梦 Seedance 2.0</option>
                </select>
              </label>
              <label className="field">
                <span>生成模式</span>
                <select value={config.mode} onChange={(event) => updateConfig({ mode: event.target.value })}>
                  {seedanceModes.map((mode) => (
                    <option key={mode.value} value={mode.value}>
                      {mode.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>提示词</span>
                <textarea
                  value={config.prompt}
                  onChange={(event) => updateConfig({ prompt: event.target.value })}
                  rows={7}
                />
              </label>
              <div className="field-grid three">
                <label className="field">
                  <span>比例</span>
                  <select value={config.ratio} onChange={(event) => updateConfig({ ratio: event.target.value })}>
                    {seedanceRatios.map((ratio) => (
                      <option key={ratio} value={ratio}>
                        {ratio}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>分辨率</span>
                  <select value={config.resolution} onChange={(event) => updateConfig({ resolution: event.target.value })}>
                    {seedanceResolutions.map((resolution) => (
                      <option key={resolution} value={resolution}>
                        {resolution}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>时长</span>
                  <input
                    type="number"
                    min="-1"
                    max="15"
                    value={config.duration}
                    onChange={(event) => updateConfig({ duration: event.target.value })}
                  />
                </label>
              </div>
              <div className="check-grid">
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={Boolean(config.generateAudio)}
                    onChange={(event) => updateConfig({ generateAudio: event.target.checked })}
                  />
                  <span>有声视频</span>
                </label>
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={Boolean(config.watermark)}
                    onChange={(event) => updateConfig({ watermark: event.target.checked })}
                  />
                  <span>水印</span>
                </label>
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={Boolean(config.webSearch)}
                    onChange={(event) => updateConfig({ webSearch: event.target.checked })}
                  />
                  <span>联网搜索</span>
                </label>
              </div>
              <label className="field">
                <span>参考图片 URL / asset</span>
                <textarea
                  value={config.imageRefs}
                  onChange={(event) => updateConfig({ imageRefs: event.target.value })}
                  rows={3}
                />
              </label>
              <label className="field">
                <span>参考视频 URL / asset</span>
                <textarea
                  value={config.videoRefs}
                  onChange={(event) => updateConfig({ videoRefs: event.target.value })}
                  rows={3}
                />
              </label>
              <label className="field">
                <span>参考音频 URL / asset</span>
                <textarea
                  value={config.audioRefs}
                  onChange={(event) => updateConfig({ audioRefs: event.target.value })}
                  rows={3}
                />
              </label>
              <label className="field">
                <span>API 参数预览</span>
                <textarea className="api-preview" value={JSON.stringify(buildSeedancePayload(config), null, 2)} readOnly rows={10} />
              </label>
            </>
          )}
          <div className={`kind-chip ${meta.tone}`}>{meta.label}</div>
          <button className="ghost-button danger" onClick={onDeleteNode}>
            <Trash2 size={17} />
            删除节点
          </button>
        </aside>
      );
    }

    return (
      <aside className="inspector">
        <div className="panel-title">
          <PanelRightOpen size={18} />
          节点
        </div>
        <label className="field">
          <span>类型</span>
          <select value={selectedNode.data.kind || 'input'} onChange={(event) => onNodeChange({ kind: event.target.value })}>
            {Object.entries(kindMeta).map(([key, item]) => (
              <option key={key} value={key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>标题</span>
          <input value={selectedNode.data.label || ''} onChange={(event) => onNodeChange({ label: event.target.value })} />
        </label>
        <label className="field">
          <span>内容</span>
          <textarea
            value={selectedNode.data.description || ''}
            onChange={(event) => onNodeChange({ description: event.target.value })}
            rows={8}
          />
        </label>
        <div className={`kind-chip ${meta.tone}`}>{meta.label}</div>
        <button className="ghost-button danger" onClick={onDeleteNode}>
          <Trash2 size={17} />
          删除节点
        </button>
      </aside>
    );
  }

  return (
    <aside className="inspector">
      <div className="panel-title">
        <LayoutDashboard size={18} />
        画布
      </div>
      <label className="field">
        <span>名称</span>
        <input
          value={canvas.title}
          onInput={(event) => onTitleChange(event.currentTarget.value)}
          onChange={(event) => onTitleChange(event.target.value)}
        />
      </label>
    </aside>
  );
}

function AdminPanel({ open = true, onClose, mode = 'drawer' }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ username: '', role: 'user' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const active = mode === 'page' || open;

  const loadUsers = useCallback(async () => {
    if (!active) return;
    setLoading(true);
    setError('');
    try {
      const data = await api('/api/admin/users');
      setUsers(data.users);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [active]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  async function createUser(event) {
    event.preventDefault();
    setError('');
    try {
      await api('/api/admin/users', { method: 'POST', body: form });
      setForm({ username: '', role: 'user' });
      await loadUsers();
    } catch (err) {
      setError(err.message);
    }
  }

  async function updateUser(id, patch) {
    setError('');
    try {
      await api(`/api/admin/users/${id}`, { method: 'PUT', body: patch });
      await loadUsers();
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteUser(id) {
    if (!window.confirm('删除这个用户？')) return;
    setError('');
    try {
      await api(`/api/admin/users/${id}`, { method: 'DELETE' });
      await loadUsers();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!active) return null;

  return (
    <section className={mode === 'page' ? 'admin-page-panel' : 'admin-drawer'} aria-label="后台管理">
      <div className="admin-header">
        <div className="panel-title">
          <Users size={19} />
          后台管理
        </div>
        {mode === 'drawer' ? (
          <button className="icon-button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        ) : null}
      </div>
      <form className="admin-create" onSubmit={createUser}>
        <input
          placeholder="用户名"
          value={form.username}
          onChange={(event) => setForm((next) => ({ ...next, username: event.target.value }))}
        />
        <select value={form.role} onChange={(event) => setForm((next) => ({ ...next, role: event.target.value }))}>
          <option value="user">用户</option>
          <option value="admin">管理员</option>
        </select>
        <button className="primary-button" type="submit">
          <Plus size={17} />
          添加
        </button>
      </form>
      {error ? <div className="form-error">{error}</div> : null}
      <div className="user-table">
        {loading ? <div className="muted-line">加载中</div> : null}
        {users.map((user) => (
          <div className="user-row" key={user.id}>
            <div className="user-name">
              {user.role === 'admin' ? <Shield size={17} /> : <UserRound size={17} />}
              <input
                defaultValue={user.username}
                onBlur={(event) => {
                  const username = event.currentTarget.value.trim();
                  if (username && username !== user.username) updateUser(user.id, { username });
                }}
              />
            </div>
            <select value={user.role} onChange={(event) => updateUser(user.id, { role: event.target.value })}>
              <option value="user">用户</option>
              <option value="admin">管理员</option>
            </select>
            <select
              className="status-select"
              value={user.active ? 'enabled' : 'disabled'}
              onChange={(event) => updateUser(user.id, { status: event.target.value })}
            >
              <option value="enabled">启用</option>
              <option value="disabled">禁用</option>
            </select>
            <span className={`password-state ${user.hasPassword ? 'ok' : ''}`}>
              {user.hasPassword ? '已设密码' : '未设密码'}
            </span>
            <div className="last-used">
              <span>最后使用</span>
              <strong>{formatLastUsedAt(user.lastUsedAt)}</strong>
            </div>
            <div className="password-actions">
              <KeyRound size={16} />
              <button
                className="ghost-button danger"
                disabled={!user.hasPassword}
                onClick={() => {
                  if (!user.hasPassword || !window.confirm('清空这个用户的密码？')) return;
                  updateUser(user.id, { clearPassword: true });
                }}
              >
                清空密码
              </button>
            </div>
            <button className="icon-button danger" onClick={() => deleteUser(user.id)} title="删除">
              <Trash2 size={17} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function AdminPage({ user, onLogout }) {
  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    onLogout();
  }

  if (user.role !== 'admin') {
    return (
      <main className="admin-page">
        <section className="admin-access-panel">
          <div className="brand-mark">
            <Shield size={24} />
          </div>
          <h1>需要管理员权限</h1>
          <p>当前账号没有进入后台管理的权限。</p>
          <div className="admin-page-actions">
            <button className="ghost-button" onClick={() => (window.location.href = '/')}>
              <LayoutDashboard size={17} />
              回到画布
            </button>
            <button className="ghost-button" onClick={logout}>
              <LogOut size={17} />
              退出
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="admin-page">
      <header className="admin-page-topbar">
        <div className="app-brand">
          <div className="brand-mark small">
            <Users size={20} />
          </div>
          <div>
            <strong>后台管理</strong>
            <small>{user.username}</small>
          </div>
        </div>
        <div className="admin-page-actions">
          <button className="ghost-button" onClick={() => (window.location.href = '/')}>
            <LayoutDashboard size={17} />
            画布工作台
          </button>
          <button className="ghost-button" onClick={logout}>
            <LogOut size={17} />
            退出
          </button>
        </div>
      </header>
      <AdminPanel mode="page" />
    </main>
  );
}

function Workbench({ user, onLogout }) {
  const [canvases, setCanvases] = useState([]);
  const [activeCanvas, setActiveCanvas] = useState(null);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [contextMenu, setContextMenu] = useState(null);
  const flowRef = useRef(null);
  const fileInputRef = useRef(null);
  const viewportRef = useRef({ x: 0, y: 0, zoom: 1 });
  const contextPositionRef = useRef(null);
  const activeCanvasRef = useRef(null);
  const nodesRef = useRef([]);
  const edgesRef = useRef([]);
  const saveTimerRef = useRef(null);
  const savingRef = useRef(false);
  const pendingSaveRef = useRef(false);
  const lastSavedKeyRef = useRef('');

  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedNodeId), [nodes, selectedNodeId]);

  useEffect(() => {
    activeCanvasRef.current = activeCanvas;
    nodesRef.current = nodes;
    edgesRef.current = edges;
  }, [activeCanvas, nodes, edges]);

  function snapshotFor(canvas, snapshotNodes, snapshotEdges, viewport) {
    if (!canvas) return null;
    const payload = {
      title: canvas.title,
      data: {
        nodes: snapshotNodes,
        edges: snapshotEdges,
        viewport
      }
    };

    return {
      canvasId: canvas.id,
      payload,
      key: JSON.stringify({
        id: canvas.id,
        ...payload
      })
    };
  }

  function currentSnapshot() {
    return snapshotFor(activeCanvasRef.current, nodesRef.current, edgesRef.current, viewportRef.current);
  }

  function updateCanvasSummary(canvas) {
    const nodeCount = Array.isArray(canvas.data?.nodes) ? canvas.data.nodes.length : 0;
    const edgeCount = Array.isArray(canvas.data?.edges) ? canvas.data.edges.length : 0;
    setCanvases((items) =>
      items.map((item) =>
        String(item.id) === String(canvas.id)
          ? {
              ...item,
              title: canvas.title,
              nodeCount,
              edgeCount,
              updatedAt: canvas.updatedAt
            }
          : item
      )
    );
  }

  function scheduleAutoSave(delay = 700) {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void flushAutoSave();
    }, delay);
  }

  function markCanvasChanged(delay) {
    setDirty(true);
    scheduleAutoSave(delay);
  }

  async function flushAutoSave() {
    const snapshot = currentSnapshot();
    if (!snapshot || snapshot.key === lastSavedKeyRef.current) {
      setDirty(false);
      return;
    }

    if (savingRef.current) {
      pendingSaveRef.current = true;
      return;
    }

    savingRef.current = true;
    pendingSaveRef.current = false;
    setSaving(true);
    setError('');

    try {
      const data = await api(`/api/canvases/${snapshot.canvasId}`, {
        method: 'PUT',
        body: snapshot.payload
      });
      updateCanvasSummary(data.canvas);

      const latest = currentSnapshot();
      if (latest && latest.canvasId === snapshot.canvasId && latest.key === snapshot.key) {
        lastSavedKeyRef.current = snapshot.key;
        setDirty(false);
        setActiveCanvas((canvas) =>
          canvas && String(canvas.id) === String(data.canvas.id)
            ? {
                ...canvas,
                createdAt: data.canvas.createdAt,
                updatedAt: data.canvas.updatedAt
              }
            : canvas
        );
      }
    } catch (err) {
      setError(err.message);
    } finally {
      savingRef.current = false;
      setSaving(false);

      const latest = currentSnapshot();
      if (pendingSaveRef.current || (latest && latest.key !== lastSavedKeyRef.current)) {
        pendingSaveRef.current = false;
        scheduleAutoSave(250);
      }
    }
  }

  const loadCanvases = useCallback(async () => {
    const data = await api('/api/canvases');
    setCanvases(data.canvases);
    return data.canvases;
  }, []);

  const openCanvas = useCallback(
    async (id) => {
      setError('');
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const data = await api(`/api/canvases/${id}`);
      const canvas = data.canvas;
      const nextNodes = (canvas.data.nodes || []).map((node) => ({ ...node, type: node.type || 'workflow' }));
      const nextEdges = canvas.data.edges || [];
      const viewport = canvas.data.viewport || { x: 0, y: 0, zoom: 1 };
      setActiveCanvas({ ...canvas, data: { ...canvas.data, nodes: nextNodes } });
      setNodes(nextNodes);
      setEdges(nextEdges);
      setSelectedNodeId(null);
      lastSavedKeyRef.current = snapshotFor(canvas, nextNodes, nextEdges, viewport)?.key || '';
      setDirty(false);
      setTimeout(() => {
        viewportRef.current = viewport;
        flowRef.current?.setViewport(viewport, { duration: 120 });
      }, 0);
    },
    [setEdges, setNodes]
  );

  useEffect(() => {
    loadCanvases()
      .then((items) => {
        if (items[0]) openCanvas(items[0].id);
      })
      .catch((err) => setError(err.message));
  }, [loadCanvases, openCanvas]);

  async function createCanvas() {
    setError('');
    try {
      const data = await api('/api/canvases', { method: 'POST', body: { title: '新画布' } });
      await loadCanvases();
      await openCanvas(data.canvas.id);
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteCanvas(id) {
    if (!window.confirm('删除这个画布？')) return;
    setError('');
    try {
      await api(`/api/canvases/${id}`, { method: 'DELETE' });
      const items = await loadCanvases();
      if (String(activeCanvas?.id) === String(id)) {
        if (items[0]) await openCanvas(items[0].id);
        else {
          if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
          }
          lastSavedKeyRef.current = '';
          setActiveCanvas(null);
          setNodes([]);
          setEdges([]);
        }
      }
    } catch (err) {
      setError(err.message);
    }
  }

  function addWorkflowNode(kind, options = {}) {
    const meta = kindMeta[kind] || kindMeta.input;
    const fallbackPosition = flowRef.current
      ? flowRef.current.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
      : { x: 180 + nodes.length * 28, y: 160 + nodes.length * 28 };

    const node = {
      id: uid(kind),
      type: 'workflow',
      position: options.position || fallbackPosition,
      data: {
        kind,
        label: options.label || `${meta.label}节点`,
        description: options.description || '',
        config: { ...defaultNodeConfig(kind), ...(options.config || {}) }
      }
    };

    setNodes((items) => items.concat(node));
    setSelectedNodeId(node.id);
    markCanvasChanged();
  }

  function addNode(kind) {
    addWorkflowNode(kind);
  }

  function closeContextMenu() {
    setContextMenu(null);
  }

  function runContextAction(action) {
    action(contextMenu?.flowPosition || contextPositionRef.current || undefined);
    closeContextMenu();
  }

  function openNodePickerFromContext() {
    setContextMenu((menu) => (menu ? { ...menu, mode: 'node-picker' } : menu));
  }

  function openContextMenu(event) {
    if (!activeCanvas) return;
    if (event.target.closest?.('.canvas-context-menu')) return;
    event.preventDefault();
    const flowPosition = flowRef.current
      ? flowRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY })
      : { x: event.clientX, y: event.clientY };
    const x = Math.min(event.clientX, window.innerWidth - 260);
    const y = Math.min(event.clientY, window.innerHeight - 394);

    contextPositionRef.current = flowPosition;
    setSelectedNodeId(null);
    setContextMenu({
      x: Math.max(12, x),
      y: Math.max(12, y),
      flowPosition
    });
  }

  function uploadFromContext() {
    contextPositionRef.current = contextMenu?.flowPosition || contextPositionRef.current;
    closeContextMenu();
    fileInputRef.current?.click();
  }

  function handleUploadFiles(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;

    const names = files.map((file) => file.name);
    const position = contextPositionRef.current || undefined;
    addWorkflowNode('input', {
      position,
      label: files.length > 1 ? `上传资产（${files.length}）` : '上传资产',
      description: names.join('\n')
    });
  }

  function updateSelectedNode(patch) {
    if (!selectedNodeId) return;
    setNodes((items) =>
      items.map((node) =>
        node.id === selectedNodeId ? { ...node, data: { ...node.data, ...patch } } : node
      )
    );
    markCanvasChanged();
  }

  function deleteSelectedNode() {
    if (!selectedNodeId) return;
    setNodes((items) => items.filter((node) => node.id !== selectedNodeId));
    setEdges((items) => items.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
    setSelectedNodeId(null);
    markCanvasChanged();
  }

  function renameActiveCanvas(title) {
    setActiveCanvas((canvas) => (canvas ? { ...canvas, title } : canvas));
    setCanvases((items) =>
      items.map((item) => (String(item.id) === String(activeCanvasRef.current?.id) ? { ...item, title } : item))
    );
    markCanvasChanged();
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    onLogout();
  }

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    function closeOnEscape(event) {
      if (event.key === 'Escape') closeContextMenu();
    }

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  return (
    <ReactFlowProvider>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="app-brand">
            <div className="brand-mark small">
              <LayoutDashboard size={21} />
            </div>
            <div>
              <strong>画布工作台</strong>
              <small>{user.username}</small>
            </div>
          </div>
          <CanvasList
            canvases={canvases}
            activeId={activeCanvas?.id}
            onOpen={openCanvas}
            onCreate={createCanvas}
            onDelete={deleteCanvas}
          />
          <div className="sidebar-actions">
            {user.role === 'admin' ? (
              <button className="ghost-button" onClick={() => (window.location.href = '/admin')}>
                <Users size={17} />
                后台管理
              </button>
            ) : null}
            <button className="ghost-button" onClick={logout}>
              <LogOut size={17} />
              退出登录
            </button>
          </div>
        </aside>

        <main className="workspace">
          <header className="toolbar">
            <div className="toolbar-title">
              {activeCanvas ? (
                <input
                  className="toolbar-title-input"
                  value={activeCanvas.title}
                  onInput={(event) => renameActiveCanvas(event.currentTarget.value)}
                  onChange={(event) => renameActiveCanvas(event.target.value)}
                />
              ) : (
                <span>未选择画布</span>
              )}
              {saving ? <small>保存中</small> : dirty ? <small>等待自动保存</small> : <small>已自动保存</small>}
            </div>
            <div className="toolbar-actions">
              <div className="node-tools">
                {toolbarKinds.map((kind) => {
                  const meta = kindMeta[kind];
                  return (
                  <button
                    key={kind}
                    className="tool-button"
                    onClick={() => addNode(kind)}
                    title={`添加${meta.label}`}
                    disabled={!activeCanvas}
                  >
                    <CopyPlus size={16} />
                    {meta.label}
                  </button>
                  );
                })}
              </div>
              <button className="ghost-button toolbar-logout" onClick={logout}>
                <LogOut size={17} />
                退出登录
              </button>
            </div>
          </header>
          {error ? <div className="canvas-error">{error}</div> : null}
          <div className="flow-shell" onContextMenuCapture={openContextMenu}>
            <input
              ref={fileInputRef}
              className="hidden-file-input"
              type="file"
              multiple
              onChange={handleUploadFiles}
            />
            {activeCanvas ? (
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onInit={(instance) => {
                  flowRef.current = instance;
                }}
                onNodesChange={(changes) => {
                  onNodesChange(changes);
                  markCanvasChanged();
                }}
                onEdgesChange={(changes) => {
                  onEdgesChange(changes);
                  markCanvasChanged();
                }}
                onConnect={(connection) => {
                  setEdges((items) => addEdge({ ...connection, animated: true }, items));
                  markCanvasChanged();
                }}
                onNodeClick={(_, node) => setSelectedNodeId(node.id)}
                onPaneClick={() => {
                  setSelectedNodeId(null);
                  closeContextMenu();
                }}
                onMoveEnd={(_, viewport) => {
                  viewportRef.current = viewport;
                  markCanvasChanged();
                }}
                fitView
              >
                <Background gap={22} size={1} color="#d8ded8" />
                <MiniMap pannable zoomable nodeStrokeWidth={3} />
                <Controls position="bottom-right" />
              </ReactFlow>
            ) : (
              <div className="empty-workspace">
                <LayoutDashboard size={40} />
                <button className="primary-button" onClick={createCanvas}>
                  <Plus size={17} />
                  新建画布
                </button>
              </div>
            )}
            <CanvasContextMenu
              menu={contextMenu}
              onUpload={uploadFromContext}
              onAddAsset={() =>
                runContextAction((position) =>
                  addWorkflowNode('input', {
                    position,
                    label: '资产',
                    description: '可在这里记录图片、视频、音频或素材链接'
                  })
                )
              }
              onOpenNodePicker={openNodePickerFromContext}
              onSelectNodeType={(choice) =>
                runContextAction((position) =>
                  addWorkflowNode(choice.kind, {
                    position,
                    label: `${choice.label}节点`,
                    description: choice.description || ''
                  })
                )
              }
              onAddTool={() =>
                runContextAction((position) =>
                  addWorkflowNode('review', {
                    position,
                    label: '辅助工具',
                    description: '记录辅助处理、审核或工具调用'
                  })
                )
              }
            />
          </div>
        </main>

        <Inspector
          canvas={activeCanvas}
          selectedNode={selectedNode}
          onTitleChange={(title) => {
            renameActiveCanvas(title);
          }}
          onNodeChange={updateSelectedNode}
          onDeleteNode={deleteSelectedNode}
        />
      </div>
    </ReactFlowProvider>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const isAdminRoute = window.location.pathname.replace(/\/+$/, '') === '/admin';

  async function handleLogout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
    if (window.location.pathname !== '/') {
      window.history.pushState(null, '', '/');
    }
  }

  useEffect(() => {
    api('/api/auth/me')
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) {
    return (
      <div className="boot-screen">
        <LayoutDashboard size={30} />
      </div>
    );
  }

  if (!user) {
    return <Login onLogin={setUser} />;
  }

  if (isAdminRoute) {
    return <AdminPage user={user} onLogout={() => setUser(null)} />;
  }

  return <CanvasApp user={user} onLogout={handleLogout} />;
}

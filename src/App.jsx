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
  UserPlus,
  UserRound,
  Users,
  Video,
  X
} from 'lucide-react';
import CanvasApp from './canvas/App';
import ErrorLibraryPage from './ErrorLibraryPage';
import { getAdminPath, getAppHomePath, isAdminPath, isErrorLibraryPath } from './shared/routes';

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
const seedanceResolutions = ['720p', '1080p', '4k'];

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

const adminProjectStatusOptions = [
  { value: 'not_started', label: '未开始' },
  { value: 'in_progress', label: '进行中' },
  { value: 'completed', label: '已完成' }
];

function projectStatusLabel(status) {
  return adminProjectStatusOptions.find((item) => item.value === status)?.label || '未开始';
}

const usagePeriodOptions = [
  { value: 'day', label: '按天' },
  { value: 'week', label: '按周' },
  { value: 'month', label: '按月' },
  { value: 'year', label: '按年' }
];

const usageTypeOptions = [
  { value: 'all', label: '全部类型' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'text', label: '文字' }
];

const usageStatusOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'submitted', label: '提交中' },
  { value: 'succeeded', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' }
];

function todayDateKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function usageTypeLabel(value) {
  return usageTypeOptions.find((item) => item.value === value)?.label || value || '-';
}

function usageStatusLabel(value) {
  return usageStatusOptions.find((item) => item.value === value)?.label || value || '-';
}

function formatUsageTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function formatUsageResolution(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const normalized = text.toUpperCase();
  if (normalized === '720P' || normalized === '768P' || normalized === '1080P' || normalized === '480P') return normalized;
  if (normalized === '4K' || normalized === '2K' || normalized === '1K') return normalized;
  return text;
}

function formatUsageDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return `${Number.isInteger(seconds) ? seconds : Number(seconds.toFixed(1))}s`;
}

function usageRecordSettingChips(record) {
  const settings = record?.settings && typeof record.settings === 'object' ? record.settings : {};
  const chips = [];
  const resolution = formatUsageResolution(settings.resolution || settings.quality || '');
  if (resolution && (record.operationType === 'image' || record.operationType === 'video')) {
    chips.push(`清晰度 ${resolution}`);
  }
  const duration = formatUsageDuration(settings.duration || settings.durationSec || settings.seconds || '');
  if (duration && record.operationType === 'video') {
    chips.push(`秒数 ${duration}`);
  }
  return chips;
}

function usageVideoTaskStatusLabel(status) {
  if (status === 'running') return '运行中';
  return usageStatusLabel(status);
}

function usageTaskText(value, max = 36) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function usageVideoTaskParams(task) {
  if (!task) return [];
  const params = [];
  if (task.model) params.push(`模型 ${task.model}`);
  if (task.mode) params.push(`模式 ${task.mode}`);
  if (task.ratio) params.push(`比例 ${task.ratio}`);
  if (task.resolution) params.push(`清晰度 ${formatUsageResolution(task.resolution)}`);
  if (task.durationSec) params.push(`秒数 ${formatUsageDuration(task.durationSec)}`);
  if (task.quantity) params.push(`数量 ${task.quantity}`);
  const enableSound = task.submissionParams?.enableSound;
  if (enableSound) params.push(enableSound === 'off' ? '无声' : '有声');
  return params;
}

function usageVideoTaskReferenceLabels(task) {
  const refs = Array.isArray(task?.referenceMaterials) ? task.referenceMaterials : [];
  return refs
    .filter((ref) => ref && ref.type)
    .map((ref) => {
      const typeLabel =
        ref.type === 'image'
          ? '图片'
          : ref.type === 'video'
            ? '视频'
            : ref.type === 'text'
              ? '文本'
              : ref.type === 'audio'
                ? '音频'
                : '提示词引用';
      return `${typeLabel}${ref.index || ''}${ref.title ? ` · ${usageTaskText(ref.title, 26)}` : ''}`;
    });
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
  // 注册（2026-08-24）。跟「设置密码」共用 setup-overlay 那套弹窗样式，不另做一套。
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registerName, setRegisterName] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registerConfirm, setRegisterConfirm] = useState('');
  const [registerApiKey, setRegisterApiKey] = useState('');
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

  /**
   * 注册。成功后服务端已经把会话 cookie 下发了，所以直接 onLogin 进去，不用再登一次。
   *
   * 202 是个特殊情况：账号已经建在共享用户目录里了，只是本地影子行还没同步过来。
   * 这时候**绝对不能提示重试** —— 再点一次就会建出第二个同名候选。
   */
  async function submitRegister(event) {
    event.preventDefault();
    setError('');

    const name = registerName.trim();
    if (name.length < 2 || name.length > 50) {
      setError('账号长度需要在 2 到 50 个字符之间');
      return;
    }
    if (registerPassword.length < 4) {
      setError('密码至少 4 个字符');
      return;
    }
    if (registerPassword !== registerConfirm) {
      setError('两次输入的密码不一致');
      return;
    }
    const apiKey = registerApiKey.trim();
    if (apiKey.length < 12) {
      setError('请填写有效的 API Key');
      return;
    }

    setLoading(true);
    try {
      const data = await api('/api/auth/register', {
        method: 'POST',
        body: { username: name, password: registerPassword, apiKey }
      });
      // 服务端的 202（账号建好了、本地影子行还没同步）**不会**走到 catch ——
      // 202 属于 response.ok，api() 直接返回 payload。所以只能靠有没有 user 来判断。
      if (!data.user) {
        setRegisterOpen(false);
        setError(data.error || '账号已创建，请回到登录页选这个账号登录');
        await loadLoginUsers();
        return;
      }
      onLogin(data.user);
    } catch (err) {
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
          <img src="/shotflow-logo.svg" alt="Shotflow" className="brand-wordmark" />
          <div>
            <h1 style={{ display: 'none' }}>Shotflow</h1>
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
          {error && !setupUser && !registerOpen ? <div className="form-error">{error}</div> : null}
          <button type="submit" className="primary-button" disabled={loading || !selectedUser}>
            <Check size={18} />
            {loading ? '处理中' : '登录'}
          </button>
          {/* 注册入口。做成次要按钮：登录才是这个页面的主动作 */}
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              setRegisterOpen(true);
              setRegisterName('');
              setRegisterPassword('');
              setRegisterConfirm('');
              setRegisterApiKey('');
              setError('');
            }}
          >
            <UserPlus size={17} />
            注册新账号
          </button>
        </form>
      </section>
      {registerOpen ? (
        <section className="setup-overlay" aria-label="注册新账号">
          <form className="setup-dialog" onSubmit={submitRegister}>
            <div className="admin-header">
              <div className="panel-title">
                <UserPlus size={18} />
                注册新账号
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={() => {
                  setRegisterOpen(false);
                  setError('');
                }}
                title="关闭"
              >
                <X size={18} />
              </button>
            </div>
            <label className="field">
              <span>账号</span>
              <input
                value={registerName}
                onChange={(event) => setRegisterName(event.target.value)}
                placeholder="2 到 50 个字符"
                autoFocus
              />
            </label>
            <label className="field">
              <span>密码</span>
              <input
                value={registerPassword}
                onChange={(event) => setRegisterPassword(event.target.value)}
                type="password"
                placeholder="至少 4 个字符"
              />
            </label>
            <label className="field">
              <span>确认密码</span>
              <input
                value={registerConfirm}
                onChange={(event) => setRegisterConfirm(event.target.value)}
                type="password"
              />
            </label>
            <label className="field">
              <span>API Key</span>
              <input
                value={registerApiKey}
                onChange={(event) => setRegisterApiKey(event.target.value)}
                type="password"
                autoComplete="off"
                placeholder="必填，用于出图和生成"
              />
            </label>
            {error ? <div className="form-error">{error}</div> : null}
            <button className="primary-button" type="submit" disabled={loading}>
              <Check size={18} />
              {loading ? '注册中' : '注册并登录'}
            </button>
            <p className="setup-note">注册后角色是「制作人」。API Key 走你自己的网关额度，必填。</p>
          </form>
        </section>
      ) : null}
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
  const [projects, setProjects] = useState([]);
  const [projectForm, setProjectForm] = useState({ name: '', status: 'not_started' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(false);
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

  const loadProjects = useCallback(async () => {
    if (!active) return;
    setProjectsLoading(true);
    setError('');
    try {
      const data = await api('/api/admin/projects');
      setProjects(data.projects);
    } catch (err) {
      setError(err.message);
    } finally {
      setProjectsLoading(false);
    }
  }, [active]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

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

  async function createProject(event) {
    event.preventDefault();
    setError('');
    try {
      await api('/api/admin/projects', { method: 'POST', body: projectForm });
      setProjectForm({ name: '', status: 'not_started' });
      await loadProjects();
    } catch (err) {
      setError(err.message);
    }
  }

  async function updateProject(id, patch) {
    setError('');
    try {
      await api(`/api/admin/projects/${id}`, { method: 'PUT', body: patch });
      await loadProjects();
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

      <div className="admin-subpanel">
        <div className="admin-subpanel-header">
          <div className="panel-title">
            <LayoutDashboard size={18} />
            项目管理
          </div>
        </div>
        <form className="admin-create admin-project-create" onSubmit={createProject}>
          <input
            placeholder="项目名称"
            value={projectForm.name}
            onChange={(event) => setProjectForm((next) => ({ ...next, name: event.target.value }))}
          />
          <select
            value={projectForm.status}
            onChange={(event) => setProjectForm((next) => ({ ...next, status: event.target.value }))}
          >
            {adminProjectStatusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button className="primary-button" type="submit">
            <Plus size={17} />
            添加项目
          </button>
        </form>
        <div className="user-table admin-project-table">
          {projectsLoading ? <div className="muted-line">加载中</div> : null}
          {projects.map((project) => (
            <div className="user-row admin-project-row" key={project.id}>
              <div className="user-name">
                <LayoutDashboard size={17} />
                <input
                  defaultValue={project.name}
                  onBlur={(event) => {
                    const name = event.currentTarget.value.trim();
                    if (name && name !== project.name) updateProject(project.id, { name });
                  }}
                />
              </div>
              <select value={project.status} onChange={(event) => updateProject(project.id, { status: event.target.value })}>
                {adminProjectStatusOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className={`password-state ok admin-project-status admin-project-status-${project.status}`}>
                {projectStatusLabel(project.status)}
              </span>
              <div className="last-used">
                <span>创建时间</span>
                <strong>{formatLastUsedAt(project.createdAt)}</strong>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function AdminPage({ user, onLogout }) {
  const [usageFilters, setUsageFilters] = useState({
    period: 'day',
    date: todayDateKey(),
    userId: 'all',
    type: 'all',
    model: 'all',
    status: 'all'
  });
  const [usage, setUsage] = useState(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState('');
  const [apiKeyInfo, setApiKeyInfo] = useState(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyLoading, setApiKeyLoading] = useState(false);
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyError, setApiKeyError] = useState('');
  const [apiKeyMessage, setApiKeyMessage] = useState('');

  const loadUsage = useCallback(async () => {
    if (user.role !== 'admin') return;
    setUsageLoading(true);
    setUsageError('');
    try {
      const query = new URLSearchParams({
        ...usageFilters,
        limit: '500'
      });
      const data = await api(`/api/admin/usage?${query.toString()}`);
      setUsage(data);
    } catch (error) {
      setUsageError(error.message || '使用记录加载失败');
    } finally {
      setUsageLoading(false);
    }
  }, [usageFilters, user.role]);

  const loadApiKeyInfo = useCallback(async () => {
    if (user.role !== 'admin') return;
    setApiKeyLoading(true);
    setApiKeyError('');
    try {
      const data = await api('/api/admin/api-key');
      setApiKeyInfo(data);
    } catch (error) {
      setApiKeyError(error.message || 'API Key 信息加载失败');
    } finally {
      setApiKeyLoading(false);
    }
  }, [user.role]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  useEffect(() => {
    void loadApiKeyInfo();
  }, [loadApiKeyInfo]);

  function updateUsageFilter(key, value) {
    setUsageFilters((prev) => ({ ...prev, [key]: value }));
  }

  async function submitApiKey(event) {
    event.preventDefault();
    const nextKey = apiKeyInput.trim();
    if (!nextKey) {
      setApiKeyError('请先填写新的 API Key');
      return;
    }
    setApiKeySaving(true);
    setApiKeyError('');
    setApiKeyMessage('');
    try {
      const data = await api('/api/admin/api-key', { method: 'POST', body: { apiKey: nextKey } });
      setApiKeyInfo(data);
      setApiKeyInput('');
      setApiKeyMessage('API Key 已替换，并已写入服务器配置');
    } catch (error) {
      setApiKeyError(error.message || 'API Key 替换失败');
    } finally {
      setApiKeySaving(false);
    }
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    onLogout();
  }

  const homePath = getAppHomePath(window.location.pathname);
  const externalAdminLinks = [
    {
      key: 'users',
      title: '用户管理',
      description: '打开共享用户管理网页',
      href: 'http://172.25.135.159:8080/sd2/users.html'
    },
    {
      key: 'projects',
      title: '项目管理',
      description: '打开共享项目管理网页',
      href: 'http://172.25.135.159:8080/sd2/projects.html'
    }
  ];

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
            <button className="ghost-button" onClick={() => (window.location.href = homePath)}>
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
          <img src="/shotflow-logo.svg" alt="Shotflow" className="brand-wordmark small" />
          <div>
            <small>后台管理 · {user.username}</small>
          </div>
        </div>
        <div className="admin-page-actions">
          <button className="ghost-button" onClick={() => (window.location.href = homePath)}>
            <LayoutDashboard size={17} />
            Shotflow 工作台
          </button>
          <button className="ghost-button" onClick={logout}>
            <LogOut size={17} />
            退出
          </button>
        </div>
      </header>
      <section className="admin-links-panel" aria-label="后台管理入口">
        <div className="admin-links-head">
          <div className="panel-title">
            <Users size={19} />
            后台管理
          </div>
          <p>这里直接跳转到统一的用户管理和项目管理网页。</p>
        </div>
        <div className="admin-links-grid">
          {externalAdminLinks.map((item) => (
            <a key={item.key} className="admin-link-card" href={item.href}>
              <div className="admin-link-copy">
                <strong>{item.title}</strong>
                <span>{item.description}</span>
                <small>{item.href}</small>
              </div>
              <span className="admin-link-action">
                打开
                <PanelRightOpen size={16} />
              </span>
            </a>
          ))}
        </div>
      </section>
      <section className="admin-api-key-panel" aria-label="API Key 管理">
        <div className="admin-api-key-head">
          <div>
            <div className="panel-title">
              <KeyRound size={19} />
              API Key 管理
            </div>
            <p>切换网页工具使用的模型密钥，并保留替换记录。页面只显示脱敏 key，不展示完整密钥。</p>
          </div>
          <button className="ghost-button compact" onClick={loadApiKeyInfo} disabled={apiKeyLoading || apiKeySaving}>
            {apiKeyLoading ? '刷新中' : '刷新'}
          </button>
        </div>

        <div className="admin-api-key-current">
          <span>现用 API Key</span>
          <code>{apiKeyInfo?.current?.maskedValue || (apiKeyLoading ? '读取中...' : '未配置')}</code>
          {apiKeyInfo?.current?.openaiSynced === false ? (
            <em>OPENAI_API_KEY 与 LLM_API_KEY 不一致，替换后会同步成新 key</em>
          ) : null}
        </div>

        <form className="admin-api-key-form" onSubmit={submitApiKey}>
          <input
            type="password"
            value={apiKeyInput}
            onChange={(event) => setApiKeyInput(event.target.value)}
            placeholder="填写新的 API Key"
            autoComplete="off"
          />
          <button type="submit" className="primary-button" disabled={apiKeySaving}>
            {apiKeySaving ? '替换中' : '替换'}
          </button>
        </form>

        {apiKeyError ? <div className="admin-usage-error">{apiKeyError}</div> : null}
        {apiKeyMessage ? <div className="admin-api-key-message">{apiKeyMessage}</div> : null}

        <div className="admin-api-key-records">
          <h3>替换记录</h3>
          {(apiKeyInfo?.records || []).length ? (
            <div className="admin-api-key-record-list">
              {apiKeyInfo.records.map((record) => (
                <article key={record.id} className="admin-api-key-record">
                  <div>
                    <strong>{record.changedByName || '系统'}</strong>
                    <span>{record.oldKeyMasked || '未配置'} → {record.newKeyMasked || '未配置'}</span>
                  </div>
                  <time>{formatUsageTime(record.createdAt)}</time>
                </article>
              ))}
            </div>
          ) : (
            <p className="admin-usage-empty">还没有替换记录。</p>
          )}
        </div>
      </section>
      <section className="admin-usage-panel" aria-label="付费使用统计">
        <div className="admin-usage-head">
          <div>
            <div className="panel-title">
              <FileText size={19} />
              付费使用统计
            </div>
            <p>从现在开始记录每个用户的视频、图片、文字付费操作，按时间由近到远查看。</p>
          </div>
          <button className="ghost-button compact" onClick={loadUsage} disabled={usageLoading}>
            {usageLoading ? '刷新中' : '刷新'}
          </button>
        </div>

        <div className="admin-usage-filters">
          <label>
            <span>范围</span>
            <select value={usageFilters.period} onChange={(event) => updateUsageFilter('period', event.target.value)}>
              {usagePeriodOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>日期</span>
            <input type="date" value={usageFilters.date} onChange={(event) => updateUsageFilter('date', event.target.value)} />
          </label>
          <label>
            <span>用户</span>
            <select value={usageFilters.userId} onChange={(event) => updateUsageFilter('userId', event.target.value)}>
              <option value="all">全部用户</option>
              {(usage?.users || []).map((item) => (
                <option key={item.userId ?? item.username} value={item.userId ?? 'all'}>{item.username}</option>
              ))}
            </select>
          </label>
          <label>
            <span>类型</span>
            <select value={usageFilters.type} onChange={(event) => updateUsageFilter('type', event.target.value)}>
              {usageTypeOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>模型</span>
            <select value={usageFilters.model} onChange={(event) => updateUsageFilter('model', event.target.value)}>
              <option value="all">全部模型</option>
              {(usage?.models || []).map((model) => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select>
          </label>
          <label>
            <span>状态</span>
            <select value={usageFilters.status} onChange={(event) => updateUsageFilter('status', event.target.value)}>
              {usageStatusOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>

        {usageError ? <div className="admin-usage-error">{usageError}</div> : null}

        <div className="admin-usage-cards">
          <div><span>总记录</span><strong>{usage?.summary?.records || 0}</strong></div>
          <div><span>图片</span><strong>{usage?.summary?.byType?.image?.quantity || 0}</strong></div>
          <div><span>视频</span><strong>{usage?.summary?.byType?.video?.quantity || 0}</strong></div>
          <div><span>文字</span><strong>{usage?.summary?.byType?.text?.quantity || 0}</strong></div>
        </div>

        <div className="admin-usage-grid">
          <div className="admin-usage-users">
            <h3>用户汇总</h3>
            {(usage?.users || []).length ? (
              <div className="admin-usage-user-list">
                {usage.users.map((item) => {
                  const videoSecondsByResolution = item.videoSecondsByResolution || {};
                  return (
                  <div key={item.userId ?? item.username} className="admin-usage-user-row">
                    <div className="admin-usage-user-mainline">
                      <strong>{item.username}</strong>
                      <span>图片 {item.imageQuantity}</span>
                      <span>视频 {item.videoQuantity}</span>
                      <span>视频总秒数 {formatUsageDuration(item.videoSeconds) || '0s'}</span>
                      <span>文字 {item.textQuantity}</span>
                      <em>{item.quantity} 次</em>
                    </div>
                    <div className="admin-usage-user-resolution-row">
                      {['480P', '720P', '768P', '1080P', '2K', '4K'].map((resolution) => (
                        <span key={resolution}>
                          {resolution} {formatUsageDuration(videoSecondsByResolution[resolution]) || '0s'}
                        </span>
                      ))}
                    </div>
                    {(item.byModel || []).length ? (
                      <div className="admin-usage-user-resolution-row admin-usage-user-model-row">
                        {item.byModel.map((entry) => (
                          <span key={`${entry.model}-${entry.operationType}`}>
                            {entry.model} {entry.quantity}次
                            {entry.operationType === 'video' && entry.videoSeconds
                              ? ` · ${formatUsageDuration(entry.videoSeconds)}`
                              : ''}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  );
                })}
              </div>
            ) : (
              <p className="admin-usage-empty">这个范围内还没有付费记录。</p>
            )}
          </div>
          <div className="admin-usage-records">
            <h3>明细记录</h3>
            {(usage?.records || []).length ? (
              <div className="admin-usage-record-list">
                {usage.records.map((record) => {
                  const settingChips = usageRecordSettingChips(record);
                  const videoTask = record.videoTask || null;
                  const videoTaskParams = usageVideoTaskParams(videoTask);
                  const videoTaskReferences = usageVideoTaskReferenceLabels(videoTask);
                  return (
                  <article key={record.id} className={`admin-usage-record admin-usage-record-${record.status}`}>
                    <div className="admin-usage-record-main">
                      <div>
                        <strong>{record.username}</strong>
                        <span>{usageTypeLabel(record.operationType)} · {record.model}</span>
                      </div>
                      <time>{formatUsageTime(record.createdAt)}</time>
                    </div>
                    <div className="admin-usage-record-meta">
                      <span>{usageStatusLabel(record.status)}</span>
                      <span>{record.quantity} 次</span>
                      <span>结果 {record.resultCount || 0}</span>
                      {settingChips.map((chip) => <span key={chip}>{chip}</span>)}
                      {record.canvasTitle ? <span>{record.canvasTitle}</span> : null}
                    </div>
                    {record.promptPreview ? <p>{record.promptPreview}</p> : null}
                    {record.errorMessage ? <small>{record.errorMessage}</small> : null}
                    {videoTask ? (
                      <div className="admin-usage-video-task">
                        <div className="admin-usage-video-task-line">
                          <span>任务ID <b>{usageTaskText(videoTask.internalJobId, 18)}</b></span>
                          <span>任务状态 <b>{usageVideoTaskStatusLabel(videoTask.status)}</b></span>
                          {(videoTask.providerJobIds || []).length ? (
                            <span>Provider ID <b>{videoTask.providerJobIds.map((id) => usageTaskText(id, 18)).join(' / ')}</b></span>
                          ) : null}
                        </div>
                        {videoTaskParams.length ? (
                          <div className="admin-usage-video-task-line">
                            {videoTaskParams.map((item) => <span key={item}>{item}</span>)}
                          </div>
                        ) : null}
                        <div className="admin-usage-video-task-refs">
                          <strong>参考素材</strong>
                          {videoTaskReferences.length ? (
                            videoTaskReferences.slice(0, 10).map((item) => <span key={item}>{item}</span>)
                          ) : (
                            <em>无</em>
                          )}
                        </div>
                        {(videoTask.errorMessage || record.errorMessage) ? (
                          <small>{videoTask.errorMessage || record.errorMessage}</small>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                  );
                })}
              </div>
            ) : (
              <p className="admin-usage-empty">没有匹配的明细。</p>
            )}
          </div>
        </div>
      </section>
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
            <img src="/shotflow-logo.svg" alt="Shotflow" className="brand-wordmark small" />
            <div>
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
              <button className="ghost-button" onClick={() => (window.location.href = getAdminPath())}>
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
  const isAdminRoute = isAdminPath(window.location.pathname);
  const isErrorLibraryRoute = isErrorLibraryPath(window.location.pathname);

  async function handleLogout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
    const homePath = getAppHomePath(window.location.pathname);
    if (window.location.pathname !== homePath) {
      window.history.pushState(null, '', homePath);
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

  if (isErrorLibraryRoute) {
    return <ErrorLibraryPage user={user} onLogout={handleLogout} />;
  }

  return <CanvasApp user={user} onLogout={handleLogout} />;
}

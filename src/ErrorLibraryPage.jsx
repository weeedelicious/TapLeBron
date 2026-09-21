import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpDown,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  LogOut,
  RefreshCw,
  Search,
  Video,
} from 'lucide-react';
import { getAppHomePath } from './shared/routes';
import './error-library.css';

const PAGE_SIZE = 30;
const TIME_RANGES = [
  { value: 'today', label: '今天' },
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
  { value: 'all', label: '全部' },
];

function formatTime(value) {
  if (!value) return '未知时间';
  return new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function operationCategory(value, nodeType = '') {
  const normalized = `${nodeType} ${value || ''}`.toLowerCase();
  if (normalized.includes('video')) return 'video';
  if (
    normalized.includes('text')
    || normalized.includes('llm')
    || normalized.includes('script')
    || normalized.includes('translate')
  ) return 'text';
  if (normalized.includes('image') || normalized.includes('light-stage')) return 'image';
  return 'other';
}

function operationLabel(value, nodeType = '') {
  const normalized = String(value || '');
  if (normalized.includes('light-stage')) return '灯光重塑';
  if (normalized.includes('toolbox')) return '工具节点';
  const category = operationCategory(value, nodeType);
  if (category === 'image') return '图片';
  if (category === 'video') return '视频';
  if (category === 'text') return '文字';
  return value || '其他';
}

function OperationIcon({ type, nodeType }) {
  const category = operationCategory(type, nodeType);
  if (category === 'image') return <ImageIcon size={15} />;
  if (category === 'video') return <Video size={15} />;
  return <FileText size={15} />;
}

function detailValue(value) {
  if (value == null || value === '') return '未记录';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

export default function ErrorLibraryPage({ user, onLogout }) {
  const [records, setRecords] = useState([]);
  const [summary, setSummary] = useState({ total: 0, images: 0, videos: 0, texts: 0 });
  const [options, setOptions] = useState({ usernames: [], operationTypes: [], models: [] });
  const [filters, setFilters] = useState({
    date: '',
    username: '',
    operationType: '',
    model: '',
    keyword: '',
  });
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [page, setPage] = useState(1);
  const [sortOrder, setSortOrder] = useState('desc');
  const [timeRange, setTimeRange] = useState('all');
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [copiedIdentifier, setCopiedIdentifier] = useState('');

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const isOwner = String(user?.username || '').trim() === '吴逸翔';

  const load = useCallback(async () => {
    if (!isOwner) return;
    setLoading(true);
    setError('');
    const query = new URLSearchParams({
      page: String(page),
      pageSize: String(PAGE_SIZE),
      sortOrder,
    });
    if (!appliedFilters.date && timeRange !== 'all') query.set('period', timeRange);
    for (const [key, value] of Object.entries(appliedFilters)) {
      if (String(value || '').trim()) query.set(key, String(value).trim());
    }
    try {
      const data = await request(`/api/error-library?${query.toString()}`);
      setRecords(data.records || []);
      setSummary(data.summary || { total: 0, images: 0, videos: 0, texts: 0 });
      setOptions(data.options || { usernames: [], operationTypes: [], models: [] });
      setTotal(Number(data.total || 0));
    } catch (loadError) {
      setError(loadError.message || '报错库加载失败');
    } finally {
      setLoading(false);
    }
  }, [appliedFilters, isOwner, page, sortOrder, timeRange]);

  useEffect(() => {
    void load();
  }, [load]);

  const pageRange = useMemo(() => {
    if (!total) return '0 条';
    const start = (page - 1) * PAGE_SIZE + 1;
    const end = Math.min(total, page * PAGE_SIZE);
    return `${start}-${end} / ${total} 条`;
  }, [page, total]);

  function applyFilters(event) {
    event.preventDefault();
    if (filters.date) setTimeRange('all');
    setPage(1);
    setAppliedFilters({ ...filters });
  }

  function clearFilters() {
    const empty = { date: '', username: '', operationType: '', model: '', keyword: '' };
    setFilters(empty);
    setAppliedFilters(empty);
    setTimeRange('all');
    setPage(1);
  }

  function selectTimeRange(value) {
    setTimeRange(value);
    setFilters((current) => ({ ...current, date: '' }));
    setAppliedFilters((current) => ({ ...current, date: '' }));
    setPage(1);
  }

  async function copyIdentifier(value, key) {
    if (!value) return;
    try {
      let copied = false;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(value);
          copied = true;
        } catch {
          copied = false;
        }
      }
      if (!copied) {
        const input = document.createElement('textarea');
        input.value = value;
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        copied = document.execCommand('copy');
        input.remove();
      }
      if (!copied) throw new Error('copy_failed');
      setCopiedIdentifier(key);
      window.setTimeout(() => {
        setCopiedIdentifier((current) => (current === key ? '' : current));
      }, 1600);
    } catch {
      setError('复制失败，请手动选择 ID');
    }
  }

  if (!isOwner) {
    return (
      <main className="error-library-access">
        <AlertTriangle size={30} />
        <h1>无法访问报错库</h1>
        <p>这个独立报错库仅吴逸翔可见。</p>
        <button type="button" onClick={() => { window.location.href = getAppHomePath(); }}>
          返回画布管理
        </button>
      </main>
    );
  }

  return (
    <main className="error-library-page">
      <header className="error-library-topbar">
        <div className="error-library-brand">
          <img src="/shotflow-icon.svg" alt="" />
          <div>
            <strong>节点报错库</strong>
            <span>独立数据库 · 仅吴逸翔可见</span>
          </div>
        </div>
        <div className="error-library-top-actions">
          <span className="error-library-user">{user.username}</span>
          <button type="button" onClick={() => { window.location.href = getAppHomePath(); }}>
            <ArrowLeft size={15} />
            返回画布管理
          </button>
          <button type="button" className="danger" onClick={onLogout}>
            <LogOut size={15} />
            退出登录
          </button>
        </div>
      </header>

      <section className="error-library-content">
        <div className="error-library-heading">
          <div>
            <span className="error-library-eyebrow"><AlertTriangle size={14} /> GENERATION ERRORS</span>
            <h1>节点生成报错</h1>
            <p>记录生成失败时的节点、模型、提交参数与供应商错误，可直接返回对应画布排查。</p>
          </div>
          <button type="button" className="error-library-refresh" onClick={() => { void load(); }} disabled={loading}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
            刷新
          </button>
        </div>

        <div className="error-library-summary" aria-label="报错汇总">
          <div><span>全部报错</span><strong>{summary.total}</strong></div>
          <div className="image"><span>图片</span><strong>{summary.images}</strong></div>
          <div className="video"><span>视频</span><strong>{summary.videos}</strong></div>
          <div className="text"><span>文字</span><strong>{summary.texts}</strong></div>
        </div>

        <form className="error-library-filters" onSubmit={applyFilters}>
          <label className="keyword">
            <Search size={15} />
            <input
              value={filters.keyword}
              onChange={(event) => setFilters((current) => ({ ...current, keyword: event.target.value }))}
              placeholder="搜索错误、节点、画布或任务 ID"
            />
          </label>
          <label>
            <CalendarDays size={15} />
            <input
              type="date"
              value={filters.date}
              onChange={(event) => setFilters((current) => ({ ...current, date: event.target.value }))}
            />
          </label>
          <select
            value={filters.username}
            onChange={(event) => setFilters((current) => ({ ...current, username: event.target.value }))}
            aria-label="用户"
          >
            <option value="">全部用户</option>
            {options.usernames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <select
            value={filters.operationType}
            onChange={(event) => setFilters((current) => ({ ...current, operationType: event.target.value }))}
            aria-label="节点类型"
          >
            <option value="">全部节点类型</option>
            {options.operationTypes.map((type) => <option key={type} value={type}>{operationLabel(type)}</option>)}
          </select>
          <select
            value={filters.model}
            onChange={(event) => setFilters((current) => ({ ...current, model: event.target.value }))}
            aria-label="模型"
          >
            <option value="">全部模型</option>
            {options.models.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
          <button type="submit" className="primary">查询</button>
          <button type="button" onClick={clearFilters}>清空</button>
        </form>

        {error ? <div className="error-library-error">{error}</div> : null}

        <div className="error-library-list-head">
          <div className="error-library-list-title">
            <strong>明细记录</strong>
            <div className="error-library-periods" role="group" aria-label="报错时间范围">
              {TIME_RANGES.map((range) => (
                <button
                  key={range.value}
                  type="button"
                  className={timeRange === range.value && !appliedFilters.date ? 'active' : ''}
                  aria-pressed={timeRange === range.value && !appliedFilters.date}
                  onClick={() => selectTimeRange(range.value)}
                >
                  {range.label}
                </button>
              ))}
            </div>
          </div>
          <div className="error-library-list-tools">
            <label className="error-library-sort">
              <ArrowUpDown size={14} />
              <select
                value={sortOrder}
                onChange={(event) => {
                  setPage(1);
                  setSortOrder(event.target.value);
                }}
                aria-label="报错时间排序"
              >
                <option value="desc">报错时间由近到远</option>
                <option value="asc">报错时间由远到近</option>
              </select>
            </label>
            <span>{pageRange}</span>
          </div>
        </div>

        <section className="error-library-list" aria-busy={loading}>
          {loading && !records.length ? (
            <div className="error-library-empty">正在读取独立报错数据库...</div>
          ) : records.length ? records.map((record) => {
            const expanded = expandedId === record.id;
            const canvasUrl = record.projectUuid
              ? `${getAppHomePath()}?project=${encodeURIComponent(record.projectUuid)}`
              : '';
            return (
              <article className="error-record" key={record.id}>
                <div className="error-record-main">
                  <div className={`error-record-type ${operationCategory(record.operationType, record.nodeType)}`}>
                    <OperationIcon type={record.operationType} nodeType={record.nodeType} />
                    {operationLabel(record.operationType, record.nodeType)}
                  </div>
                  <div className="error-record-body">
                    <div className="error-record-title">
                      <strong>{record.nodeName}</strong>
                      <span>{record.canvasTitle}</span>
                    </div>
                    <div className="error-record-meta">
                      <span>{record.username}</span>
                      <span>{record.model || '未记录模型'}</span>
                      {record.resolution ? <span>{record.resolution}</span> : null}
                      {record.ratio ? <span>{record.ratio}</span> : null}
                      <time>{formatTime(record.createdAt)}</time>
                    </div>
                    <pre className="error-record-message">{record.errorMessage}</pre>
                  </div>
                  <div className="error-record-actions">
                    <button type="button" onClick={() => setExpandedId(expanded ? null : record.id)}>
                      {expanded ? '收起详情' : '查看详情'}
                    </button>
                    <button
                      type="button"
                      className="open-canvas"
                      disabled={!canvasUrl}
                      onClick={() => { if (canvasUrl) window.location.href = canvasUrl; }}
                    >
                      <ExternalLink size={14} />
                      进入画布
                    </button>
                  </div>
                </div>
                {expanded ? (
                  <div className="error-record-details">
                    <dl>
                      <div>
                        <dt>节点 ID</dt>
                        <dd className="identifier-value">
                          <span title={record.nodeKey || ''}>{record.nodeKey || '未记录'}</span>
                          {record.nodeKey ? (
                            <button
                              type="button"
                              className="identifier-copy"
                              title="复制节点 ID"
                              aria-label="复制节点 ID"
                              onClick={() => void copyIdentifier(record.nodeKey, `${record.id}:node`)}
                            >
                              {copiedIdentifier === `${record.id}:node` ? <Check size={12} /> : <Copy size={12} />}
                            </button>
                          ) : null}
                        </dd>
                      </div>
                      <div>
                        <dt>任务 ID</dt>
                        <dd className="identifier-value">
                          <span title={record.taskId || ''}>{record.taskId || '即时请求错误'}</span>
                          {record.taskId ? (
                            <button
                              type="button"
                              className="identifier-copy"
                              title="复制任务 ID"
                              aria-label="复制任务 ID"
                              onClick={() => void copyIdentifier(record.taskId, `${record.id}:task`)}
                            >
                              {copiedIdentifier === `${record.id}:task` ? <Check size={12} /> : <Copy size={12} />}
                            </button>
                          ) : null}
                        </dd>
                      </div>
                      <div><dt>接口</dt><dd>{record.endpoint || '未记录'}</dd></div>
                      <div><dt>供应商</dt><dd>{record.provider || '未记录'}</dd></div>
                      <div><dt>HTTP / 错误码</dt><dd>{record.httpStatus || '-'} / {record.errorCode || '-'}</dd></div>
                      <div><dt>数量 / 秒数</dt><dd>{record.quantity} / {record.durationSec || 0}s</dd></div>
                    </dl>
                    <div className="error-detail-json">
                      <strong>提交参数（敏感字段已隐藏）</strong>
                      <pre>{detailValue(record.requestParams)}</pre>
                    </div>
                    <div className="error-detail-json">
                      <strong>参考素材</strong>
                      <pre>{detailValue(record.referenceMaterials)}</pre>
                    </div>
                    <div className="error-detail-json">
                      <strong>供应商状态</strong>
                      <pre>{detailValue(record.providerStatus)}</pre>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          }) : (
            <div className="error-library-empty">当前筛选范围内没有报错记录。</div>
          )}
        </section>

        <footer className="error-library-pagination">
          <button type="button" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>
            <ChevronLeft size={15} /> 上一页
          </button>
          <span>第 {page} / {totalPages} 页</span>
          <button type="button" disabled={page >= totalPages || loading} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>
            下一页 <ChevronRight size={15} />
          </button>
        </footer>
      </section>
    </main>
  );
}

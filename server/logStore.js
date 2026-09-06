const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const LOG_FILE = path.join(config.projectsDir, '..', 'activity-logs.json');
const MAX_LOGS = 5000;
const LOG_MANAGERS = new Set(['\u5f90\u5b50\u5a77', '\u5b9e\u4e60\u751f6', '\u9648\u5a67\u4eea', '\u5b9e\u4e60\u751f6\u9648\u5a67\u4eea']);

function ensureLogFile() {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, JSON.stringify({ logs: [] }, null, 2), 'utf8');
  }
}

function readLogDocument() {
  ensureLogFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    return { logs: Array.isArray(parsed.logs) ? parsed.logs : [] };
  } catch {
    return { logs: [] };
  }
}

function writeLogDocument(document) {
  ensureLogFile();
  const tmpFile = `${LOG_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(document, null, 2), 'utf8');
  fs.renameSync(tmpFile, LOG_FILE);
}

function shanghaiDateKey(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeDateKey(value) {
  const raw = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function normalizeLog(log) {
  const createdAtMs = Number(log?.createdAtMs || new Date(log?.createdAt || 0).getTime() || Date.now());
  const normalized = {
    id: String(log?.id || crypto.randomUUID()),
    content: String(log?.content || ''),
    authorId: Number(log?.authorId || 0),
    authorName: String(log?.authorName || ''),
    createdAtMs,
    createdAt: new Date(createdAtMs).toISOString(),
    dateKey: normalizeDateKey(log?.dateKey) || shanghaiDateKey(createdAtMs),
  };

  const updatedAtMs = Number(log?.updatedAtMs || new Date(log?.updatedAt || 0).getTime() || 0);
  if (updatedAtMs > 0) {
    normalized.updatedAtMs = updatedAtMs;
    normalized.updatedAt = new Date(updatedAtMs).toISOString();
    normalized.updatedById = Number(log?.updatedById || 0);
    normalized.updatedByName = String(log?.updatedByName || '');
  }

  return normalized;
}

function listLogs(options = {}) {
  const dateKey = normalizeDateKey(options.date);
  const document = readLogDocument();
  return document.logs
    .map(normalizeLog)
    .filter((log) => !dateKey || log.dateKey === dateKey)
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
}

function assertLogContent(content) {
  const text = String(content || '').trim();
  if (!text) throw new Error('\u65e5\u5fd7\u5185\u5bb9\u4e0d\u80fd\u4e3a\u7a7a');
  if (text.length > 5000) throw new Error('\u65e5\u5fd7\u5185\u5bb9\u4e0d\u80fd\u8d85\u8fc7 5000 \u5b57');
  return text;
}

function addLog({ content, user }) {
  const text = assertLogContent(content);
  const now = Date.now();
  const log = normalizeLog({
    id: crypto.randomUUID(),
    content: text,
    authorId: user?.id,
    authorName: user?.username,
    createdAtMs: now,
    createdAt: new Date(now).toISOString(),
    dateKey: shanghaiDateKey(now),
  });

  const document = readLogDocument();
  const logs = [log, ...document.logs.map(normalizeLog)]
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, MAX_LOGS);
  writeLogDocument({ logs });
  return log;
}

function updateLog({ id, content, user }) {
  const logId = String(id || '').trim();
  const text = assertLogContent(content);
  if (!logId) throw new Error('\u65e5\u5fd7\u4e0d\u5b58\u5728');

  const document = readLogDocument();
  const logs = document.logs.map(normalizeLog);
  const index = logs.findIndex((log) => log.id === logId);
  if (index < 0) throw new Error('\u65e5\u5fd7\u4e0d\u5b58\u5728');

  const now = Date.now();
  const updatedLog = normalizeLog({
    ...logs[index],
    content: text,
    updatedAtMs: now,
    updatedAt: new Date(now).toISOString(),
    updatedById: user?.id,
    updatedByName: user?.username,
  });

  logs[index] = updatedLog;
  writeLogDocument({ logs: logs.sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, MAX_LOGS) });
  return updatedLog;
}

function canAddLog(user) {
  return Boolean(user && (user.role === 'admin' || LOG_MANAGERS.has(String(user.username || '').trim())));
}

module.exports = {
  addLog,
  canAddLog,
  listLogs,
  updateLog,
};

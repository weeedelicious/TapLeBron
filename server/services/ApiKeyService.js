const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const config = require('../config');
const { getAdminPool } = require('../db');

const ENV_PATH = path.join(__dirname, '..', '..', '.env');
const MANAGED_KEYS = ['LLM_API_KEY', 'OPENAI_API_KEY'];
const DISPLAY_KEY = 'LLM_API_KEY';
const MAX_RECORDS = 80;

function cleanSecret(value) {
  return String(value || '').trim();
}

function maskSecret(value) {
  const text = cleanSecret(value);
  if (!text) return '';
  if (text.length <= 10) return `${text.slice(0, 2)}...${text.slice(-2)}`;
  return `${text.slice(0, 5)}...${text.slice(-4)}`;
}

function hashSecret(value) {
  const text = cleanSecret(value);
  if (!text) return '';
  return crypto.createHash('sha256').update(text).digest('hex');
}

function currentApiKey() {
  return cleanSecret(process.env.LLM_API_KEY || config.llmApiKey || '');
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  if (Array.isArray(value) || typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToRecord(row) {
  return {
    id: Number(row.id),
    keyName: row.key_name,
    changedBy: row.changed_by == null ? null : Number(row.changed_by),
    changedByName: row.changed_by_name || '',
    oldKeyMasked: row.old_key_mask || '',
    newKeyMasked: row.new_key_mask || '',
    affectedKeys: parseJson(row.affected_keys, []),
    createdAt: row.created_at,
  };
}

async function readEnvFile() {
  try {
    return await fs.readFile(ENV_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function writeEnvKeys(nextKey) {
  const text = await readEnvFile();
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const hadFinalNewline = /\r?\n$/.test(text);
  const lines = text ? text.split(/\r?\n/) : [];
  if (hadFinalNewline) lines.pop();

  const seen = new Set();
  const updatedLines = lines.map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#') || !line.includes('=')) return line;
    const name = line.split('=', 1)[0].trim();
    if (!MANAGED_KEYS.includes(name)) return line;
    seen.add(name);
    return `${name}=${nextKey}`;
  });

  for (const name of MANAGED_KEYS) {
    if (!seen.has(name)) updatedLines.push(`${name}=${nextKey}`);
  }

  const backupPath = path.join(path.dirname(ENV_PATH), '.env.bak-before-api-key-manager');
  try {
    await fs.access(ENV_PATH);
    await fs.access(backupPath);
  } catch (error) {
    if (error.code === 'ENOENT' && text) {
      await fs.writeFile(backupPath, text, 'utf8').catch(() => null);
    }
  }

  await fs.writeFile(ENV_PATH, `${updatedLines.join(newline)}${newline}`, 'utf8');
}

async function listApiKeyRecords(limit = MAX_RECORDS) {
  const safeLimit = Math.min(Math.max(Number(limit) || MAX_RECORDS, 1), 200);
  const [rows] = await getAdminPool().query(
    `SELECT id, key_name, changed_by, changed_by_name, old_key_mask, new_key_mask, affected_keys, created_at
     FROM api_key_change_logs
     ORDER BY id DESC
     LIMIT ${safeLimit}`
  );
  return rows.map(rowToRecord);
}

async function getApiKeyStatus() {
  const key = currentApiKey();
  const openaiKey = cleanSecret(process.env.OPENAI_API_KEY || config.openaiApiKey || '');
  const records = await listApiKeyRecords();
  return {
    current: {
      keyName: DISPLAY_KEY,
      configured: Boolean(key),
      maskedValue: maskSecret(key),
      openaiSynced: !openaiKey || openaiKey === key,
      managedKeys: MANAGED_KEYS,
    },
    records,
  };
}

async function replaceApiKey(nextKey, user) {
  const cleanKey = cleanSecret(nextKey);
  if (!cleanKey || cleanKey.length < 12) {
    const error = new Error('API Key 不能为空，长度也不能太短');
    error.status = 400;
    throw error;
  }

  const oldKey = currentApiKey();
  const oldOpenaiKey = cleanSecret(process.env.OPENAI_API_KEY || config.openaiApiKey || '');
  const needsOpenaiSync = oldOpenaiKey !== cleanKey;
  if (oldKey === cleanKey && !needsOpenaiSync) {
    return getApiKeyStatus();
  }

  await writeEnvKeys(cleanKey);

  process.env.LLM_API_KEY = cleanKey;
  process.env.OPENAI_API_KEY = cleanKey;
  config.llmApiKey = cleanKey;
  config.openaiApiKey = cleanKey;

  await getAdminPool().query(
    `INSERT INTO api_key_change_logs
      (key_name, changed_by, changed_by_name, old_key_mask, new_key_mask, old_key_hash, new_key_hash, affected_keys)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      DISPLAY_KEY,
      user?.id || null,
      String(user?.username || '').slice(0, 80),
      maskSecret(oldKey),
      maskSecret(cleanKey),
      hashSecret(oldKey),
      hashSecret(cleanKey),
      JSON.stringify(MANAGED_KEYS),
    ]
  );

  return getApiKeyStatus();
}

module.exports = {
  getApiKeyStatus,
  replaceApiKey,
};

'use strict';

function taskUserId(task) {
  const value = Number(task?.userId);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function taskUserIdFromRow(row) {
  const value = Number(row?.user_id);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function createGenerationTaskApiKeyRunner({ getPool, getUserApiKeyByUser, apiKeyStore }) {
  if (typeof getPool !== 'function') throw new TypeError('getPool is required');
  if (typeof getUserApiKeyByUser !== 'function') throw new TypeError('getUserApiKeyByUser is required');
  if (!apiKeyStore || typeof apiKeyStore.run !== 'function') throw new TypeError('apiKeyStore is required');

  return async function runWithGenerationTaskApiKey(task, callback) {
    if (typeof callback !== 'function') throw new TypeError('callback is required');

    const userId = taskUserId(task);
    let userKey = null;
    if (userId) {
      const [rows] = await getPool().query(
        'SELECT id, external_user_id FROM users WHERE id = ? LIMIT 1',
        [userId],
      );
      const user = rows?.[0] || null;
      if (user) userKey = await getUserApiKeyByUser(user);
    }

    // Async resources created inside run() keep this user's key after the
    // callback returns, which is exactly what detached provider pollers need.
    return apiKeyStore.run({ userKey: userKey || null }, callback);
  };
}

module.exports = {
  createGenerationTaskApiKeyRunner,
  taskUserId,
  taskUserIdFromRow,
};

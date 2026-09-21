import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  createGenerationTaskApiKeyRunner,
  taskUserIdFromRow,
} = require('../server/services/GenerationTaskApiKeyContext.js');

describe('generation task restart API-key context', () => {
  it('keeps generation_tasks.user_id in the resumable task record', () => {
    const userId = taskUserIdFromRow({
      user_id: 36,
    });

    expect(userId).toBe(36);
  });

  it('starts the detached poller with the task owner key, not the global key', async () => {
    const storage = new AsyncLocalStorage<{ userKey: string | null }>();
    const query = vi.fn(async () => [[{ id: 36, external_user_id: 9001 }]]);
    const resolveKey = vi.fn(async (user: { id: number; external_user_id: number }) => {
      expect(user).toEqual({ id: 36, external_user_id: 9001 });
      return 'user-specific-key';
    });
    const run = createGenerationTaskApiKeyRunner({
      getPool: () => ({ query }),
      getUserApiKeyByUser: resolveKey,
      apiKeyStore: storage,
    });

    let keySeenByDetachedPoller: string | null | undefined;
    await run({ userId: 36 }, () => new Promise<void>((resolve) => {
      setImmediate(() => {
        keySeenByDetachedPoller = storage.getStore()?.userKey;
        resolve();
      });
    }));

    expect(query).toHaveBeenCalledWith(
      'SELECT id, external_user_id FROM users WHERE id = ? LIMIT 1',
      [36],
    );
    expect(resolveKey).toHaveBeenCalledTimes(1);
    expect(keySeenByDetachedPoller).toBe('user-specific-key');
  });
});

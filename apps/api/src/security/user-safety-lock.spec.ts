import { Prisma } from '@prisma/client';
import {
  acquireGroupDeliveryLock,
  acquireTelegramUpdateLock,
  acquireUserSafetyLocks,
} from './user-safety-lock';

describe('user safety advisory locks', () => {
  it('projects a supported scalar instead of deserializing PostgreSQL void lock results', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ acquired: 1 }]);
    const tx = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;

    await acquireUserSafetyLocks(tx, 'user-1', ['delivery', 'sync', 'sync']);
    await acquireTelegramUpdateLock(tx, 'chat:-100');
    await acquireGroupDeliveryLock(tx, 'group-1');

    expect(queryRaw).toHaveBeenCalledTimes(4);

    const queries = queryRaw.mock.calls.map(([query]) => query as Prisma.Sql);
    for (const query of queries) {
      expect(query.text).toContain('SELECT 1::integer AS acquired');
      expect(query.text).toContain('FROM pg_catalog.pg_advisory_xact_lock(');
      expect(query.text).toContain('pg_catalog.hashtextextended($1, 0)');
      expect(query.text).not.toMatch(/SELECT\s+pg_catalog\.pg_advisory_xact_lock/);
    }

    expect(queries.map((query) => query.values)).toEqual([
      ['tradeping:user:user-1:sync'],
      ['tradeping:user:user-1:delivery'],
      ['tradeping:telegram-update:chat:-100'],
      ['tradeping:group:group-1:delivery'],
    ]);
  });
});

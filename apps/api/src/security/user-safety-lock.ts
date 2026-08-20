import { Prisma } from '@prisma/client';
import { WEBHOOK } from '../config/constants';

export type UserSafetyLockScope = 'sync' | 'delivery';

const LOCK_ORDER: Record<UserSafetyLockScope, number> = {
  sync: 0,
  delivery: 1,
};

/**
 * Cross-process user lifecycle fence backed by PostgreSQL advisory locks.
 *
 * The caller must keep the surrounding interactive transaction open for the
 * whole protected operation. Locks are acquired in a fixed order so a global
 * disconnect can safely wait for both an in-flight sync and an in-flight send.
 */
export async function acquireUserSafetyLocks(
  tx: Prisma.TransactionClient,
  userId: string,
  scopes: UserSafetyLockScope[],
): Promise<void> {
  const ordered = [...new Set(scopes)].sort((a, b) => LOCK_ORDER[a] - LOCK_ORDER[b]);
  for (const scope of ordered) {
    const key = `tradeping:user:${userId}:${scope}`;
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
    `);
  }
}

export async function acquireTelegramUpdateLock(
  tx: Prisma.TransactionClient,
  scopeKey: string,
): Promise<void> {
  const key = `tradeping:telegram-update:${scopeKey}`;
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
  `);
}

export async function acquireGroupDeliveryLock(
  tx: Prisma.TransactionClient,
  groupId: string,
): Promise<void> {
  const key = `tradeping:group:${groupId}:delivery`;
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
  `);
}

export const DELIVERY_FENCE_TRANSACTION = {
  // maxWait and timeout are sequential Prisma budgets. Keep their sum at five
  // minutes so pool contention cannot turn a nominal five-minute fence into a
  // ten-minute callback that resumes after its caller's safety assumptions.
  maxWait: 30_000,
  timeout: 4 * 60_000 + 30_000,
} as const;

export const SYNC_FENCE_TRANSACTION = {
  maxWait: 15 * 60_000,
  timeout: 15 * 60_000,
} as const;

/** A webhook holds both user fences across its bounded remote/queue side
 * effects, so its idempotency lease always outlives this transaction. */
export const WEBHOOK_FENCE_TRANSACTION = {
  maxWait: WEBHOOK.FENCE_MAX_WAIT_MS,
  timeout: WEBHOOK.FENCE_TIMEOUT_MS,
} as const;

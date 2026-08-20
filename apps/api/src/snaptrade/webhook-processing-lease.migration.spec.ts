import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('webhook processing lease migration', () => {
  const root = resolve(__dirname, '../../../../');
  const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8');
  const sql = readFileSync(
    resolve(root, 'prisma/migrations/20260811020000_webhook_processing_lease/migration.sql'),
    'utf8',
  );

  it('distinguishes finite in-flight claims from completed replay boundaries', () => {
    expect(schema).toMatch(/model IdempotencyKey \{[\s\S]*status\s+String[\s\S]*leaseUntil\s+DateTime\?[\s\S]*processingToken\s+String\?[\s\S]*completedAt\s+DateTime\?/);
    expect(sql).toMatch(/"status" = 'PROCESSING'[\s\S]*"leaseUntil" IS NOT NULL[\s\S]*"processingToken" IS NOT NULL/);
    expect(sql).toMatch(/"status" = 'COMPLETED'[\s\S]*"completedAt" IS NOT NULL/);
    expect(sql).toMatch(/CREATE INDEX "IdempotencyKey_status_leaseUntil_idx"/);
  });

  it('keeps pre-migration nonces completed instead of replaying historical webhooks', () => {
    expect(sql).toMatch(/ADD COLUMN "status" TEXT NOT NULL DEFAULT 'COMPLETED'/);
    expect(sql).toMatch(/UPDATE "IdempotencyKey"[\s\S]*SET "completedAt" = "createdAt"/);
    expect(sql).toMatch(/ALTER COLUMN "status" DROP DEFAULT/);
  });
});

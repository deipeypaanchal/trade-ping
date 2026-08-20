import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('provider deletion lifecycle migration', () => {
  const root = resolve(__dirname, '../../../../');
  const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8');
  const sql = readFileSync(
    resolve(root, 'prisma/migrations/20260811010000_provider_deletion_lifecycle/migration.sql'),
    'utf8',
  );

  it('persists purpose, generation, status, and the provider identity as the tombstone key', () => {
    expect(schema).toMatch(/model ProviderDeletion \{[\s\S]*purpose\s+ProviderDeletionPurpose[\s\S]*generation\s+Int[\s\S]*status\s+ProviderDeletionStatus[\s\S]*@@id\(\[provider, providerUserId\]\)/);
    expect(sql).toMatch(/PRIMARY KEY \("provider", "providerUserId"\)/);
    expect(sql).toMatch(/'READY', 'PENDING', 'CONFIRMED'/);
  });

  it('makes user-scoped audit logs cascade and removes legacy orphan references first', () => {
    expect(schema).toMatch(/model AuditLog \{[\s\S]*user\s+User\?\s+@relation\([^\n]*onDelete: Cascade/);
    expect(sql).toMatch(/audit\.metadata->>'userId' = app_user\."snaptradeUserId"/);
    expect(sql).toMatch(/SET metadata = audit\.metadata - 'userId'/);
    expect(sql.indexOf("metadata - 'userId'")).toBeLessThan(sql.indexOf('ADD CONSTRAINT "AuditLog_userId_fkey"'));
    expect(sql.indexOf('DELETE FROM "AuditLog"')).toBeLessThan(sql.indexOf('ADD CONSTRAINT "AuditLog_userId_fkey"'));
    expect(sql).toMatch(/"AuditLog_userId_fkey"[\s\S]*ON DELETE CASCADE/);
  });

  it('provides the durable Telegram update cursor requested by the ingestion path', () => {
    expect(schema).toMatch(/model TelegramUpdateCursor \{[\s\S]*scopeKey\s+String\s+@id[\s\S]*lastUpdateId\s+Int/);
    expect(sql).toMatch(/CREATE TABLE "TelegramUpdateCursor"/);
    expect(sql).toMatch(/CREATE INDEX "TelegramUpdateCursor_updatedAt_idx"/);
  });
});

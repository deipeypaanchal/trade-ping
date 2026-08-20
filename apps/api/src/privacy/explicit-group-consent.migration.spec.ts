import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

describe('explicit group consent database contract', () => {
  const repositoryRoot = resolve(__dirname, '../../../..');
  const schema = readFileSync(join(repositoryRoot, 'prisma/schema.prisma'), 'utf8');
  const migrationRoot = join(repositoryRoot, 'prisma/migrations');
  const migrationDirectories = readdirSync(migrationRoot).sort();
  const allMigrationSql = migrationDirectories
    .map((directory) => readFileSync(join(migrationRoot, directory, 'migration.sql'), 'utf8'))
    .join('\n');
  const consentMigrationDirectory = migrationDirectories
    .sort()
    .reverse()
    .find((directory) => {
      const sql = readFileSync(join(migrationRoot, directory, 'migration.sql'), 'utf8');
      return sql.includes('sharingEnabledAt');
    });

  it('makes new memberships fail closed in the Prisma schema', () => {
    const groupMember = schema.match(/model GroupMember \{[\s\S]*?\n\}/)?.[0];

    expect(groupMember).toBeDefined();
    expect(groupMember).toMatch(/privacyLevel\s+PrivacyLevel\s+@default\(OFF\)/);
    expect(groupMember).toMatch(/alertsEnabled\s+Boolean\s+@default\(false\)/);
    expect(groupMember).toMatch(/sharingEnabledAt\s+DateTime\?/);
  });

  it('adds a durable broker-sync kill switch that defaults off', () => {
    const user = schema.match(/model User \{[\s\S]*?\n\}/)?.[0];

    expect(user).toBeDefined();
    expect(user).toMatch(/brokerSyncEnabled\s+Boolean\s+@default\(false\)/);
    expect(allMigrationSql).toMatch(/ADD COLUMN\s+"brokerSyncEnabled"\s+BOOLEAN\s+NOT NULL\s+DEFAULT\s+false/i);
  });

  it('applies every privacy-lifecycle forward migration as one explicit transaction', () => {
    const releaseMigrations = migrationDirectories.filter((directory) => directory.startsWith('20260811'));
    expect(releaseMigrations).toHaveLength(3);
    for (const directory of releaseMigrations) {
      const sql = readFileSync(join(migrationRoot, directory, 'migration.sql'), 'utf8').trim();
      expect(sql.startsWith('BEGIN;')).toBe(true);
      expect(sql.endsWith('COMMIT;')).toBe(true);
      expect(sql.match(/\bBEGIN;/g)).toHaveLength(1);
      expect(sql.match(/\bCOMMIT;/g)).toHaveLength(1);
    }
  });

  it('fails every legacy membership closed and invalidates all queued group deliveries', () => {
    if (!consentMigrationDirectory) throw new Error('No migration adds GroupMember.sharingEnabledAt');
    const sql = readFileSync(join(migrationRoot, consentMigrationDirectory, 'migration.sql'), 'utf8');

    expect(sql).toMatch(/ADD COLUMN\s+"sharingEnabledAt"\s+TIMESTAMP\(3\)/i);
    expect(sql).toMatch(/ALTER COLUMN\s+"privacyLevel"\s+SET DEFAULT\s+'OFF'/i);
    expect(sql).toMatch(/ALTER COLUMN\s+"alertsEnabled"\s+SET DEFAULT\s+false/i);

    const legacyMembershipReset = sql.match(/UPDATE\s+"GroupMember"\s+SET\s+"privacyLevel"[\s\S]*?;/i)?.[0];
    expect(legacyMembershipReset).toMatch(/"privacyLevel"\s*=\s*'OFF'/i);
    expect(legacyMembershipReset).toMatch(/"alertsEnabled"\s*=\s*false/i);
    expect(legacyMembershipReset).toMatch(/"sharingEnabledAt"\s*=\s*NULL/i);
    expect(legacyMembershipReset).not.toMatch(/\bWHERE\b/i);

    const queuedEventReset = sql.match(/UPDATE\s+"TradeEvent"[\s\S]*?;/i)?.[0];
    expect(queuedEventReset).toMatch(/"alertStatus"\s*=\s*'SKIPPED'/i);
    expect(queuedEventReset).toMatch(/"backfillStatus"\s*=\s*'BACKFILL'/i);
    expect(queuedEventReset).toMatch(/"alertStatus"\s+IN\s*\(\s*'PENDING'\s*,\s*'SENDING'\s*\)/i);

    expect(sql).toMatch(/ADD CONSTRAINT\s+"GroupMember_explicit_sharing_check"/i);
    expect(sql).toMatch(/"alertsEnabled"\s*=\s*true[\s\S]*"privacyLevel"\s*<>\s*'OFF'[\s\S]*"sharingEnabledAt"\s+IS\s+NOT\s+NULL/i);
  });
});

import { validateEnv } from './env';

const baseEnv = {
  NODE_ENV: 'development',
  APP_BASE_URL: 'https://tradeping.example',
  DATABASE_URL: 'postgresql://tradeping:tradeping@localhost:5432/tradeping?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  TELEGRAM_BOT_TOKEN: '123456:token',
  TELEGRAM_WEBHOOK_SECRET: 'telegram_secret_123456',
  SNAPTRADE_CLIENT_ID: 'snap-client',
  SNAPTRADE_CONSUMER_KEY: 'snap-consumer',
  SNAPTRADE_REDIRECT_URI: 'https://tradeping.example/snaptrade/callback',
  SNAPTRADE_USE_MOCK: 'false',
  ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  INTERNAL_JOB_SECRET: 'internal_job_secret_1234567890abcd',
};

describe('validateEnv', () => {
  it('parses false string as false', () => {
    expect(validateEnv(baseEnv).SNAPTRADE_USE_MOCK).toBe(false);
  });

  it('requires internal job secret', () => {
    const env = { ...baseEnv, INTERNAL_JOB_SECRET: undefined };
    expect(() => validateEnv(env)).toThrow();
  });

  it('rejects mock SnapTrade mode in production', () => {
    expect(() => validateEnv({ ...baseEnv, NODE_ENV: 'production', SNAPTRADE_USE_MOCK: 'true' })).toThrow(/SNAPTRADE_USE_MOCK/);
  });
});

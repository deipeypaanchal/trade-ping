import { validateEnv } from './env';

const baseEnv = {
  NODE_ENV: 'development',
  APP_BASE_URL: 'https://tradeping.example',
  DATABASE_URL: 'postgresql://tradeping:tradeping@localhost:5432/tradeping?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  TELEGRAM_BOT_TOKEN: '123456:token',
  TELEGRAM_WEBHOOK_SECRET: 'test_webhook_secret_value',
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
    expect(() => validateEnv({ ...baseEnv, NODE_ENV: 'production', TELEGRAM_BOT_USERNAME: 'tradeping_bot', SNAPTRADE_USE_MOCK: 'true' })).toThrow(/SNAPTRADE_USE_MOCK/);
  });

  it('requires the encryption key to decode to exactly 32 bytes', () => {
    expect(() => validateEnv({ ...baseEnv, ENCRYPTION_KEY_BASE64: Buffer.alloc(31, 7).toString('base64') })).toThrow(/32 bytes/);
  });

  it('requires https public urls in production', () => {
    expect(() => validateEnv({ ...baseEnv, NODE_ENV: 'production', TELEGRAM_BOT_USERNAME: 'tradeping_bot', APP_BASE_URL: 'http://tradeping.example' })).toThrow(/APP_BASE_URL/);
    expect(() => validateEnv({ ...baseEnv, NODE_ENV: 'production', TELEGRAM_BOT_USERNAME: 'tradeping_bot', SNAPTRADE_REDIRECT_URI: 'http://tradeping.example/snaptrade/callback' })).toThrow(/SNAPTRADE_REDIRECT_URI/);
  });

  it('requires a verified bot username in production', () => {
    expect(() => validateEnv({ ...baseEnv, NODE_ENV: 'production' })).toThrow(/TELEGRAM_BOT_USERNAME/);
  });

  it('accepts an optional recovery suppression timestamp', () => {
    expect(validateEnv({ ...baseEnv, RECOVERY_SUPPRESS_BEFORE: '2026-07-06T05:00:00.000Z' }).RECOVERY_SUPPRESS_BEFORE).toBe('2026-07-06T05:00:00.000Z');
  });

  it('accepts only UUID Railway deployment identifiers', () => {
    const deploymentId = '019c92ba-3e22-7c2a-a57c-89f03b330a51';
    expect(validateEnv({ ...baseEnv, RAILWAY_DEPLOYMENT_ID: deploymentId }).RAILWAY_DEPLOYMENT_ID).toBe(deploymentId);
    expect(() => validateEnv({ ...baseEnv, RAILWAY_DEPLOYMENT_ID: 'latest' })).toThrow(/RAILWAY_DEPLOYMENT_ID/);
  });
});

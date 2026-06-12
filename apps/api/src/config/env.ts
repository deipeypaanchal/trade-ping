import { z } from 'zod';

const envBoolean = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return value;
}, z.boolean());

export const envSchema = z.object({
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  PORT: z.coerce.number().default(3000),
  APP_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_BOT_USERNAME: z.string().regex(/^[A-Za-z0-9_]{5,32}$/).optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
  SNAPTRADE_CLIENT_ID: z.string().min(1),
  SNAPTRADE_CONSUMER_KEY: z.string().min(1),
  SNAPTRADE_REDIRECT_URI: z.string().url(),
  SNAPTRADE_BROKER_SLUG: z.string().optional(),
  SNAPTRADE_USE_MOCK: envBoolean.default(false),
  ENCRYPTION_KEY_BASE64: z.string().min(32),
  INTERNAL_JOB_SECRET: z.string().min(32),
  RELEASE_SHA: z.string().min(7).optional(),
  TRADE_ORDER_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(90).default(3),
  SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(5),
  BACKFILL_SUPPRESS_HOURS: z.coerce.number().int().min(0).max(168).default(24),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && env.SNAPTRADE_USE_MOCK) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SNAPTRADE_USE_MOCK'],
      message: 'SNAPTRADE_USE_MOCK must be false in production',
    });
  }
});

export type Env = z.infer<typeof envSchema>;
export function validateEnv(config: Record<string, unknown>) {
  return envSchema.parse(config);
}

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Bottleneck from 'bottleneck';
import { ALERT, LIMITS } from '../config/constants';

export type TelegramReplyMarkup = {
  inline_keyboard: Array<Array<{ text: string; url: string }>>;
};

export type TelegramMessageOptions = {
  replyMarkup?: TelegramReplyMarkup;
  /** Absolute wall-clock cutoff. A queued job is rejected and cannot send once reached. */
  deadlineAt?: number;
  /** Optional caller cancellation, combined with the absolute deadline. */
  signal?: AbortSignal;
};

export class TelegramApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

/**
 * Telegram bot send-message wrapper with built-in rate limiting and 429 retries.
 *
 * Telegram limits (per https://core.telegram.org/bots/faq#broadcasting-to-users):
 *   - In a single chat: max 1 message / second (short bursts tolerated).
 *   - In a group: max 20 messages / minute.
 *   - Global: ~30 messages / second for bulk notifications.
 *
 * Strategy:
 *   - Per-chat limiter: minTime + reservoir/min protects chat and group limits.
 *   - Chained global limiter: 25 msgs/sec, leaving headroom under the 30/sec ceiling.
 *   - On HTTP 429, honor `retry_after` from the response body and retry up to LIMITS.TELEGRAM_MAX_RETRIES.
 */
@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);
  private readonly globalLimiter = new Bottleneck({
    reservoir: LIMITS.TELEGRAM_GLOBAL_RESERVOIR,
    reservoirRefreshAmount: LIMITS.TELEGRAM_GLOBAL_RESERVOIR,
    reservoirRefreshInterval: LIMITS.TELEGRAM_GLOBAL_RESERVOIR_REFRESH_MS,
    maxConcurrent: LIMITS.TELEGRAM_GLOBAL_MAX_CONCURRENT,
  });
  private readonly perChat = new Bottleneck.Group({
    minTime: LIMITS.TELEGRAM_PER_CHAT_MIN_TIME_MS,
    maxConcurrent: 1,
    reservoir: LIMITS.TELEGRAM_PER_CHAT_RESERVOIR,
    reservoirRefreshAmount: LIMITS.TELEGRAM_PER_CHAT_RESERVOIR,
    reservoirRefreshInterval: LIMITS.TELEGRAM_PER_CHAT_RESERVOIR_REFRESH_MS,
  });

  constructor(private config: ConfigService) {
    this.perChat.on('created', (limiter) => {
      limiter.chain(this.globalLimiter);
    });
  }

  /**
   * Register the webhook and command menu on boot so a fresh deploy is live with
   * no manual curl step. Skipped (with a warning) while APP_BASE_URL / the bot
   * token are still placeholders, e.g. local dev without a public tunnel.
   * Failures are logged, never fatal — the API should still come up.
   */
  async onModuleInit(): Promise<void> {
    const baseUrl = this.config.get<string>('APP_BASE_URL') ?? '';
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? '';
    if (!baseUrl.startsWith('https://') || baseUrl.includes('your-domain.com') || token.includes('replace_me')) {
      this.logger.warn('Skipping Telegram registration: set a public https APP_BASE_URL and a real TELEGRAM_BOT_TOKEN, then restart to go live.');
      return;
    }
    try {
      await this.verifyBotIdentity();
      await this.setWebhook();
      await this.setMyCommands();
      this.logger.log('Telegram webhook and command menu registered');
    } catch (e) {
      this.logger.error(`Telegram startup registration failed: ${(e as Error).message}`);
    }
  }

  async sendMessage(chatId: string, text: string, options: TelegramMessageOptions = {}): Promise<{ message_id?: number }> {
    const signal = this.operationSignal({
      ...options,
      deadlineAt: options.deadlineAt ?? Date.now() + ALERT.DELIVERY_MAX_RUN_MS,
    });
    signal?.throwIfAborted();
    const scheduled = this.perChat.key(chatId).schedule(async () => {
      // Bottleneck can legally retain a job while its reservoir is empty. The
      // absolute signal makes a job that starts after its owning DB fence a
      // no-op instead of a late Telegram send.
      signal?.throwIfAborted();
      return this.doSend(chatId, text, options, 0, signal);
    });
    return this.awaitWithSignal(scheduled, signal);
  }

  async editMessageText(chatId: string, messageId: number, text: string, options: Omit<TelegramMessageOptions, 'replyMarkup'> = {}): Promise<void> {
    const signal = this.operationSignal({
      ...options,
      deadlineAt: options.deadlineAt ?? Date.now() + ALERT.DELIVERY_MAX_RUN_MS,
    });
    signal?.throwIfAborted();
    const scheduled = this.perChat.key(chatId).schedule(async () => {
      signal?.throwIfAborted();
      return this.doEdit(chatId, messageId, text, 0, signal);
    });
    return this.awaitWithSignal(scheduled, signal);
  }

  async setWebhook(): Promise<void> {
    const token = this.config.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    const url = `${this.config.getOrThrow<string>('APP_BASE_URL')}/telegram/webhook`;
    const secret = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET');
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // Never drop queued updates during routine deploys. A queued /privacy off
      // or /disconnect request is safety-sensitive and must survive restarts.
      body: JSON.stringify({
        url,
        secret_token: secret,
        allowed_updates: ['message', 'my_chat_member'],
        // Serial delivery plus the durable update cursor prevents an older
        // consent command from overtaking a newer safety command.
        max_connections: 1,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new TelegramApiError(`Telegram setWebhook failed: ${res.status} ${await res.text()}`, res.status);
  }

  async isChatAdmin(chatId: string, userId: string): Promise<boolean> {
    // Telegram represents commands sent as an anonymous group admin with this
    // service account. The webhook secret prevents callers from spoofing it.
    if (userId === '1087968824') return true;
    const token = this.config.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    const res = await fetch(`https://api.telegram.org/bot${token}/getChatMember`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, user_id: userId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new TelegramApiError(`Telegram getChatMember failed: ${res.status} ${await res.text()}`, res.status);
    }
    const json = await res.json() as { result?: { status?: string } };
    if (!json.result?.status) {
      throw new TelegramApiError('Telegram getChatMember returned no member status', 502);
    }
    return json.result.status === 'creator' || json.result.status === 'administrator';
  }

  /** Publishes the slash-command menu users see in the Telegram UI. */
  async setMyCommands(): Promise<void> {
    const token = this.config.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    const commands = [
      { command: 'connect', description: 'Connect a read-only brokerage' },
      { command: 'reconnect', description: 'Repair a disabled brokerage connection' },
      { command: 'privacy', description: 'Set alert privacy: public, normal, private, off' },
      { command: 'trust', description: 'What is bot, user, and group level' },
      { command: 'diagnostics', description: 'Explain latest sync and broker freshness' },
      { command: 'groupstatus', description: 'Admin: aggregate group alert health' },
      { command: 'setup', description: 'Post group onboarding instructions' },
      { command: 'status', description: 'Show your brokerage connection status' },
      { command: 'sync', description: 'Manual backup sync' },
      { command: 'inferred', description: 'Admin: provisional Robinhood holdings alerts' },
      { command: 'disconnect', description: 'DM: revoke all brokerage connections' },
      { command: 'help', description: 'How TradePing works' },
    ];
    const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commands }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new TelegramApiError(`Telegram setMyCommands failed: ${res.status} ${await res.text()}`, res.status);
  }

  private async doSend(
    chatId: string,
    text: string,
    options: TelegramMessageOptions,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<{ message_id?: number }> {
    signal?.throwIfAborted();
    const token = this.config.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      }),
      signal: this.requestSignal(signal),
    });
    const body = await res.text();
    if (res.status === 429 && attempt < LIMITS.TELEGRAM_MAX_RETRIES) {
      const retryAfterSec = this.retryAfter(body);
      this.logger.warn(`Telegram 429 for chat ${chatId}; retrying in ${retryAfterSec}s`);
      await this.abortableDelay((retryAfterSec + LIMITS.TELEGRAM_RETRY_AFTER_PADDING_S) * 1000, signal);
      return this.doSend(chatId, text, options, attempt + 1, signal);
    }
    if (!res.ok) throw new TelegramApiError(`Telegram sendMessage failed: ${res.status} ${body}`, res.status);
    const json = JSON.parse(body) as { result?: { message_id: number } };
    return { message_id: json.result?.message_id };
  }

  private async doEdit(chatId: string, messageId: number, text: string, attempt: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const token = this.config.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: this.requestSignal(signal),
    });
    const body = await res.text();
    if (res.status === 429 && attempt < LIMITS.TELEGRAM_MAX_RETRIES) {
      const retryAfterSec = this.retryAfter(body);
      this.logger.warn(`Telegram 429 editing chat ${chatId}; retrying in ${retryAfterSec}s`);
      await this.abortableDelay((retryAfterSec + LIMITS.TELEGRAM_RETRY_AFTER_PADDING_S) * 1000, signal);
      return this.doEdit(chatId, messageId, text, attempt + 1, signal);
    }
    // A retry after a DB error may edit a message that already has the final
    // text. Telegram reports that idempotent state as HTTP 400.
    if (res.status === 400 && body.includes('message is not modified')) return;
    if (!res.ok) throw new TelegramApiError(`Telegram editMessageText failed: ${res.status} ${body}`, res.status);
  }

  private retryAfter(body: string): number {
    try {
      const retryAfter = (JSON.parse(body)?.parameters?.retry_after as number) || 1;
      return Number.isFinite(retryAfter) && retryAfter >= 0
        ? Math.min(retryAfter, LIMITS.TELEGRAM_MAX_RETRY_AFTER_S)
        : 1;
    } catch {
      return 1;
    }
  }

  private operationSignal(options: Pick<TelegramMessageOptions, 'deadlineAt' | 'signal'>): AbortSignal | undefined {
    const signals: AbortSignal[] = [];
    if (options.signal) signals.push(options.signal);
    if (options.deadlineAt !== undefined) {
      const remainingMs = options.deadlineAt - Date.now();
      signals.push(remainingMs > 0
        ? AbortSignal.timeout(remainingMs)
        : AbortSignal.abort(new Error('Telegram operation deadline exceeded')));
    }
    if (!signals.length) return undefined;
    return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  }

  private requestSignal(operationSignal?: AbortSignal): AbortSignal {
    const requestTimeout = AbortSignal.timeout(LIMITS.TELEGRAM_REQUEST_TIMEOUT_MS);
    return operationSignal ? AbortSignal.any([operationSignal, requestTimeout]) : requestTimeout;
  }

  private async awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error('Telegram operation aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  private async abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return;
    }
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('Telegram operation aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async verifyBotIdentity(): Promise<void> {
    const token = this.config.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    const configured = this.config.get<string>('TELEGRAM_BOT_USERNAME')?.replace(/^@/, '').toLowerCase();
    if (!configured && this.config.get<string>('NODE_ENV') === 'production') {
      throw new Error('TELEGRAM_BOT_USERNAME is required in production');
    }
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json() as { ok?: boolean; result?: { username?: string } };
    const actual = payload.result?.username?.toLowerCase();
    if (!response.ok || !payload.ok || !actual) throw new TelegramApiError(`Telegram getMe failed: ${response.status}`, response.status);
    if (configured && actual !== configured) throw new Error(`TELEGRAM_BOT_USERNAME does not match getMe (${actual})`);
  }
}

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Bottleneck from 'bottleneck';
import { LIMITS } from '../config/constants';

export type TelegramReplyMarkup = {
  inline_keyboard: Array<Array<{ text: string; url: string }>>;
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
      await this.setWebhook();
      await this.setMyCommands();
      this.logger.log('Telegram webhook and command menu registered');
    } catch (e) {
      this.logger.error(`Telegram startup registration failed: ${(e as Error).message}`);
    }
  }

  async sendMessage(chatId: string, text: string, options: { replyMarkup?: TelegramReplyMarkup } = {}): Promise<{ message_id?: number }> {
    return this.perChat.key(chatId).schedule(() => this.doSend(chatId, text, options, 0));
  }

  async setWebhook(): Promise<void> {
    const token = this.config.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    const url = `${this.config.getOrThrow<string>('APP_BASE_URL')}/telegram/webhook`;
    const secret = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET');
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true }),
    });
    if (!res.ok) throw new TelegramApiError(`Telegram setWebhook failed: ${res.status} ${await res.text()}`, res.status);
  }

  async isChatAdmin(chatId: string, userId: string): Promise<boolean> {
    // Telegram represents commands sent as an anonymous group admin with this
    // service account. The webhook secret prevents callers from spoofing it.
    if (userId === '1087968824') return true;
    const token = this.config.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getChatMember`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, user_id: userId }),
      });
      if (!res.ok) return false;
      const json = await res.json() as { result?: { status?: string } };
      return json.result?.status === 'creator' || json.result?.status === 'administrator';
    } catch {
      return false;
    }
  }

  /** Publishes the slash-command menu users see in the Telegram UI. */
  async setMyCommands(): Promise<void> {
    const token = this.config.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    const commands = [
      { command: 'connect', description: 'Connect a read-only brokerage' },
      { command: 'privacy', description: 'Set alert privacy: public, normal, private, off' },
      { command: 'trust', description: 'What is bot, user, and group level' },
      { command: 'diagnostics', description: 'Explain latest sync and broker freshness' },
      { command: 'groupstatus', description: 'Show group setup and alert health' },
      { command: 'setup', description: 'Post group onboarding instructions' },
      { command: 'status', description: 'Show your brokerage connection status' },
      { command: 'sync', description: 'Manual backup sync' },
      { command: 'inferred', description: 'Admin: provisional Robinhood holdings alerts' },
      { command: 'disconnect', description: 'Remove your brokerage connections' },
      { command: 'help', description: 'How TradePing works' },
    ];
    const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
    if (!res.ok) throw new TelegramApiError(`Telegram setMyCommands failed: ${res.status} ${await res.text()}`, res.status);
  }

  private async doSend(chatId: string, text: string, options: { replyMarkup?: TelegramReplyMarkup }, attempt: number): Promise<{ message_id?: number }> {
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
    });
    const body = await res.text();
    if (res.status === 429 && attempt < LIMITS.TELEGRAM_MAX_RETRIES) {
      const retryAfterSec = this.retryAfter(body);
      this.logger.warn(`Telegram 429 for chat ${chatId}; retrying in ${retryAfterSec}s`);
      await new Promise((r) => setTimeout(r, (retryAfterSec + LIMITS.TELEGRAM_RETRY_AFTER_PADDING_S) * 1000));
      return this.doSend(chatId, text, options, attempt + 1);
    }
    if (!res.ok) throw new TelegramApiError(`Telegram sendMessage failed: ${res.status} ${body}`, res.status);
    const json = JSON.parse(body) as { result?: { message_id: number } };
    return { message_id: json.result?.message_id };
  }

  private retryAfter(body: string): number {
    try {
      const retryAfter = (JSON.parse(body)?.parameters?.retry_after as number) || 1;
      return Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : 1;
    } catch {
      return 1;
    }
  }
}

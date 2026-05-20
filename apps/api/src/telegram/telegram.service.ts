import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Bottleneck from 'bottleneck';

/**
 * Telegram bot send-message wrapper with built-in rate limiting and 429 retries.
 *
 * Telegram limits (per https://core.telegram.org/bots/faq#broadcasting-to-users):
 *   - In a single chat: max 1 message / second (short bursts tolerated).
 *   - In a group: max 20 messages / minute.
 *   - Global: ~30 messages / second for bulk notifications.
 *
 * Strategy:
 *   - Per-chat limiter: minTime=1100ms and reservoir=20/min protects chat and group limits.
 *   - Chained global limiter: 25 msgs/sec, leaving headroom under the 30/sec ceiling.
 *   - On HTTP 429, honor `retry_after` from the response body and retry once.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly globalLimiter = new Bottleneck({
    reservoir: 25,
    reservoirRefreshAmount: 25,
    reservoirRefreshInterval: 1000,
    maxConcurrent: 5,
  });
  private readonly perChat = new Bottleneck.Group({
    minTime: 1100,
    maxConcurrent: 1,
    reservoir: 20,
    reservoirRefreshAmount: 20,
    reservoirRefreshInterval: 60_000,
  });

  constructor(private config: ConfigService) {
    this.perChat.on('created', (limiter) => {
      limiter.chain(this.globalLimiter);
    });
  }

  async sendMessage(chatId: string, text: string): Promise<{ message_id?: number }> {
    return this.perChat.key(chatId).schedule(() => this.doSend(chatId, text, 0));
  }

  async setWebhook(): Promise<void> {
    const token = this.config.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    const url = `${this.config.getOrThrow<string>('APP_BASE_URL')}/telegram/webhook`;
    const secret = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET');
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, secret_token: secret, allowed_updates: ['message'] }),
    });
    if (!res.ok) throw new Error(`Telegram setWebhook failed: ${res.status} ${await res.text()}`);
  }

  private async doSend(chatId: string, text: string, attempt: number): Promise<{ message_id?: number }> {
    const token = this.config.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const body = await res.text();
    if (res.status === 429 && attempt < 2) {
      let retryAfterSec = 1;
      try { retryAfterSec = (JSON.parse(body)?.parameters?.retry_after as number) || 1; } catch { /* ignore */ }
      this.logger.warn(`Telegram 429 for chat ${chatId}; retrying in ${retryAfterSec}s`);
      await new Promise((r) => setTimeout(r, (retryAfterSec + 0.2) * 1000));
      return this.doSend(chatId, text, attempt + 1);
    }
    if (!res.ok) throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
    const json = JSON.parse(body) as { result?: { message_id: number } };
    return { message_id: json.result?.message_id };
  }
}

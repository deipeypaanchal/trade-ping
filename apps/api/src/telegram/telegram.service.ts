import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TelegramService {
  constructor(private config: ConfigService) {}

  async sendMessage(chatId: string, text: string): Promise<{ message_id?: number }> {
    const token = this.config.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
    const json = JSON.parse(body) as { result?: { message_id: number } };
    return { message_id: json.result?.message_id };
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
}

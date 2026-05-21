import { BadRequestException, Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../config/prisma.service';
import { JOB_DEFAULTS } from '../config/constants';
import { TelegramService } from './telegram.service';
import { TelegramUpdate } from './telegram.types';
import { BrokerOnboardingService } from '../broker/broker-onboarding.service';
import { PrivacyService } from '../privacy/privacy.service';

const VALID_PRIVACY = new Set(['PUBLIC', 'NORMAL', 'PRIVATE', 'OFF']);

@Controller('telegram')
export class TelegramController {
  constructor(
    private prisma: PrismaService,
    private telegram: TelegramService,
    private onboarding: BrokerOnboardingService,
    private privacy: PrivacyService,
    private config: ConfigService,
    @InjectQueue('trade-sync') private queue: Queue,
  ) {}

  @Post('webhook')
  async webhook(@Body() update: TelegramUpdate, @Headers('x-telegram-bot-api-secret-token') secret?: string) {
    const expected = this.config.getOrThrow<string>('TELEGRAM_WEBHOOK_SECRET');
    if (secret !== expected) throw new UnauthorizedException();
    const msg = update.message;
    if (!msg) return { ok: true };

    if (msg.new_chat_members?.length) {
      await this.handleNewChatMembers(msg);
      return { ok: true };
    }

    if (!msg.text || !msg.from) return { ok: true };
    const text = msg.text.trim();
    const chatId = String(msg.chat.id);
    const user = await this.prisma.user.upsert({
      where: { telegramUserId: String(msg.from.id) },
      update: { displayName: this.displayName(msg.from) },
      create: { telegramUserId: String(msg.from.id), displayName: this.displayName(msg.from) },
    });
    const group = await this.groupFor(msg.chat);
    if (group) {
      await this.prisma.groupMember.upsert({ where: { userId_groupId: { userId: user.id, groupId: group.id } }, update: {}, create: { userId: user.id, groupId: group.id } });
    }

    try {
      if (this.cmd(text, '/connect')) {
        if (!group) {
          await this.telegram.sendMessage(chatId, 'Run /connect inside your TradePing group so alerts post there. I\'ll DM you the private link.');
          return { ok: true };
        }
        const url = await this.onboarding.createConnectUrl(user.id, group.id);
        await this.sendConnectLink(msg.chat.type, chatId, String(msg.from.id), url);
      } else if (this.cmd(text, '/privacy')) {
        if (!group) {
          await this.telegram.sendMessage(chatId, 'Privacy is per group. Run /privacy public, normal, private, or off inside your TradePing group.');
          return { ok: true };
        }
        const level = text.split(/\s+/)[1]?.toUpperCase();
        if (!level || !VALID_PRIVACY.has(level)) {
          await this.telegram.sendMessage(chatId, this.privacyHelpText());
        } else {
          await this.privacy.setPrivacy(user.id, group.id, level);
          await this.telegram.sendMessage(chatId, `Alert visibility set to <b>${level}</b> for this group.`);
        }
      } else if (this.cmd(text, '/setup')) {
        await this.telegram.sendMessage(chatId, this.groupSetupText(msg.chat.title), { replyMarkup: this.privateStartKeyboard() });
      } else if (this.cmd(text, '/status')) {
        await this.onboarding.refreshConnections(user.id);
        const connections = await this.prisma.brokerConnection.findMany({
          where: { userId: user.id, status: { not: 'DISCONNECTED' } },
          orderBy: { updatedAt: 'desc' },
        });
        await this.telegram.sendMessage(chatId, this.statusText(connections));
      } else if (this.cmd(text, '/sync')) {
        await this.queue.add('sync-user', { userId: user.id }, { ...JOB_DEFAULTS });
        await this.telegram.sendMessage(chatId, 'Sync queued — new executions will alert here shortly.');
      } else if (this.cmd(text, '/timezone')) {
        const tz = text.split(/\s+/)[1];
        if (!tz) {
          await this.telegram.sendMessage(chatId, `Your alert timezone is <b>${this.escape(user.timeZone || 'UTC')}</b>.\nChange it with /timezone <IANA-zone>, e.g. /timezone Europe/London`);
        } else if (!this.isValidTimezone(tz)) {
          await this.telegram.sendMessage(chatId, `Unknown timezone: ${this.escape(tz)}. Use an IANA zone like America/New_York or Europe/London.`);
        } else {
          await this.prisma.user.update({ where: { id: user.id }, data: { timeZone: tz } });
          await this.telegram.sendMessage(chatId, `Alert timezone set to <b>${this.escape(tz)}</b>.`);
        }
      } else if (this.cmd(text, '/disconnect')) {
        const count = await this.onboarding.disconnectAll(user.id);
        await this.telegram.sendMessage(chatId, count ? `Disconnected ${count} brokerage connection(s). No more alerts until you /connect again.` : 'You had no active brokerage connections.');
      } else if (this.cmd(text, '/help') || this.cmd(text, '/start')) {
        await this.telegram.sendMessage(chatId, this.helpText(msg.chat.type), { replyMarkup: msg.chat.type === 'private' ? undefined : this.privateStartKeyboard() });
      }
    } catch (e) {
      const command = text.split(/\s+/)[0] || 'unknown';
      const err = e as Error;
      await this.prisma.auditLog.create({
        data: {
          userId: user.id,
          action: 'telegram_command_failed',
          metadata: { command, message: err.message, name: err.name },
        },
      });
      const userMsg = e instanceof BadRequestException
        ? `Invalid input: ${err.message}`
        : 'Something went wrong. Please try again or contact the group admin.';
      await this.telegram.sendMessage(chatId, userMsg);
    }
    return { ok: true };
  }

  private cmd(text: string, command: string) { return text === command || text.startsWith(`${command} `) || text.startsWith(`${command}@`); }
  private groupFor(chat: NonNullable<TelegramUpdate['message']>['chat']) {
    if (chat.type !== 'group' && chat.type !== 'supergroup') return null;
    return this.prisma.group.upsert({
      where: { telegramChatId: String(chat.id) },
      update: { name: chat.title },
      create: { telegramChatId: String(chat.id), name: chat.title },
    });
  }

  private async handleNewChatMembers(msg: NonNullable<TelegramUpdate['message']>) {
    // Greet only once — when TradePing itself is added. Stay silent on member
    // joins so the group never gets spammed with per-join welcome messages.
    const botUsername = (this.config.get<string>('TELEGRAM_BOT_USERNAME') ?? '').toLowerCase();
    const botAdded = msg.new_chat_members?.some((m) => m.is_bot && m.username?.toLowerCase() === botUsername) ?? false;
    if (!botAdded) return;
    await this.telegram.sendMessage(String(msg.chat.id), this.groupSetupText(msg.chat.title), { replyMarkup: this.privateStartKeyboard() });
  }

  private async sendConnectLink(chatType: string, chatId: string, telegramUserId: string, url: string) {
    const text = `Connect your brokerage (read-only):\n${url}\n\nThe link expires in ~5 minutes. Run /disconnect anytime to revoke access.`;
    if (chatType === 'private') {
      await this.telegram.sendMessage(chatId, text);
      return;
    }
    try {
      await this.telegram.sendMessage(telegramUserId, text);
      await this.telegram.sendMessage(chatId, 'Sent your private connection link in DM.');
    } catch {
      await this.telegram.sendMessage(
        chatId,
        'I can\'t DM you yet. Tap <b>Start private setup</b>, press Start, then run /connect here again.',
        { replyMarkup: this.privateStartKeyboard() },
      );
    }
  }

  private helpText(chatType: string) {
    if (chatType === 'private') {
      return 'You\'re ready. Go back to your TradePing group and run /connect there — I\'ll DM your read-only brokerage link, and your trade alerts will post in that group.';
    }
    return [
      'TradePing posts read-only trade alerts to this group.',
      '',
      '/connect — connect a read-only brokerage',
      '/privacy — public, normal, private, or off',
      '/timezone — set IANA timezone (e.g. Europe/London)',
      '/status — your connection status',
      '/disconnect — remove your connections',
    ].join('\n');
  }

  private statusText(connections: Array<{ status: string; brokerageName: string | null; brokerageSlug: string | null }>) {
    if (!connections.length) return 'No brokerage connected. Run /connect to get started.';
    const label: Record<string, string> = {
      ACTIVE: 'connected (read-only)',
      PENDING: 'finishing connection…',
      ERROR: 'needs reconnect — run /connect',
      DISABLED: 'disabled by your broker — run /connect',
    };
    const lines = connections.map((c) => {
      const name = this.escape(c.brokerageName ?? c.brokerageSlug ?? 'Brokerage');
      return `${name} — ${label[c.status] ?? c.status.toLowerCase()}`;
    });
    return ['Your connections:', ...lines].join('\n');
  }

  private privacyHelpText() {
    return [
      'Set how your trades appear in this group:',
      '/privacy public  — name, symbol, quantity and price',
      '/privacy normal  — name and symbol only (default)',
      '/privacy private — anonymous, symbol only',
      '/privacy off     — no alerts',
    ].join('\n');
  }

  private groupSetupText(chatTitle?: string) {
    const name = chatTitle ? `<b>${this.escape(chatTitle)}</b>` : 'this group';
    return [
      `TradePing is ready for ${name}.`,
      '',
      'To share your trades here:',
      '1. Tap <b>Start private setup</b> so I can DM you safely.',
      '2. Come back and run /connect.',
      '3. Set visibility with /privacy (public, normal, private, off).',
      '',
      'Alerts are read-only — TradePing never sees your login and can never place trades.',
    ].join('\n');
  }

  private privateStartKeyboard() {
    const username = this.config.get<string>('TELEGRAM_BOT_USERNAME') ?? 'tradeping_v1_bot';
    return { inline_keyboard: [[{ text: 'Start private setup', url: `https://t.me/${username}?start=setup` }]] };
  }

  private displayName(from: NonNullable<TelegramUpdate['message']>['from']) {
    return from?.username ? `@${from.username}` : [from?.first_name, from?.last_name].filter(Boolean).join(' ') || 'Telegram User';
  }

  /** Validate IANA timezone strings via Intl. Returns false for unknown zones. */
  private isValidTimezone(tz: string): boolean {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }

  private escape(v: string): string {
    return v
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

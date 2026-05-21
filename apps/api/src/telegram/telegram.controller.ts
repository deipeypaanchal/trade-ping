import { Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../config/prisma.service';
import { TelegramService } from './telegram.service';
import { TelegramUpdate } from './telegram.types';
import { BrokerOnboardingService } from '../broker/broker-onboarding.service';
import { PrivacyService } from '../privacy/privacy.service';

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
    const group = await this.prisma.group.upsert({ where: { telegramChatId: chatId }, update: { name: msg.chat.title }, create: { telegramChatId: chatId, name: msg.chat.title } });
    await this.prisma.groupMember.upsert({ where: { userId_groupId: { userId: user.id, groupId: group.id } }, update: {}, create: { userId: user.id, groupId: group.id } });

    try {
      if (this.cmd(text, '/connect')) {
        const url = await this.onboarding.createConnectUrl(user.id, group.id);
        await this.sendConnectLink(msg.chat.type, chatId, String(msg.from.id), url);
      } else if (this.cmd(text, '/privacy')) {
        const level = text.split(/\s+/)[1]?.toUpperCase();
        if (!level) await this.telegram.sendMessage(chatId, 'Privacy options: /privacy public, /privacy normal, /privacy private, /privacy off');
        else { await this.privacy.setPrivacy(user.id, group.id, level); await this.telegram.sendMessage(chatId, `Privacy updated to ${level}.`); }
      } else if (this.cmd(text, '/setup')) {
        await this.telegram.sendMessage(chatId, this.groupSetupText(msg.chat.title), { replyMarkup: this.privateStartKeyboard() });
      } else if (this.cmd(text, '/status')) {
        await this.onboarding.refreshConnections(user.id);
        const connections = await this.prisma.brokerConnection.findMany({ where: { userId: user.id }, orderBy: { updatedAt: 'desc' } });
        const summary = connections.length ? connections.map(c => `${c.status}: ${c.brokerageName ?? c.brokerageSlug ?? 'Brokerage'} (${c.connectionType ?? 'read'})`).join('\n') : 'No brokerage connected yet. Use /connect.';
        await this.telegram.sendMessage(chatId, summary);
      } else if (this.cmd(text, '/sync')) {
        await this.queue.add('sync-user', { userId: user.id }, { removeOnComplete: 100, attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
        await this.telegram.sendMessage(chatId, 'Sync queued. Alerts will appear in this group as new executions arrive.');
      } else if (this.cmd(text, '/disconnect')) {
        const count = await this.onboarding.disconnectAll(user.id);
        await this.telegram.sendMessage(chatId, `Disconnected ${count} brokerage connection(s).`);
      } else if (this.cmd(text, '/help') || this.cmd(text, '/start')) {
        await this.telegram.sendMessage(chatId, this.helpText(msg.chat.type), { replyMarkup: msg.chat.type === 'private' ? undefined : this.privateStartKeyboard() });
      }
    } catch (e) {
      await this.prisma.auditLog.create({ data: { userId: user.id, action: 'telegram_command_failed', metadata: { message: (e as Error).message } } });
      await this.telegram.sendMessage(chatId, 'Something went wrong. Please try again or contact the group admin.');
    }
    return { ok: true };
  }

  private cmd(text: string, command: string) { return text === command || text.startsWith(`${command} `) || text.startsWith(`${command}@`); }
  private async handleNewChatMembers(msg: NonNullable<TelegramUpdate['message']>) {
    const chatId = String(msg.chat.id);
    const humans = msg.new_chat_members?.filter((member) => !member.is_bot) ?? [];
    if (humans.length === 0) {
      await this.telegram.sendMessage(chatId, this.groupSetupText(msg.chat.title), { replyMarkup: this.privateStartKeyboard() });
      return;
    }
    const names = humans.slice(0, 3).map((member) => this.escape(this.displayName(member))).join(', ');
    const suffix = humans.length > 3 ? ` and ${humans.length - 3} more` : '';
    await this.telegram.sendMessage(
      chatId,
      `Welcome ${names}${suffix}.\n\nTo share verified trade alerts here:\n1. Tap <b>Start private setup</b>.\n2. Come back to this group and run /connect.\n3. Pick privacy with /privacy private, normal, public, or off.`,
      { replyMarkup: this.privateStartKeyboard() },
    );
  }

  private async sendConnectLink(chatType: string, chatId: string, telegramUserId: string, url: string) {
    const text = `Connect your brokerage read-only here:\n${url}\n\nThe link expires in about 5 minutes. Use /disconnect anytime.`;
    if (chatType === 'private') {
      await this.telegram.sendMessage(chatId, text);
      return;
    }
    try {
      await this.telegram.sendMessage(telegramUserId, text);
      await this.telegram.sendMessage(chatId, 'I sent your private brokerage connection link in DM.');
    } catch {
      await this.telegram.sendMessage(
        chatId,
        'I need permission to DM your private brokerage link.\n\nTap <b>Start private setup</b>, press Start there, then come back and run /connect again.',
        { replyMarkup: this.privateStartKeyboard() },
      );
    }
  }
  private helpText(chatType: string) {
    if (chatType === 'private') {
      return 'You are ready to receive private setup links.\n\nNext: go back to your TradePing group and run /connect there. I will DM you the read-only brokerage link and future trade alerts will post in that group.';
    }
    return 'TradePing setup:\n/setup - post the member setup instructions\n/connect - connect read-only brokerage\n/privacy - set alert privacy\n/status - connection status\n/sync - manual sync\n/disconnect - revoke brokerage connections';
  }

  private groupSetupText(chatTitle?: string) {
    const name = chatTitle ? `<b>${this.escape(chatTitle)}</b>` : 'this group';
    return `TradePing is ready for ${name}.\n\nFor each member:\n1. Tap <b>Start private setup</b> once so I can DM them safely.\n2. Return here and run /connect.\n3. Choose privacy with /privacy private, normal, public, or off.\n\nAfter a member connects, executed trades from their read-only brokerage connection will alert in this group.`;
  }

  private privateStartKeyboard() {
    const username = this.config.get<string>('TELEGRAM_BOT_USERNAME') ?? 'tradeping_v1_bot';
    return { inline_keyboard: [[{ text: 'Start private setup', url: `https://t.me/${username}?start=setup` }]] };
  }

  private displayName(from: NonNullable<TelegramUpdate['message']>['from']) {
    return from?.username ? `@${from.username}` : [from?.first_name, from?.last_name].filter(Boolean).join(' ') || 'Telegram User';
  }

  private escape(v: string): string {
    return v.replace(/[&<>]/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[s]!));
  }
}

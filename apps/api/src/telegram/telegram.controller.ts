import { Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../config/prisma.service';
import { TelegramService } from './telegram.service';
import { TelegramUpdate } from './telegram.types';
import { BrokerOnboardingService } from '../broker/broker-onboarding.service';
import { BrokerSyncService } from '../broker/broker-sync.service';
import { PrivacyService } from '../privacy/privacy.service';

@Controller('telegram')
export class TelegramController {
  constructor(
    private prisma: PrismaService,
    private telegram: TelegramService,
    private onboarding: BrokerOnboardingService,
    private sync: BrokerSyncService,
    private privacy: PrivacyService,
    private config: ConfigService,
  ) {}

  @Post('webhook')
  async webhook(@Body() update: TelegramUpdate, @Headers('x-telegram-bot-api-secret-token') secret?: string) {
    const expected = this.config.getOrThrow<string>('TELEGRAM_WEBHOOK_SECRET');
    if (secret !== expected) throw new UnauthorizedException();
    const msg = update.message;
    if (!msg?.text || !msg.from) return { ok: true };
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
      } else if (this.cmd(text, '/status')) {
        await this.onboarding.refreshConnections(user.id);
        const connections = await this.prisma.brokerConnection.findMany({ where: { userId: user.id }, orderBy: { updatedAt: 'desc' } });
        const summary = connections.length ? connections.map(c => `${c.status}: ${c.brokerageName ?? c.brokerageSlug ?? 'Brokerage'} (${c.connectionType ?? 'read'})`).join('\n') : 'No brokerage connected yet. Use /connect.';
        await this.telegram.sendMessage(chatId, summary);
      } else if (this.cmd(text, '/sync')) {
        const result = await this.sync.syncUser(user.id);
        await this.telegram.sendMessage(chatId, `Sync complete. New events: ${result.created}. Alerts sent: ${result.alerted}.`);
      } else if (this.cmd(text, '/disconnect')) {
        const count = await this.onboarding.disconnectAll(user.id);
        await this.telegram.sendMessage(chatId, `Disconnected ${count} brokerage connection(s).`);
      } else if (this.cmd(text, '/help') || this.cmd(text, '/start')) {
        await this.telegram.sendMessage(chatId, 'TradePing commands:\n/connect - connect read-only brokerage\n/privacy - set alert privacy\n/status - connection status\n/sync - manual sync\n/disconnect - revoke brokerage connections');
      }
    } catch (e) {
      await this.prisma.auditLog.create({ data: { userId: user.id, action: 'telegram_command_failed', metadata: { message: (e as Error).message } } });
      await this.telegram.sendMessage(chatId, 'Something went wrong. Please try again or contact the group admin.');
    }
    return { ok: true };
  }

  private cmd(text: string, command: string) { return text === command || text.startsWith(`${command} `) || text.startsWith(`${command}@`); }
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
      await this.telegram.sendMessage(chatId, 'Open a private chat with me first, then run /connect here again so I can DM your brokerage connection link.');
    }
  }
  private displayName(from: NonNullable<TelegramUpdate['message']>['from']) {
    return from?.username ? `@${from.username}` : [from?.first_name, from?.last_name].filter(Boolean).join(' ') || 'Telegram User';
  }
}

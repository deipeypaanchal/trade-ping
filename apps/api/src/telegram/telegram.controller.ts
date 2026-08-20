import { BadRequestException, Body, Controller, Headers, Logger, Optional, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../config/prisma.service';
import { JOB_DEFAULTS, SYNC, TIME } from '../config/constants';
import { TelegramService } from './telegram.service';
import { TelegramUpdate } from './telegram.types';
import { BrokerOnboardingService } from '../broker/broker-onboarding.service';
import { PrivacyService } from '../privacy/privacy.service';
import { brokerFreshnessNote, brokerFreshnessSummary } from '../broker/broker-freshness';
import { safeEqual } from '../security/constant-time';
import { acquireTelegramUpdateLock } from '../security/user-safety-lock';
import { createHmac } from 'crypto';
import { CryptoService } from '../security/crypto.service';

const VALID_PRIVACY = new Set(['PUBLIC', 'NORMAL', 'PRIVATE', 'OFF']);
const TELEGRAM_CURSOR_ACTIVE_MS = 6 * 24 * 60 * 60_000;
const TELEGRAM_ORDER_TRANSACTION = {
  // Status refreshes have an eight-minute provider budget and Telegram replies
  // have a four-minute budget. Keep the identity/order fence alive through both
  // while staying below PostgreSQL/Railway request-drain limits.
  maxWait: 60_000,
  timeout: 13 * 60_000,
} as const;
type TelegramMessage = NonNullable<TelegramUpdate['message']>;
type TelegramCommandMessage = TelegramMessage & {
  from: NonNullable<TelegramMessage['from']>;
  text: string;
};
type TelegramOperationResult = { ok: true; advanceCursor?: boolean };

@Controller('telegram')
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);

  constructor(
    private prisma: PrismaService,
    private telegram: TelegramService,
    private onboarding: BrokerOnboardingService,
    private privacy: PrivacyService,
    private config: ConfigService,
    @InjectQueue('trade-sync') private queue: Queue,
    @Optional() private crypto?: CryptoService,
  ) {}

  @Post('webhook')
  async webhook(@Body() update: TelegramUpdate, @Headers('x-telegram-bot-api-secret-token') secret?: string) {
    const expected = this.config.getOrThrow<string>('TELEGRAM_WEBHOOK_SECRET');
    if (!safeEqual(secret, expected)) throw new UnauthorizedException();

    if (update.my_chat_member) {
      const isRemoval = update.my_chat_member.new_chat_member.status === 'left'
        || update.my_chat_member.new_chat_member.status === 'kicked';
      return this.processOrderedUpdate(
        update.update_id,
        [isRemoval
          ? this.telegramScope('group-revocation', update.my_chat_member.chat.id)
          : this.telegramScope('exact-update', update.update_id ?? `membership:${update.my_chat_member.date}`)],
        async () => {
          await this.handleMyChatMember(update.my_chat_member!);
          return { ok: true };
        },
      );
    }

    const msg = update.message;
    if (!msg) return { ok: true };

    if (msg.new_chat_members?.length) {
      const botUsername = (this.config.get<string>('TELEGRAM_BOT_USERNAME') ?? '').toLowerCase();
      const botAdded = msg.new_chat_members.some((member) => member.is_bot && member.username?.toLowerCase() === botUsername);
      if (!botAdded) return { ok: true };
      return this.processOrderedUpdate(
        update.update_id,
        [this.telegramScope('exact-update', update.update_id ?? `${msg.chat.id}:${msg.message_id}`)],
        async () => {
          await this.handleNewChatMembers(msg);
          return { ok: true };
        },
      );
    }
    if (msg.left_chat_member) {
      const botUsername = (this.config.get<string>('TELEGRAM_BOT_USERNAME') ?? '').toLowerCase();
      const removedBot = msg.left_chat_member.is_bot === true
        && !!botUsername
        && msg.left_chat_member.username?.toLowerCase() === botUsername;
      if (removedBot) {
        return this.processOrderedUpdate(
          update.update_id,
          [this.telegramScope('group-revocation', msg.chat.id)],
          async () => {
            await this.handleLeftChatMember(msg);
            return { ok: true };
          },
        );
      }
      const knownUser = await this.prisma.user.findUnique({
        where: { telegramUserId: String(msg.left_chat_member.id) },
        select: { id: true },
      });
      if (!knownUser) return { ok: true };
      return this.processOrderedUpdate(
        update.update_id,
        [this.telegramScope('member-revocation', `${msg.left_chat_member.id}:${msg.chat.id}`)],
        async () => {
          await this.handleLeftChatMember(msg, knownUser.id);
          return { ok: true };
        },
        [
          this.telegramScope('group-revocation', msg.chat.id),
          this.telegramScope('user-revocation', msg.left_chat_member.id),
        ],
      );
    }

    if (!msg.text || !msg.from) return { ok: true };
    const text = msg.text.trim();
    // Telegram group privacy mode may be disabled so the bot can observe
    // service messages. Do not retain ordinary chat participants merely
    // because their text was delivered to this webhook.
    if (!text.startsWith('/')) return { ok: true };
    if (this.addressedToAnotherBot(text)) return { ok: true };
    return this.processOrderedCommand(update.update_id, msg as TelegramCommandMessage, text);
  }

  private async processOrderedCommand(
    updateId: number | undefined,
    msg: TelegramCommandMessage,
    text: string,
  ): Promise<{ ok: true; replay?: true }> {
    const exactScope = this.telegramScope('exact-update', updateId ?? `${msg.chat.id}:${msg.message_id}`);
    const userRevocationScope = this.telegramScope('user-revocation', msg.from.id);
    const groupBoundaryScope = this.telegramScope('group-revocation', msg.chat.id);
    const memberRevocationScope = this.telegramScope('member-revocation', `${msg.from.id}:${msg.chat.id}`);
    const memberChoiceScope = this.telegramScope('member-choice', `${msg.from.id}:${msg.chat.id}`);
    const identityScope = this.telegramIdentityScope(msg.from.id);

    let advanceScopeKeys = [exactScope];
    let barrierScopeKeys: string[] = [];
    if (this.cmd(text, '/privacy') && msg.chat.type !== 'private') {
      const level = text.split(/\s+/)[1]?.toUpperCase();
      if (level && VALID_PRIVACY.has(level)) {
        advanceScopeKeys = [memberChoiceScope];
        barrierScopeKeys = [userRevocationScope, memberRevocationScope, groupBoundaryScope];
      }
    } else if ((this.cmd(text, '/connect') || this.cmd(text, '/reconnect')) && msg.chat.type !== 'private') {
      advanceScopeKeys = [this.telegramScope('portal-choice', msg.from.id)];
      barrierScopeKeys = [userRevocationScope, memberRevocationScope, groupBoundaryScope];
    } else if (this.cmd(text, '/disconnect')
      && msg.chat.type === 'private'
      && text.split(/\s+/)[1]?.toLowerCase() === 'confirm') {
      // Disconnect is a safety boundary. Later read-only or portal commands
      // must never supersede it; only a genuinely newer portal command may
      // pass this cursor after the revocation has completed.
      advanceScopeKeys = [userRevocationScope];
    } else if (this.cmd(text, '/inferred') && msg.chat.type !== 'private') {
      const mode = text.split(/\s+/)[1]?.toLowerCase();
      if (mode === 'on' || mode === 'off') {
        advanceScopeKeys = [this.telegramScope('inferred-choice', msg.chat.id)];
        barrierScopeKeys = [groupBoundaryScope];
      }
    }

    return this.processOrderedUpdate(
      updateId,
      advanceScopeKeys,
      async () => {
        if (await this.suppressDeletedIdentity(msg, text, updateId)) return { ok: true };
        return this.handleCommand(msg, text);
      },
      barrierScopeKeys,
      [identityScope],
    );
  }

  private async processOrderedUpdate(
    updateId: number | undefined,
    advanceScopeKeys: string[],
    operation: () => Promise<TelegramOperationResult>,
    barrierScopeKeys: string[] = [],
    lockOnlyScopeKeys: string[] = [],
  ): Promise<{ ok: true; replay?: true }> {
    if (!Number.isInteger(updateId) || !advanceScopeKeys.length) {
      await operation();
      return { ok: true };
    }
    const orderedAdvanceScopeKeys = [...new Set(advanceScopeKeys)].sort();
    const orderedCursorScopeKeys = [...new Set([...orderedAdvanceScopeKeys, ...barrierScopeKeys])].sort();
    const orderedLockScopeKeys = [...new Set([...orderedCursorScopeKeys, ...lockOnlyScopeKeys])].sort();
    return this.prisma.$transaction(async (tx) => {
      for (const scopeKey of orderedLockScopeKeys) await acquireTelegramUpdateLock(tx, scopeKey);
      const cursors = await tx.telegramUpdateCursor.findMany({ where: { scopeKey: { in: orderedCursorScopeKeys } } });
      const activeCutoff = Date.now() - TELEGRAM_CURSOR_ACTIVE_MS;
      const cursorByScope = new Map(cursors
        .filter((cursor) => !cursor.updatedAt || cursor.updatedAt.getTime() >= activeCutoff)
        .map((cursor) => [cursor.scopeKey, cursor.lastUpdateId]));
      // Any newer related boundary supersedes this update. Using `some` is
      // essential for cross-resource safety (for example, bot removal must
      // block an older per-user privacy command even if its own cursor is old).
      if (orderedCursorScopeKeys.some((scopeKey) => (cursorByScope.get(scopeKey) ?? -1) >= updateId!)) {
        return { ok: true, replay: true };
      }

      const result = await operation();
      if (result.advanceCursor !== false) {
        for (const scopeKey of orderedAdvanceScopeKeys) {
          if ((cursorByScope.get(scopeKey) ?? -1) >= updateId!) continue;
          await tx.telegramUpdateCursor.upsert({
            where: { scopeKey },
            update: { lastUpdateId: updateId! },
            create: { scopeKey, lastUpdateId: updateId! },
          });
        }
      }
      return { ok: true };
    }, TELEGRAM_ORDER_TRANSACTION);
  }

  private async handleCommand(msg: TelegramCommandMessage, text: string): Promise<TelegramOperationResult> {
    const chatId = String(msg.chat.id);
    const user = await this.prisma.user.upsert({
      where: { telegramUserId: String(msg.from.id) },
      update: { displayName: this.displayName(msg.from) },
      create: { telegramUserId: String(msg.from.id), displayName: this.displayName(msg.from) },
    });
    const group = await this.groupFor(msg.chat);

    try {
      if (this.cmd(text, '/connect')) {
        if (!group) {
          await this.telegram.sendMessage(chatId, 'Run /connect inside your TradePing group so alerts post there. I\'ll DM you the private link.');
          return { ok: true };
        }
        const url = await this.onboarding.createConnectUrl(user.id, group.id);
        await this.sendAfterCommit('/connect', () => this.sendConnectLink(msg.chat.type, chatId, String(msg.from.id), url));
      } else if (this.cmd(text, '/reconnect')) {
        if (!group) {
          await this.telegram.sendMessage(chatId, 'Run /reconnect inside your TradePing group so the repaired connection stays linked to the right alert destination.');
          return { ok: true };
        }
        const broker = text.split(/\s+/).slice(1).join(' ') || undefined;
        const url = await this.onboarding.createReconnectUrl(user.id, group.id, broker);
        await this.sendAfterCommit('/reconnect', () => this.sendReconnectLink(msg.chat.type, chatId, String(msg.from.id), url));
      } else if (this.cmd(text, '/privacy')) {
        if (!group) {
          await this.telegram.sendMessage(chatId, 'Privacy is per user, per group. Run /privacy public, normal, private, or off inside the TradePing group you want to change.');
          return { ok: true };
        }
        const level = text.split(/\s+/)[1]?.toUpperCase();
        if (!level || !VALID_PRIVACY.has(level)) {
          await this.telegram.sendMessage(chatId, this.privacyHelpText());
        } else {
          await this.privacy.setPrivacy(user.id, group.id, level);
          await this.sendAfterCommit('/privacy', () => this.telegram.sendMessage(chatId, level === 'OFF'
            ? 'Sharing is <b>OFF</b> in this group. Pending alerts here were cancelled.'
            : `Sharing is now <b>${level}</b> in this group. Only trades executed after sharing was enabled are eligible.`));
        }
      } else if (this.cmd(text, '/setup') || this.cmd(text, '/guide')) {
        await this.telegram.sendMessage(chatId, this.groupSetupText(msg.chat.title), { replyMarkup: this.privateStartKeyboard() });
      } else if (this.cmd(text, '/status')) {
        if (group) {
          await this.sendPrivateResult(
            chatId,
            String(msg.from.id),
            await this.userStatusText(user.id, group.id),
            'status',
          );
          return { ok: true };
        }
        await this.telegram.sendMessage(chatId, await this.userStatusText(user.id));
      } else if (this.cmd(text, '/sync')) {
        const windowKey = Math.floor(Date.now() / SYNC.FANOUT_DEDUPE_WINDOW_MS);
        await this.queue.add('sync-user', { userId: user.id }, { jobId: `manual-sync-user:${user.id}:${windowKey}`, ...JOB_DEFAULTS });
        await this.sendAfterCommit('/sync', () => this.telegram.sendMessage(chatId, 'Sync queued. TradePing also checks automatically in the background. Alerts appear when your broker reports fresh data; Fidelity/IBKR may be delayed up to 24h.'));
      } else if (this.cmd(text, '/inferred')) {
        if (!group) {
          await this.telegram.sendMessage(chatId, 'Run /inferred on or /inferred off inside the TradePing group you want to change.');
          return { ok: true };
        }
        const mode = text.split(/\s+/)[1]?.toLowerCase();
        if (mode !== 'on' && mode !== 'off') {
          await this.telegram.sendMessage(chatId, 'Use /inferred on or /inferred off. This group-level setting controls clearly labeled provisional Robinhood holdings alerts when execution details are unavailable.');
          return { ok: true };
        }
        if (!(await this.telegram.isChatAdmin(chatId, String(msg.from.id)))) {
          await this.telegram.sendMessage(chatId, 'Only a Telegram group admin can change provisional holdings alerts.');
          // A confirmed non-admin command is acknowledged, but it must not
          // supersede an older delayed admin safety command for this group.
          return { ok: true, advanceCursor: false };
        }
        const enabled = mode === 'on';
        await this.privacy.setInferredAlerts(group.id, enabled);
        await this.sendAfterCommit('/inferred', () => this.telegram.sendMessage(chatId, enabled
          ? 'Provisional Robinhood holdings alerts are <b>ON</b> for this group. These alerts are labeled as position changes, not broker-confirmed executions. Fidelity/IBKR remain diagnostic-only.'
          : 'Provisional holdings alerts are <b>OFF</b> for this group. Position-only changes will stay in diagnostics.'));
      } else if (this.cmd(text, '/disconnect')) {
        const confirmed = text.split(/\s+/)[1]?.toLowerCase() === 'confirm';
        if (group) {
          await this.telegram.sendMessage(chatId, 'To stop sharing only in this group, use /privacy off. To revoke every brokerage connection across TradePing, DM me /disconnect confirm.');
          return { ok: true };
        }
        if (!confirmed) {
          await this.telegram.sendMessage(chatId, 'This revokes every brokerage connection and turns sharing off in every TradePing group. Run /disconnect confirm here in DM to continue.');
          return { ok: true };
        }
        const result = await this.onboarding.disconnectAll(user.id);
        const remote = result.remoteRevocationComplete
          ? `Revoked ${result.revoked} brokerage connection(s).`
          : `Revoked ${result.revoked} connection(s), but ${result.failed || 'one or more'} remote authorization(s) could not be confirmed revoked. Contact support.`;
        await this.sendAfterCommit('/disconnect', () => this.telegram.sendMessage(chatId, `TradePing syncing and group sharing are off. ${remote} Use /connect and choose /privacy again to return.`));
      } else if (this.cmd(text, '/trust')) {
        await this.telegram.sendMessage(chatId, this.trustText());
      } else if (this.cmd(text, '/diagnostics')) {
        const diagnostics = await this.diagnosticsText(user.id, group?.id);
        if (group) {
          await this.sendPrivateResult(chatId, String(msg.from.id), diagnostics, 'diagnostics');
        } else {
          await this.telegram.sendMessage(chatId, diagnostics);
        }
      } else if (this.cmd(text, '/groupstatus')) {
        if (!group) {
          await this.telegram.sendMessage(chatId, 'Run /groupstatus inside a TradePing group.');
          return { ok: true };
        }
        if (!(await this.telegram.isChatAdmin(chatId, String(msg.from.id)))) {
          await this.telegram.sendMessage(chatId, 'Only a Telegram group admin can view group-wide TradePing health. Use /status for your private connection details.');
          return { ok: true };
        }
        await this.telegram.sendMessage(chatId, await this.groupStatusText(group.id));
      } else if (this.cmd(text, '/help') || this.cmd(text, '/start')) {
        await this.telegram.sendMessage(chatId, this.helpText(msg.chat.type), { replyMarkup: msg.chat.type === 'private' ? undefined : this.privateStartKeyboard() });
      } else if (text.startsWith('/')) {
        await this.telegram.sendMessage(chatId, 'Unknown TradePing command. Run /help to see the available commands.');
      }
    } catch (e) {
      const command = text.split(/\s+/)[0] || 'unknown';
      const err = e as Error;
      try {
        await this.prisma.auditLog.create({
          data: {
            userId: user.id,
            action: 'telegram_command_failed',
            metadata: { command, message: err.message, name: err.name },
          },
        });
      } catch (auditErr) {
        this.logger.warn(`could not audit failed Telegram command ${command}: ${(auditErr as Error).message}`);
      }
      const userMsg = e instanceof BadRequestException
        ? `Invalid input: ${err.message}`
        : 'Something went wrong. Please try again or contact the group admin.';
      try {
        await this.telegram.sendMessage(chatId, userMsg);
      } catch (replyErr) {
        // The command mutation may already be committed. A Telegram reply
        // outage must not cause the same update to be replayed out of order.
        this.logger.warn(`could not send failure reply for ${command}: ${(replyErr as Error).message}`);
      }
      // Only a fully successful mutation may advance its domain cursor. A
      // failure reply is best-effort, but the original error must propagate so
      // Telegram retries the safety command instead of permanently dropping it.
      throw e;
    }
    return { ok: true };
  }

  private async sendAfterCommit(command: string, send: () => Promise<unknown>): Promise<void> {
    try {
      await send();
    } catch (err) {
      // The side effect is already committed. Retrying the Telegram update can
      // recreate provider portals or repeat revocation work, so acknowledge the
      // update while recording that only its confirmation reply was lost.
      this.logger.warn(`could not send committed ${command} reply: ${(err as Error).message}`);
    }
  }

  private async suppressDeletedIdentity(
    msg: TelegramCommandMessage,
    text: string,
    updateId: number | undefined,
  ): Promise<boolean> {
    if (!this.crypto) return false;
    const identityHash = this.crypto.hash(String(msg.from.id));
    const suppression = await this.prisma.telegramIdentitySuppression.findUnique({ where: { identityHash } });
    if (!suppression) return false;
    if (suppression.expiresAt <= new Date()) {
      await this.prisma.telegramIdentitySuppression.deleteMany({ where: { identityHash } });
      return false;
    }
    const isPrivateStart = msg.chat.type === 'private' && this.cmd(text, '/start');
    const sentAt = Number.isFinite(msg.date) ? new Date(msg.date! * 1000) : null;
    if (
      isPrivateStart
      && sentAt
      && suppression.deletionCompletedAt
      && !suppression.reactivatedAt
      && sentAt > suppression.deletionCompletedAt
    ) {
      await this.prisma.$transaction(async (tx) => {
        await tx.telegramIdentitySuppression.update({
          where: { identityHash },
          data: { reactivatedAt: sentAt, reactivatedUpdateId: updateId },
        });
        // Re-entry and its epoch commit together. If user creation fails, the
        // old deletion boundary remains active and later commands stay blocked.
        await tx.user.upsert({
          where: { telegramUserId: String(msg.from.id) },
          update: { displayName: this.displayName(msg.from) },
          create: { telegramUserId: String(msg.from.id), displayName: this.displayName(msg.from) },
        });
      });
      return false;
    }
    if (!suppression.reactivatedAt || !sentAt) return true;
    if (sentAt > suppression.reactivatedAt) return false;
    if (sentAt < suppression.reactivatedAt) return true;
    return !Number.isInteger(updateId)
      || !Number.isInteger(suppression.reactivatedUpdateId)
      || updateId! < suppression.reactivatedUpdateId!;
  }

  private cmd(text: string, command: string) {
    const token = text.split(/\s+/, 1)[0]?.toLowerCase();
    if (token === command.toLowerCase()) return true;
    const botUsername = this.config.get<string>('TELEGRAM_BOT_USERNAME')?.toLowerCase();
    return !!botUsername && token === `${command.toLowerCase()}@${botUsername}`;
  }

  private addressedToAnotherBot(text: string): boolean {
    const token = text.split(/\s+/, 1)[0] ?? '';
    const separator = token.indexOf('@');
    if (separator < 0) return false;
    const addressedUsername = token.slice(separator + 1).toLowerCase();
    const botUsername = this.config.get<string>('TELEGRAM_BOT_USERNAME')?.toLowerCase();
    return !botUsername || addressedUsername !== botUsername;
  }

  private telegramScope(kind: string, id: string | number): string {
    const secret = this.config.getOrThrow<string>('TELEGRAM_WEBHOOK_SECRET');
    const digest = createHmac('sha256', secret).update(String(id)).digest('hex');
    return `telegram-${kind}:${digest}`;
  }

  private telegramIdentityScope(telegramUserId: string | number): string {
    const digest = this.crypto?.hash(String(telegramUserId))
      ?? createHmac('sha256', this.config.getOrThrow<string>('TELEGRAM_WEBHOOK_SECRET')).update(String(telegramUserId)).digest('hex');
    return `telegram-identity:${digest}`;
  }
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

  private async handleLeftChatMember(msg: NonNullable<TelegramUpdate['message']>, knownUserId?: string): Promise<void> {
    if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') return;
    const group = await this.prisma.group.findUnique({ where: { telegramChatId: String(msg.chat.id) } });
    if (!group || !msg.left_chat_member) return;

    const botUsername = (this.config.get<string>('TELEGRAM_BOT_USERNAME') ?? '').toLowerCase();
    const removedBot = msg.left_chat_member.is_bot === true
      && !!botUsername
      && msg.left_chat_member.username?.toLowerCase() === botUsername;
    if (removedBot) {
      await this.privacy.disableGroupSharing(group.id, 'telegram_bot_removed');
      return;
    }

    const userId = knownUserId ?? (await this.prisma.user.findUnique({ where: { telegramUserId: String(msg.left_chat_member.id) }, select: { id: true } }))?.id;
    if (userId) await this.privacy.disableSharing(userId, group.id, 'telegram_group_left');
  }

  private async handleMyChatMember(update: NonNullable<TelegramUpdate['my_chat_member']>): Promise<void> {
    if (update.chat.type !== 'group' && update.chat.type !== 'supergroup') return;
    if (update.new_chat_member.status !== 'left' && update.new_chat_member.status !== 'kicked') return;
    const group = await this.prisma.group.findUnique({ where: { telegramChatId: String(update.chat.id) }, select: { id: true } });
    if (group) await this.privacy.disableGroupSharing(group.id, `telegram_bot_${update.new_chat_member.status}`);
  }

  private async sendConnectLink(chatType: string, chatId: string, telegramUserId: string, url: string) {
    const text = [
      'Connect your brokerage with SnapTrade read-only access:',
      url,
      '',
      'TradePing can read executed trades and positions for alerts. It cannot place trades, move money, or see your brokerage password.',
      'Broker freshness depends on the broker. Fidelity/IBKR may be delayed up to 24h.',
      '',
      'The link expires in about 5 minutes. Sharing stays OFF until you return to this group and choose /privacy public, normal, or private.',
      'Run /disconnect confirm in DM anytime to revoke every brokerage connection.',
    ].join('\n');
    if (chatType === 'private') {
      await this.telegram.sendMessage(chatId, text);
      return;
    }
    try {
      await this.telegram.sendMessage(telegramUserId, text);
      await this.telegram.sendMessage(chatId, 'Sent your private connection link in DM. After connecting, choose /privacy public, normal, or private here; sharing remains off until then.');
    } catch {
      await this.telegram.sendMessage(
        chatId,
        'I can\'t DM you yet. Tap <b>Start private setup</b>, press Start, then run /connect here again.',
        { replyMarkup: this.privateStartKeyboard() },
      );
    }
  }

  private async sendReconnectLink(chatType: string, chatId: string, telegramUserId: string, url: string) {
    const text = [
      'Repair your existing read-only brokerage connection:',
      url,
      '',
      'Use the same brokerage login you linked before. Repairing it preserves your existing connection history and avoids duplicates.',
      '',
      'The link expires in about 5 minutes.',
    ].join('\n');
    if (chatType === 'private') {
      await this.telegram.sendMessage(chatId, text);
      return;
    }
    try {
      await this.telegram.sendMessage(telegramUserId, text);
      await this.telegram.sendMessage(chatId, 'Sent your private reconnect link in DM.');
    } catch {
      await this.telegram.sendMessage(chatId, 'I can\'t DM you yet. Tap <b>Start private setup</b>, press Start, then run /reconnect here again.', { replyMarkup: this.privateStartKeyboard() });
    }
  }

  private async sendPrivateResult(groupChatId: string, telegramUserId: string, text: string, label: string): Promise<void> {
    try {
      await this.telegram.sendMessage(telegramUserId, text);
      await this.telegram.sendMessage(groupChatId, `Sent your private ${label} in DM.`);
    } catch {
      await this.telegram.sendMessage(
        groupChatId,
        `I can't DM you yet. Tap <b>Start private setup</b>, press Start, then run /${label} here again.`,
        { replyMarkup: this.privateStartKeyboard() },
      );
    }
  }

  private async userStatusText(userId: string, groupId?: string): Promise<string> {
    await this.onboarding.refreshConnections(userId);
    const connections = await this.prisma.brokerConnection.findMany({
      where: { userId, status: { not: 'DISCONNECTED' } },
      include: { accounts: { where: { status: { not: 'DISCONNECTED' } }, select: { id: true, accountType: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    const syncStates = connections.length ? await this.syncStatesFor(connections.flatMap((c) => c.accounts.map((a) => a.id))) : new Map<string, Date>();
    const executionFreshness = connections.length ? await this.executionFreshnessFor(connections.flatMap((c) => c.accounts.map((a) => a.id))) : new Map<string, { createdAt: Date; tradeTime: Date }>();
    const lines: string[] = [];
    if (groupId) {
      const member = await this.prisma.groupMember.findUnique({
        where: { userId_groupId: { userId, groupId } },
        select: { privacyLevel: true, alertsEnabled: true, sharingEnabledAt: true },
      });
      const sharing = member?.alertsEnabled && member.privacyLevel !== 'OFF' && member.sharingEnabledAt;
      lines.push(sharing
        ? `This group: sharing ${member.privacyLevel.toLowerCase()}. Only trades executed after you enabled sharing are eligible.`
        : 'This group: sharing is off. Choose /privacy public, normal, or private in the group to enable future alerts.');
    }
    lines.push(this.statusText(connections, syncStates, executionFreshness));
    return lines.join('\n\n');
  }

  private helpText(chatType: string) {
    if (chatType === 'private') {
      return [
        'TradePing is ready for private setup.',
        '',
        'Next steps:',
        '1. Go back to your TradePing group.',
        '2. Run /connect there.',
        '3. I will DM your private read-only brokerage link.',
        '4. Return to that group and explicitly choose /privacy public, normal, or private. Sharing stays off until then.',
        '',
        'Use /trust in the group to see exactly what is bot-level, user-level, and group-level.',
      ].join('\n');
    }
    return [
      'TradePing posts read-only trade alerts to this group.',
      '',
      '/connect — connect a read-only brokerage',
      '/reconnect — repair a disabled brokerage connection',
      '/privacy — public, normal, private, or off',
      '/trust — what data is bot, user, and group level',
      '/diagnostics — explain what TradePing sees right now',
      '/groupstatus — group setup and alert health',
      '/setup — post the group onboarding guide again',
      '/status — linked accounts and alert health for this group',
      '/inferred — admin toggle for provisional Robinhood holdings alerts',
      '/disconnect — in DM, revoke every brokerage connection; use /privacy off here for this group only',
      '',
      'Normal setup: tap Start private setup once, run /connect here, then explicitly choose /privacy public, normal, or private. Sharing is off until you choose.',
      'Broker freshness varies. Fidelity/IBKR may be delayed up to 24h.',
    ].join('\n');
  }

  private statusText(
    connections: Array<{ status: string; brokerageName: string | null; brokerageSlug: string | null; accounts?: Array<{ id: string; accountType: string | null }> }>,
    syncStates: Map<string, Date>,
    executionFreshness = new Map<string, { createdAt: Date; tradeTime: Date }>(),
  ) {
    if (!connections.length) return 'No brokerage connected. Run /connect to get started.';
    const label: Record<string, string> = {
      ACTIVE: 'connected (read-only)',
      PENDING: 'finishing connection…',
      ERROR: 'needs reconnect — run /reconnect',
      DISABLED: 'disabled by your broker — run /reconnect',
    };
    const lines = connections.map((c) => {
      const name = this.escape(c.brokerageName ?? c.brokerageSlug ?? 'Brokerage');
      const accountTypes = [...new Set((c.accounts ?? []).flatMap((account) => {
        const label = this.accountTypeLabel(account.accountType);
        return label ? [label] : [];
      }))];
      const suffix = accountTypes.length ? `; accounts: ${accountTypes.join(', ')}` : '';
      const lastChecked = this.lastChecked(c.accounts ?? [], syncStates);
      const checked = lastChecked ? `; last checked ${this.relativeTime(lastChecked)}` : '';
      const executionFeed = this.executionFeedSummary(c.accounts ?? [], executionFreshness);
      const feed = executionFeed ? `\nExecution feed: ${executionFeed}` : '';
      return `${name} — ${label[c.status] ?? c.status.toLowerCase()}${suffix}${checked}${feed}\n${brokerFreshnessNote(c)}`;
    });
    return ['Your connections:', ...lines].join('\n\n');
  }

  private accountTypeLabel(type: string | null): string | null {
    if (!type) return null;
    const normalized = type.trim().toUpperCase();
    const labels: Record<string, string> = {
      DIGITALASSET: 'Crypto',
      INDIVIDUAL: 'Individual',
      NP: 'BrokerageLink',
      BROKERAGELINK: 'BrokerageLink',
      CASH: 'Cash',
      MARGIN: 'Margin',
      RETIREMENT: 'Retirement',
    };
    return labels[normalized] ?? this.escape(normalized.replace(/[_-]+/g, ' ').toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase()));
  }

  private privacyHelpText() {
    return [
      'Set how your trades appear in this group.',
      'This is per user, per group:',
      '/privacy public  — name, symbol, quantity, execution price, total, estimated sell return and broker',
      '/privacy normal  — name, symbol, quantity, execution price, total and broker',
      '/privacy private — anonymous, symbol, side and broker only',
      '/privacy off     — no alerts',
      'Sharing is off until you explicitly choose a non-off level. Only later executions are eligible.',
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
      '3. Set your group visibility with /privacy.',
      '',
      'Each member connects their own read-only brokerage. This group receives alerts only after that member explicitly enables sharing here.',
      'Trades executed before sharing is enabled are never posted into this group.',
      'Alerts depend on broker freshness. Fidelity/IBKR may be delayed up to 24h.',
      'Position-only changes stay in diagnostics unless a group admin enables clearly labeled provisional Robinhood alerts with /inferred on.',
      '',
      'Run /trust to see what is bot-level, user-level, and group-level.',
    ].join('\n');
  }

  private trustText() {
    return [
      '<b>TradePing trust model</b>',
      '',
      '<b>Bot level</b>',
      'Shared infrastructure: Telegram bot, SnapTrade API, Railway, database, Redis, and background sync.',
      '',
      '<b>User level</b>',
      'Your Telegram identity, read-only SnapTrade connection, broker accounts, and detected trades/positions. /disconnect confirm in DM revokes every brokerage connection.',
      '',
      '<b>Group level</b>',
      'The Telegram group destination and which connected members can post alerts here.',
      'Group alerts use broker execution records by default. A group admin can opt into clearly labeled provisional Robinhood holdings alerts with /inferred on. Fidelity/IBKR remain diagnostic-only.',
      '',
      '<b>Per-user per-group level</b>',
      '/privacy explicitly enables or disables only your alerts in this group. You can be public here, private elsewhere, or off in another group.',
      '',
      '<b>Safety</b>',
      'TradePing uses read-only access. It cannot place trades, transfer money, or see your brokerage password.',
      '',
      '<b>Freshness</b>',
      'Alerts are best-effort near-real-time where the broker supports it. Fidelity/IBKR data may be delayed up to 24h.',
    ].join('\n');
  }

  private async diagnosticsText(userId: string, groupId?: string) {
    const connections = await this.prisma.brokerConnection.findMany({
      where: { userId, status: { not: 'DISCONNECTED' } },
      include: { accounts: { where: { status: { not: 'DISCONNECTED' } }, select: { id: true, accountType: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    const syncStates = connections.length ? await this.syncStatesFor(connections.flatMap((c) => c.accounts.map((a) => a.id))) : new Map<string, Date>();
    const executionFreshness = connections.length ? await this.executionFreshnessFor(connections.flatMap((c) => c.accounts.map((a) => a.id))) : new Map<string, { createdAt: Date; tradeTime: Date }>();
    const latest = await this.prisma.tradeEvent.findFirst({
      where: { userId, ...(groupId ? { groupId } : {}) },
      orderBy: { tradeTime: 'desc' },
      select: {
        symbol: true,
        side: true,
        tradeTime: true,
        createdAt: true,
        alertStatus: true,
        backfillStatus: true,
        rawType: true,
        rawStatus: true,
        priceSource: true,
        account: { select: { connection: { select: { brokerageName: true, brokerageSlug: true } } } },
      },
    });
    const member = groupId ? await this.prisma.groupMember.findUnique({
      where: { userId_groupId: { userId, groupId } },
      select: { privacyLevel: true, alertsEnabled: true, sharingEnabledAt: true },
    }) : null;

    const lines = ['<b>TradePing diagnostics</b>'];
    if (groupId) {
      const sharing = member?.alertsEnabled && member.privacyLevel !== 'OFF' && member.sharingEnabledAt;
      lines.push(sharing
        ? `This group: sharing ${member.privacyLevel.toLowerCase()} for executions after consent.`
        : 'This group: sharing off; choose /privacy public, normal, or private there to enable future alerts.');
    }
    lines.push(`Connections: ${connections.length ? connections.length : 'none'}.`);
    if (connections.length) lines.push(brokerFreshnessSummary(connections));
    for (const conn of connections) {
      const accountTypes = [...new Set(conn.accounts.flatMap((account) => {
        const label = this.accountTypeLabel(account.accountType);
        return label ? [label] : [];
      }))];
      const lastChecked = this.lastChecked(conn.accounts, syncStates);
      const executionFeed = this.executionFeedSummary(conn.accounts, executionFreshness);
      lines.push(`${this.escape(conn.brokerageName ?? conn.brokerageSlug ?? 'Brokerage')}: ${conn.status.toLowerCase()}${accountTypes.length ? `; ${accountTypes.join(', ')}` : ''}${lastChecked ? `; checked ${this.relativeTime(lastChecked)}` : ''}${executionFeed ? `; execution feed ${executionFeed}` : ''}.`);
    }
    if (latest) {
      const broker = latest.account?.connection?.brokerageName ?? latest.account?.connection?.brokerageSlug ?? 'broker';
      lines.push(`Latest detected here: ${latest.side} ${this.escape(latest.symbol)} via ${this.escape(broker)} at ${new Date(latest.tradeTime).toLocaleString('en-US', { timeZone: TIME.DEFAULT_TIMEZONE })}; ${latest.backfillStatus.toLowerCase()}, ${latest.alertStatus.toLowerCase()}.`);
      lines.push(this.alertExplanation(latest, member));
    } else {
      lines.push('Latest detected here: none yet.');
    }
    lines.push('If a broker is delayed, /sync cannot force data SnapTrade has not received yet.');
    return lines.join('\n');
  }

  private async groupStatusText(groupId: string) {
    const [group, members, latest, pendingAlerts, skippedInferred, failedJobs] = await Promise.all([
      this.prisma.group.findUniqueOrThrow({ where: { id: groupId }, select: { inferredAlertsEnabled: true } }),
      this.prisma.groupMember.findMany({
        where: {
          groupId,
          alertsEnabled: true,
          privacyLevel: { not: 'OFF' },
          sharingEnabledAt: { not: null },
        },
        orderBy: { createdAt: 'asc' },
        select: {
          user: {
            select: {
              brokerConnections: {
                where: { status: { not: 'DISCONNECTED' } },
                select: {
                  status: true,
                  brokerageName: true,
                  brokerageSlug: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.tradeEvent.findFirst({
        where: { groupId, alertStatus: 'SENT' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      this.prisma.tradeEvent.count({ where: { groupId, alertStatus: 'PENDING' } }),
      this.prisma.tradeEvent.count({
        where: {
          groupId,
          alertStatus: 'SKIPPED',
          createdAt: { gte: new Date(Date.now() - 24 * 3600_000) },
          OR: [{ rawType: 'position_delta' }, { rawStatus: 'INFERRED' }],
        },
      }),
      this.prisma.auditLog.count({ where: { action: 'job_failed', createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } } }),
    ]);

    const connectedMembers = members.filter((member) => member.user.brokerConnections.some((conn) => conn.status === 'ACTIVE')).length;
    const brokerRefs = members.flatMap((member) => member.user.brokerConnections.map((conn) => ({
      brokerageName: conn.brokerageName,
      brokerageSlug: conn.brokerageSlug,
    })));
    const delayed = brokerRefs.some((broker) => brokerFreshnessNote(broker).includes('delayed'));
    const lines = [
      '<b>TradePing group status</b>',
      `Members sharing: ${members.length}`,
      `Connected sharing members: ${connectedMembers}`,
      `Provisional Robinhood holdings alerts: ${group.inferredAlertsEnabled ? 'on' : 'off'}`,
      `Pending alerts: ${pendingAlerts}`,
      `Inferred trades skipped in last 24h: ${skippedInferred}`,
      `Worker failures in last 24h (service-wide): ${failedJobs}`,
      delayed ? 'Freshness: at least one connected broker may be delayed up to 24h.' : 'Freshness: best-effort near-real-time when brokers report fresh data.',
    ];
    if (latest) {
      lines.push(`Latest posted alert: ${this.relativeTime(latest.createdAt)}.`);
    } else {
      lines.push('Latest posted alert: none yet.');
    }
    lines.push('Individual names, brokers, account types, and unposted trades are intentionally hidden. Members can use /status for a private DM.');
    return lines.join('\n');
  }

  private alertExplanation(
    trade: {
      alertStatus: string;
      backfillStatus: string;
      rawType: string | null;
      rawStatus: string | null;
      priceSource: string | null;
      createdAt: Date;
    },
    member: { privacyLevel: string; alertsEnabled: boolean } | null,
  ): string {
    if (trade.alertStatus === 'SENT' && (trade.rawType === 'position_delta' || trade.rawStatus === 'INFERRED')) return 'Alert result: posted as a provisional holdings change because this group opted in.';
    if (trade.alertStatus === 'SENT') return 'Alert result: posted to the group.';
    if (trade.alertStatus === 'PENDING') return 'Alert result: queued for delivery.';
    if (trade.alertStatus === 'SENDING') return 'Alert result: currently being delivered.';
    if (trade.alertStatus === 'FAILED') return 'Alert result: delivery failed and will retry if still inside the retry window.';
    if (member && (!member.alertsEnabled || member.privacyLevel === 'OFF')) return 'Alert result: skipped because your alerts are off in this group.';
    if (trade.backfillStatus === 'BACKFILL') return 'Alert result: skipped as older broker history/backfill, so TradePing did not replay it into the group.';
    if (trade.rawType === 'position_delta' || trade.rawStatus === 'INFERRED') {
      return 'Alert result: skipped because TradePing saw only a holdings change, not a broker execution record. Position-only changes are diagnostic-only.';
    }
    if (trade.alertStatus === 'SKIPPED') return 'Alert result: skipped by safety policy.';
    return `Alert result: ${trade.alertStatus.toLowerCase()}.`;
  }

  private async syncStatesFor(accountIds: string[]): Promise<Map<string, Date>> {
    if (!accountIds.length) return new Map();
    const states = await this.prisma.syncState.findMany({
      where: { accountId: { in: accountIds }, key: { in: ['position_snapshot', 'last_successful_order_sync'] } },
      select: { accountId: true, updatedAt: true },
    });
    const byAccount = new Map<string, Date>();
    for (const state of states) {
      if (!state.accountId) continue;
      const prev = byAccount.get(state.accountId);
      if (!prev || state.updatedAt > prev) byAccount.set(state.accountId, state.updatedAt);
    }
    return byAccount;
  }

  private async executionFreshnessFor(accountIds: string[]): Promise<Map<string, { createdAt: Date; tradeTime: Date }>> {
    if (!accountIds.length) return new Map();
    const events = await this.prisma.tradeEvent.findMany({
      where: {
        accountId: { in: accountIds },
        NOT: [{ rawType: 'position_delta' }, { rawStatus: 'INFERRED' }],
      },
      orderBy: { createdAt: 'desc' },
      take: Math.max(accountIds.length * 4, 20),
      select: { accountId: true, createdAt: true, tradeTime: true },
    });
    const byAccount = new Map<string, { createdAt: Date; tradeTime: Date }>();
    for (const event of events) {
      if (!event.accountId || byAccount.has(event.accountId)) continue;
      byAccount.set(event.accountId, { createdAt: event.createdAt, tradeTime: event.tradeTime });
    }
    return byAccount;
  }

  private executionFeedSummary(accounts: Array<{ id: string; accountType: string | null }>, executionFreshness: Map<string, { createdAt: Date; tradeTime: Date }>): string | null {
    const summaries = accounts.flatMap((account) => {
      const latest = executionFreshness.get(account.id);
      if (!latest) return [];
      const accountLabel = this.accountTypeLabel(account.accountType) ?? 'Account';
      const lag = this.duration(latest.createdAt.getTime() - latest.tradeTime.getTime());
      return [`${accountLabel} confirmed ${this.relativeTime(latest.createdAt)}; broker lag ${lag}`];
    });
    return summaries.length ? summaries.join(', ') : null;
  }

  private lastChecked(accounts: Array<{ id: string }>, syncStates: Map<string, Date>): Date | null {
    return accounts.reduce<Date | null>((latest, account) => {
      const checked = syncStates.get(account.id);
      if (!checked) return latest;
      return !latest || checked > latest ? checked : latest;
    }, null);
  }

  private relativeTime(date: Date): string {
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 90) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 90) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  private duration(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 90) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  }

  private privateStartKeyboard() {
    const username = this.config.get<string>('TELEGRAM_BOT_USERNAME') ?? 'tradeping_v1_bot';
    return { inline_keyboard: [[{ text: 'Start private setup', url: `https://t.me/${username}?start=setup` }]] };
  }

  private displayName(from: NonNullable<TelegramUpdate['message']>['from']) {
    return from?.username ? `@${from.username}` : [from?.first_name, from?.last_name].filter(Boolean).join(' ') || 'Telegram User';
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

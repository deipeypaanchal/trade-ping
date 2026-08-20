import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PrismaService } from '../config/prisma.service';
import { BrokerOnboardingService } from '../broker/broker-onboarding.service';
import { PrivacyService } from '../privacy/privacy.service';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';
import { createHmac } from 'crypto';

const telegramScope = (kind: string, id: string | number) =>
  `telegram-${kind}:${createHmac('sha256', 'secret').update(String(id)).digest('hex')}`;

type CursorQuery = { where: { scopeKey: { in: string[] } } };
type CursorUpsert = {
  where: { scopeKey: string };
  update: { lastUpdateId: number };
  create: { scopeKey: string; lastUpdateId: number };
};

function orderedPrisma(
  base: Record<string, unknown>,
  initial: Record<string, number> = {},
  initialUpdatedAt: Record<string, Date> = {},
) {
  const cursors = new Map(Object.entries(initial));
  const transaction = {
    ...base,
    $queryRaw: jest.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]),
    telegramUpdateCursor: {
      findMany: jest.fn(async ({ where }: CursorQuery) => where.scopeKey.in
        .filter((scopeKey) => cursors.has(scopeKey))
        .map((scopeKey) => ({
          scopeKey,
          lastUpdateId: cursors.get(scopeKey)!,
          updatedAt: initialUpdatedAt[scopeKey] ?? new Date(),
        }))),
      upsert: jest.fn(async ({ where, update, create }: CursorUpsert) => {
        const lastUpdateId = cursors.has(where.scopeKey) ? update.lastUpdateId : create.lastUpdateId;
        cursors.set(where.scopeKey, lastUpdateId);
        return { scopeKey: where.scopeKey, lastUpdateId };
      }),
    },
  };
  const prisma = {
    ...base,
    $transaction: jest.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
  } as unknown as PrismaService;
  return { prisma, transaction, cursors };
}

describe('TelegramController', () => {
  it('does not retain users or groups for ordinary Telegram chat text', async () => {
    const prisma = {
      user: { upsert: jest.fn() },
      group: { upsert: jest.fn() },
    } as unknown as PrismaService;
    const telegram = { sendMessage: jest.fn() } as unknown as TelegramService;
    const controller = new TelegramController(
      prisma,
      telegram,
      {} as BrokerOnboardingService,
      {} as PrivacyService,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret' }),
      {} as Queue,
    );

    await controller.webhook({
      message: {
        message_id: 1,
        chat: { id: -200, type: 'supergroup', title: 'Second group' },
        from: { id: 123, first_name: 'Deipey' },
        text: 'This is a normal group conversation.',
      },
    }, 'secret');

    expect(prisma.user.upsert).not.toHaveBeenCalled();
    expect(prisma.group.upsert).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('ignores commands addressed to another bot without retaining the sender or group', async () => {
    const prisma = {
      user: { upsert: jest.fn() },
      group: { upsert: jest.fn() },
    } as unknown as PrismaService;
    const telegram = { sendMessage: jest.fn() } as unknown as TelegramService;
    const privacy = { setPrivacy: jest.fn() } as unknown as PrivacyService;
    const controller = new TelegramController(
      prisma,
      telegram,
      {} as BrokerOnboardingService,
      privacy,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret', TELEGRAM_BOT_USERNAME: 'tradeping_bot' }),
      {} as Queue,
    );

    await controller.webhook({
      update_id: 12,
      message: {
        message_id: 1,
        chat: { id: -200, type: 'supergroup', title: 'Second group' },
        from: { id: 123, first_name: 'Deipey' },
        text: '/privacy@OtherBot normal',
      },
    }, 'secret');

    expect(prisma.user.upsert).not.toHaveBeenCalled();
    expect(prisma.group.upsert).not.toHaveBeenCalled();
    expect(privacy.setPrivacy).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('does not recreate a deleted Telegram identity from a delayed command', async () => {
    const deletedAt = new Date('2026-08-11T12:00:00.000Z');
    const identityHash = 'deleted-identity-hash';
    const suppression = {
      identityHash,
      deletedAt,
      deletionCompletedAt: null,
      reactivatedAt: null,
      expiresAt: new Date('2026-11-09T12:00:00.000Z'),
    };
    const { prisma } = orderedPrisma({
      user: { upsert: jest.fn() },
      telegramIdentitySuppression: {
        findUnique: jest.fn().mockResolvedValue(suppression),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    });
    const telegram = { sendMessage: jest.fn() } as unknown as TelegramService;
    const controller = new TelegramController(
      prisma,
      telegram,
      {} as BrokerOnboardingService,
      {} as PrivacyService,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret' }),
      {} as Queue,
      { hash: jest.fn().mockReturnValue(identityHash) } as never,
    );

    await expect(controller.webhook({
      update_id: 15,
      message: {
        message_id: 5,
        date: Math.floor(new Date('2026-08-11T11:59:59.000Z').getTime() / 1000),
        chat: { id: 123, type: 'private' },
        from: { id: 123, first_name: 'Deleted user' },
        text: '/help',
      },
    }, 'secret')).resolves.toEqual({ ok: true });

    expect(prisma.user.upsert).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('allows an explicit newer private /start to clear the deletion boundary', async () => {
    const identityHash = 'deleted-identity-hash';
    const suppressionStore = {
      findUnique: jest.fn().mockResolvedValue({
        identityHash,
        deletedAt: new Date('2026-08-11T12:00:00.000Z'),
        deletionCompletedAt: new Date('2026-08-11T12:00:01.000Z'),
        reactivatedAt: null,
        expiresAt: new Date('2026-11-09T12:00:00.000Z'),
      }),
      update: jest.fn().mockResolvedValue({}),
    };
    const { prisma } = orderedPrisma({
      user: { upsert: jest.fn().mockResolvedValue({ id: 'new-user', displayName: 'Returning user' }) },
      telegramIdentitySuppression: suppressionStore,
    });
    const telegram = { sendMessage: jest.fn().mockResolvedValue({}) } as unknown as TelegramService;
    const controller = new TelegramController(
      prisma,
      telegram,
      {} as BrokerOnboardingService,
      {} as PrivacyService,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret' }),
      {} as Queue,
      { hash: jest.fn().mockReturnValue(identityHash) } as never,
    );

    await expect(controller.webhook({
      update_id: 16,
      message: {
        message_id: 6,
        date: Math.floor(new Date('2026-08-11T12:00:02.000Z').getTime() / 1000),
        chat: { id: 123, type: 'private' },
        from: { id: 123, first_name: 'Returning user' },
        text: '/start',
      },
    }, 'secret')).resolves.toEqual({ ok: true });

    expect(suppressionStore.update).toHaveBeenCalledWith({
      where: { identityHash },
      data: { reactivatedAt: new Date('2026-08-11T12:00:02.000Z'), reactivatedUpdateId: 16 },
    });
    expect(prisma.user.upsert).toHaveBeenCalled();
  });

  it('drops an older consent command after a newer privacy-off update', async () => {
    const { prisma, transaction, cursors } = orderedPrisma({
      user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1', displayName: 'Deipey' }) },
      group: { upsert: jest.fn().mockResolvedValue({ id: 'group-1' }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    });
    const telegram = { sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }) } as unknown as TelegramService;
    const privacy = { setPrivacy: jest.fn().mockResolvedValue(undefined) } as unknown as PrivacyService;
    const controller = new TelegramController(
      prisma,
      telegram,
      {} as BrokerOnboardingService,
      privacy,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret', TELEGRAM_BOT_USERNAME: 'tradeping_bot' }),
      {} as Queue,
    );

    const newer = await controller.webhook({
      update_id: 20,
      message: {
        message_id: 2,
        chat: { id: -200, type: 'supergroup', title: 'Second group' },
        from: { id: 123, first_name: 'Deipey' },
        text: '/privacy off',
      },
    }, 'secret');
    const older = await controller.webhook({
      update_id: 19,
      message: {
        message_id: 1,
        chat: { id: -200, type: 'supergroup', title: 'Second group' },
        from: { id: 123, first_name: 'Deipey' },
        text: '/privacy normal',
      },
    }, 'secret');

    expect(newer).toEqual({ ok: true });
    expect(older).toEqual({ ok: true, replay: true });
    expect(privacy.setPrivacy).toHaveBeenCalledTimes(1);
    expect(privacy.setPrivacy).toHaveBeenCalledWith('user-1', 'group-1', 'OFF');
    const choiceScope = telegramScope('member-choice', '123:-200');
    expect(cursors.get(choiceScope)).toBe(20);
    const relatedScopes = [
      choiceScope,
      telegramScope('group-revocation', -200),
      telegramScope('member-revocation', '123:-200'),
      telegramScope('user-revocation', 123),
    ].sort();
    expect(transaction.telegramUpdateCursor.findMany).toHaveBeenLastCalledWith({
      where: { scopeKey: { in: relatedScopes } },
    });
  });

  it('advances the update cursor when the command succeeds but both Telegram replies fail', async () => {
    const { prisma, transaction, cursors } = orderedPrisma({
      user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1', displayName: 'Deipey' }) },
      group: { upsert: jest.fn().mockResolvedValue({ id: 'group-1' }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    });
    const telegram = { sendMessage: jest.fn().mockRejectedValue(new Error('Telegram unavailable')) } as unknown as TelegramService;
    const privacy = { setPrivacy: jest.fn().mockResolvedValue(undefined) } as unknown as PrivacyService;
    const controller = new TelegramController(
      prisma,
      telegram,
      {} as BrokerOnboardingService,
      privacy,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret', TELEGRAM_BOT_USERNAME: 'tradeping_bot' }),
      {} as Queue,
    );
    const update = {
      update_id: 77,
      message: {
        message_id: 7,
        chat: { id: -200, type: 'supergroup' as const, title: 'Second group' },
        from: { id: 123, first_name: 'Deipey' },
        text: '/privacy off',
      },
    };

    await expect(controller.webhook(update, 'secret')).resolves.toEqual({ ok: true });
    await expect(controller.webhook(update, 'secret')).resolves.toEqual({ ok: true, replay: true });

    expect(privacy.setPrivacy).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(transaction.telegramUpdateCursor.upsert).toHaveBeenCalledTimes(1);
    expect(cursors.get(telegramScope('member-choice', '123:-200'))).toBe(77);
  });

  it('does not let a newer read-only command supersede an older privacy-off mutation', async () => {
    const { prisma } = orderedPrisma({
      user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1', displayName: 'Deipey' }) },
      group: { upsert: jest.fn().mockResolvedValue({ id: 'group-1' }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    });
    const telegram = { sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }) } as unknown as TelegramService;
    const privacy = { setPrivacy: jest.fn().mockResolvedValue(undefined) } as unknown as PrivacyService;
    const controller = new TelegramController(
      prisma,
      telegram,
      {} as BrokerOnboardingService,
      privacy,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret' }),
      {} as Queue,
    );

    await controller.webhook({
      update_id: 100,
      message: {
        message_id: 2,
        chat: { id: -200, type: 'supergroup', title: 'Group' },
        from: { id: 123, first_name: 'Deipey' },
        text: '/help',
      },
    }, 'secret');
    await expect(controller.webhook({
      update_id: 99,
      message: {
        message_id: 1,
        chat: { id: -200, type: 'supergroup', title: 'Group' },
        from: { id: 123, first_name: 'Deipey' },
        text: '/privacy off',
      },
    }, 'secret')).resolves.toEqual({ ok: true });

    expect(privacy.setPrivacy).toHaveBeenCalledWith('user-1', 'group-1', 'OFF');
  });

  it('does not advance a safety cursor when the privacy mutation fails', async () => {
    const { prisma, transaction, cursors } = orderedPrisma({
      user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1', displayName: 'Deipey' }) },
      group: { upsert: jest.fn().mockResolvedValue({ id: 'group-1' }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    });
    const telegram = { sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }) } as unknown as TelegramService;
    const privacy = { setPrivacy: jest.fn().mockRejectedValue(new Error('database unavailable')) } as unknown as PrivacyService;
    const controller = new TelegramController(
      prisma,
      telegram,
      {} as BrokerOnboardingService,
      privacy,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret' }),
      {} as Queue,
    );
    const update = {
      update_id: 78,
      message: {
        message_id: 8,
        chat: { id: -200, type: 'supergroup' as const, title: 'Group' },
        from: { id: 123, first_name: 'Deipey' },
        text: '/privacy off',
      },
    };

    await expect(controller.webhook(update, 'secret')).rejects.toThrow('database unavailable');
    await expect(controller.webhook(update, 'secret')).rejects.toThrow('database unavailable');
    expect(privacy.setPrivacy).toHaveBeenCalledTimes(2);
    expect(transaction.telegramUpdateCursor.upsert).not.toHaveBeenCalled();
    expect(cursors.get(telegramScope('member-choice', '123:-200'))).toBeUndefined();
  });

  it('accepts a lower update id after the inline six-day cursor reset margin', async () => {
    const choiceScope = telegramScope('member-choice', '123:-200');
    const { prisma, cursors } = orderedPrisma(
      {
        user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1', displayName: 'Deipey' }) },
        group: { upsert: jest.fn().mockResolvedValue({ id: 'group-1' }) },
        auditLog: { create: jest.fn().mockResolvedValue({}) },
      },
      { [choiceScope]: 5000 },
      { [choiceScope]: new Date(Date.now() - 7 * 24 * 60 * 60_000) },
    );
    const privacy = { setPrivacy: jest.fn().mockResolvedValue(undefined) } as unknown as PrivacyService;
    const controller = new TelegramController(
      prisma,
      { sendMessage: jest.fn().mockResolvedValue({}) } as unknown as TelegramService,
      {} as BrokerOnboardingService,
      privacy,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret' }),
      {} as Queue,
    );

    await expect(controller.webhook({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: -200, type: 'supergroup' as const },
        from: { id: 123, first_name: 'Deipey' },
        text: '/privacy off',
      },
    }, 'secret')).resolves.toEqual({ ok: true });
    expect(privacy.setPrivacy).toHaveBeenCalledTimes(1);
    expect(cursors.get(choiceScope)).toBe(1);
  });

  it('does not create or enable a group membership for a generic /help command', async () => {
    const prisma = {
      user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1', displayName: 'Deipey Paanchal' }) },
      group: { upsert: jest.fn().mockResolvedValue({ id: 'group-b' }) },
      groupMember: { upsert: jest.fn() },
      auditLog: { create: jest.fn() },
    } as unknown as PrismaService;
    const telegram = { sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }) } as unknown as TelegramService;
    const privacy = { setPrivacy: jest.fn() } as unknown as PrivacyService;
    const controller = new TelegramController(
      prisma,
      telegram,
      {} as BrokerOnboardingService,
      privacy,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret' }),
      {} as Queue,
    );

    await controller.webhook({
      message: {
        message_id: 1,
        chat: { id: -200, type: 'supergroup', title: 'Second group' },
        from: { id: 123, first_name: 'Deipey' },
        text: '/help',
      },
    }, 'secret');

    expect(prisma.groupMember.upsert).not.toHaveBeenCalled();
    expect(privacy.setPrivacy).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledWith('-200', expect.stringContaining('/privacy'), expect.any(Object));
  });

  it('enables sharing only after an explicit /privacy choice in that group', async () => {
    const prisma = {
      user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1', displayName: 'Deipey Paanchal' }) },
      group: { upsert: jest.fn().mockResolvedValue({ id: 'group-b' }) },
      groupMember: { upsert: jest.fn() },
      auditLog: { create: jest.fn() },
    } as unknown as PrismaService;
    const telegram = { sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }) } as unknown as TelegramService;
    const privacy = { setPrivacy: jest.fn().mockResolvedValue(undefined) } as unknown as PrivacyService;
    const controller = new TelegramController(
      prisma,
      telegram,
      {} as BrokerOnboardingService,
      privacy,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret' }),
      {} as Queue,
    );

    await controller.webhook({
      message: {
        message_id: 1,
        chat: { id: -200, type: 'supergroup', title: 'Second group' },
        from: { id: 123, first_name: 'Deipey' },
        text: '/privacy normal',
      },
    }, 'secret');

    expect(prisma.groupMember.upsert).not.toHaveBeenCalled();
    expect(privacy.setPrivacy).toHaveBeenCalledWith('user-1', 'group-b', 'NORMAL');
    expect(telegram.sendMessage).toHaveBeenCalledWith('-200', expect.stringContaining('NORMAL'));
  });

  it('disables only that user\'s sharing epoch when they leave a Telegram group', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-1' }) },
      group: {
        findUnique: jest.fn().mockResolvedValue({ id: 'group-a' }),
        upsert: jest.fn().mockResolvedValue({ id: 'group-a' }),
      },
    } as unknown as PrismaService;
    const telegram = { sendMessage: jest.fn() } as unknown as TelegramService;
    const privacy = { disableSharing: jest.fn().mockResolvedValue(undefined) } as unknown as PrivacyService;
    const controller = new TelegramController(
      prisma,
      telegram,
      {} as BrokerOnboardingService,
      privacy,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret', TELEGRAM_BOT_USERNAME: 'tradeping_bot' }),
      {} as Queue,
    );

    await controller.webhook({
      message: {
        message_id: 1,
        chat: { id: -100, type: 'supergroup', title: 'High Risk High Rewards' },
        from: { id: 999, first_name: 'Admin' },
        left_chat_member: { id: 123, first_name: 'Deipey' },
      },
    }, 'secret');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { telegramUserId: '123' }, select: { id: true } });
    expect(privacy.disableSharing).toHaveBeenCalledWith('user-1', 'group-a', 'telegram_group_left');
  });

  it('delegates fenced group shutdown when the bot is removed through a legacy service message', async () => {
    const prisma = {
      group: {
        findUnique: jest.fn().mockResolvedValue({ id: 'group-a' }),
        upsert: jest.fn().mockResolvedValue({ id: 'group-a' }),
      },
    } as unknown as PrismaService;
    const privacy = { disableGroupSharing: jest.fn().mockResolvedValue(undefined) } as unknown as PrivacyService;
    const controller = new TelegramController(
      prisma,
      { sendMessage: jest.fn() } as unknown as TelegramService,
      {} as BrokerOnboardingService,
      privacy,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret', TELEGRAM_BOT_USERNAME: 'tradeping_bot' }),
      {} as Queue,
    );

    await controller.webhook({
      message: {
        message_id: 1,
        chat: { id: -100, type: 'supergroup', title: 'High Risk High Rewards' },
        from: { id: 999, first_name: 'Admin' },
        left_chat_member: { id: 777, is_bot: true, username: 'TradePing_Bot' },
      },
    }, 'secret');

    expect(privacy.disableGroupSharing).toHaveBeenCalledWith('group-a', 'telegram_bot_removed');
  });

  it.each(['left', 'kicked'] as const)(
    'uses the group lifecycle cursor and disables sharing for canonical my_chat_member status %s',
    async (status) => {
      const { prisma, transaction, cursors } = orderedPrisma({
        group: { findUnique: jest.fn().mockResolvedValue({ id: 'group-a' }) },
      });
      const privacy = { disableGroupSharing: jest.fn().mockResolvedValue(undefined) } as unknown as PrivacyService;
      const controller = new TelegramController(
        prisma,
        { sendMessage: jest.fn() } as unknown as TelegramService,
        {} as BrokerOnboardingService,
        privacy,
        new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret', TELEGRAM_BOT_USERNAME: 'tradeping_bot' }),
        {} as Queue,
      );

      await controller.webhook({
        update_id: 91,
        my_chat_member: {
          chat: { id: -100, type: 'supergroup', title: 'High Risk High Rewards' },
          from: { id: 999, first_name: 'Admin' },
          date: 1_786_478_400,
          old_chat_member: { status: 'member' },
          new_chat_member: { status },
        },
      }, 'secret');

      expect(privacy.disableGroupSharing).toHaveBeenCalledWith('group-a', `telegram_bot_${status}`);
      const groupScope = telegramScope('group-revocation', -100);
      expect(transaction.telegramUpdateCursor.findMany).toHaveBeenCalledWith({
        where: { scopeKey: { in: [groupScope] } },
      });
      expect(cursors.get(groupScope)).toBe(91);
    },
  );

  it('uses the member revocation boundary to reject older consent commands', async () => {
    const { prisma, cursors } = orderedPrisma({
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-1' }),
        upsert: jest.fn().mockResolvedValue({ id: 'user-1', displayName: 'Deipey' }),
      },
      group: {
        findUnique: jest.fn().mockResolvedValue({ id: 'group-a' }),
        upsert: jest.fn().mockResolvedValue({ id: 'group-a' }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    });
    const privacy = {
      disableSharing: jest.fn().mockResolvedValue(undefined),
      setPrivacy: jest.fn().mockResolvedValue(undefined),
    } as unknown as PrivacyService;
    const controller = new TelegramController(
      prisma,
      { sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }) } as unknown as TelegramService,
      {} as BrokerOnboardingService,
      privacy,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret', TELEGRAM_BOT_USERNAME: 'tradeping_bot' }),
      {} as Queue,
    );

    await controller.webhook({
      update_id: 101,
      message: {
        message_id: 10,
        chat: { id: -100, type: 'supergroup', title: 'High Risk High Rewards' },
        from: { id: 999, first_name: 'Admin' },
        left_chat_member: { id: 123, first_name: 'Deipey' },
      },
    }, 'secret');
    await expect(controller.webhook({
      update_id: 100,
      message: {
        message_id: 9,
        chat: { id: -100, type: 'supergroup', title: 'High Risk High Rewards' },
        from: { id: 123, first_name: 'Deipey' },
        text: '/privacy normal',
      },
    }, 'secret')).resolves.toEqual({ ok: true, replay: true });

    expect(privacy.disableSharing).toHaveBeenCalledWith('user-1', 'group-a', 'telegram_group_left');
    expect(privacy.setPrivacy).not.toHaveBeenCalled();
    expect(cursors.get(telegramScope('member-revocation', '123:-100'))).toBe(101);
  });

  it('uses the group removal boundary to reject an older privacy enable', async () => {
    const { prisma } = orderedPrisma({
      user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1', displayName: 'Deipey' }) },
      group: {
        findUnique: jest.fn().mockResolvedValue({ id: 'group-a' }),
        upsert: jest.fn().mockResolvedValue({ id: 'group-a' }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    });
    const privacy = {
      disableGroupSharing: jest.fn().mockResolvedValue(undefined),
      setPrivacy: jest.fn().mockResolvedValue(undefined),
    } as unknown as PrivacyService;
    const controller = new TelegramController(
      prisma,
      { sendMessage: jest.fn().mockResolvedValue({}) } as unknown as TelegramService,
      {} as BrokerOnboardingService,
      privacy,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret' }),
      {} as Queue,
    );

    await controller.webhook({
      update_id: 120,
      my_chat_member: {
        chat: { id: -100, type: 'supergroup' },
        from: { id: 999, first_name: 'Admin' },
        date: 1_786_478_400,
        old_chat_member: { status: 'member' },
        new_chat_member: { status: 'kicked' },
      },
    }, 'secret');
    await expect(controller.webhook({
      update_id: 119,
      message: {
        message_id: 11,
        chat: { id: -100, type: 'supergroup' },
        from: { id: 123, first_name: 'Deipey' },
        text: '/privacy normal',
      },
    }, 'secret')).resolves.toEqual({ ok: true, replay: true });

    expect(privacy.disableGroupSharing).toHaveBeenCalled();
    expect(privacy.setPrivacy).not.toHaveBeenCalled();
  });

  it('renders admin-only /groupstatus as aggregate data without identities, brokers, accounts, or symbols', async () => {
    const prisma = {
      user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1', displayName: 'Deipey Paanchal' }) },
      group: {
        upsert: jest.fn().mockResolvedValue({ id: 'group-1' }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ inferredAlertsEnabled: false }),
      },
      groupMember: {
        upsert: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([
          {
            privacyLevel: 'NORMAL',
            alertsEnabled: true,
            user: {
              displayName: 'Deipey Paanchal',
              brokerConnections: [
                {
                  status: 'ACTIVE',
                  brokerageName: 'Sensitive Brokerage',
                  brokerageSlug: 'sensitive-brokerage',
                  accounts: [{ id: 'acct-1', accountType: 'SECRET_ACCOUNT_TYPE' }],
                },
              ],
            },
          },
        ]),
      },
      tradeEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([
          {
            accountId: 'acct-1',
            createdAt: new Date(Date.now() - 30_000),
            tradeTime: new Date(Date.now() - 42_000),
          },
        ]),
        count: jest.fn().mockResolvedValue(0),
      },
      auditLog: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
      },
      syncState: {
        findMany: jest.fn().mockResolvedValue([{ accountId: 'acct-1', updatedAt: new Date() }]),
      },
    } as unknown as PrismaService;
    const telegram = {
      sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }),
      isChatAdmin: jest.fn().mockResolvedValue(true),
    } as unknown as TelegramService;
    const privacy = { setInferredAlerts: jest.fn().mockResolvedValue(undefined) } as unknown as PrivacyService;
    const controller = new TelegramController(
      prisma,
      telegram,
      {} as BrokerOnboardingService,
      privacy,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret' }),
      {} as Queue,
    );

    await controller.webhook({
      message: {
        message_id: 1,
        chat: { id: -100, type: 'supergroup', title: 'High Risk High Rewards' },
        from: { id: 123, first_name: 'Deipey' },
        text: '/groupstatus',
      },
    }, 'secret');

    expect(telegram.sendMessage).toHaveBeenCalledWith('-100', expect.stringContaining('<b>TradePing group status</b>'));
    const text = (telegram.sendMessage as jest.Mock).mock.calls.find((call) => call[0] === '-100')?.[1] as string;
    expect(text).toContain('Provisional Robinhood holdings alerts: off');
    expect(text).not.toContain('Deipey Paanchal');
    expect(text).not.toContain('Sensitive Brokerage');
    expect(text).not.toContain('SECRET_ACCOUNT_TYPE');
    expect(text).not.toContain('AAPL');
    expect(text).not.toContain('Linked accounts');
    expect(prisma.tradeEvent.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { groupId: 'group-1', alertStatus: 'SENT' },
      select: { createdAt: true },
    }));
  });

  it('denies /groupstatus to a non-admin before reading group health data', async () => {
    const prisma = {
      user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1', displayName: 'Member' }) },
      group: {
        upsert: jest.fn().mockResolvedValue({ id: 'group-1' }),
        findUniqueOrThrow: jest.fn(),
      },
      groupMember: { findMany: jest.fn(), count: jest.fn() },
      tradeEvent: { findFirst: jest.fn(), count: jest.fn() },
      auditLog: { count: jest.fn(), create: jest.fn() },
    } as unknown as PrismaService;
    const telegram = {
      sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }),
      isChatAdmin: jest.fn().mockResolvedValue(false),
    } as unknown as TelegramService;
    const controller = new TelegramController(
      prisma,
      telegram,
      {} as BrokerOnboardingService,
      {} as PrivacyService,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret' }),
      {} as Queue,
    );

    await controller.webhook({
      message: {
        message_id: 1,
        chat: { id: -100, type: 'supergroup', title: 'High Risk High Rewards' },
        from: { id: 456, first_name: 'Member' },
        text: '/groupstatus',
      },
    }, 'secret');

    expect(telegram.sendMessage).toHaveBeenCalledWith('-100', expect.stringContaining('Only a Telegram group admin'));
    expect(prisma.group.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(prisma.groupMember.findMany).not.toHaveBeenCalled();
    expect(prisma.tradeEvent.findFirst).not.toHaveBeenCalled();
  });

  it('sends a member\'s detailed group /status response by DM instead of exposing it in the group', async () => {
    const prisma = {
      user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1', displayName: 'Deipey Paanchal' }) },
      group: { upsert: jest.fn().mockResolvedValue({ id: 'group-1' }) },
      groupMember: {
        findUnique: jest.fn().mockResolvedValue({
          privacyLevel: 'NORMAL',
          alertsEnabled: true,
          sharingEnabledAt: new Date(0),
        }),
      },
      brokerConnection: {
        findMany: jest.fn().mockResolvedValue([{
          status: 'ACTIVE',
          brokerageName: 'Sensitive Brokerage',
          brokerageSlug: 'sensitive-brokerage',
          accounts: [{ id: 'acct-1', accountType: 'INDIVIDUAL' }],
        }]),
      },
      tradeEvent: { findMany: jest.fn().mockResolvedValue([]) },
      syncState: { findMany: jest.fn().mockResolvedValue([]) },
      auditLog: { create: jest.fn() },
    } as unknown as PrismaService;
    const telegram = { sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }) } as unknown as TelegramService;
    const onboarding = { refreshConnections: jest.fn().mockResolvedValue(undefined) } as unknown as BrokerOnboardingService;
    const controller = new TelegramController(
      prisma,
      telegram,
      onboarding,
      {} as PrivacyService,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret' }),
      {} as Queue,
    );

    await controller.webhook({
      message: {
        message_id: 1,
        chat: { id: -100, type: 'supergroup', title: 'High Risk High Rewards' },
        from: { id: 123, first_name: 'Deipey' },
        text: '/status',
      },
    }, 'secret');

    expect(telegram.sendMessage).toHaveBeenCalledWith('123', expect.stringContaining('Sensitive Brokerage'));
    const groupMessages = (telegram.sendMessage as jest.Mock).mock.calls
      .filter((call) => call[0] === '-100')
      .map((call) => String(call[1]));
    expect(groupMessages.join('\n')).not.toContain('Sensitive Brokerage');
    expect(groupMessages.join('\n')).not.toContain('Individual');
  });

  it('explains when a detected trade was skipped because it was inferred from holdings', async () => {
    const prisma = {
      user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1', displayName: 'Deipey Paanchal' }) },
      group: { upsert: jest.fn().mockResolvedValue({ id: 'group-1' }) },
      groupMember: {
        upsert: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ privacyLevel: 'NORMAL', alertsEnabled: true, sharingEnabledAt: new Date(0) }),
      },
      brokerConnection: {
        findMany: jest.fn().mockResolvedValue([
          {
            status: 'ACTIVE',
            brokerageName: 'Robinhood',
            brokerageSlug: 'robinhood',
            accounts: [{ id: 'acct-1', accountType: 'INDIVIDUAL' }],
          },
        ]),
      },
      tradeEvent: {
        findFirst: jest.fn().mockResolvedValue({
          symbol: 'USDC',
          side: 'SELL',
          tradeTime: new Date('2026-05-28T00:00:00Z'),
          createdAt: new Date('2026-05-28T00:00:10Z'),
          alertStatus: 'SKIPPED',
          backfillStatus: 'NEW',
          rawType: 'position_delta',
          rawStatus: 'INFERRED',
          priceSource: 'POSITION_COST_BASIS',
          account: { connection: { brokerageName: 'Robinhood', brokerageSlug: 'robinhood' } },
        }),
        findMany: jest.fn().mockResolvedValue([
          {
            accountId: 'acct-1',
            createdAt: new Date(Date.now() - 2 * 60_000),
            tradeTime: new Date(Date.now() - 17 * 60_000),
          },
        ]),
      },
      auditLog: { create: jest.fn() },
      syncState: {
        findMany: jest.fn().mockResolvedValue([{ accountId: 'acct-1', updatedAt: new Date() }]),
      },
    } as unknown as PrismaService;
    const telegram = { sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }) } as unknown as TelegramService;
    const controller = new TelegramController(
      prisma,
      telegram,
      {} as BrokerOnboardingService,
      {} as PrivacyService,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret' }),
      {} as Queue,
    );

    await controller.webhook({
      message: {
        message_id: 1,
        chat: { id: -100, type: 'supergroup', title: 'High Risk High Rewards' },
        from: { id: 123, first_name: 'Deipey' },
        text: '/diagnostics',
      },
    }, 'secret');

    const text = (telegram.sendMessage as jest.Mock).mock.calls.find((call) => call[0] === '123')?.[1] as string;
    expect(text).toContain('Latest detected here: SELL USDC via Robinhood');
    expect(text).toContain('execution feed Individual confirmed 2m ago; broker lag 15m');
    expect(text).toContain('Position-only changes are diagnostic-only');
    expect(text).toContain('holdings change');
    const groupMessages = (telegram.sendMessage as jest.Mock).mock.calls
      .filter((call) => call[0] === '-100')
      .map((call) => String(call[1]));
    expect(groupMessages.join('\n')).not.toContain('USDC');
    expect(groupMessages.join('\n')).not.toContain('Robinhood');
  });

  it('lets a group admin enable provisional Robinhood holdings alerts', async () => {
    const prisma = {
      user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1', displayName: 'Deipey Paanchal' }) },
      group: {
        upsert: jest.fn().mockResolvedValue({ id: 'group-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      groupMember: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      auditLog: { create: jest.fn() },
    } as unknown as PrismaService;
    const telegram = {
      sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }),
      isChatAdmin: jest.fn().mockResolvedValue(true),
    } as unknown as TelegramService;
    const privacy = { setInferredAlerts: jest.fn().mockResolvedValue(undefined) } as unknown as PrivacyService;
    const controller = new TelegramController(
      prisma,
      telegram,
      {} as BrokerOnboardingService,
      privacy,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret' }),
      {} as Queue,
    );

    await controller.webhook({
      message: {
        message_id: 1,
        chat: { id: -100, type: 'supergroup', title: 'High Risk High Rewards' },
        from: { id: 123, first_name: 'Deipey' },
        text: '/inferred on',
      },
    }, 'secret');

    expect(privacy.setInferredAlerts).toHaveBeenCalledWith('group-1', true);
    expect(telegram.sendMessage).toHaveBeenCalledWith('-100', expect.stringContaining('Provisional Robinhood holdings alerts are <b>ON</b>'));
  });

  it('does not let a regular group member enable provisional alerts', async () => {
    const prisma = {
      user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1', displayName: 'Member' }) },
      group: { upsert: jest.fn().mockResolvedValue({ id: 'group-1' }), update: jest.fn() },
      groupMember: { upsert: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn() },
    } as unknown as PrismaService;
    const telegram = {
      sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }),
      isChatAdmin: jest.fn().mockResolvedValue(false),
    } as unknown as TelegramService;
    const privacy = { setInferredAlerts: jest.fn() } as unknown as PrivacyService;
    const controller = new TelegramController(prisma, telegram, {} as BrokerOnboardingService, privacy, new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret' }), {} as Queue);

    await controller.webhook({
      message: {
        message_id: 1,
        chat: { id: -100, type: 'supergroup', title: 'High Risk High Rewards' },
        from: { id: 456, first_name: 'Member' },
        text: '/inferred on',
      },
    }, 'secret');

    expect(privacy.setInferredAlerts).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledWith('-100', expect.stringContaining('Only a Telegram group admin'));
  });

  it('does not let a newer non-admin inferred command supersede an older admin off command', async () => {
    const { prisma, cursors } = orderedPrisma({
      user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1', displayName: 'Member' }) },
      group: { upsert: jest.fn().mockResolvedValue({ id: 'group-1' }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    });
    const telegram = {
      sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }),
      isChatAdmin: jest.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    } as unknown as TelegramService;
    const privacy = { setInferredAlerts: jest.fn().mockResolvedValue(undefined) } as unknown as PrivacyService;
    const controller = new TelegramController(
      prisma,
      telegram,
      {} as BrokerOnboardingService,
      privacy,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret' }),
      {} as Queue,
    );

    await controller.webhook({
      update_id: 101,
      message: {
        message_id: 2,
        chat: { id: -100, type: 'supergroup', title: 'High Risk High Rewards' },
        from: { id: 456, first_name: 'Member' },
        text: '/inferred on',
      },
    }, 'secret');

    const inferredScope = telegramScope('inferred-choice', -100);
    expect(cursors.has(inferredScope)).toBe(false);

    await controller.webhook({
      update_id: 100,
      message: {
        message_id: 1,
        chat: { id: -100, type: 'supergroup', title: 'High Risk High Rewards' },
        from: { id: 123, first_name: 'Admin' },
        text: '/inferred off',
      },
    }, 'secret');

    expect(privacy.setInferredAlerts).toHaveBeenCalledTimes(1);
    expect(privacy.setInferredAlerts).toHaveBeenCalledWith('group-1', false);
    expect(cursors.get(inferredScope)).toBe(100);
  });

  it('does not advance the inferred cursor when Telegram cannot verify admin status', async () => {
    const { prisma, cursors } = orderedPrisma({
      user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1', displayName: 'Admin' }) },
      group: { upsert: jest.fn().mockResolvedValue({ id: 'group-1' }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    });
    const telegram = {
      sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }),
      isChatAdmin: jest.fn().mockRejectedValue(new Error('Telegram unavailable')),
    } as unknown as TelegramService;
    const privacy = { setInferredAlerts: jest.fn() } as unknown as PrivacyService;
    const controller = new TelegramController(
      prisma,
      telegram,
      {} as BrokerOnboardingService,
      privacy,
      new ConfigService({ TELEGRAM_WEBHOOK_SECRET: 'secret' }),
      {} as Queue,
    );

    await expect(controller.webhook({
      update_id: 102,
      message: {
        message_id: 3,
        chat: { id: -100, type: 'supergroup', title: 'High Risk High Rewards' },
        from: { id: 123, first_name: 'Admin' },
        text: '/inferred off',
      },
    }, 'secret')).rejects.toThrow('Telegram unavailable');

    expect(privacy.setInferredAlerts).not.toHaveBeenCalled();
    expect(cursors.has(telegramScope('inferred-choice', -100))).toBe(false);
  });
});

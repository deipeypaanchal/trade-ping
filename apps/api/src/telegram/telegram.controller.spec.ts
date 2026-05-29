import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PrismaService } from '../config/prisma.service';
import { BrokerOnboardingService } from '../broker/broker-onboarding.service';
import { PrivacyService } from '../privacy/privacy.service';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';

describe('TelegramController', () => {
  it('renders group /status with owner, broker, account type, and alert visibility', async () => {
    const prisma = {
      user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1', displayName: 'Deipey Paanchal' }) },
      group: {
        upsert: jest.fn().mockResolvedValue({ id: 'group-1' }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ inferredAlertsEnabled: false }),
      },
      groupMember: {
        upsert: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([
          {
            privacyLevel: 'NORMAL',
            alertsEnabled: true,
            user: {
              displayName: 'Deipey Paanchal',
              brokerConnections: [
                {
                  status: 'ACTIVE',
                  brokerageName: 'Robinhood',
                  brokerageSlug: 'robinhood',
                  accounts: [{ id: 'acct-1', accountType: 'INDIVIDUAL' }],
                },
              ],
            },
          },
        ]),
      },
      tradeEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
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
        text: '/status',
      },
    }, 'secret');

    expect(telegram.sendMessage).toHaveBeenCalledWith('-100', expect.stringContaining('<b>Linked accounts in this group</b>'));
    const text = (telegram.sendMessage as jest.Mock).mock.calls[0][1] as string;
    expect(text).toContain('Deipey Paanchal: Robinhood');
    expect(text).toContain('accounts: Individual');
    expect(text).toContain('alerts normal');
    expect(text).toContain('Inferred alerts: off');
    expect(text).toContain('Owner means the Telegram member');
  });

  it('explains when a detected trade was skipped because it was inferred from holdings', async () => {
    const prisma = {
      user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1', displayName: 'Deipey Paanchal' }) },
      group: { upsert: jest.fn().mockResolvedValue({ id: 'group-1' }) },
      groupMember: {
        upsert: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ privacyLevel: 'NORMAL', alertsEnabled: true }),
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

    const text = (telegram.sendMessage as jest.Mock).mock.calls[0][1] as string;
    expect(text).toContain('Latest detected here: SELL USDC via Robinhood');
    expect(text).toContain('skipped because inferred alerts are off');
    expect(text).toContain('holdings change');
  });
});

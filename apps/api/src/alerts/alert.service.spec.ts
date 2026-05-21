import { Decimal } from '@prisma/client/runtime/library';
import { AlertService } from './alert.service';
import { PrismaService } from '../config/prisma.service';
import { TelegramApiError, TelegramService } from '../telegram/telegram.service';

describe('AlertService.render (via sendTradeAlert)', () => {
  function makeEvent(overrides: Record<string, unknown> = {}) {
    return {
      id: 'trade-1',
      userId: 'user-1',
      groupId: 'group-1',
      symbol: 'AAPL',
      side: 'BUY',
      quantity: new Decimal('10'),
      price: new Decimal('150.25'),
      tradeTime: new Date('2026-05-21T14:30:00Z'),
      alertStatus: 'PENDING',
      user: { displayName: '@trader', timeZone: 'America/New_York' },
      group: { telegramChatId: '-100' },
      account: { connection: { brokerageName: 'Robinhood' } },
      ...overrides,
    };
  }

  function makeService(opts: { sendImpl?: jest.Mock; member?: any } = {}) {
    const sentTexts: string[] = [];
    const prisma = {
      tradeEvent: {
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
      groupMember: {
        findUnique: jest.fn().mockResolvedValue(opts.member ?? { alertsEnabled: true, privacyLevel: 'PUBLIC' }),
      },
      alert: { create: jest.fn() },
    } as unknown as PrismaService;
    const telegram = {
      sendMessage: opts.sendImpl ?? jest.fn().mockImplementation(async (_chat: string, text: string) => {
        sentTexts.push(text);
        return { message_id: 1 };
      }),
    } as unknown as TelegramService;
    return { svc: new AlertService(prisma, telegram), prisma, telegram, sentTexts };
  }

  it('escapes HTML special characters including quotes', async () => {
    const event = makeEvent({ symbol: 'A<B>&"C\'' });
    const { svc, prisma, sentTexts } = makeService();
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain('A&lt;B&gt;&amp;&quot;C&#39;');
  });

  it('formats quantity, price, and value without precision loss', async () => {
    const event = makeEvent({ price: new Decimal('123456789.987') });
    const { svc, prisma, sentTexts } = makeService();
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain('Qty: 10');
    expect(sentTexts[0]).toContain('$123456789.99');
    expect(sentTexts[0]).toContain('Value: $1234567899.87');
  });

  it('shows quantity and value in normal privacy mode', async () => {
    const event = makeEvent();
    const { svc, prisma, sentTexts } = makeService({ member: { alertsEnabled: true, privacyLevel: 'NORMAL' } });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain('Qty: 10');
    expect(sentTexts[0]).toContain('Value: $1502.50');
    expect(sentTexts[0]).not.toContain('Avg price:');
  });

  it('adds average price in public privacy mode', async () => {
    const event = makeEvent();
    const { svc, prisma, sentTexts } = makeService({ member: { alertsEnabled: true, privacyLevel: 'PUBLIC' } });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain('Avg price: $150.25');
  });

  it('does not present inferred position prices as execution value', async () => {
    const event = makeEvent({ rawType: 'position_delta', rawStatus: 'INFERRED' });
    const { svc, prisma, sentTexts } = makeService({ member: { alertsEnabled: true, privacyLevel: 'PUBLIC' } });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain('Qty: 10');
    expect(sentTexts[0]).toContain('Fill price unavailable; inferred from position change.');
    expect(sentTexts[0]).not.toContain('Avg price:');
    expect(sentTexts[0]).not.toContain('Value:');
  });

  it('hides size details in private privacy mode', async () => {
    const event = makeEvent();
    const { svc, prisma, sentTexts } = makeService({ member: { alertsEnabled: true, privacyLevel: 'PRIVATE' } });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain('Anonymous member bought AAPL');
    expect(sentTexts[0]).not.toContain('Qty:');
    expect(sentTexts[0]).not.toContain('Value:');
  });

  it("uses the user's timezone when set", async () => {
    const event = makeEvent({ user: { displayName: 'x', timeZone: 'Europe/London' } });
    const { svc, prisma, sentTexts } = makeService();
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    // 14:30 UTC = 15:30 BST in May
    expect(sentTexts[0]).toMatch(/Time: .*3:30/);
  });

  it('marks SKIPPED on permanent 4xx telegram failure', async () => {
    const event = makeEvent();
    const sendImpl = jest.fn().mockRejectedValue(new TelegramApiError('blocked', 403));
    const { svc, prisma } = makeService({ sendImpl });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    const ok = await svc.sendTradeAlert('trade-1');
    expect(ok).toBe(false);
    expect((prisma.tradeEvent.update as jest.Mock)).toHaveBeenCalledWith({ where: { id: 'trade-1' }, data: { alertStatus: 'SKIPPED' } });
  });
});

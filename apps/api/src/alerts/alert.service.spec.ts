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
      priceSource: 'EXECUTION',
      assetType: 'EQUITY',
      underlying: null,
      optionExpiration: null,
      optionStrike: null,
      optionType: null,
      profitLoss: null,
      profitLossPct: null,
      tradeTime: new Date('2026-05-21T14:30:00Z'),
      createdAt: new Date('2026-05-21T14:30:00Z'),
      alertStatus: 'PENDING',
      alertAttempts: 0,
      lastAlertAttemptAt: null,
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
    expect(sentTexts[0]).toContain('Notional: $1234567899.87');
  });

  it('shows quantity and notional in normal privacy mode', async () => {
    const event = makeEvent();
    const { svc, prisma, sentTexts } = makeService({ member: { alertsEnabled: true, privacyLevel: 'NORMAL' } });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain('Qty: 10');
    expect(sentTexts[0]).toContain('Avg fill: $150.25');
    expect(sentTexts[0]).toContain('Notional: $1502.50');
  });

  it('adds average fill in public privacy mode', async () => {
    const event = makeEvent();
    const { svc, prisma, sentTexts } = makeService({ member: { alertsEnabled: true, privacyLevel: 'PUBLIC' } });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain('Avg fill: $150.25');
  });

  it('labels inferred position prices as estimates', async () => {
    const event = makeEvent({ rawType: 'position_delta', rawStatus: 'INFERRED', priceSource: 'POSITION_COST_BASIS' });
    const { svc, prisma, sentTexts } = makeService({ member: { alertsEnabled: true, privacyLevel: 'PUBLIC' } });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain('Qty: 10');
    expect(sentTexts[0]).toContain('Est. cost basis: $150.25');
    expect(sentTexts[0]).toContain('Est. value: $1502.50');
    expect(sentTexts[0]).toContain('Inferred from position change; fill price unavailable.');
    expect(sentTexts[0]).not.toContain('Avg fill:');
  });

  it('shows realized profit for sells when cost basis was captured', async () => {
    const event = makeEvent({ side: 'SELL', profitLoss: new Decimal('25.50'), profitLossPct: new Decimal('12.75') });
    const { svc, prisma, sentTexts } = makeService({ member: { alertsEnabled: true, privacyLevel: 'NORMAL' } });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain('Est. profit: +$25.50 (+12.75%)');
  });

  it('renders options with strike, type, expiry and contract-multiplier notional', async () => {
    const event = makeEvent({
      symbol: 'AAPL  250321C00150000',
      assetType: 'OPTION',
      underlying: 'AAPL',
      optionStrike: new Decimal('150'),
      optionType: 'CALL',
      optionExpiration: new Date('2025-03-21T00:00:00Z'),
      quantity: new Decimal('1'),
      price: new Decimal('5.23'),
      priceSource: 'EXECUTION',
    });
    const { svc, prisma, sentTexts } = makeService({ member: { alertsEnabled: true, privacyLevel: 'NORMAL' } });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain('AAPL $150.00 Call exp Mar 21, 2025');
    expect(sentTexts[0]).toContain('Contracts: 1');
    expect(sentTexts[0]).toContain('Avg fill: $5.23 premium');
    expect(sentTexts[0]).toContain('Notional: $523.00');
  });

  it('legacy options without assetType still get 100x notional via symbol shape', async () => {
    const event = makeEvent({ symbol: 'SOXS  260522C00010000', assetType: null, quantity: new Decimal('1'), price: new Decimal('0.18'), priceSource: 'EXECUTION' });
    const { svc, prisma, sentTexts } = makeService({ member: { alertsEnabled: true, privacyLevel: 'NORMAL' } });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain('Avg fill: $0.18 premium');
    expect(sentTexts[0]).toContain('Notional: $18.00');
  });

  it('hides size details in private privacy mode', async () => {
    const event = makeEvent();
    const { svc, prisma, sentTexts } = makeService({ member: { alertsEnabled: true, privacyLevel: 'PRIVATE' } });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain('Anonymous member bought AAPL');
    expect(sentTexts[0]).not.toContain('Qty:');
    expect(sentTexts[0]).not.toContain('Notional:');
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
    expect((prisma.tradeEvent.update as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'trade-1' },
      data: expect.objectContaining({ alertStatus: 'SKIPPED' }),
    }));
  });

  it('gives up and marks SKIPPED after MAX_ATTEMPTS retries (no infinite re-alert loop)', async () => {
    const event = makeEvent({ alertAttempts: 8 }); // already at the cap
    const sendImpl = jest.fn();
    const { svc, prisma } = makeService({ sendImpl });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    const ok = await svc.sendTradeAlert('trade-1');
    expect(ok).toBe(false);
    expect(sendImpl).not.toHaveBeenCalled();
    expect((prisma.tradeEvent.update as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ alertStatus: 'SKIPPED' }),
    }));
  });

  it('gives up if the trade is older than MAX_AGE_MS regardless of attempts (outage replay guard)', async () => {
    const event = makeEvent({
      alertAttempts: 1,
      tradeTime: new Date(Date.now() - 72 * 60 * 60 * 1000), // 3 days ago, beyond 48h cap
    });
    const sendImpl = jest.fn();
    const { svc, prisma } = makeService({ sendImpl });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    const ok = await svc.sendTradeAlert('trade-1');
    expect(ok).toBe(false);
    expect(sendImpl).not.toHaveBeenCalled();
  });
});

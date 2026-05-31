import { Decimal } from '@prisma/client/runtime/library';
import { AlertService } from './alert.service';
import { PrismaService } from '../config/prisma.service';
import { TelegramApiError, TelegramService } from '../telegram/telegram.service';

describe('AlertService.render (via sendTradeAlert)', () => {
  function makeEvent(overrides: Record<string, unknown> = {}) {
    const recent = new Date(Date.now() - 5 * 60_000);
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
      tradeTime: recent,
      createdAt: recent,
      alertStatus: 'PENDING',
      alertAttempts: 0,
      lastAlertAttemptAt: null,
      user: { displayName: '@trader', timeZone: 'America/New_York' },
      group: { telegramChatId: '-100', inferredAlertsEnabled: false },
      account: { accountType: 'INDIVIDUAL', connection: { brokerageName: 'Robinhood' } },
      ...overrides,
    };
  }

  function makeService(opts: { sendImpl?: jest.Mock; member?: { alertsEnabled: boolean; privacyLevel: string } } = {}) {
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

    expect(sentTexts[0]).toContain('10 shares @ $123,456,789.987');
    expect(sentTexts[0]).toContain('Total debit · $1,234,567,899.87');
  });

  it('shows quantity, execution price, and total in normal privacy mode', async () => {
    const event = makeEvent();
    const { svc, prisma, sentTexts } = makeService({ member: { alertsEnabled: true, privacyLevel: 'NORMAL' } });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain('<b>🟢 BUY · AAPL</b>');
    expect(sentTexts[0]).toContain('@trader · Robinhood');
    expect(sentTexts[0]).toContain('10 shares @ $150.25');
    expect(sentTexts[0]).toContain('Total debit · $1,502.50');
  });

  it('adds estimated return in public privacy mode', async () => {
    const event = makeEvent({ side: 'SELL', profitLoss: new Decimal('25.50'), profitLossPct: new Decimal('12.75') });
    const { svc, prisma, sentTexts } = makeService({ member: { alertsEnabled: true, privacyLevel: 'PUBLIC' } });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain('Est. return · +$25.50 (+12.75%)');
  });

  it('does not send inferred position-delta alerts', async () => {
    const recent = new Date(Date.now() - 5 * 60_000);
    const event = makeEvent({ rawType: 'position_delta', rawStatus: 'INFERRED', priceSource: 'POSITION_COST_BASIS', tradeTime: recent, createdAt: recent });
    const sendImpl = jest.fn();
    const { svc, prisma } = makeService({ sendImpl, member: { alertsEnabled: true, privacyLevel: 'PUBLIC' } });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    const ok = await svc.sendTradeAlert('trade-1');

    expect(ok).toBe(false);
    expect(sendImpl).not.toHaveBeenCalled();
    expect((prisma.tradeEvent.update as jest.Mock)).toHaveBeenCalledWith({ where: { id: 'trade-1' }, data: { alertStatus: 'SKIPPED' } });
  });

  it('does not send inferred alerts even if a legacy group flag is enabled', async () => {
    const recent = new Date(Date.now() - 5 * 60_000);
    const event = makeEvent({
      rawType: 'position_delta',
      rawStatus: 'INFERRED',
      priceSource: 'POSITION_COST_BASIS',
      tradeTime: recent,
      createdAt: recent,
      group: { telegramChatId: '-100', inferredAlertsEnabled: true },
    });
    const sendImpl = jest.fn();
    const { svc, prisma } = makeService({ sendImpl, member: { alertsEnabled: true, privacyLevel: 'PUBLIC' } });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    const ok = await svc.sendTradeAlert('trade-1');

    expect(ok).toBe(false);
    expect(sendImpl).not.toHaveBeenCalled();
  });

  it('skips stale inferred alerts without touching Telegram', async () => {
    const oldTime = new Date(Date.now() - 3 * 60 * 60_000);
    const event = makeEvent({ rawType: 'position_delta', rawStatus: 'INFERRED', priceSource: 'POSITION_COST_BASIS', tradeTime: oldTime, createdAt: oldTime });
    const sendImpl = jest.fn();
    const { svc, prisma } = makeService({ sendImpl });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    const ok = await svc.sendTradeAlert('trade-1');
    expect(ok).toBe(false);
    expect(sendImpl).not.toHaveBeenCalled();
  });

  it('shows realized profit for sells when cost basis was captured', async () => {
    const event = makeEvent({ side: 'SELL', profitLoss: new Decimal('25.50'), profitLossPct: new Decimal('12.75') });
    const { svc, prisma, sentTexts } = makeService({ member: { alertsEnabled: true, privacyLevel: 'PUBLIC' } });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain('Est. return · +$25.50 (+12.75%)');
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
    const { svc, prisma, sentTexts } = makeService({ member: { alertsEnabled: true, privacyLevel: 'PUBLIC' } });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain('<b>🟢 BUY · AAPL $150.00 Call</b>');
    expect(sentTexts[0]).toContain('Expires · Mar 21, 2025');
    expect(sentTexts[0]).toContain('1 contract @ $5.23 premium');
    expect(sentTexts[0]).toContain('Total debit · $523.00');
  });

  it('legacy options without assetType still get 100x notional via symbol shape', async () => {
    const event = makeEvent({ symbol: 'SOXS  260522C00010000', assetType: null, quantity: new Decimal('1'), price: new Decimal('0.18'), priceSource: 'EXECUTION' });
    const { svc, prisma, sentTexts } = makeService({ member: { alertsEnabled: true, privacyLevel: 'PUBLIC' } });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain('1 contract @ $0.18 premium');
    expect(sentTexts[0]).toContain('Total debit · $18.00');
  });

  it('hides size details in private privacy mode', async () => {
    const event = makeEvent();
    const { svc, prisma, sentTexts } = makeService({ member: { alertsEnabled: true, privacyLevel: 'PRIVATE' } });
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain('<b>🟢 BUY · AAPL</b>');
    expect(sentTexts[0]).toContain('Anonymous member · Robinhood');
    expect(sentTexts[0]).not.toContain('shares @');
    expect(sentTexts[0]).not.toContain('Total debit');
  });

  it("uses the user's timezone when set", async () => {
    const tradeTime = new Date(Date.now() - 5 * 60_000);
    const event = makeEvent({ tradeTime, createdAt: tradeTime, user: { displayName: 'x', timeZone: 'Europe/London' } });
    const { svc, prisma, sentTexts } = makeService();
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain(`Executed · ${tradeTime.toLocaleString('en-US', {
      timeZone: 'Europe/London',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    })}`);
  });

  it('labels delayed broker arrivals with both timestamps', async () => {
    const tradeTime = new Date(Date.now() - 60 * 60_000);
    const createdAt = new Date();
    const event = makeEvent({ tradeTime, createdAt, account: { accountType: 'NP', connection: { brokerageName: 'Fidelity' } } });
    const { svc, prisma, sentTexts } = makeService();
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain(`Executed · ${tradeTime.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    })}`);
    expect(sentTexts[0]).toContain(`Received · ${createdAt.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    })}`);
    expect(sentTexts[0]).toContain('◷ Broker-confirmed execution · Read-only · Not financial advice');
  });

  it('formats crypto with useful precision and its ticker as the unit', async () => {
    const event = makeEvent({
      symbol: 'BTC',
      quantity: new Decimal('0.01443642'),
      price: new Decimal('73353.67118885'),
      account: { accountType: 'DIGITALASSET', connection: { brokerageName: 'Robinhood' } },
    });
    const { svc, prisma, sentTexts } = makeService();
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain('0.01443642 BTC @ $73,353.67118885');
    expect(sentTexts[0]).toContain('Total debit · $1,058.96');
  });

  it('escapes the crypto ticker before rendering it as the quantity unit', async () => {
    const event = makeEvent({
      symbol: 'BTC<&',
      account: { accountType: 'DIGITALASSET', connection: { brokerageName: 'Robinhood' } },
    });
    const { svc, prisma, sentTexts } = makeService();
    (prisma.tradeEvent.findUniqueOrThrow as jest.Mock).mockResolvedValue(event);

    await svc.sendTradeAlert('trade-1');

    expect(sentTexts[0]).toContain('BTC&lt;&amp;');
    expect(sentTexts[0]).not.toContain('BTC<&');
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

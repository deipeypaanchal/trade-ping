import { Decimal } from '@prisma/client/runtime/library';

/**
 * Typed shape of the trade event passed to AlertService.render and its helpers.
 * Sourced from `prisma.tradeEvent.findUnique({ include: { user, group, account: { connection } } })`.
 *
 * Keeping this hand-written (instead of `Prisma.TradeEventGetPayload<...>`) lets
 * the render path use a NARROW projection so accidental access to other columns
 * is a compile error \u2014 e.g. a renderer that reaches into `event.dedupeHash`
 * was a real bug we want to keep impossible.
 */
export type RenderableTrade = {
  id: string;
  userId: string;
  groupId: string | null;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: Decimal | null;
  price: Decimal | null;
  priceSource: string | null;
  assetType: string | null;
  underlying: string | null;
  optionType: string | null;
  optionStrike: Decimal | null;
  optionExpiration: Date | null;
  profitLoss: Decimal | null;
  profitLossPct: Decimal | null;
  tradeTime: Date;
  createdAt: Date;
  alertAttempts: number | null;
  rawType: string | null;
  rawStatus: string | null;
  user: { displayName: string; timeZone: string | null };
  group: { telegramChatId: string; inferredAlertsEnabled?: boolean } | null;
  account: { id: string; accountType: string | null; connection: { brokerageName: string | null; brokerageSlug?: string | null } | null } | null;
};

import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { SnapTradeOrder } from '../snaptrade/snaptrade.types';

export type NormalizedTrade = {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity?: number;
  price?: number;
  currency?: string;
  tradeTime: Date;
  rawType?: string;
  rawStatus?: string;
  rawId?: string;
  dedupeHash: string;
};

@Injectable()
export class TradeDetectorService {
  normalizeOrder(userId: string, accountId: string, order: SnapTradeOrder): NormalizedTrade | null {
    const status = String(order.status ?? '').toUpperCase();
    if (!['EXECUTED', 'FILLED', 'PARTIAL'].includes(status)) return null;
    const rawSide = String(order.action ?? order.side ?? order.type ?? '').toUpperCase();
    const side = rawSide.includes('SELL') ? 'SELL' : rawSide.includes('BUY') ? 'BUY' : null;
    if (!side) return null;
    const symbol = order.universal_symbol?.symbol ?? order.universal_symbol?.raw_symbol ?? order.option_symbol?.ticker ?? order.option_symbol?.symbol ?? order.symbol;
    if (!symbol) return null;
    const quantity = this.toNumber(order.filled_quantity ?? order.total_quantity ?? order.quantity);
    const price = this.toNumber(order.average_fill_price ?? order.execution_price ?? order.price);
    const timestamp = order.time_executed ?? order.filled_date ?? order.execution_time ?? order.time_placed ?? order.trade_date ?? order.updated_date ?? order.time_updated ?? order.created_date ?? new Date().toISOString();
    const providerOrderId = order.brokerage_order_id ?? order.id;
    const rawId = providerOrderId ?? `${symbol}-${side}-${timestamp}-${quantity ?? ''}-${price ?? ''}`;
    const rawType = String(order.order_type ?? order.type ?? 'order');
    const hashInput = providerOrderId
      ? JSON.stringify({ userId, accountId, providerOrderId })
      : JSON.stringify({ userId, accountId, rawId, symbol, side, quantity, price, timestamp });
    return {
      symbol: String(symbol).toUpperCase(),
      side,
      quantity,
      price,
      currency: 'USD',
      tradeTime: new Date(timestamp),
      rawType,
      rawStatus: status,
      rawId,
      dedupeHash: createHash('sha256').update(hashInput).digest('hex'),
    };
  }

  private toNumber(v: unknown): number | undefined {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
}

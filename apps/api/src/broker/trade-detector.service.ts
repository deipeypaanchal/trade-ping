import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { SnapTradeOrder, SnapTradePosition } from '../snaptrade/snaptrade.types';

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

export type PositionSnapshotEntry = {
  symbol: string;
  symbolId?: string;
  quantity: number;
  price?: number;
  currency?: string;
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

  normalizePosition(position: SnapTradePosition): PositionSnapshotEntry | null {
    const symbol = this.extractPositionSymbol(position);
    if (!symbol) return null;
    const quantity = this.toNumber(position.units ?? position.quantity ?? position.fractional_units);
    if (quantity === undefined || quantity < 0) return null;
    const price = this.toNumber(position.average_purchase_price ?? position.price);
    const currency = typeof position.currency === 'string' ? position.currency : position.currency?.code ?? position.symbol?.currency?.code;
    return {
      symbol: symbol.symbol.toUpperCase(),
      symbolId: symbol.id,
      quantity,
      price,
      currency: currency ?? 'USD',
    };
  }

  normalizePositionDelta(
    userId: string,
    accountId: string,
    previous: PositionSnapshotEntry | undefined,
    current: PositionSnapshotEntry | undefined,
    now = new Date(),
  ): NormalizedTrade | null {
    if (!previous && !current) return null;
    const previousQuantity = previous?.quantity ?? 0;
    const currentQuantity = current?.quantity ?? 0;
    if (previousQuantity === currentQuantity) return null;
    const source = current ?? previous;
    if (!source) return null;
    const side = currentQuantity > previousQuantity ? 'BUY' : 'SELL';
    const symbolId = source.symbolId ?? source.symbol;
    const rawId = `position-delta:${accountId}:${symbolId}:${previousQuantity}->${currentQuantity}`;
    const hashInput = JSON.stringify({ userId, accountId, rawId });
    return {
      symbol: source.symbol,
      side,
      quantity: Math.abs(currentQuantity - previousQuantity),
      price: current?.price ?? previous?.price,
      currency: current?.currency ?? previous?.currency ?? 'USD',
      tradeTime: now,
      rawType: 'position_delta',
      rawStatus: 'INFERRED',
      rawId,
      dedupeHash: createHash('sha256').update(hashInput).digest('hex'),
    };
  }

  private extractPositionSymbol(position: SnapTradePosition): { symbol: string; id?: string } | null {
    const nested = position.symbol?.symbol;
    if (typeof nested === 'string' && nested) return { symbol: nested, id: position.symbol?.id };
    if (nested && typeof nested === 'object') {
      const symbol = nested.symbol ?? nested.raw_symbol;
      if (symbol) return { symbol, id: nested.id ?? position.symbol?.id };
    }
    if (position.symbol?.raw_symbol) return { symbol: position.symbol.raw_symbol, id: position.symbol.id };
    if (position.universal_symbol?.symbol) return { symbol: position.universal_symbol.symbol, id: position.universal_symbol.id };
    if (position.universal_symbol?.raw_symbol) return { symbol: position.universal_symbol.raw_symbol, id: position.universal_symbol.id };
    return null;
  }

  private toNumber(v: unknown): number | undefined {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
}

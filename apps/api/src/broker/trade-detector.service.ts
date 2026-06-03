import { Injectable } from '@nestjs/common';
import { SnapTradeOrder, SnapTradePosition } from '../snaptrade/snaptrade.types';
import { computeOrderKey, computePositionDeltaKey } from './order-key';
import { AssetType, inferAssetType } from './asset-type';
import { isExcludedBotSymbol } from './excluded-symbols';

export type NormalizedTrade = {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity?: number;
  /** Per-share or per-contract price actually rendered to users. Picked from
   *  the broker's most-authoritative field; never the limit price. Undefined
   *  when no fill price is available — the renderer must label "price unavailable". */
  price?: number;
  priceSource?: 'EXECUTION' | 'POSITION_COST_BASIS';
  /** Raw price components captured verbatim from the broker for forensics / future PnL. */
  averageFillPrice?: number;
  executionPrice?: number;
  limitPrice?: number;
  /** Fees + commissions on this single fill, when the broker surfaces them. */
  fees?: number;
  currency?: string;
  tradeTime: Date;
  rawType?: string;
  rawStatus?: string;
  rawId?: string;
  dedupeHash: string;
  /** Asset-class classification — drives multiplier and alert rendering. */
  assetType: AssetType;
  /** Underlying ticker for options (e.g. "AAPL" for "AAPL  250321C00150000"). */
  underlying?: string;
  /** ISO date string for option expiration; undefined for non-options. */
  optionExpiration?: string;
  optionStrike?: number;
  optionType?: 'CALL' | 'PUT';
};

export type PositionSnapshotEntry = {
  symbol: string;
  symbolId?: string;
  quantity: number;
  price?: number;
  marketPrice?: number;
  openPnl?: number;
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
    // Fill-price selection: prefer broker-confirmed fills. Never fall back to
    // `order.price` for the canonical fill price — some brokers put the limit
    // price there and we'd render an order ticket as if it were a fill.
    const averageFillPrice = this.toNumber(order.average_fill_price);
    const executionPrice = this.toNumber(order.execution_price);
    const limitPrice = this.toNumber(order.limit_price ?? order.price);
    const price = averageFillPrice ?? executionPrice;
    const priceSource = price === undefined ? undefined : 'EXECUTION';

    const timestamp = order.time_executed ?? order.filled_date ?? order.execution_time ?? order.time_placed ?? order.trade_date ?? order.updated_date ?? order.time_updated ?? order.created_date ?? new Date().toISOString();
    const providerOrderId = order.brokerage_order_id ?? order.id;
    const symbolUpper = String(symbol).toUpperCase();
    if (isExcludedBotSymbol(symbolUpper)) return null;
    // rawId is forensic only — keep it stable for grouping but do NOT use it
    // for identity. Identity comes from computeOrderKey().
    const rawId = providerOrderId ?? `${symbolUpper}-${side}-${timestamp}`;
    const rawType = String(order.order_type ?? order.type ?? 'order');

    const option = order.option_symbol;
    const assetType = inferAssetType({ hasOptionSymbol: !!option, symbol: symbolUpper });
    const optionType = this.toOptionType(option?.option_type);
    const optionStrike = this.toNumber(option?.strike_price);
    const optionExpiration = option?.expiration_date && /^\d{4}-\d{2}-\d{2}/.test(option.expiration_date) ? option.expiration_date.slice(0, 10) : undefined;
    const underlying = option?.underlying_symbol?.symbol ?? option?.underlying_symbol?.raw_symbol ?? option?.symbol;
    const fees = this.toNumber(order.fees);
    const currency = typeof order.currency === 'string' ? order.currency : order.currency?.code ?? 'USD';

    return {
      symbol: symbolUpper,
      side,
      quantity,
      price,
      priceSource,
      averageFillPrice,
      executionPrice,
      limitPrice,
      fees,
      currency,
      tradeTime: new Date(timestamp),
      rawType,
      rawStatus: status,
      rawId,
      dedupeHash: computeOrderKey({ userId, accountId, providerOrderId, symbol: symbolUpper, side, timestamp }),
      assetType,
      underlying: underlying ? String(underlying).toUpperCase() : undefined,
      optionExpiration,
      optionStrike,
      optionType,
    };
  }

  normalizePosition(position: SnapTradePosition): PositionSnapshotEntry | null {
    const symbol = this.extractPositionSymbol(position);
    if (!symbol) return null;
    const symbolUpper = symbol.symbol.toUpperCase();
    if (isExcludedBotSymbol(symbolUpper)) return null;
    const quantity = this.positionQuantity(position);
    if (quantity === undefined || quantity < 0) return null;
    const costBasis = this.toNumber(position.average_purchase_price ?? position.cost_basis);
    const marketPrice = this.toNumber(position.price);
    const price = costBasis ?? marketPrice;
    const openPnl = this.toNumber(position.open_pnl);
    const currency = typeof position.currency === 'string' ? position.currency : position.currency?.code ?? this.positionInstrumentCurrency(position) ?? position.symbol?.currency?.code;
    return {
      symbol: symbolUpper,
      symbolId: symbol.id,
      quantity,
      price,
      marketPrice,
      openPnl,
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
    if (isExcludedBotSymbol(source.symbol)) return null;
    const side = currentQuantity > previousQuantity ? 'BUY' : 'SELL';
    const symbolId = source.symbolId ?? source.symbol;
    const rawId = `position-delta:${accountId}:${symbolId}:${previousQuantity}->${currentQuantity}`;
    return {
      symbol: source.symbol,
      side,
      quantity: Math.abs(currentQuantity - previousQuantity),
      price: source.price,
      priceSource: source.price === undefined ? undefined : 'POSITION_COST_BASIS',
      currency: current?.currency ?? previous?.currency ?? 'USD',
      tradeTime: now,
      rawType: 'position_delta',
      rawStatus: 'INFERRED',
      rawId,
      dedupeHash: computePositionDeltaKey({ userId, accountId, symbolId, previousQuantity, currentQuantity }),
      assetType: inferAssetType({ symbol: source.symbol }),
    };
  }

  private extractPositionSymbol(position: SnapTradePosition): { symbol: string; id?: string } | null {
    if (position.instrument?.symbol) return { symbol: position.instrument.symbol, id: position.instrument.id };
    if (position.instrument?.raw_symbol) return { symbol: position.instrument.raw_symbol, id: position.instrument.id };
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

  private positionInstrumentCurrency(position: SnapTradePosition): string | undefined {
    const currency = position.instrument?.currency;
    return typeof currency === 'string' ? currency : currency?.code;
  }

  private positionQuantity(position: SnapTradePosition): number | undefined {
    const quantity = this.toNumber(position.quantity);
    if (quantity !== undefined) return quantity;

    const units = this.toNumber(position.units);
    const fractionalUnits = this.toNumber(position.fractional_units);
    if (units !== undefined && fractionalUnits !== undefined) {
      return Number.isInteger(units) && fractionalUnits > 0 && fractionalUnits < 1 ? units + fractionalUnits : units;
    }

    return units ?? fractionalUnits;
  }

  private toNumber(v: unknown): number | undefined {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }

  private toOptionType(raw: unknown): 'CALL' | 'PUT' | undefined {
    if (typeof raw !== 'string') return undefined;
    const upper = raw.toUpperCase();
    if (upper === 'CALL' || upper === 'C') return 'CALL';
    if (upper === 'PUT' || upper === 'P') return 'PUT';
    return undefined;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SnapTradeAccount, SnapTradeConnection, SnapTradeOrder, SnapTradePortal, SnapTradeUser } from './snaptrade.types';

@Injectable()
export class SnaptradeService {
  private readonly logger = new Logger(SnaptradeService.name);
  private readonly baseUrl = 'https://api.snaptrade.com/api/v1';
  constructor(private readonly config: ConfigService) {}

  private credentials() {
    const clientId = this.config.getOrThrow<string>('SNAPTRADE_CLIENT_ID');
    const consumerKey = this.config.getOrThrow<string>('SNAPTRADE_CONSUMER_KEY');
    return { clientId, consumerKey };
  }

  private async request<T>(path: string, init: RequestInit = {}, query: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    if (this.config.get<boolean>('SNAPTRADE_USE_MOCK')) return this.mock<T>(path, init);
    const { clientId, consumerKey } = this.credentials();
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'SnapTrade-Client-Id': clientId,
        'SnapTrade-Consumer-Key': consumerKey,
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`SnapTrade ${init.method ?? 'GET'} ${path} failed: ${res.status} ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async registerUser(appUserId: string): Promise<SnapTradeUser> {
    return this.request<SnapTradeUser>('/snapTrade/registerUser', { method: 'POST', body: JSON.stringify({ userId: appUserId }) });
  }

  async deleteUser(userId: string): Promise<void> {
    await this.request(`/snapTrade/deleteUser`, { method: 'DELETE' }, { userId });
  }

  async connectionPortal(userId: string, userSecret: string, groupId: string): Promise<SnapTradePortal> {
    const body: Record<string, unknown> = {
      connectionType: 'read',
      immediateRedirect: true,
      customRedirect: `${this.config.getOrThrow<string>('SNAPTRADE_REDIRECT_URI')}?groupId=${encodeURIComponent(groupId)}`,
      showCloseButton: true,
      connectionPortalVersion: 'v4',
    };
    const broker = this.config.get<string>('SNAPTRADE_BROKER_SLUG');
    if (broker) body.broker = broker;
    return this.request<SnapTradePortal>('/snapTrade/login', { method: 'POST', body: JSON.stringify(body) }, { userId, userSecret });
  }

  async listConnections(userId: string, userSecret: string): Promise<SnapTradeConnection[]> {
    return this.request<SnapTradeConnection[]>('/authorizations', {}, { userId, userSecret });
  }

  async deleteConnection(userId: string, userSecret: string, authorizationId: string): Promise<void> {
    await this.request(`/authorizations/${authorizationId}`, { method: 'DELETE' }, { userId, userSecret });
  }

  async listAccounts(userId: string, userSecret: string, authorizationId?: string): Promise<SnapTradeAccount[]> {
    if (authorizationId) {
      return this.request<SnapTradeAccount[]>(`/authorizations/${authorizationId}/accounts`, {}, { userId, userSecret });
    }
    return this.request<SnapTradeAccount[]>('/accounts', {}, { userId, userSecret });
  }

  async listAccountOrders(userId: string, userSecret: string, accountId: string, days: number): Promise<SnapTradeOrder[]> {
    return this.request<SnapTradeOrder[]>(`/accounts/${accountId}/orders`, {}, { userId, userSecret, days, state: 'all' });
  }

  private async mock<T>(path: string, init: RequestInit): Promise<T> {
    this.logger.warn(`SNAPTRADE_USE_MOCK=true: ${init.method ?? 'GET'} ${path}`);
    if (path.includes('registerUser')) return { userId: `mock-${Date.now()}`, userSecret: 'mock-secret' } as T;
    if (path.includes('login')) return { redirectURI: `${process.env.APP_BASE_URL}/snaptrade/callback?mock=true`, sessionId: 'mock-session' } as T;
    if (path === '/authorizations') return [{ id: 'mock-auth', type: 'read', disabled: false, brokerage: { slug: 'ROBINHOOD', display_name: 'Robinhood' } }] as T;
    if (path.includes('/accounts')) {
      if (path.endsWith('/orders')) return [{ brokerage_order_id: 'mock-order-1', status: 'EXECUTED', action: 'BUY', universal_symbol: { symbol: 'AAPL' }, filled_quantity: 1, average_fill_price: 100, filled_date: new Date().toISOString() }] as T;
      return [{ id: 'mock-account', name: 'Mock Robinhood', brokerage_authorization: 'mock-auth' }] as T;
    }
    return {} as T;
  }
}

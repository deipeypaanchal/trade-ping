import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Snaptrade } from 'snaptrade-typescript-sdk';
import { SnapTradeAccount, SnapTradeConnection, SnapTradeOrder, SnapTradePortal, SnapTradePosition, SnapTradeUser } from './snaptrade.types';

@Injectable()
export class SnaptradeService {
  private readonly logger = new Logger(SnaptradeService.name);
  private client: Snaptrade | null = null;
  /**
   * Cache the first init error so we fail fast on subsequent calls instead of
   * silently reinitializing on every method invocation (which masks misconfig
   * and burns CPU).
   */
  private clientInitError: Error | null = null;

  constructor(private readonly config: ConfigService) {}

  private sdk(): Snaptrade {
    if (this.client) return this.client;
    if (this.clientInitError) throw this.clientInitError;
    try {
      this.client = new Snaptrade({
        clientId: this.config.getOrThrow<string>('SNAPTRADE_CLIENT_ID'),
        consumerKey: this.config.getOrThrow<string>('SNAPTRADE_CONSUMER_KEY'),
      });
      return this.client;
    } catch (err) {
      this.clientInitError = err as Error;
      throw err;
    }
  }

  private get mock(): boolean {
    return this.config.get<boolean>('SNAPTRADE_USE_MOCK') === true;
  }

  async registerUser(appUserId: string): Promise<SnapTradeUser> {
    if (this.mock) return { userId: `mock-${appUserId}`, userSecret: 'mock-secret' };
    const res = await this.sdk().authentication.registerSnapTradeUser({ userId: appUserId });
    if (!res?.data || typeof res.data !== 'object') throw new Error('SnapTrade registerUser returned unexpected response shape');
    const data = res.data as Record<string, unknown>;
    const userId = data['userId'];
    const userSecret = data['userSecret'];
    if (typeof userId !== 'string' || !userId || typeof userSecret !== 'string' || !userSecret) {
      throw new Error('SnapTrade registerUser did not return userId/userSecret');
    }
    return { userId, userSecret };
  }

  async deleteUser(userId: string): Promise<void> {
    if (this.mock) return;
    await this.sdk().authentication.deleteSnapTradeUser({ userId });
  }

  async connectionPortal(userId: string, userSecret: string, groupId: string): Promise<SnapTradePortal> {
    if (this.mock) {
      return { redirectURI: `${this.config.getOrThrow<string>('APP_BASE_URL')}/snaptrade/callback?mock=true`, sessionId: 'mock-session' };
    }
    const broker = this.config.get<string>('SNAPTRADE_BROKER_SLUG') || undefined;
    const customRedirect = `${this.config.getOrThrow<string>('SNAPTRADE_REDIRECT_URI')}?groupId=${encodeURIComponent(groupId)}`;
    const res = await this.sdk().authentication.loginSnapTradeUser({
      userId,
      userSecret,
      broker,
      connectionType: 'read',
      immediateRedirect: true,
      customRedirect,
      showCloseButton: true,
      connectionPortalVersion: 'v4',
    });
    if (!res?.data || typeof res.data !== 'object') throw new Error('SnapTrade login returned unexpected response shape');
    const data = res.data as Record<string, unknown>;
    const redirectURI = data['redirectURI'];
    if (typeof redirectURI !== 'string' || !redirectURI) throw new Error('SnapTrade login did not return redirectURI');
    const sessionId = typeof data['sessionId'] === 'string' ? (data['sessionId'] as string) : undefined;
    return { redirectURI, sessionId };
  }

  async listConnections(userId: string, userSecret: string): Promise<SnapTradeConnection[]> {
    if (this.mock) {
      return [{ id: 'mock-auth', type: 'read', disabled: false, brokerage: { slug: 'ROBINHOOD', display_name: 'Robinhood' } }];
    }
    const res = await this.sdk().connections.listBrokerageAuthorizations({ userId, userSecret });
    const data = res?.data;
    return Array.isArray(data) ? (data as SnapTradeConnection[]) : [];
  }

  async deleteConnection(userId: string, userSecret: string, authorizationId: string): Promise<void> {
    if (this.mock) return;
    // removeBrokerageAuthorization is synchronous (204). Use it so disconnect is immediate.
    await this.sdk().connections.removeBrokerageAuthorization({ authorizationId, userId, userSecret });
  }

  async listAccounts(userId: string, userSecret: string, authorizationId?: string): Promise<SnapTradeAccount[]> {
    if (this.mock) {
      return [{ id: 'mock-account', name: 'Mock Robinhood', brokerage_authorization: 'mock-auth' }];
    }
    if (authorizationId) {
      const res = await this.sdk().connections.listBrokerageAuthorizationAccounts({ authorizationId, userId, userSecret });
      return Array.isArray(res?.data) ? (res.data as SnapTradeAccount[]) : [];
    }
    const res = await this.sdk().accountInformation.listUserAccounts({ userId, userSecret });
    return Array.isArray(res?.data) ? (res.data as SnapTradeAccount[]) : [];
  }

  async listAccountOrders(userId: string, userSecret: string, accountId: string, days: number): Promise<SnapTradeOrder[]> {
    if (this.mock) {
      return [{ brokerage_order_id: 'mock-order-1', status: 'EXECUTED', action: 'BUY', universal_symbol: { symbol: 'AAPL' }, filled_quantity: 1, average_fill_price: 100, filled_date: new Date().toISOString() }];
    }
    const res = await this.sdk().accountInformation.getUserAccountOrders({ userId, userSecret, accountId, state: 'all', days });
    return Array.isArray(res?.data) ? (res.data as SnapTradeOrder[]) : [];
  }

  async listAccountPositions(userId: string, userSecret: string, accountId: string): Promise<SnapTradePosition[]> {
    if (this.mock) {
      return [{ symbol: { id: 'mock-aapl', symbol: 'AAPL' }, units: 1, price: 100, average_purchase_price: 100, currency: 'USD' }];
    }
    const res = await this.sdk().accountInformation.getUserAccountPositions({ userId, userSecret, accountId });
    return Array.isArray(res?.data) ? (res.data as SnapTradePosition[]) : [];
  }

  /**
   * Trigger a manual holdings refresh for one connection. Useful after CONNECTION_ADDED
   * or on demand. SnapTrade fires ACCOUNT_HOLDINGS_UPDATED when complete.
   */
  async refreshConnection(userId: string, userSecret: string, authorizationId: string): Promise<void> {
    if (this.mock) return;
    try {
      await this.sdk().connections.refreshBrokerageAuthorization({ authorizationId, userId, userSecret });
    } catch (err) {
      // Refresh is disabled on real-time plans and rate-limited on others; log and continue.
      this.logger.warn(`refreshBrokerageAuthorization failed for ${authorizationId}: ${(err as Error).message}`);
    }
  }
}

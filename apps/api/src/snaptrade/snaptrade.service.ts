import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Snaptrade } from 'snaptrade-typescript-sdk';
import { SnapTradeAccount, SnapTradeConnection, SnapTradeOrder, SnapTradePortal, SnapTradeUser } from './snaptrade.types';

@Injectable()
export class SnaptradeService {
  private readonly logger = new Logger(SnaptradeService.name);
  private client: Snaptrade | null = null;

  constructor(private readonly config: ConfigService) {}

  private sdk(): Snaptrade {
    if (this.client) return this.client;
    this.client = new Snaptrade({
      clientId: this.config.getOrThrow<string>('SNAPTRADE_CLIENT_ID'),
      consumerKey: this.config.getOrThrow<string>('SNAPTRADE_CONSUMER_KEY'),
    });
    return this.client;
  }

  private get mock(): boolean {
    return this.config.get<boolean>('SNAPTRADE_USE_MOCK') === true;
  }

  async registerUser(appUserId: string): Promise<SnapTradeUser> {
    if (this.mock) return { userId: `mock-${appUserId}`, userSecret: 'mock-secret' };
    const res = await this.sdk().authentication.registerSnapTradeUser({ userId: appUserId });
    const data = res.data as { userId?: string; userSecret?: string };
    if (!data?.userId || !data?.userSecret) throw new Error('SnapTrade registerUser did not return userId/userSecret');
    return { userId: data.userId, userSecret: data.userSecret };
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
    const data = res.data as { redirectURI?: string; sessionId?: string };
    if (!data?.redirectURI) throw new Error('SnapTrade login did not return redirectURI');
    return { redirectURI: data.redirectURI, sessionId: data.sessionId };
  }

  async listConnections(userId: string, userSecret: string): Promise<SnapTradeConnection[]> {
    if (this.mock) {
      return [{ id: 'mock-auth', type: 'read', disabled: false, brokerage: { slug: 'ROBINHOOD', display_name: 'Robinhood' } }];
    }
    const res = await this.sdk().connections.listBrokerageAuthorizations({ userId, userSecret });
    return (res.data as SnapTradeConnection[]) ?? [];
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
      return (res.data as SnapTradeAccount[]) ?? [];
    }
    const res = await this.sdk().accountInformation.listUserAccounts({ userId, userSecret });
    return (res.data as SnapTradeAccount[]) ?? [];
  }

  async listAccountOrders(userId: string, userSecret: string, accountId: string, days: number): Promise<SnapTradeOrder[]> {
    if (this.mock) {
      return [{ brokerage_order_id: 'mock-order-1', status: 'EXECUTED', action: 'BUY', universal_symbol: { symbol: 'AAPL' }, filled_quantity: 1, average_fill_price: 100, filled_date: new Date().toISOString() }];
    }
    const res = await this.sdk().accountInformation.getUserAccountOrders({ userId, userSecret, accountId, state: 'all', days });
    return (res.data as SnapTradeOrder[]) ?? [];
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

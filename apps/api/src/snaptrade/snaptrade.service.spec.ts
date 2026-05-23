import { ConfigService } from '@nestjs/config';
import { SnaptradeService } from './snaptrade.service';

describe('SnaptradeService order resilience', () => {
  function makeService(accountInformation: Record<string, jest.Mock>) {
    const svc = new SnaptradeService(new ConfigService({
      SNAPTRADE_CLIENT_ID: 'client',
      SNAPTRADE_CONSUMER_KEY: 'key',
      SNAPTRADE_USE_MOCK: false,
    }));
    (svc as unknown as { client: unknown }).client = { accountInformation };
    return svc;
  }

  it('surfaces historical order failures so sync watermarks are preserved', async () => {
    const svc = makeService({
      getUserAccountOrders: jest.fn().mockRejectedValue(new Error('broker endpoint unavailable')),
    });

    await expect(svc.listAccountOrders('user', 'secret', 'account', 3)).rejects.toThrow('broker endpoint unavailable');
  });

  it('surfaces recent order failures so sync watermarks are preserved', async () => {
    const svc = makeService({
      getUserAccountRecentOrders: jest.fn().mockRejectedValue(new Error('recent endpoint unavailable')),
    });

    await expect(svc.listRecentAccountOrders('user', 'secret', 'account')).rejects.toThrow('recent endpoint unavailable');
  });
});

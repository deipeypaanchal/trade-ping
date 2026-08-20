import { ProviderDeletionRetryService } from './provider-deletion-retry.service';

describe('ProviderDeletionRetryService', () => {
  afterEach(() => jest.useRealTimers());

  it('retries on boot and periodically without overlapping application startup', async () => {
    jest.useFakeTimers();
    const onboarding = { retryProviderDeletions: jest.fn().mockResolvedValue({ attempted: 1, accepted: 1 }) };
    const service = new ProviderDeletionRetryService(onboarding as never);

    service.onModuleInit();
    await Promise.resolve();
    expect(onboarding.retryProviderDeletions).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(60 * 60_000);
    expect(onboarding.retryProviderDeletions).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });

  it('contains provider errors so a transient outage cannot crash the app', async () => {
    const onboarding = { retryProviderDeletions: jest.fn().mockRejectedValue(new Error('provider down')) };
    const service = new ProviderDeletionRetryService(onboarding as never);
    await expect(service.runOnce()).resolves.toBeUndefined();
  });
});

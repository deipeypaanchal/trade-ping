import { brokerFreshnessNote, brokerFreshnessSummary, hasDelayedBroker, supportsProvisionalPositionAlerts } from './broker-freshness';

describe('broker freshness messaging', () => {
  it('marks Fidelity as delayed', () => {
    expect(brokerFreshnessNote({ brokerageName: 'Fidelity', brokerageSlug: 'FIDELITY' })).toContain('delayed up to 24h');
    expect(hasDelayedBroker([{ brokerageName: 'Fidelity' }])).toBe(true);
  });

  it('marks IBKR as delayed', () => {
    expect(brokerFreshnessNote({ brokerageName: 'Interactive Brokers' })).toContain('delayed up to 24h');
    expect(hasDelayedBroker([{ brokerageSlug: 'IBKR' }])).toBe(true);
  });

  it('uses best-effort language for other brokers', () => {
    expect(brokerFreshnessNote({ brokerageName: 'Robinhood' })).toContain('Near-real-time');
    expect(brokerFreshnessSummary([{ brokerageName: 'Robinhood' }])).toContain('best-effort near-real-time');
  });

  it('allows provisional position alerts only for Robinhood', () => {
    expect(supportsProvisionalPositionAlerts({ brokerageName: 'Robinhood' })).toBe(true);
    expect(supportsProvisionalPositionAlerts({ brokerageName: 'Fidelity' })).toBe(false);
    expect(supportsProvisionalPositionAlerts({ brokerageSlug: 'IBKR' })).toBe(false);
  });
});

type BrokerRef = {
  brokerageName?: string | null;
  brokerageSlug?: string | null;
};

const DELAYED_BROKERS = [
  { match: /\bfidelity\b/i, label: 'Fidelity', note: 'Fidelity data can be delayed up to 24h.' },
  { match: /\bibkr\b|\binteractive brokers\b/i, label: 'IBKR', note: 'IBKR data can be delayed up to 24h.' },
] as const;

export function brokerFreshnessNote(broker: BrokerRef): string {
  const raw = [broker.brokerageName, broker.brokerageSlug].filter(Boolean).join(' ');
  const delayed = DELAYED_BROKERS.find((entry) => entry.match.test(raw));
  return delayed?.note ?? 'Near-real-time when the broker reports fresh data.';
}

export function hasDelayedBroker(brokers: BrokerRef[]): boolean {
  return brokers.some((broker) => {
    const raw = [broker.brokerageName, broker.brokerageSlug].filter(Boolean).join(' ');
    return DELAYED_BROKERS.some((entry) => entry.match.test(raw));
  });
}

/** Position snapshots are only eligible for provisional alerts on brokers whose
 * holdings are expected to update near real time. Keep this allow-list narrow:
 * a delayed or cached broker can otherwise replay stale portfolio changes. */
export function supportsProvisionalPositionAlerts(broker: BrokerRef): boolean {
  const raw = [broker.brokerageName, broker.brokerageSlug].filter(Boolean).join(' ');
  return /\brobinhood\b/i.test(raw);
}

export function brokerFreshnessSummary(brokers: BrokerRef[]): string {
  if (!brokers.length) return 'Broker freshness appears after you connect.';
  return hasDelayedBroker(brokers)
    ? 'Broker freshness: Fidelity/IBKR may be delayed up to 24h; other brokers are best-effort near-real-time.'
    : 'Broker freshness: best-effort near-real-time when your broker reports fresh data.';
}

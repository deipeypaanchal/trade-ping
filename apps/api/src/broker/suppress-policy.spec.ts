import { shouldSuppressAlert } from './suppress-policy';

const HOURS = 24;
const NOW = new Date('2026-05-22T12:00:00Z');

describe('shouldSuppressAlert', () => {
  it('suppresses when caller passes suppressBackfill=true (even for fresh trades)', () => {
    const d = shouldSuppressAlert({
      tradeTime: NOW,
      isFirstSync: false,
      suppressBackfill: true,
      backfillSuppressHours: HOURS,
      now: NOW,
    });
    expect(d).toEqual({ suppress: true, reason: 'suppress_backfill_flag' });
  });

  it('suppresses every order on the first sync (baseline)', () => {
    const d = shouldSuppressAlert({
      tradeTime: NOW,
      isFirstSync: true,
      suppressBackfill: false,
      backfillSuppressHours: HOURS,
      now: NOW,
    });
    expect(d).toEqual({ suppress: true, reason: 'first_sync' });
  });

  it('allows a fresh trade after baseline', () => {
    const d = shouldSuppressAlert({
      tradeTime: new Date(NOW.getTime() - 60_000),
      isFirstSync: false,
      suppressBackfill: false,
      backfillSuppressHours: HOURS,
      now: NOW,
    });
    expect(d.suppress).toBe(false);
    expect(d.reason).toBe('fresh');
  });

  it('suppresses trades older than the static backfill window when there is no last-sync hint', () => {
    const d = shouldSuppressAlert({
      tradeTime: new Date(NOW.getTime() - (HOURS + 1) * 3_600_000),
      isFirstSync: false,
      suppressBackfill: false,
      backfillSuppressHours: HOURS,
      now: NOW,
    });
    expect(d).toEqual({ suppress: true, reason: 'older_than_backfill_window' });
  });

  it('after a long outage, suppresses trades older than the last successful sync (NOT just the static window)', () => {
    // Bot offline for 30h. Trade T fired 26h ago, already alerted before the outage.
    // Static window says "still in 24h backfill" — but lastSync was 30h ago and T is older than that,
    // so we suppress. The point of this case: T was already alerted.
    const lastSync = new Date(NOW.getTime() - 30 * 3_600_000);
    const d = shouldSuppressAlert({
      tradeTime: new Date(NOW.getTime() - 26 * 3_600_000),
      isFirstSync: false,
      suppressBackfill: false,
      backfillSuppressHours: HOURS,
      lastSuccessfulSyncAt: lastSync,
      now: NOW,
    });
    // 26h ago is OLDER than 24h cutoff so it should suppress via window.
    expect(d.suppress).toBe(true);
  });

  it('after a brief gap, a fresh trade still alerts', () => {
    const lastSync = new Date(NOW.getTime() - 5 * 60_000);
    const d = shouldSuppressAlert({
      tradeTime: new Date(NOW.getTime() - 60_000),
      isFirstSync: false,
      suppressBackfill: false,
      backfillSuppressHours: HOURS,
      lastSuccessfulSyncAt: lastSync,
      now: NOW,
    });
    expect(d.suppress).toBe(false);
  });

  it('uses the LATER of (now − window, lastSync) as the cutoff', () => {
    // Trade is 12h old (well inside the 24h window). lastSync was 6h ago.
    // Effective cutoff = max(now-24h, now-6h) = now-6h. 12h-old trade < cutoff → suppress.
    const lastSync = new Date(NOW.getTime() - 6 * 3_600_000);
    const d = shouldSuppressAlert({
      tradeTime: new Date(NOW.getTime() - 12 * 3_600_000),
      isFirstSync: false,
      suppressBackfill: false,
      backfillSuppressHours: HOURS,
      lastSuccessfulSyncAt: lastSync,
      now: NOW,
    });
    expect(d).toEqual({ suppress: true, reason: 'older_than_last_sync' });
  });
});

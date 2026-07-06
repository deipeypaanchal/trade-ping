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

  it('suppresses executions before the recovery marker without blocking newer trades', () => {
    const marker = new Date('2026-05-22T12:00:00Z');
    expect(shouldSuppressAlert({
      tradeTime: new Date('2026-05-22T11:59:59Z'),
      isFirstSync: false,
      suppressBackfill: false,
      backfillSuppressHours: HOURS,
      suppressBefore: marker,
      now: NOW,
    })).toEqual({ suppress: true, reason: 'recovery_suppress_before' });

    expect(shouldSuppressAlert({
      tradeTime: new Date('2026-05-22T12:00:01Z'),
      isFirstSync: false,
      suppressBackfill: false,
      backfillSuppressHours: HOURS,
      suppressBefore: marker,
      now: NOW,
    })).toEqual({ suppress: false, reason: 'fresh' });
  });

  it('allows a delayed but unseen execution inside the static backfill window', () => {
    const d = shouldSuppressAlert({
      tradeTime: new Date(NOW.getTime() - 12 * 3_600_000),
      isFirstSync: false,
      suppressBackfill: false,
      backfillSuppressHours: HOURS,
      now: NOW,
    });
    expect(d).toEqual({ suppress: false, reason: 'fresh' });
  });
});

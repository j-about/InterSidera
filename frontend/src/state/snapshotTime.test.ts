// @vitest-environment node
import { snapshotIsoUtc } from './snapshotTime';

describe('snapshotIsoUtc', () => {
  it('names the rendered instant once the mirror is published', () => {
    // JD 2460409.25 TT = 2024-04-08T18:00:00 TT; TT - UTC = 69.184 s.
    expect(snapshotIsoUtc({ tt: 2460409.25, ttMinusUtc: 69.184 }, 0)).toBe('2024-04-08T17:58:51Z');
  });

  it('falls back to the wall clock while the mirror is NaN', () => {
    const now = Date.UTC(2026, 8, 9, 15, 14, 3, 123);
    expect(snapshotIsoUtc({ tt: NaN, ttMinusUtc: 69.184 }, now)).toBe('2026-09-09T15:14:03.123Z');
    expect(snapshotIsoUtc({ tt: 2460409.25, ttMinusUtc: NaN }, now)).toBe(
      '2026-09-09T15:14:03.123Z',
    );
  });
});

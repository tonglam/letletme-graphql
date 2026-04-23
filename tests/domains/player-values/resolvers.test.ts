import { describe, expect, it } from 'bun:test';
import { normalizePlayerValueHistoryArgs } from '../../../src/domains/player-values/resolvers';

describe('normalizePlayerValueHistoryArgs', () => {
  it('uses default limit when missing', () => {
    const result = normalizePlayerValueHistoryArgs({ playerId: 7 });
    expect(result.limit).toBe(30);
  });

  it('caps limit at max value', () => {
    const result = normalizePlayerValueHistoryArgs({ playerId: 7, limit: 999 });
    expect(result.limit).toBe(365);
  });

  it('normalizes lower bound for limit', () => {
    const result = normalizePlayerValueHistoryArgs({ playerId: 7, limit: 0 });
    expect(result.limit).toBe(1);
  });

  it('throws when fromDate is after toDate', () => {
    const fromDate = new Date('2026-04-10T00:00:00.000Z');
    const toDate = new Date('2026-04-01T00:00:00.000Z');

    expect(() =>
      normalizePlayerValueHistoryArgs({
        playerId: 7,
        fromDate,
        toDate,
      })
    ).toThrow('Invalid date range');
  });
});

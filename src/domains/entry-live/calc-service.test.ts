import { describe, expect, it } from 'bun:test';
import { calcElementLivePoints } from './calc-service';
import type { LivePerformance } from '../live/repository';

const makeLive = (overrides: Partial<LivePerformance> = {}): LivePerformance => ({
  eventId: 1,
  playerId: 1,
  minutes: 90,
  goalsScored: 0,
  assists: 0,
  cleanSheets: 0,
  goalsConceded: 0,
  ownGoals: 0,
  penaltiesSaved: 0,
  penaltiesMissed: 0,
  yellowCards: 0,
  redCards: 0,
  saves: 0,
  bonus: 0,
  bps: 0,
  defensiveContribution: 0,
  starts: true,
  expectedGoals: null,
  expectedAssists: null,
  expectedGoalInvolvements: null,
  expectedGoalsConceded: null,
  inDreamTeam: null,
  totalPoints: 0,
  ...overrides,
});

describe('calcElementLivePoints', () => {
  it('returns 0 for undefined live', () => {
    expect(calcElementLivePoints(1, undefined)).toBe(0);
  });

  it('returns FPL totalPoints directly', () => {
    const live = makeLive({ totalPoints: 7 });
    expect(calcElementLivePoints(3, live)).toBe(7);
  });

  it('returns 0 when totalPoints is 0', () => {
    const live = makeLive({ totalPoints: 0 });
    expect(calcElementLivePoints(2, live)).toBe(0);
  });

  it('handles negative totalPoints', () => {
    const live = makeLive({ totalPoints: -3 });
    expect(calcElementLivePoints(2, live)).toBe(-3);
  });

  it('returns totalPoints regardless of position type', () => {
    for (const elementType of [1, 2, 3, 4]) {
      const live = makeLive({ totalPoints: 5 });
      expect(calcElementLivePoints(elementType, live)).toBe(5);
    }
  });

  it('does not double-count for DGW players', () => {
    const live = makeLive({ totalPoints: 8, minutes: 180 });
    expect(calcElementLivePoints(4, live)).toBe(8);
  });
});
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

  it('uses FPL totalPoints as base', () => {
    const live = makeLive({ totalPoints: 7 });
    expect(calcElementLivePoints(3, live)).toBe(7);
  });

  it('adds DC bonus for DEF with DC >= 10', () => {
    const live = makeLive({ totalPoints: 5, defensiveContribution: 10 });
    expect(calcElementLivePoints(2, live)).toBe(7);
  });

  it('does not add DC bonus for DEF with DC < 10', () => {
    const live = makeLive({ totalPoints: 5, defensiveContribution: 9 });
    expect(calcElementLivePoints(2, live)).toBe(5);
  });

  it('adds DC bonus for MID with DC >= 12', () => {
    const live = makeLive({ totalPoints: 3, defensiveContribution: 12 });
    expect(calcElementLivePoints(3, live)).toBe(5);
  });

  it('does not add DC bonus for MID with DC < 12', () => {
    const live = makeLive({ totalPoints: 3, defensiveContribution: 11 });
    expect(calcElementLivePoints(3, live)).toBe(3);
  });

  it('adds DC bonus for FWD with DC >= 12', () => {
    const live = makeLive({ totalPoints: 4, defensiveContribution: 15 });
    expect(calcElementLivePoints(4, live)).toBe(6);
  });

  it('does not add DC bonus for GKP', () => {
    const live = makeLive({ totalPoints: 6, defensiveContribution: 20 });
    expect(calcElementLivePoints(1, live)).toBe(6);
  });

  it('handles zero totalPoints with DC bonus', () => {
    const live = makeLive({ totalPoints: 0, defensiveContribution: 12 });
    expect(calcElementLivePoints(3, live)).toBe(2);
  });

  it('handles negative totalPoints', () => {
    const live = makeLive({ totalPoints: -3, defensiveContribution: 5 });
    expect(calcElementLivePoints(2, live)).toBe(-3);
  });

  it('handles null defensiveContribution', () => {
    const live = makeLive({ totalPoints: 5, defensiveContribution: null as unknown as number });
    expect(calcElementLivePoints(2, live)).toBe(5);
  });

  it('does not double-count FPL points for DGW players', () => {
    const live = makeLive({ totalPoints: 2 });
    expect(calcElementLivePoints(3, live)).toBe(2);
  });
});
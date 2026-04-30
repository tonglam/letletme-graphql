import { describe, expect, it } from 'bun:test';
import type { GraphQLContext } from '../../../src/graphql/context';
import type { Entry, EntryEventResult } from '../../../src/domains/entries/repository';
import { entriesResolvers, entryResultChipToEnum } from '../../../src/domains/entries/resolvers';
import { entriesService } from '../../../src/domains/entries/service';
import type { ElementEventResultData } from '../../../src/domains/entry-live/calc-service';
import { Position, type Player } from '../../../src/domains/players/repository';
import { playersService } from '../../../src/domains/players/service';

const makePick = (overrides: Partial<ElementEventResultData>): ElementEventResultData => ({
  season: '2025',
  event: 33,
  element: 1,
  code: 1,
  webName: 'Player',
  price: 10,
  elementType: 2,
  elementTypeName: 'DEF',
  teamId: 1,
  teamCode: 1,
  teamName: 'Team',
  teamShortName: 'TST',
  againstId: 2,
  againstName: 'Other',
  againstShortName: 'OTH',
  wasHome: 'true',
  score: '0-0',
  position: 1,
  multiplier: 1,
  isCaptain: false,
  isViceCaptain: false,
  isGwStarted: true,
  isGwFinished: true,
  isPlayed: true,
  playStatus: 4,
  minutes: 90,
  goalsScored: 0,
  assists: 0,
  cleanSheets: 1,
  goalsConceded: 0,
  defensiveContribution: 0,
  ownGoals: 0,
  penaltiesSaved: 0,
  penaltiesMissed: 0,
  yellowCards: 0,
  redCards: 0,
  saves: 0,
  bonus: 0,
  bps: 0,
  totalPoints: 6,
  starts: true,
  expectedGoals: null,
  expectedAssists: null,
  expectedGoalInvolvements: null,
  expectedGoalsConceded: null,
  inDreamTeam: false,
  pickActive: true,
  autoSub: false,
  bgw: false,
  dgw: false,
  ...overrides,
});

const makeEntryEventResult = (overrides: Partial<EntryEventResult> = {}): EntryEventResult => ({
  entryId: 84885,
  eventId: 33,
  eventPoints: 82,
  eventRank: 123,
  overallPoints: 2000,
  overallRank: 4567,
  eventTransfers: 1,
  eventTransfersCost: 4,
  eventNetPoints: 78,
  eventBenchPoints: 9,
  eventChip: 'bboost',
  eventPlayedCaptain: 430,
  eventCaptainPoints: 24,
  eventPicks: [makePick({ element: 1, autoSub: false }), makePick({ element: 2, autoSub: true })],
  teamValue: 1030,
  bank: 10,
  ...overrides,
});

describe('entries resolver enum mappers', () => {
  it('normalizes entry result chip strings to GraphQL enum values', () => {
    expect(entryResultChipToEnum('bboost')).toBe('BENCH_BOOST');
    expect(entryResultChipToEnum('freehit')).toBe('FREE_HIT');
    expect(entryResultChipToEnum('3xc')).toBe('TRIPLE_CAPTAIN');
    expect(entryResultChipToEnum('wc')).toBe('WILDCARD');
    expect(entryResultChipToEnum('manager')).toBe('MANAGER');
    expect(entryResultChipToEnum('unknown')).toBe('NONE');
    expect(entryResultChipToEnum(null)).toBe('NONE');
  });
});

describe('EntryEventResult resolvers', () => {
  it('resolves stored historical fields from the parent row', () => {
    const parent = makeEntryEventResult();

    expect(entriesResolvers.EntryEventResult.eventBenchPoints(parent)).toBe(9);
    expect(entriesResolvers.EntryEventResult.eventChip(parent)).toBe('BENCH_BOOST');
    expect(entriesResolvers.EntryEventResult.eventCaptainPoints(parent)).toBe(24);
  });

  it('resolves event pick lists through entriesService', async () => {
    const original = entriesService.getEntryEventPicks;
    const context = {} as unknown as GraphQLContext;
    const parent = makeEntryEventResult();
    const picks = [makePick({ element: 1, autoSub: false }), makePick({ element: 2, autoSub: true })];

    entriesService.getEntryEventPicks = async (
      inputContext: GraphQLContext,
      inputParent: EntryEventResult
    ): Promise<ElementEventResultData[]> => {
      expect(inputContext).toBe(context);
      expect(inputParent).toBe(parent);
      return picks;
    };

    try {
      await expect(
        entriesResolvers.EntryEventResult.eventPicks(parent, {}, context)
      ).resolves.toHaveLength(2);
      await expect(
        entriesResolvers.EntryEventResult.eventAutoSub(parent, {}, context)
      ).resolves.toHaveLength(1);
    } finally {
      entriesService.getEntryEventPicks = original;
    }
  });

  it('resolves entry through entriesService instead of live calculation', async () => {
    const original = entriesService.getEntryById;
    const context = {} as unknown as GraphQLContext;
    const entry: Entry = {
      id: 84885,
      entryName: 'Stored Entry',
      playerName: 'Manager',
      region: null,
      startedEvent: 1,
      overallPoints: 2000,
      overallRank: 4567,
      bank: 10,
      teamValue: 1030,
      totalTransfers: 20,
      lastEventId: 33,
    };

    entriesService.getEntryById = async (
      inputContext: GraphQLContext,
      entryId: number
    ): Promise<Entry | null> => {
      expect(inputContext).toBe(context);
      expect(entryId).toBe(84885);
      return entry;
    };

    try {
      const result = await entriesResolvers.EntryEventResult.entry(
        makeEntryEventResult(),
        {},
        context
      );
      expect(result).toBe(entry);
    } finally {
      entriesService.getEntryById = original;
    }
  });

  it('resolves played captain by stored player id and event id', async () => {
    const original = playersService.getPlayerByIdForEvent;
    const context = {} as unknown as GraphQLContext;
    const captain: Player = {
      id: 430,
      code: 1,
      webName: 'Salah',
      firstName: 'Mo',
      secondName: 'Salah',
      teamId: 12,
      position: Position.MIDFIELDER,
      price: 130,
      startPrice: 125,
      totalPoints: 200,
      selectedByPercent: 40.1,
    };

    playersService.getPlayerByIdForEvent = async (
      inputContext: GraphQLContext,
      playerId: number,
      eventId: number
    ): Promise<Player | null> => {
      expect(inputContext).toBe(context);
      expect(playerId).toBe(430);
      expect(eventId).toBe(33);
      return captain;
    };

    try {
      const result = await entriesResolvers.EntryEventResult.eventPlayedCaptain(
        makeEntryEventResult(),
        {},
        context
      );
      expect(result).toBe(captain);
    } finally {
      playersService.getPlayerByIdForEvent = original;
    }
  });
});

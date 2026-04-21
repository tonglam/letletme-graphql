import { describe, expect, it } from 'bun:test';
import { LeagueType } from '../leagues/repository';
import { GroupMode, KnockoutMode, TournamentState } from './repository';
import {
  groupModeToEnum,
  knockoutModeToEnum,
  leagueTypeToEnum,
  tournamentStateToEnum,
} from './resolvers';

describe('tournaments resolver enum mappers', () => {
  it('maps league type to GraphQL enum', () => {
    expect(leagueTypeToEnum(LeagueType.CLASSIC)).toBe('CLASSIC');
    expect(leagueTypeToEnum(LeagueType.H2H)).toBe('H2H');
  });

  it('maps group mode including null', () => {
    expect(groupModeToEnum(null)).toBeNull();
    expect(groupModeToEnum(GroupMode.NO_GROUP)).toBe('NO_GROUP');
    expect(groupModeToEnum(GroupMode.POINTS_RACES)).toBe('POINTS_RACES');
    expect(groupModeToEnum(GroupMode.BATTLE_RACES)).toBe('BATTLE_RACES');
  });

  it('maps knockout mode including null', () => {
    expect(knockoutModeToEnum(null)).toBeNull();
    expect(knockoutModeToEnum(KnockoutMode.NO_KNOCKOUT)).toBe('NO_KNOCKOUT');
    expect(knockoutModeToEnum(KnockoutMode.SINGLE_ELIMINATION)).toBe('SINGLE_ELIMINATION');
    expect(knockoutModeToEnum(KnockoutMode.DOUBLE_ELIMINATION)).toBe('DOUBLE_ELIMINATION');
    expect(knockoutModeToEnum(KnockoutMode.HEAD_TO_HEAD)).toBe('HEAD_TO_HEAD');
  });

  it('maps tournament state to GraphQL enum', () => {
    expect(tournamentStateToEnum(TournamentState.ACTIVE)).toBe('ACTIVE');
    expect(tournamentStateToEnum(TournamentState.INACTIVE)).toBe('INACTIVE');
    expect(tournamentStateToEnum(TournamentState.FINISHED)).toBe('FINISHED');
  });
});

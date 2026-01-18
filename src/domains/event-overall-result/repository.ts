import type { GraphQLContext } from '../../graphql/context';

export type ChipPlay = {
  chipName: string;
  numberPlayed: number;
};

export type TopElementInfo = {
  element: number;
  points: number;
};

export type EventResult = {
  event: number;
  averageEntryScore: number;
  finished: boolean;
  highestScoringEntry: number;
  highestScore: number;
  chipPlays: ChipPlay[];
  mostSelected: number;
  mostTransferredIn: number;
  topElementInfo: TopElementInfo;
  transfersMade: number;
  mostCaptained: number;
  mostViceCaptained: number;
};

export interface EventOverallResultRepository {
  getEventOverallResult(context: GraphQLContext, season: number): Promise<EventResult[]>;
}

function getCacheKey(season: number): string {
  return `EventOverallResult:${season}`;
}

function parseEventResult(rawData: unknown): EventResult | null {
  if (typeof rawData !== 'object' || rawData === null) {
    return null;
  }

  const data = rawData as Record<string, unknown>;

  // Parse chipPlays array
  let chipPlays: ChipPlay[] = [];
  if (Array.isArray(data.chipPlays)) {
    chipPlays = data.chipPlays
      .map((chip: unknown) => {
        if (typeof chip === 'object' && chip !== null) {
          const chipObj = chip as Record<string, unknown>;
          return {
            chipName: String(chipObj.chipName ?? ''),
            numberPlayed: Number(chipObj.numberPlayed ?? 0),
          };
        }
        return null;
      })
      .filter((chip): chip is ChipPlay => chip !== null);
  }

  // Parse topElementInfo
  let topElementInfo: TopElementInfo = { element: 0, points: 0 };
  if (typeof data.topElementInfo === 'object' && data.topElementInfo !== null) {
    const topElement = data.topElementInfo as Record<string, unknown>;
    topElementInfo = {
      element: Number(topElement.element ?? 0),
      points: Number(topElement.points ?? 0),
    };
  }

  return {
    event: Number(data.event ?? 0),
    averageEntryScore: Number(data.averageEntryScore ?? 0),
    finished: Boolean(data.finished ?? false),
    highestScoringEntry: Number(data.highestScoringEntry ?? 0),
    highestScore: Number(data.highestScore ?? 0),
    chipPlays,
    mostSelected: Number(data.mostSelected ?? 0),
    mostTransferredIn: Number(data.mostTransferredIn ?? 0),
    topElementInfo,
    transfersMade: Number(data.transfersMade ?? 0),
    mostCaptained: Number(data.mostCaptained ?? 0),
    mostViceCaptained: Number(data.mostViceCaptained ?? 0),
  };
}

export const eventOverallResultRepository: EventOverallResultRepository = {
  async getEventOverallResult(
    context: GraphQLContext,
    season: number
  ): Promise<EventResult[]> {
    const cacheKey = getCacheKey(season);
    context.logger.info({ cacheKey, season }, 'Looking for event overall result in Redis');

    try {
      // Check if key exists
      const keyType = await context.redis.type(cacheKey);

      if (keyType === 'none') {
        context.logger.warn({ cacheKey, season }, 'Event overall result not found in Redis');
        return [];
      }

      // Get the data from Redis
      const eventResults: EventResult[] = [];

      if (keyType === 'string') {
        // Handle string type (JSON)
        const cached = await context.redis.get(cacheKey);
        if (!cached) {
          context.logger.warn({ cacheKey, season }, 'Empty value found in Redis');
          return [];
        }
        try {
          const parsed = JSON.parse(cached) as unknown;
          if (Array.isArray(parsed)) {
            // If it's an array, parse each item
            for (const item of parsed) {
              const result = parseEventResult(item);
              if (result) {
                eventResults.push(result);
              }
            }
          } else if (typeof parsed === 'object' && parsed !== null) {
            // If it's an object, convert to array
            const dataObj = parsed as Record<string, unknown>;
            for (const value of Object.values(dataObj)) {
              const result = parseEventResult(value);
              if (result) {
                eventResults.push(result);
              }
            }
          }
        } catch (error) {
          context.logger.error({ err: error, cacheKey, season }, 'Failed to parse JSON from Redis');
          return [];
        }
      } else if (keyType === 'hash') {
        // Handle hash type - each hash field value is a JSON string that needs parsing
        const hashData = await context.redis.hgetall(cacheKey);

        for (const [eventId, jsonValue] of Object.entries(hashData)) {
          try {
            const parsed = JSON.parse(jsonValue) as unknown;
            const result = parseEventResult(parsed);
            if (result) {
              eventResults.push(result);
            } else {
              context.logger.warn({ cacheKey, season, eventId }, 'Failed to parse event result');
            }
          } catch (error) {
            context.logger.warn({ err: error, cacheKey, season, eventId }, 'Failed to parse hash value as JSON');
          }
        }

        // Sort by event number
        eventResults.sort((a, b) => a.event - b.event);
      } else {
        context.logger.error({ cacheKey, season, keyType }, 'Unsupported Redis key type for event overall result');
        return [];
      }

      context.logger.info({ cacheKey, season, eventCount: eventResults.length }, 'Successfully retrieved event overall result from Redis');

      return eventResults;
    } catch (error) {
      context.logger.error({ err: error, cacheKey: getCacheKey(season), season }, 'Failed to get event overall result from Redis');
      return [];
    }
  },
};

/**
 * Length-prefix the run component so `capacity-run` cannot also match
 * `capacity-run-2`. The complete request ID remains within GraphQL's 64-byte
 * request-ID contract for the allowed 8-32 byte run IDs.
 */
export const capacityRunRequestIdPrefix = (runId: string): string => `cr${runId.length}_${runId}_`;

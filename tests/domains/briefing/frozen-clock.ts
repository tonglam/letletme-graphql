import { afterEach, beforeEach, spyOn } from "bun:test";

export const BRIEFING_FIXTURE_NOW_MS = Date.parse("2026-08-19T12:00:00.000Z");

export const withFrozenBriefingClock = (suite: () => void): void => {
	let dateSpy: ReturnType<typeof spyOn<typeof Date, "now">> | undefined;

	beforeEach(() => {
		dateSpy = spyOn(Date, "now").mockReturnValue(BRIEFING_FIXTURE_NOW_MS);
	});

	afterEach(() => {
		dateSpy?.mockRestore();
	});

	suite();
};

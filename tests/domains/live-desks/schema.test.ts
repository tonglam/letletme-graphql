import { describe, expect, it } from "bun:test";
import { isEnumType, isInputObjectType, isObjectType } from "graphql";

import { schema } from "../../../src/graphql/schema";

describe("live competition board chip contract", () => {
	it("uses the shared Chip enum for input and output", () => {
		const input = schema.getType("EntryLiveCompetitionBoardInput");
		const row = schema.getType("EntryLiveCompetitionBoardRow");
		const chip = schema.getType("Chip");

		expect(isInputObjectType(input)).toBe(true);
		expect(isObjectType(row)).toBe(true);
		expect(isEnumType(chip)).toBe(true);
		if (!isInputObjectType(input) || !isObjectType(row) || !isEnumType(chip)) return;

		expect(String(input.getFields().chips.type)).toBe("[Chip!]");
		expect(String(row.getFields().chip.type)).toBe("Chip");
		expect(chip.getValues().map((value) => value.name)).toEqual([
			"NONE",
			"BENCH_BOOST",
			"FREE_HIT",
			"TRIPLE_CAPTAIN",
			"WILDCARD",
			"MANAGER",
		]);
	});
});

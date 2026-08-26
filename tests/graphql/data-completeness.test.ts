import { describe, expect, it } from "bun:test";
import { getNamedType, isObjectType } from "graphql";
import { buildDataCompleteness, revisionsAgree } from "../../src/graphql/data-completeness";
import { schema } from "../../src/graphql/schema";

describe("additive data completeness metadata", () => {
	it("fails closed when the metadata and payload revisions diverge", () => {
		expect(revisionsAgree("r1", "r1")).toBe(true);
		expect(revisionsAgree("r1", "r2")).toBe(false);
		expect(
			buildDataCompleteness({
				contractKey: "core-fixtures",
				scopeKey: "season:2026",
				revision: "r1",
				payloadRevision: "r2",
				complete: true,
			})
		).toMatchObject({
			complete: false,
			eligibility: "INVALID",
			revision: "r1",
		});
	});

	it("exposes metadata on the business envelopes without replacing legacy fields", () => {
		for (const typeName of [
			"CoreEventContext",
			"LiveSnapshotMeta",
			"GameweekDesk",
			"MarketSnapshotContext",
			"PriceChangeBoard",
			"MyFplSnapshotMeta",
			"PlayerStatsContext",
			"TournamentOfficialH2H",
			"TournamentOfficialH2HBoard",
			"HomePersonalDesk",
			"HomeMarketDesk",
		]) {
			const type = schema.getType(typeName);
			expect(type && isObjectType(type)).toBe(true);
			if (!type || !isObjectType(type)) continue;
			expect(type.getFields().completeness.type.toString()).toBe("DataCompletenessMeta");
		}
		const meta = schema.getType("DataCompletenessMeta");
		expect(meta && isObjectType(meta)).toBe(true);
		if (meta && isObjectType(meta)) {
			expect(getNamedType(meta.getFields().complete.type).toString()).toBe("Boolean");
			expect(meta.getFields().eligibility.type.toString()).toBe("DataEligibilityState!");
		}
	});
});

import { describe, expect, it } from "bun:test";
import { schema } from "../../../src/graphql/schema";

describe("price-change board schema", () => {
	it("exposes the official prediction board as a public query", () => {
		const field = schema.getQueryType()?.getFields().priceChangeBoard;
		expect(field).toBeDefined();
		expect(field?.type.toString()).toBe("PriceChangeBoard!");
	});

	it("keeps purchase and selling prices out of the prediction contract", () => {
		const fields = schema.getType("PriceChangePlayer");
		const fieldNames = fields && "getFields" in fields ? Object.keys(fields.getFields()) : [];
		expect(fieldNames).not.toContain("purchasePrice");
		expect(fieldNames).not.toContain("sellingPrice");
	});
});

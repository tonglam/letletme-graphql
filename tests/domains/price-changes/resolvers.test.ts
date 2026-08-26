import { describe, expect, it } from "bun:test";
import { schema } from "../../../src/graphql/schema";

describe("price-change board schema", () => {
	it("exposes the official prediction board as a public query", () => {
		const field = schema.getQueryType()?.getFields().priceChangeBoard;
		expect(field).toBeDefined();
		expect(field?.type.toString()).toBe("PriceChangeBoard!");
	});

	it("adds live cursor and board queries without changing the durable query", () => {
		const fields = schema.getQueryType()?.getFields();
		expect(fields?.priceChangeLiveCursor?.type.toString()).toBe("PriceChangeLiveCursor!");
		expect(fields?.priceChangeLiveBoard?.type.toString()).toBe("PriceChangeLiveBoard!");
		expect(fields?.priceChangeLiveCursor?.args.map((arg) => arg.name)).toEqual(["seasonCode"]);
		expect(fields?.priceChangeLiveBoard?.args.map((arg) => arg.name)).toEqual([
			"seasonCode",
			"revision",
		]);
		const liveBoard = schema.getType("PriceChangeLiveBoard");
		const liveBoardFields = liveBoard && "getFields" in liveBoard ? liveBoard.getFields() : {};
		expect(liveBoardFields.durablePublicationId?.type.toString()).toBe("ID");
	});

	it("keeps purchase and selling prices out of the prediction contract", () => {
		const fields = schema.getType("PriceChangePlayer");
		const fieldNames = fields && "getFields" in fields ? Object.keys(fields.getFields()) : [];
		expect(fieldNames).not.toContain("purchasePrice");
		expect(fieldNames).not.toContain("sellingPrice");
	});
});

import { describe, expect, it } from "bun:test";
import {
	extractGraphQLOperationName,
	RequestTiming,
	resolveRequestId,
} from "../../src/http/request-timing";

describe("request timing diagnostics", () => {
	it("records cumulative stage durations without exposing task inputs", async () => {
		let now = 100;
		const timing = new RequestTiming(() => now);
		const result = await timing.measure("redis", async () => {
			now += 4.25;
			return "ok";
		});
		timing.measureSync("parse", () => {
			now += 1.5;
		});

		expect(result).toBe("ok");
		expect(timing.snapshot()).toEqual({ redis: 4.25, parse: 1.5 });
		expect(timing.elapsedMs()).toBe(5.75);
	});

	it("accepts only bounded request and operation identifiers", () => {
		expect(resolveRequestId("proxy_123456", () => "generated")).toBe("proxy_123456");
		expect(resolveRequestId("bad id", () => "generated")).toBe("generated");
		expect(extractGraphQLOperationName({ operationName: "CoreEventFixtureSchedule" })).toBe(
			"CoreEventFixtureSchedule"
		);
		expect(extractGraphQLOperationName({ operationName: "bad operation" })).toBe("anonymous");
	});
});

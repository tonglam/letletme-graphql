import { describe, expect, it } from "bun:test";
import {
	Kind,
	parse,
	type FieldNode,
	type FragmentDefinitionNode,
	type GraphQLResolveInfo,
	type OperationDefinitionNode,
} from "graphql";

import {
	createLiveMatchPayloadSampler,
	deskHasStartedActivity,
	liveMatchReadModeFromInfo,
} from "../../../src/domains/live-matches/resolvers";

const resolveInfo = (
	documentText: string,
	variableValues: Record<string, unknown> = {}
): GraphQLResolveInfo => {
	const document = parse(documentText);
	const operation = document.definitions.find(
		(definition): definition is OperationDefinitionNode =>
			definition.kind === Kind.OPERATION_DEFINITION
	);
	if (!operation) throw new Error("test document is missing an operation");

	const fragments: Record<string, FragmentDefinitionNode> = {};
	for (const definition of document.definitions) {
		if (definition.kind === Kind.FRAGMENT_DEFINITION) {
			fragments[definition.name.value] = definition;
		}
	}

	const fieldNodes = operation.selectionSet.selections.filter(
		(selection): selection is FieldNode => selection.kind === Kind.FIELD
	);
	return {
		fieldNodes,
		fragments,
		variableValues,
	} as unknown as GraphQLResolveInfo;
};

describe("liveMatchReadModeFromInfo", () => {
	it("selects HEAD when the snapshot does not request matches", () => {
		const info = resolveInfo(`
			query FullNameDoesNotMatter {
				liveMatchday {
					snapshot {
						eventId
						delivery { state }
					}
				}
			}
		`);

		expect(liveMatchReadModeFromInfo(info)).toBe("HEAD");
	});

	it("selects DESK from the schema field name even when matches is aliased", () => {
		const info = resolveInfo(`
			query ArbitraryOperationName {
				liveMatchday {
					snapshot {
						fixtureRows: matches { fixtureId }
					}
				}
			}
		`);

		expect(liveMatchReadModeFromInfo(info)).toBe("DESK");
	});

	it("selects FULL through fragments, inline fragments, and players aliases", () => {
		const info = resolveInfo(`
			query AnotherOperationName {
				liveMatchday {
					snapshot {
						...MatchFields
						... on LiveMatchdaySnapshot {
							matches {
								players: players { id }
							}
						}
					}
				}
			}
			fragment MatchFields on LiveMatchdaySnapshot {
				matches { fixtureId players { id } }
			}
		`);

		expect(liveMatchReadModeFromInfo(info)).toBe("FULL");
	});

	it("does not read detail for selections excluded by literal or variable directives", () => {
		const literalExcluded = resolveInfo(`
			query LiteralDirective {
				liveMatchday {
					snapshot {
						matches @skip(if: true) { players { id } }
					}
				}
			}
		`);
		const variableExcluded = resolveInfo(
			`query VariableDirective($showPlayers: Boolean!) {
				liveMatchday {
					snapshot {
						matches {
							players @include(if: $showPlayers) { id }
						}
					}
				}
			}`,
			{ showPlayers: false }
		);

		expect(liveMatchReadModeFromInfo(literalExcluded)).toBe("HEAD");
		expect(liveMatchReadModeFromInfo(variableExcluded)).toBe("DESK");
	});
});

describe("deskHasStartedActivity", () => {
	const metadataDesk = (state: "PRE_DEADLINE" | "LIVE_ACTIVE", startedFixtureIds: number[]) =>
		({
			payloadLoaded: false,
			fixtureCoverage: { fixtureIds: [101, 102], startedFixtureIds },
			publication: { state },
		}) as never;

	it("uses retained started fixture coverage for metadata-only reads", () => {
		expect(deskHasStartedActivity(metadataDesk("PRE_DEADLINE", [101]))).toBe(true);
		expect(deskHasStartedActivity(metadataDesk("LIVE_ACTIVE", []))).toBe(false);
	});

	it("fails closed when metadata-only coverage is absent", () => {
		expect(
			deskHasStartedActivity({
				payloadLoaded: false,
				publication: { state: "LIVE_ACTIVE" },
			} as never)
		).toBe(false);
	});
});

describe("deterministic Live Matches payload sampling", () => {
	it("samples the first FULL request", () => {
		const sampler = createLiveMatchPayloadSampler();

		expect(sampler("FULL")).toBe(true);
		expect(sampler("FULL")).toBe(false);
	});

	it("samples once per 100 FULL requests and then every 100th request", () => {
		const sampler = createLiveMatchPayloadSampler();
		const firstHundred = Array.from({ length: 100 }, () => sampler("FULL"));

		expect(firstHundred.filter(Boolean)).toHaveLength(1);
		expect(sampler("FULL")).toBe(true);
	});

	it("does not let HEAD or DESK requests advance the FULL counter", () => {
		const sampler = createLiveMatchPayloadSampler();

		expect(sampler("HEAD")).toBe(true);
		expect(sampler("DESK")).toBe(true);
		expect(sampler("FULL")).toBe(true);
		for (let index = 0; index < 99; index += 1) {
			expect(sampler("FULL")).toBe(false);
		}
		expect(sampler("FULL")).toBe(true);
	});
});

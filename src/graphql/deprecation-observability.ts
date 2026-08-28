import type { BaseContext, GraphQLRequestExecutionListener } from "@apollo/server";

export type DeprecationResponsePathSegment = string | number;

/**
 * A response-path segment that records the runtime object type for a
 * conditional selection. GraphQL response keys cannot contain a colon, so the
 * marker cannot collide with an actual response key.
 */
export const deprecationTypeOwnerSegment = (typeName: string): string => `__type:${typeName}`;

/**
 * Convert a GraphQL response path into a stable owner key. List indexes are
 * intentionally omitted because one fragment occurrence can execute once per
 * item; response object keys still distinguish separate branches/aliases.
 */
export const deprecationPathOwner = (path: readonly DeprecationResponsePathSegment[]): string =>
	`path:${path.filter((segment): segment is string => typeof segment === "string").join(".")}`;

const executionPathKey = (path: readonly DeprecationResponsePathSegment[]): string =>
	path
		.map((segment) => (typeof segment === "number" ? `number:${segment}` : `string:${segment}`))
		.join("/");

const executionParentPathForResponseSegments = (
	path: readonly DeprecationResponsePathSegment[],
	responseSegmentCount: number
): readonly DeprecationResponsePathSegment[] | undefined => {
	if (responseSegmentCount === 0) return [];
	let seenResponseSegments = 0;
	for (let index = 0; index < path.length; index += 1) {
		if (typeof path[index] !== "string") continue;
		seenResponseSegments += 1;
		if (seenResponseSegments !== responseSegmentCount) continue;
		let end = index + 1;
		while (typeof path[end] === "number") end += 1;
		return path.slice(0, end);
	}
	return undefined;
};

export const recordDeprecatedSchemaUsages = ({
	symbols,
	increment,
}: {
	symbols: readonly string[];
	increment: (symbol: string) => void;
}): number => {
	const uniqueSymbols = [...new Set(symbols)].sort();
	for (const symbol of uniqueSymbols) increment(symbol);
	return uniqueSymbols.length;
};

export const createDeprecatedSchemaUsageExecutionListener = <TContext extends BaseContext>({
	symbols,
	symbolOwners = {},
	globalSymbols,
	increment,
	onExecutionEnd,
	isExecutionSuccessful,
}: {
	symbols: readonly string[];
	symbolOwners?: Readonly<Record<string, readonly string[]>>;
	globalSymbols?: readonly string[];
	increment: (symbol: string) => void;
	onExecutionEnd?: () => void;
	isExecutionSuccessful?: () => boolean;
}): GraphQLRequestExecutionListener<TContext> => {
	let committed = false;
	let executedField = false;
	const ownedSymbols = new Set(Object.values(symbolOwners).flat());
	const hasExplicitGlobalSymbols = globalSymbols !== undefined;
	const effectiveGlobalSymbols =
		globalSymbols ?? symbols.filter((symbol) => !ownedSymbols.has(symbol));
	const executedOwners = new Set<string>();
	const runtimePathOwnersByResponsePath = new Map<
		string,
		readonly {
			owner: string;
			markers: readonly { typeName: string; responseSegmentCount: number }[];
		}[]
	>();
	for (const owner of Object.keys(symbolOwners)) {
		if (!owner.startsWith("path:")) continue;
		const segments = owner.slice("path:".length).split(".");
		const markers = segments.flatMap((segment, index) =>
			segment.startsWith("__type:")
				? [
						{
							typeName: segment.slice("__type:".length),
							responseSegmentCount: segments
								.slice(0, index)
								.filter((candidate) => !candidate.startsWith("__type:")).length,
						},
					]
				: []
		);
		if (markers.length === 0) continue;
		const responsePath = segments.filter((segment) => !segment.startsWith("__type:")).join(".");
		const owners = runtimePathOwnersByResponsePath.get(responsePath) ?? [];
		runtimePathOwnersByResponsePath.set(responsePath, [...owners, { owner, markers }]);
	}
	const runtimeTypeByExecutionParentPath = new Map<string, string>();
	return {
		...(symbols.length > 0
			? {
					willResolveField({ info }): void {
						executedField = true;
						for (const fieldNode of info.fieldNodes) {
							if (fieldNode.loc) executedOwners.add(`field:${fieldNode.loc.start}`);
						}
						const path: DeprecationResponsePathSegment[] = [];
						for (
							let current: typeof info.path | undefined = info.path;
							current;
							current = current.prev
						) {
							path.push(current.key);
						}
						const responsePath = path.reverse();
						const executionParentPath = responsePath.slice(0, -1);
						runtimeTypeByExecutionParentPath.set(
							executionPathKey(executionParentPath),
							info.parentType.name
						);
						executedOwners.add(deprecationPathOwner(responsePath));
						const responsePathKey = responsePath
							.filter((segment): segment is string => typeof segment === "string")
							.join(".");
						for (const runtimePathOwner of runtimePathOwnersByResponsePath.get(responsePathKey) ??
							[]) {
							const matches = runtimePathOwner.markers.every((marker) => {
								const parentPath = executionParentPathForResponseSegments(
									responsePath,
									marker.responseSegmentCount
								);
								return (
									parentPath !== undefined &&
									runtimeTypeByExecutionParentPath.get(executionPathKey(parentPath)) ===
										marker.typeName
								);
							});
							if (matches) executedOwners.add(runtimePathOwner.owner);
						}
						executedOwners.add(`${info.parentType.name}.${info.fieldName}`);
					},
				}
			: {}),
		async executionDidEnd(error?: Error): Promise<void> {
			// A successful operation may execute no resolver (for example, every
			// field is excluded by an @skip directive) but still use a deprecated
			// operation-level/directive symbol. Commit global symbols in that case;
			// field-owned symbols remain gated on an actually executed field.
			if (
				!error &&
				!committed &&
				(executedField ||
					(hasExplicitGlobalSymbols &&
						effectiveGlobalSymbols.length > 0 &&
						(isExecutionSuccessful?.() ?? true)))
			) {
				const executedSymbols = new Set(effectiveGlobalSymbols);
				for (const owner of executedOwners) {
					for (const symbol of symbolOwners[owner] ?? []) executedSymbols.add(symbol);
				}
				recordDeprecatedSchemaUsages({ symbols: [...executedSymbols], increment });
				committed = true;
			}
			onExecutionEnd?.();
		},
	};
};

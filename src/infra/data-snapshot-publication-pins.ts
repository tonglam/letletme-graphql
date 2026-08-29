import type { GraphQLContext } from "../graphql/context";
import {
	readDataPublication,
	readDataPublicationItemsAtManifest,
	readDataPublicationItemsObserved,
	readDataPublicationManifest,
	type DataPublication,
	type DataPublicationManifest,
} from "./data-publication";

export const CORE_PUBLICATION_ITEMS = [
	"events",
	"teams",
	"players",
	"phases",
	"fixtures",
	"currentEventId",
] as const;

export const TEAM_SELECTION_CORE_PUBLICATION_ITEMS = [
	...CORE_PUBLICATION_ITEMS,
	"selectionRules",
] as const;

export const LIVE_PUBLICATION_ITEMS = ["eventLive", "fixtures"] as const;

type CorePublicationPin = {
	manifest: Promise<DataPublicationManifest | null>;
	publication?: Promise<DataPublication | null>;
};

const corePublicationPinMemo = new WeakMap<object, CorePublicationPin>();

export const bindCoreRevision = <T extends { revision: string }>(
	context: GraphQLContext,
	loading: Promise<T>
): Promise<T> =>
	loading.then((snapshot) => {
		context.dataRevision ??= `core-${snapshot.revision}`;
		return snapshot;
	});

export const reserveCorePublicationPin = (
	context: GraphQLContext,
	mode: "manifest" | "publication"
): CorePublicationPin => {
	const requestScope = context.requestScope ?? context;
	const existing = corePublicationPinMemo.get(requestScope);
	if (existing) {
		if (mode === "publication" && !existing.publication) {
			existing.publication = existing.manifest.then((manifest) =>
				manifest
					? readDataPublicationItemsAtManifest(context.redis, manifest, CORE_PUBLICATION_ITEMS)
					: null
			);
		}
		return existing;
	}

	const scope = {
		dataset: "fpl:core" as const,
		seasonCode: context.currentSeason.seasonCode,
	};
	if (mode === "publication") {
		const publication = readDataPublication(context.redis, scope, CORE_PUBLICATION_ITEMS);
		const pin: CorePublicationPin = {
			publication,
			manifest: publication.then((value) => value?.manifest ?? null),
		};
		corePublicationPinMemo.set(requestScope, pin);
		return pin;
	}

	const pin: CorePublicationPin = {
		manifest: readDataPublicationManifest(context.redis, scope),
	};
	corePublicationPinMemo.set(requestScope, pin);
	return pin;
};

export const readPinnedCorePublicationItems = async (
	context: GraphQLContext,
	requiredItemNames: readonly string[]
): Promise<DataPublication | null> => {
	const requestScope = context.requestScope ?? context;
	let pin = corePublicationPinMemo.get(requestScope);
	if (!pin) {
		const scope = {
			dataset: "fpl:core" as const,
			seasonCode: context.currentSeason.seasonCode,
		};
		const read = readDataPublicationItemsObserved(context.redis, scope, requiredItemNames);
		const publication = read.then((value) => value.publication);
		pin = {
			manifest: read.then(
				(value) => value.observedManifest ?? readDataPublicationManifest(context.redis, scope)
			),
		};
		corePublicationPinMemo.set(requestScope, pin);
		return publication;
	}
	if (pin.publication) {
		const publication = await pin.publication;
		if (publication && requiredItemNames.every((name) => Object.hasOwn(publication.items, name))) {
			return publication;
		}
	}
	const manifest = await pin.manifest;
	return manifest
		? readDataPublicationItemsAtManifest(context.redis, manifest, requiredItemNames)
		: null;
};

export type LivePublicationPin = {
	manifest: Promise<DataPublicationManifest | null>;
	publication?: Promise<DataPublication | null>;
	postgresPublication?: Promise<DataPublication | null>;
};

const livePublicationPinMemo = new WeakMap<object, Map<number, LivePublicationPin>>();

export const reserveLivePublicationPin = (
	context: GraphQLContext,
	eventId: number,
	mode: "manifest" | "publication"
): LivePublicationPin => {
	const requestScope = context.requestScope ?? context;
	let eventPins = livePublicationPinMemo.get(requestScope);
	if (!eventPins) {
		eventPins = new Map();
		livePublicationPinMemo.set(requestScope, eventPins);
	}

	const existing = eventPins.get(eventId);
	if (existing) {
		if (mode === "publication" && !existing.publication) {
			existing.publication = existing.manifest.then((manifest) =>
				manifest
					? readDataPublicationItemsAtManifest(context.redis, manifest, LIVE_PUBLICATION_ITEMS)
					: null
			);
		}
		return existing;
	}

	const scope = {
		dataset: "fpl:live" as const,
		seasonCode: context.currentSeason.seasonCode,
		eventId,
	};
	if (mode === "publication") {
		const publication = readDataPublication(context.redis, scope, LIVE_PUBLICATION_ITEMS);
		const pin: LivePublicationPin = {
			publication,
			manifest: publication.then((value) => value?.manifest ?? null),
		};
		eventPins.set(eventId, pin);
		return pin;
	}

	const pin: LivePublicationPin = {
		manifest: readDataPublicationManifest(context.redis, scope),
	};
	eventPins.set(eventId, pin);
	return pin;
};

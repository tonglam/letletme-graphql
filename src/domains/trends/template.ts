export type TrendTemplateCandidate = {
	elementId: number;
	playerName: string;
	playerPosition: number;
	teamShortName: string;
	count: number;
	percentage: number | null;
	captainCount: number | null;
	viceCaptainCount: number | null;
};

export type TrendTemplateRow = Omit<TrendTemplateCandidate, "captainCount" | "viceCaptainCount"> & {
	isCaptain: boolean;
	isViceCaptain: boolean;
};

const POSITIONS = [1, 2, 3, 4] as const;
const POSITION_QUOTAS: Record<number, number> = {
	1: 2,
	2: 5,
	3: 5,
	4: 3,
};
const STARTER_MINIMUMS: Record<number, number> = {
	1: 1,
	2: 3,
	3: 2,
	4: 1,
};

const STARTER_COUNT = 11;
const MAX_TEAM_PLAYERS = 3;

type TeamOption = {
	players: TrendTemplateCandidate[];
	positionCounts: number[];
	score: number;
};

type SquadState = {
	players: TrendTemplateCandidate[];
	positionCounts: number[];
	score: number;
};

const positionIndex = (position: number): number =>
	POSITIONS.indexOf(position as (typeof POSITIONS)[number]);

const compareCandidates = (left: TrendTemplateCandidate, right: TrendTemplateCandidate): number =>
	right.count - left.count || left.elementId - right.elementId;

const betterCandidate = (
	left: TrendTemplateCandidate,
	right: TrendTemplateCandidate
): TrendTemplateCandidate => (compareCandidates(left, right) <= 0 ? left : right);

const comparePlayerSets = (
	left: readonly TrendTemplateCandidate[],
	right: readonly TrendTemplateCandidate[]
): number => {
	const leftIds = left.map((player) => player.elementId).sort((a, b) => a - b);
	const rightIds = right.map((player) => player.elementId).sort((a, b) => a - b);
	for (let index = 0; index < Math.min(leftIds.length, rightIds.length); index += 1) {
		if (leftIds[index] !== rightIds[index]) return leftIds[index] - rightIds[index];
	}
	return leftIds.length - rightIds.length;
};

const betterPlayerSet = <T extends TeamOption | SquadState>(left: T, right: T): T =>
	left.score > right.score ||
	(left.score === right.score && comparePlayerSets(left.players, right.players) < 0)
		? left
		: right;

const normalizeRoleCount = (value: number | null): number | null =>
	value !== null && Number.isFinite(value) && value >= 0 ? value : null;

/** Enumerate at most three-player choices for one club, keyed by position quota. */
const buildTeamOptions = (players: readonly TrendTemplateCandidate[]): TeamOption[] => {
	const options = new Map<string, TeamOption>();
	const visit = (
		nextIndex: number,
		selected: TrendTemplateCandidate[],
		positionCounts: number[],
		score: number
	): void => {
		const option: TeamOption = {
			players: selected,
			positionCounts,
			score,
		};
		const key = positionCounts.join(",");
		const existing = options.get(key);
		options.set(key, existing ? betterPlayerSet(existing, option) : option);
		if (selected.length >= MAX_TEAM_PLAYERS) return;

		for (let index = nextIndex; index < players.length; index += 1) {
			const player = players[index];
			const slot = positionIndex(player.playerPosition);
			if (slot < 0 || positionCounts[slot] >= POSITION_QUOTAS[player.playerPosition]) continue;
			const nextCounts = [...positionCounts];
			nextCounts[slot] += 1;
			visit(index + 1, [...selected, player], nextCounts, score + player.count);
		}
	};

	visit(0, [], [0, 0, 0, 0], 0);
	return Array.from(options.values());
};

/**
 * Solve the 15-player squad exactly over the candidate set. Processing
 * one team at a time makes the only cross-team constraint a four-number state:
 * the exact 2/5/5/3 position quotas. No Cartesian product of player rows is
 * materialized.
 */
const buildSquad = (
	byTeam: Map<string, readonly TrendTemplateCandidate[]>
): TrendTemplateCandidate[] | null => {
	let states = new Map<string, SquadState>([
		["0,0,0,0", { players: [], positionCounts: [0, 0, 0, 0], score: 0 }],
	]);

	for (const [, teamPlayers] of Array.from(byTeam.entries()).sort(([left], [right]) =>
		left.localeCompare(right)
	)) {
		const options = buildTeamOptions(teamPlayers);
		const next = new Map<string, SquadState>();
		for (const state of states.values()) {
			for (const option of options) {
				const positionCounts = state.positionCounts.map(
					(count, index) => count + option.positionCounts[index]
				);
				if (POSITIONS.some((position, index) => positionCounts[index] > POSITION_QUOTAS[position]))
					continue;
				const selection: SquadState = {
					players: [...state.players, ...option.players],
					positionCounts,
					score: state.score + option.score,
				};
				const key = positionCounts.join(",");
				const existing = next.get(key);
				next.set(key, existing ? betterPlayerSet(existing, selection) : selection);
			}
		}
		states = next;
		if (states.size === 0) return null;
	}

	return (
		states.get(POSITIONS.map((position) => POSITION_QUOTAS[position]).join(","))?.players ?? null
	);
};

const chooseStarters = (
	squad: readonly TrendTemplateCandidate[]
): TrendTemplateCandidate[] | null => {
	const starters: TrendTemplateCandidate[] = [];
	const starterIds = new Set<number>();

	const add = (candidate: TrendTemplateCandidate | undefined): boolean => {
		if (!candidate || starterIds.has(candidate.elementId)) return false;
		starters.push(candidate);
		starterIds.add(candidate.elementId);
		return true;
	};

	const byPosition = (position: number): TrendTemplateCandidate[] =>
		squad.filter((candidate) => candidate.playerPosition === position).sort(compareCandidates);

	if (!add(byPosition(1)[0])) return null;
	for (const position of POSITIONS) {
		if (position === 1) continue;
		for (const candidate of byPosition(position).slice(0, STARTER_MINIMUMS[position])) {
			if (!add(candidate)) return null;
		}
	}

	const remaining = squad
		.filter((candidate) => candidate.playerPosition !== 1 && !starterIds.has(candidate.elementId))
		.sort(compareCandidates);
	for (const candidate of remaining) {
		if (starters.length >= STARTER_COUNT) break;
		add(candidate);
	}
	return starters.length === STARTER_COUNT ? starters : null;
};

const markCaptaincy = (
	starters: readonly TrendTemplateCandidate[]
): { captainId: number | null; viceCaptainId: number | null } => {
	const captain = starters
		.filter((candidate) => candidate.captainCount !== null)
		.sort(
			(left, right) =>
				(right.captainCount ?? 0) - (left.captainCount ?? 0) || left.elementId - right.elementId
		)[0];
	const viceCaptain = starters
		.filter(
			(candidate) =>
				candidate.elementId !== captain?.elementId && candidate.viceCaptainCount !== null
		)
		.sort(
			(left, right) =>
				(right.viceCaptainCount ?? 0) - (left.viceCaptainCount ?? 0) ||
				left.elementId - right.elementId
		)[0];
	return {
		captainId: captain?.elementId ?? null,
		viceCaptainId: viceCaptain?.elementId ?? null,
	};
};

export const buildTrendTemplate = (
	candidates: readonly TrendTemplateCandidate[]
): TrendTemplateRow[] | null => {
	const unique = new Map<number, TrendTemplateCandidate>();
	for (const candidate of candidates) {
		if (
			!Number.isSafeInteger(candidate.elementId) ||
			candidate.elementId < 1 ||
			positionIndex(candidate.playerPosition) < 0 ||
			!candidate.teamShortName.trim() ||
			!Number.isFinite(candidate.count) ||
			candidate.count < 0
		)
			continue;
		const normalized = {
			...candidate,
			captainCount: normalizeRoleCount(candidate.captainCount),
			viceCaptainCount: normalizeRoleCount(candidate.viceCaptainCount),
		};
		const existing = unique.get(candidate.elementId);
		unique.set(candidate.elementId, existing ? betterCandidate(existing, normalized) : normalized);
	}

	const byPosition = new Map<number, TrendTemplateCandidate[]>();
	for (const position of POSITIONS) {
		const positionCandidates = Array.from(unique.values())
			.filter((candidate) => candidate.playerPosition === position)
			.sort(compareCandidates);
		if (positionCandidates.length < POSITION_QUOTAS[position]) return null;
		byPosition.set(position, positionCandidates);
	}

	const byTeam = new Map<string, TrendTemplateCandidate[]>();
	for (const candidate of Array.from(byPosition.values()).flat()) {
		const team = byTeam.get(candidate.teamShortName) ?? [];
		team.push(candidate);
		byTeam.set(candidate.teamShortName, team);
	}
	const squad = buildSquad(byTeam);
	if (!squad || squad.length !== 15) return null;
	const starters = chooseStarters(squad);
	if (!starters) return null;
	const starterIds = new Set(starters.map((player) => player.elementId));
	const bench = squad
		.filter((player) => !starterIds.has(player.elementId))
		.sort(
			(left, right) => left.playerPosition - right.playerPosition || compareCandidates(left, right)
		);
	if (bench.length !== 4) return null;

	const { captainId, viceCaptainId } = markCaptaincy(starters);
	return [...starters, ...bench].map(
		({ captainCount: _captainCount, viceCaptainCount: _viceCaptainCount, ...player }) => ({
			...player,
			isCaptain: player.elementId === captainId,
			isViceCaptain: player.elementId === viceCaptainId,
		})
	);
};

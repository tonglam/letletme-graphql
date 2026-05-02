export type Player = {
	id: number;
	code: number;
	webName: string;
	firstName: string | null;
	secondName: string | null;
	teamId: number;
	position: number;
	price: number;
	startPrice: number;
	totalPoints: number;
	selectedByPercent: number | null;
};

export type Team = {
	id: number;
	code: number;
	name: string;
	shortName: string;
	strength: number;
	position: number;
	points: number;
	played: number;
	win: number;
	draw: number;
	loss: number;
	form: string | null;
	strengthOverallHome: number;
	strengthOverallAway: number;
	strengthAttackHome: number;
	strengthAttackAway: number;
	strengthDefenceHome: number;
	strengthDefenceAway: number;
};

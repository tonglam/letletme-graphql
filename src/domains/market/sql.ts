export const MARKET_SNAPSHOT_PIN_EXISTS_SQL = `SELECT EXISTS (
	SELECT 1
	FROM fpl.player_market_snapshots
	WHERE season_id = $1
	  AND snapshot_date = $2::date
	  AND captured_at = $3::timestamptz
) AS present`;

import { Pool } from 'pg';
import { env } from '../../infra/env';

const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });

interface WechatResponse {
  openid?: string;
  session_key?: string;
  errcode?: number;
  errmsg?: string;
}

type UserRow = { id: string; email: string | null; fpl_entry_id: number | null };

export async function identifyWechatUser(
  code: string,
  fplEntryId?: number | null
): Promise<string> {
  const url =
    `https://api.weixin.qq.com/sns/jscode2session` +
    `?appid=${env.WECHAT_APPID}&secret=${env.WECHAT_APPSECRET}` +
    `&js_code=${code}&grant_type=authorization_code`;
  const res = await fetch(url);
  const data = (await res.json()) as WechatResponse;
  if (!data.openid) throw new Error(`WeChat auth failed: ${data.errmsg ?? 'unknown'}`);
  const openid = data.openid;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check if this openid already has a row in bauth.user
    const existing = await client.query<UserRow>(
      `SELECT id, email, fpl_entry_id FROM bauth."user" WHERE openid = $1 LIMIT 1`,
      [openid]
    );

    if (existing.rows[0]) {
      const row = existing.rows[0];

      if (row.email !== null) {
        // Already a real website user — update fpl_entry_id if provided and not yet set
        if (fplEntryId != null) {
          await client.query(
            `UPDATE bauth."user" SET fpl_entry_id = COALESCE(fpl_entry_id, $1), updated_at = NOW() WHERE id = $2`,
            [fplEntryId, row.id]
          );
        }
        // Spread openid to all other website users sharing the same team who don't have it yet
        const effectiveTeamId = fplEntryId ?? row.fpl_entry_id;
        if (effectiveTeamId != null) {
          await client.query(
            `UPDATE bauth."user" SET openid = $1, updated_at = NOW()
             WHERE fpl_entry_id = $2 AND email IS NOT NULL AND (openid IS NULL OR openid = '') AND id != $3`,
            [openid, effectiveTeamId, row.id]
          );
        }
      } else {
        // Miniprogram-only row from a previous call
        if (fplEntryId != null) {
          // Bulk-update ALL website users with this team
          const result = await client.query(
            `UPDATE bauth."user" SET openid = $1, updated_at = NOW()
             WHERE fpl_entry_id = $2 AND email IS NOT NULL AND (openid IS NULL OR openid = '')`,
            [openid, fplEntryId]
          );
          if ((result.rowCount ?? 0) > 0) {
            // Linked to website users — delete the now-redundant miniprogram-only row
            await client.query(`DELETE FROM bauth."user" WHERE id = $1`, [row.id]);
          } else {
            // No website users found — just update fpl_entry_id on existing miniprogram row
            await client.query(
              `UPDATE bauth."user" SET fpl_entry_id = $1, updated_at = NOW() WHERE id = $2`,
              [fplEntryId, row.id]
            );
          }
        }
        // If no fplEntryId: row already exists, nothing to do
      }
    } else {
      // No row for this openid yet
      if (fplEntryId != null) {
        // Bulk-update ALL website users with this team
        const result = await client.query(
          `UPDATE bauth."user" SET openid = $1, updated_at = NOW()
           WHERE fpl_entry_id = $2 AND email IS NOT NULL AND (openid IS NULL OR openid = '')`,
          [openid, fplEntryId]
        );
        if ((result.rowCount ?? 0) === 0) {
          // No website users found — create miniprogram-only row
          await client.query(
            `INSERT INTO bauth."user" (id, openid, fpl_entry_id, email_verified, created_at, updated_at)
             VALUES ($1, $2, $3, false, NOW(), NOW())`,
            [crypto.randomUUID(), openid, fplEntryId]
          );
        }
      } else {
        // No fplEntryId — create miniprogram-only row with openid only
        await client.query(
          `INSERT INTO bauth."user" (id, openid, email_verified, created_at, updated_at)
           VALUES ($1, $2, false, NOW(), NOW())`,
          [crypto.randomUUID(), openid]
        );
      }
    }

    await client.query('COMMIT');
    return openid;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function bindFplEntry(userId: string, fplEntryId: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE bauth."user"
       SET fpl_entry_id = $1, fpl_entry_bound_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [fplEntryId, userId]
    );

    // If a miniprogram-only user already claimed this team, merge their openid in and delete their row
    const mpUser = await client.query<{ id: string; openid: string }>(
      `SELECT id, openid FROM bauth."user"
       WHERE fpl_entry_id = $1 AND email IS NULL AND openid IS NOT NULL AND openid != ''
       LIMIT 1`,
      [fplEntryId]
    );
    if (mpUser.rows[0]) {
      await client.query(`DELETE FROM bauth."user" WHERE id = $1`, [mpUser.rows[0].id]);
      await client.query(
        `UPDATE bauth."user" SET openid = $1, updated_at = NOW() WHERE id = $2 AND openid IS NULL`,
        [mpUser.rows[0].openid, userId]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

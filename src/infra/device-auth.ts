import { Pool } from 'pg';
import { env } from './env';
import type { AuthUser } from './auth';

// Separate pool for device authentication
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
});

interface DeviceInfo {
  name?: string;
  os?: string;
}

interface DeviceAuthResult {
  token: string;
  userId: string;
  isAnonymous: boolean;
}

/**
 * Authenticate a device and return a session token
 * Creates anonymous user if device is new
 */
export async function authenticateDevice(
  deviceId: string,
  deviceInfo?: DeviceInfo
): Promise<DeviceAuthResult> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Check if device already has a user
    const existingUser = await client.query(
      'SELECT id, "isAnonymous" FROM "user" WHERE "deviceId" = $1',
      [deviceId]
    );
    
    let userId: string;
    let isAnonymous: boolean;
    
    if (existingUser.rows.length > 0) {
      // Existing device - return existing user
      userId = existingUser.rows[0].id;
      isAnonymous = existingUser.rows[0].isAnonymous ?? false;
    } else {
      // New device - create anonymous user
      userId = crypto.randomUUID();
      
      await client.query(
        `INSERT INTO "user" (id, "deviceId", "isAnonymous", "createdAt", "updatedAt")
         VALUES ($1, $2, true, NOW(), NOW())`,
        [userId, deviceId]
      );
      
      isAnonymous = true;
    }
    
    // Generate new token
    const token = crypto.randomUUID();
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1); // 1 year for mobile
    
    // Upsert device session
    await client.query(
      `INSERT INTO device_sessions 
       (id, user_id, device_id, device_name, device_os, token, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (device_id) DO UPDATE SET
         token = EXCLUDED.token,
         last_active = NOW(),
         expires_at = EXCLUDED.expires_at,
         device_name = COALESCE(EXCLUDED.device_name, device_sessions.device_name),
         device_os = COALESCE(EXCLUDED.device_os, device_sessions.device_os)`,
      [
        crypto.randomUUID(),
        userId,
        deviceId,
        deviceInfo?.name ?? null,
        deviceInfo?.os ?? null,
        token,
        expiresAt,
      ]
    );
    
    await client.query('COMMIT');
    
    return { token, userId, isAnonymous };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Validate a device token and return user info
 */
export async function validateDeviceToken(
  token: string
): Promise<AuthUser | null> {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `SELECT 
         ds.user_id, 
         ds.device_id, 
         u.email,
         u.name,
         u."emailVerified",
         u.image,
         u."isAnonymous"
       FROM device_sessions ds
       JOIN "user" u ON ds.user_id = u.id
       WHERE ds.token = $1 AND ds.expires_at > NOW()`,
      [token]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0];
    
    // Update last active timestamp (fire and forget)
    client
      .query('UPDATE device_sessions SET last_active = NOW() WHERE token = $1', [token])
      .catch(console.error);
    
    return {
      id: row.user_id,
      email: row.email,
      name: row.name,
      emailVerified: row.emailVerified ?? false,
      image: row.image,
      isAnonymous: row.isAnonymous ?? false,
      deviceId: row.device_id,
    };
  } finally {
    client.release();
  }
}

/**
 * Link an anonymous device user to an email/OAuth account
 */
export async function linkDeviceToAccount(
  deviceId: string,
  email: string
): Promise<void> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Get the anonymous user
    const deviceUser = await client.query(
      'SELECT id FROM "user" WHERE "deviceId" = $1 AND "isAnonymous" = true',
      [deviceId]
    );
    
    if (deviceUser.rows.length === 0) {
      throw new Error('Device user not found or already linked');
    }
    
    const userId = deviceUser.rows[0].id;
    
    // Update user to link with email
    await client.query(
      `UPDATE "user" 
       SET email = $1, "isAnonymous" = false, "linkedAt" = NOW(), "updatedAt" = NOW()
       WHERE id = $2`,
      [email, userId]
    );
    
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Revoke a device session
 */
export async function revokeDeviceToken(token: string): Promise<void> {
  const client = await pool.connect();
  
  try {
    await client.query('DELETE FROM device_sessions WHERE token = $1', [token]);
  } finally {
    client.release();
  }
}

/**
 * Get all device sessions for a user
 */
export async function getUserDevices(userId: string): Promise<
  Array<{
    id: string;
    deviceId: string;
    deviceName: string | null;
    deviceOs: string | null;
    lastActive: Date;
    createdAt: Date;
  }>
> {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `SELECT id, device_id, device_name, device_os, last_active, created_at
       FROM device_sessions
       WHERE user_id = $1 AND expires_at > NOW()
       ORDER BY last_active DESC`,
      [userId]
    );
    
    return result.rows.map((row) => ({
      id: row.id,
      deviceId: row.device_id,
      deviceName: row.device_name,
      deviceOs: row.device_os,
      lastActive: row.last_active,
      createdAt: row.created_at,
    }));
  } finally {
    client.release();
  }
}

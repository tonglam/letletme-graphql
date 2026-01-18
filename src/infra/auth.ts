import { betterAuth } from 'better-auth';
import { Pool } from 'pg';
import { env } from './env';

// PostgreSQL connection pool for Better Auth
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Better Auth instance configuration
export const auth = betterAuth({
  database: {
    provider: 'postgres',
    pool,
  },
  
  // Email and password authentication
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    requireEmailVerification: false, // Enable later if needed
  },
  
  // OAuth providers
  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      enabled: !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET,
    },
    apple: {
      clientId: env.APPLE_CLIENT_ID,
      clientSecret: env.APPLE_CLIENT_SECRET,
      enabled: !!env.APPLE_CLIENT_ID && !!env.APPLE_CLIENT_SECRET,
    },
  },
  
  // Session configuration
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // 5 minutes
    },
  },
  
  // Advanced settings
  advanced: {
    generateId: () => {
      // Use crypto.randomUUID for secure ID generation
      return crypto.randomUUID();
    },
  },
});

// Type for authenticated user
export interface AuthUser {
  id: string;
  email: string | null;
  name: string | null;
  emailVerified: boolean;
  image?: string | null;
  isAnonymous?: boolean;
  deviceId?: string | null;
}

// Helper to validate and extract user from Better Auth session
export async function getUserFromSession(
  headers: Headers
): Promise<AuthUser | null> {
  try {
    const session = await auth.api.getSession({ headers });
    
    if (!session?.user) {
      return null;
    }
    
    return {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      emailVerified: session.user.emailVerified,
      image: session.user.image,
      isAnonymous: false,
    };
  } catch (error) {
    console.error('Failed to get user from session:', error);
    return null;
  }
}

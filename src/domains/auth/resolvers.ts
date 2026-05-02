import type { GraphQLContext } from "../../graphql/context";
import type { AuthUser } from "../../infra/auth";
import { getUserDevices, revokeDeviceToken } from "../../infra/device-auth";

type DeviceSessionPayload = {
	id: string;
	deviceId: string;
	deviceName: string | null;
	deviceOs: string | null;
	lastActive: string;
	createdAt: string;
};

export const authResolvers = {
	Query: {
		// Get current authenticated user
		me: (
			_parent: unknown,
			_args: unknown,
			context: GraphQLContext,
		): AuthUser | null => context.user ?? null,

		// Get all device sessions for current user
		myDevices: async (
			_parent: unknown,
			_args: unknown,
			context: GraphQLContext,
		): Promise<DeviceSessionPayload[]> => {
			if (!context.user) {
				throw new Error("Authentication required");
			}

			const devices = await getUserDevices(context.user.id);

			return devices.map((device) => ({
				id: device.id,
				deviceId: device.deviceId,
				deviceName: device.deviceName,
				deviceOs: device.deviceOs,
				lastActive: device.lastActive.toISOString(),
				createdAt: device.createdAt.toISOString(),
			}));
		},
	},

	Mutation: {
		// Revoke a device session
		revokeDevice: async (
			_parent: unknown,
			args: { deviceId: string },
			context: GraphQLContext,
		): Promise<boolean> => {
			if (!context.user) {
				throw new Error("Authentication required");
			}

			// Get user's devices to verify ownership
			const devices = await getUserDevices(context.user.id);
			const device = devices.find((d) => d.deviceId === args.deviceId);

			if (!device) {
				throw new Error("Device not found or not owned by user");
			}

			// Find the token for this device (we need a way to get token from device_id)
			// For now, we'll need to query it separately
			const { Pool } = await import("pg");
			const { env } = await import("../../infra/env");

			const pool = new Pool({ connectionString: env.DATABASE_URL });
			const client = await pool.connect();

			try {
				type DeviceTokenRow = { token: string };
				const result = await client.query<DeviceTokenRow>(
					"SELECT token FROM device_sessions WHERE device_id = $1",
					[args.deviceId],
				);

				const row = result.rows[0];
				if (row) {
					await revokeDeviceToken(row.token);
				}

				return true;
			} finally {
				client.release();
				await pool.end();
			}
		},
	},
};

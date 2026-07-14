import type { GraphQLContext } from "../../graphql/context";
import { dbPool } from "../../infra/db-pool";
import type { AuthUser } from "../../infra/auth";
import { getUserDevices } from "../../infra/device-auth";

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
		me: (
			_parent: unknown,
			_args: unknown,
			context: GraphQLContext,
		): AuthUser | null => context.user ?? null,

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
		revokeDevice: async (
			_parent: unknown,
			args: { deviceId: string },
			context: GraphQLContext,
		): Promise<boolean> => {
			if (!context.user) {
				throw new Error("Authentication required");
			}

			const result = await dbPool.query(
				`DELETE FROM device_sessions
         WHERE device_id = $1 AND user_id = $2`,
				[args.deviceId, context.user.id],
			);

			if ((result.rowCount ?? 0) === 0) {
				throw new Error("Device not found or not owned by user");
			}

			return true;
		},
	},
};

import { startServer } from "./bootstrap";
import { logger } from "./infra/logger";

startServer().catch((error: unknown) => {
	logger.error({ err: error }, "Failed to start server");
	process.exit(1);
});

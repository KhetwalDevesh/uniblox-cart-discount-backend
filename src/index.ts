import { createApp } from "./app";
import { loadConfig } from "./config/env";
import { createContainer } from "./container";
import { pool } from "./db";
import { log } from "./lib/logger";

const config = loadConfig();
const app = createApp(createContainer(config)).listen(config.port);

log.info(`API running at http://localhost:${app.server?.port}`);
log.info(`Swagger UI at http://localhost:${app.server?.port}/swagger`);

const shutdown = async (signal: string) => {
	log.info(`${signal} received. Shutting down gracefully...`);
	await app.stop();
	await pool.end();
	process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

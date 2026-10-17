import { createPinoLogger } from "@bogeychan/elysia-logger";

export const log = createPinoLogger({
	level: process.env.LOG_LEVEL || "info",
	transport:
		process.env.NODE_ENV !== "production"
			? {
					target: "pino-pretty",
					options: { colorize: true },
				}
			: undefined,
});

export type Config = {
	port: number;
	databaseUrl: string;
	/** n: every n-th successfully placed order makes one coupon available. */
	couponEveryNOrders: number;
	/** x: percentage discount of each generated coupon. */
	couponDiscountPercent: number;
};

export class ConfigError extends Error {
	constructor(readonly problems: string[]) {
		super(`Invalid configuration:\n - ${problems.join("\n - ")}`);
		this.name = "ConfigError";
	}
}

type Env = Record<string, string | undefined>;

function readInt(
	env: Env,
	key: string,
	problems: string[],
	rules: { min: number; max: number; fallback?: number },
): number {
	const raw = env[key];
	if (raw === undefined || raw === "") {
		if (rules.fallback !== undefined) return rules.fallback;
		problems.push(`${key} is required`);
		return 0;
	}
	const value = Number(raw);
	if (!Number.isInteger(value) || value < rules.min || value > rules.max) {
		problems.push(`${key} must be an integer between ${rules.min} and ${rules.max}, got "${raw}"`);
		return 0;
	}
	return value;
}

/** Parses and validates configuration once at boot, reporting every problem together. */
export function loadConfig(env: Env = process.env): Config {
	const problems: string[] = [];

	const databaseUrl = env.DATABASE_URL;
	if (!databaseUrl) problems.push("DATABASE_URL is required");

	const config: Config = {
		port: readInt(env, "PORT", problems, { min: 1, max: 65535, fallback: 4000 }),
		databaseUrl: databaseUrl ?? "",
		couponEveryNOrders: readInt(env, "COUPON_EVERY_N_ORDERS", problems, {
			min: 1,
			max: 1_000_000,
		}),
		couponDiscountPercent: readInt(env, "COUPON_DISCOUNT_PERCENT", problems, { min: 1, max: 100 }),
	};

	if (problems.length > 0) throw new ConfigError(problems);
	return config;
}

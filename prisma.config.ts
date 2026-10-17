import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "prisma/config";

if (existsSync(".env")) {
	const envContent = readFileSync(".env", "utf-8");
	for (const line of envContent.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIndex = trimmed.indexOf("=");
		if (eqIndex === -1) continue;
		const key = trimmed.slice(0, eqIndex).trim();
		let value = trimmed.slice(eqIndex + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (!process.env[key]) {
			process.env[key] = value;
		}
	}
}

export default defineConfig({
	schema: "prisma/schema.prisma",
	datasource: {
		url: process.env.DATABASE_URL!,
	},
});

/**
 * Applies migrations to the TEST database. Bun loads .env for this script, so no shell setup is
 * needed. Also run automatically by tests/setup.ts, so `bun test` works on a fresh database.
 */
const url = process.env.TEST_DATABASE_URL;

if (!url) {
	console.error("TEST_DATABASE_URL is not set. Copy .env.example to .env.");
	process.exit(1);
}
if (!/_test(\?|$)/.test(url)) {
	console.error("Refusing to migrate: TEST_DATABASE_URL must point at a *_test database.");
	process.exit(1);
}

const result = Bun.spawnSync(["bunx", "prisma", "migrate", "deploy"], {
	env: { ...process.env, DATABASE_URL: url },
	stdout: "inherit",
	stderr: "inherit",
});
process.exit(result.exitCode);

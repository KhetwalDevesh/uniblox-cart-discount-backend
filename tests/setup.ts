// Runs before every test file. Points the app at the test database and refuses to run
// against anything else, because tests truncate tables.
const testUrl = process.env.TEST_DATABASE_URL;

if (!testUrl) {
	throw new Error("TEST_DATABASE_URL is not set. Copy .env.example to .env.");
}
if (!/_test(\?|$)/.test(testUrl)) {
	throw new Error(`Refusing to run tests: TEST_DATABASE_URL must point at a *_test database.`);
}

process.env.DATABASE_URL = testUrl;

// Bring the test database up to date so `bun test` works on a fresh checkout. Takes about a second.
const migrate = Bun.spawnSync(["bun", "scripts/migrate-test.ts"], {
	stdout: "pipe",
	stderr: "pipe",
});
if (migrate.exitCode !== 0) {
	throw new Error(`Could not migrate the test database:\n${migrate.stdout}${migrate.stderr}`);
}
process.env.LOG_LEVEL = "silent";

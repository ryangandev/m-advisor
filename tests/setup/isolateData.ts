import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Preloaded into every test process (see the `test` script in package.json), so no test can open the host's real
 * `.data/bot.sqlite3`, append to its logs, touch its real temporary directory or use its credentials.
 * Each process gets a temporary folder of its own, removed when that process exits.
 * That folder is the default data directory, and TMPDIR, TMP and TEMP point at it so `os.tmpdir()` stays inside it:
 * a test's own `mkdtemp` folders, and the speech service's output folders and stale-folder sweep, never reach the host's.
 * The runner and each test file get separate folders, because the runner's environment is inherited by the files;
 * a file's folder is nested in the runner's.
 * A test that needs its own database or directory still sets `DATABASE_PATH` or `BOT_DATA_DIR` itself.
 */
const AUTO = "M_ADVISOR_TEST_AUTO_DATA_DIR";
const directory = mkdtempSync(path.join(os.tmpdir(), "m-advisor-test-data-"));
const configured = process.env.BOT_DATA_DIR?.trim();
if (!configured || configured === process.env[AUTO]) process.env.BOT_DATA_DIR = directory;
process.env[AUTO] = directory;
for (const name of ["TMPDIR", "TMP", "TEMP"]) process.env[name] = directory;
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));

delete process.env.DATABASE_PATH;
// Never inherited from the host's shell: a test that needs one sets it, and none may reach the real Discord or Riot with it.
for (const name of ["DISCORD_TOKEN", "CLIENT_ID", "RIOT_API_KEY", "RIOT_MODE"]) delete process.env[name];

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Preloaded into every test process (see the `test` script in package.json), so no test can open the host's real
 * `.data/bot.sqlite3` or append to its logs: anything that falls back to the default data directory lands in a fresh
 * temporary directory of its own process instead, removed when that process exits.
 * The runner and each test file get separate directories, because the runner's environment is inherited by the files.
 * A test that needs its own database or directory still sets `DATABASE_PATH` or `BOT_DATA_DIR` itself.
 */
const AUTO = "M_ADVISOR_TEST_AUTO_DATA_DIR";
const configured = process.env.BOT_DATA_DIR?.trim();
if (!configured || configured === process.env[AUTO]) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "m-advisor-test-data-"));
  process.env.BOT_DATA_DIR = directory;
  process.env[AUTO] = directory;
  process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
}
delete process.env.DATABASE_PATH;
// Never inherited from the host's shell: a test that needs one sets it, and none may reach the real Discord or Riot with it.
for (const name of ["DISCORD_TOKEN", "CLIENT_ID", "RIOT_API_KEY", "RIOT_MODE"]) delete process.env[name];

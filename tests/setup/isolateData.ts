import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Preloaded into every test process (see the `test` script in package.json), so no test can open the host's real
 * `.data/bot.sqlite3`, append to its logs, touch its real temporary directory or use its credentials.
 * Each process gets a temporary folder of its own, `m-advisor-test-data-<pid>-<6 random chars>`, removed when that process exits.
 * That folder is the default data directory, and TMPDIR, TMP and TEMP point at it so `os.tmpdir()` stays inside it:
 * a test's own `mkdtemp` folders, and the speech service's output folders and stale-folder sweep, never reach the host's.
 * Each test file runs in its own process, so it gets its own folder; a child that inherits the variables of a process
 * that already ran this preload gets a fresh folder too, instead of sharing (and later deleting) its parent's.
 * A test that needs its own database or directory still sets `DATABASE_PATH` or `BOT_DATA_DIR` itself.
 */
const AUTO = "M_ADVISOR_TEST_AUTO_DATA_DIR";
const PREFIX = "m-advisor-test-data-";
const NAME = new RegExp(`^${PREFIX}(\\d+)-[A-Za-z0-9]{6}$`);

function processIsRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Removes folders an interrupted run left behind, because `exit` handlers do not run on SIGINT or SIGTERM.
 * Same rules as the speech sweep in src/services/localTts.ts: the exact name pattern, real directories only (never
 * symlinks), owned by this user, and never one whose recorded process is still running (EPERM counts as running).
 */
function sweepStaleFolders(root: string, keep: string): void {
  let names: string[];
  try { names = readdirSync(root); } catch { return; }
  const uid = process.getuid?.();
  for (const name of names) {
    const match = NAME.exec(name);
    if (!match) continue;
    const target = path.join(root, name);
    try {
      if (path.resolve(target) === path.resolve(keep)) continue;
      const info = lstatSync(target);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      if (uid !== undefined && info.uid !== uid) continue;
      if (Number(match[1]) === process.pid || processIsRunning(Number(match[1]))) continue;
      rmSync(target, { recursive: true, force: true });
    } catch { /* best effort: one unreadable entry never blocks the run */ }
  }
}

const root = os.tmpdir();
const directory = mkdtempSync(path.join(root, `${PREFIX}${process.pid}-`));
sweepStaleFolders(root, directory);
const configured = process.env.BOT_DATA_DIR?.trim();
if (!configured || configured === process.env[AUTO]) process.env.BOT_DATA_DIR = directory;
process.env[AUTO] = directory;
for (const name of ["TMPDIR", "TMP", "TEMP"]) process.env[name] = directory;
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));

delete process.env.DATABASE_PATH;
// Never inherited from the host's shell: a test that needs one sets it, and none may reach the real Discord or Riot with it.
for (const name of ["DISCORD_TOKEN", "CLIENT_ID", "RIOT_API_KEY", "RIOT_MODE"]) delete process.env[name];

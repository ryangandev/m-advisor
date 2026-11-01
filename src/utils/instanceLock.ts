import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const LOCK_FILE = "bot.lock.sqlite3";

/** The same directory the bot's database and logs use. */
export function getInstanceLockDirectory(): string {
  return path.resolve(process.env.BOT_DATA_DIR?.trim() || ".data");
}

/** Another process, or another holder in this one, already has the lock for this data directory. */
export class InstanceLockHeldError extends Error {
  readonly directory: string;
  constructor(directory: string) {
    super(`Another M-Advisor process already holds the lock in ${directory}.`);
    this.name = "InstanceLockHeldError";
    this.directory = directory;
  }
}

export interface InstanceLock {
  readonly directory: string;
  /** Idempotent. Dying without calling it releases the lock too, because the operating system drops it with the process. */
  release(): void;
}

/**
 * Takes the exclusive process lock of a data directory, or throws `InstanceLockHeldError` at once without waiting.
 * The lock is an exclusive SQLite transaction held open on a file of its own, so the operating system releases it when the
 * process ends however it ends (a crash or SIGKILL never leaves a stale lock, and there is no pid file to clean up).
 * The file stays empty and is never the bot's database.
 */
export function acquireInstanceLock(directory: string = getInstanceLockDirectory()): InstanceLock {
  const resolved = path.resolve(directory);
  mkdirSync(resolved, { recursive: true });
  // timeout 0: a second holder must fail immediately instead of waiting out SQLite's default busy timeout.
  const connection = new Database(path.join(resolved, LOCK_FILE), { timeout: 0 });
  try {
    connection.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    connection.close();
    if ((error as { code?: string }).code === "SQLITE_BUSY") throw new InstanceLockHeldError(resolved);
    throw error;
  }
  let held = true;
  return {
    directory: resolved,
    release() {
      if (!held) return;
      held = false;
      connection.close();
    },
  };
}

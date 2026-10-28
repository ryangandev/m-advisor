import type { TestContext } from "node:test";

export interface CapturedConsole {
  /** Every console.log and console.error call so far, in order, as one string per call. */
  lines: string[];
}

/**
 * Stops console.log and console.error from printing for the rest of the test and collects what they were given,
 * so the bot's own log lines cannot land among the test reporter output.
 * The console is restored when the test ends, whether it passed or failed.
 */
export function captureConsole(t: Pick<TestContext, "after">): CapturedConsole {
  const saved = { log: console.log, error: console.error };
  const captured: CapturedConsole = { lines: [] };
  const record = (...args: unknown[]) => { captured.lines.push(args.map(String).join(" ")); };
  console.log = record;
  console.error = record;
  t.after(() => {
    console.log = saved.log;
    console.error = saved.error;
  });
  return captured;
}

/** Matches the line the database logs after it copies a file to `<name>.v<version>.bak` before upgrading it. */
export function backupLine(version: number, filePath: string): RegExp {
  const escaped = `${filePath}.v${version}.bak`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\[\\d\\d:\\d\\d:\\d\\d\\] Backed up the version ${version} database to ${escaped} before upgrading it\\.$`);
}

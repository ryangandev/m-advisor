import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { acquireInstanceLock, getInstanceLockDirectory, InstanceLockHeldError } from "../src/utils/instanceLock";

const root = path.resolve(__dirname, "..");
const directories: string[] = [];
const children: ChildProcess[] = [];
function makeDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "instance-lock-test-"));
  directories.push(directory);
  return directory;
}
after(() => {
  for (const child of children) child.kill("SIGKILL");
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

/** A separate process that takes the lock, prints "locked" (or "held") and, when it got it, stays alive until stdin closes. */
async function startHolder(directory: string): Promise<{ child: ChildProcess; outcome: string }> {
  const code = String.raw`
const { acquireInstanceLock, InstanceLockHeldError } = require(${JSON.stringify(path.join(root, "src/utils/instanceLock.ts"))});
try {
  const lock = acquireInstanceLock(${JSON.stringify(directory)});
  console.log("locked");
  process.stdin.on("end", () => { lock.release(); process.exit(0); });
  process.stdin.resume();
} catch (error) {
  console.log(error instanceof InstanceLockHeldError ? "held" : "error: " + error.message);
}
`;
  const child = spawn(process.execPath, ["--import", "tsx", "-e", code], { cwd: root, stdio: ["pipe", "pipe", "inherit"] });
  children.push(child);
  child.stdout!.setEncoding("utf8");
  const [chunk] = await Promise.race([
    once(child.stdout!, "data") as Promise<[string]>,
    once(child, "exit").then(() => [""] as [string]),
  ]);
  return { child, outcome: chunk.trim() };
}

test("a second holder in this process fails at once, and the lock can be taken again after release", () => {
  const directory = makeDirectory();
  const first = acquireInstanceLock(directory);
  const started = performance.now();
  assert.throws(() => acquireInstanceLock(directory), InstanceLockHeldError);
  assert.ok(performance.now() - started < 1_000, "must not wait out a busy timeout");
  first.release();
  first.release();
  acquireInstanceLock(directory).release();
});

test("locks of different data directories are independent", () => {
  const first = acquireInstanceLock(makeDirectory());
  const second = acquireInstanceLock(makeDirectory());
  first.release();
  second.release();
});

test("a lock held by another process excludes this one immediately", async () => {
  const directory = makeDirectory();
  const holder = await startHolder(directory);
  assert.equal(holder.outcome, "locked");
  const started = performance.now();
  assert.throws(() => acquireInstanceLock(directory), (error: unknown) => error instanceof InstanceLockHeldError && error.directory === path.resolve(directory));
  assert.ok(performance.now() - started < 1_000, "must not wait out a busy timeout");
  const second = await startHolder(directory);
  assert.equal(second.outcome, "held", "two other processes exclude each other too");
  holder.child.stdin!.end();
  await once(holder.child, "exit");
  acquireInstanceLock(directory).release();
});

test("the lock frees when the holder is killed without releasing it", async () => {
  const directory = makeDirectory();
  const holder = await startHolder(directory);
  assert.equal(holder.outcome, "locked");
  assert.throws(() => acquireInstanceLock(directory), InstanceLockHeldError);
  holder.child.kill("SIGKILL");
  await once(holder.child, "exit");
  acquireInstanceLock(directory).release();
});

test("the lock directory follows BOT_DATA_DIR and defaults to .data", () => {
  const previous = process.env.BOT_DATA_DIR;
  try {
    process.env.BOT_DATA_DIR = "  /some/where  ";
    assert.equal(getInstanceLockDirectory(), path.resolve("/some/where"));
    delete process.env.BOT_DATA_DIR;
    assert.equal(getInstanceLockDirectory(), path.resolve(".data"));
  } finally {
    if (previous === undefined) delete process.env.BOT_DATA_DIR;
    else process.env.BOT_DATA_DIR = previous;
  }
});

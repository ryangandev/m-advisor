import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  BenchmarkArgsError, DEFAULT_MAX_AGE_DAYS, MANIFEST_FILE, isFatalSampleError, parseFlags, readSampleManifest, resolveMaxAgeDays,
  runSample, sampleExitCode, sampleMatchFiles, writeSampleManifest,
} from "../scripts/benchmarkArgs";
import { RiotApiError } from "../src/services/riotData";
import type { RiotErrorCode } from "../src/services/riotData";

const ROOT = path.join(__dirname, "..");
const SPECS = {
  out: { kind: "string" },
  days: { kind: "positiveInt" },
  tiers: { kind: "list", allowed: ["GOLD", "SILVER"] },
} as const;

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "benchmark-args-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const rejects = (argv: string[], pattern: RegExp) => assert.throws(() => parseFlags(argv, SPECS), (error) => error instanceof BenchmarkArgsError && pattern.test(error.message));

test("the parser reads --name=value flags into typed values", () => {
  const flags = parseFlags(["--out=/tmp/x", "--days=90", "--tiers=GOLD,SILVER"], SPECS);
  assert.equal(flags.get("out"), "/tmp/x");
  assert.equal(flags.get("days"), 90);
  assert.deepEqual(flags.get("tiers"), ["GOLD", "SILVER"]);
  assert.equal(parseFlags([], SPECS).size, 0);
});

test("the parser splits on the first equals sign only", () => {
  assert.equal(parseFlags(["--out=/tmp/a=b=c"], SPECS).get("out"), "/tmp/a=b=c");
});

test("the parser rejects the space form, bare words and unknown or misspelled flags", () => {
  rejects(["--days", "90"], /needs a value/);
  rejects(["--days=90", "extra"], /Unexpected argument "extra"/);
  rejects(["90"], /Unexpected argument/);
  rejects(["--max-age=90"], /Unknown flag "--max-age"/);
  rejects(["-days=90"], /Unexpected argument/);
  rejects(["--constructor=1"], /Unknown flag/);
});

test("the parser rejects empty and repeated flags", () => {
  rejects(["--out="], /needs a value/);
  rejects(["--days=1", "--days=2"], /more than once/);
});

test("numeric flags must be positive whole numbers", () => {
  for (const bad of ["0", "-5", "1.5", "90d", "forty", "1e3", " 7", "07", "0x10", "9007199254740993", "NaN", "Infinity"]) {
    rejects([`--days=${bad}`], /positive whole number/);
  }
  assert.equal(parseFlags(["--days=1"], SPECS).get("days"), 1);
});

test("list flags reject empty items and values outside the allowed set", () => {
  rejects(["--tiers=GOLD,"], /empty items/);
  rejects(["--tiers=GOLD,MASTER"], /does not accept "MASTER"/);
  rejects(["--tiers=gold"], /does not accept "gold"/);
});

test("the max age resolves from the flag, then the manifest, then the default", () => {
  assert.deepEqual(resolveMaxAgeDays(undefined, undefined), { maxAgeDays: DEFAULT_MAX_AGE_DAYS, source: "default" });
  assert.deepEqual(resolveMaxAgeDays(90, undefined), { maxAgeDays: 90, source: "flag" });
  assert.deepEqual(resolveMaxAgeDays(undefined, { maxAgeDays: 120 }), { maxAgeDays: 120, source: "manifest" });
  assert.deepEqual(resolveMaxAgeDays(120, { maxAgeDays: 120 }), { maxAgeDays: 120, source: "flag" });
});

test("a flag that differs from the sample's manifest is refused", () => {
  assert.throws(() => resolveMaxAgeDays(60, { maxAgeDays: 120 }), (error) => error instanceof BenchmarkArgsError && /60.*120/.test(error.message));
});

test("the manifest round-trips and leaves no temp file behind", () => {
  const dir = tempDir();
  assert.equal(readSampleManifest(dir), undefined);
  writeSampleManifest(dir, { maxAgeDays: 120 });
  assert.deepEqual(readSampleManifest(dir), { maxAgeDays: 120 });
  writeSampleManifest(dir, { maxAgeDays: 30 });
  assert.deepEqual(readSampleManifest(dir), { maxAgeDays: 30 });
  assert.deepEqual(readdirSync(dir), [MANIFEST_FILE]);
});

test("a damaged manifest is refused instead of silently using the default", () => {
  const dir = tempDir();
  for (const content of ["{", "null", "{}", '{"maxAgeDays":"60"}', '{"maxAgeDays":0}', '{"maxAgeDays":1.5}']) {
    writeFileSync(path.join(dir, MANIFEST_FILE), content);
    assert.throws(() => readSampleManifest(dir), BenchmarkArgsError, content);
  }
});

test("the build's file listing skips the manifest", () => {
  assert.deepEqual(sampleMatchFiles(["NA1_2.json", MANIFEST_FILE, "NA1_1.json", `${MANIFEST_FILE}.1.tmp`, "notes.txt"]), ["NA1_1.json", "NA1_2.json"]);
});

test("only a rejected key or request is fatal to the sampler", () => {
  const fatal: RiotErrorCode[] = ["unauthorized", "forbidden", "bad_request"];
  const skippable: RiotErrorCode[] = ["not_found", "rate_limited", "unavailable", "network", "timeout", "invalid_response", "missing_key"];
  for (const code of fatal) assert.equal(isFatalSampleError(new RiotApiError("x", code)), true, code);
  for (const code of skippable) assert.equal(isFatalSampleError(new RiotApiError("x", code)), false, code);
  assert.equal(isFatalSampleError(new Error("boom")), false);
});

test("the sampler fails only when it saved nothing and a player failed", () => {
  assert.equal(sampleExitCode(0, 1), 1);
  assert.equal(sampleExitCode(0, 0), 0);
  assert.equal(sampleExitCode(3, 5), 0);
});

/** A fake Riot: two players in one division; `onMatch` decides what the match lookup does. */
function fakeRiot(onMatch: (id: string) => unknown, urls: string[] = []) {
  return async <T>(url: string): Promise<T> => {
    urls.push(url);
    if (url.includes("/league/v4/entries/")) return [{ puuid: "a" }, { puuid: "b" }, {}] as T;
    if (url.includes("/by-puuid/")) return [`NA1_${url.includes("/a/") ? 1 : 2}`] as T;
    const result = onMatch(url.split("/").pop()!);
    if (result instanceof Error) throw result;
    return result as T;
  };
}
const options = (dir: string, riot: ReturnType<typeof fakeRiot>, extra: Partial<Parameters<typeof runSample>[0]> = {}) =>
  ({ riot, tiers: ["GOLD"], divisions: ["II"], perDivision: 5, maxAgeDays: 90, outDir: dir, now: 1_000_000_000, log: () => {}, ...extra });

test("the sampler saves matches, asks Riot for the requested window and records it in the manifest", async () => {
  const dir = tempDir();
  const urls: string[] = [];
  const result = await runSample(options(dir, fakeRiot((id) => ({ metadata: { matchId: id } }), urls)));
  assert.deepEqual(result, { saved: 2, skipped: 0 });
  assert.deepEqual(readdirSync(dir).sort(), [MANIFEST_FILE, "NA1_1.json", "NA1_2.json"].sort());
  assert.equal(JSON.parse(readFileSync(path.join(dir, "NA1_1.json"), "utf8"))._tier, "GOLD");
  assert.deepEqual(readSampleManifest(dir), { maxAgeDays: 90 });
  assert.ok(urls.some((url) => url.endsWith(`startTime=${1_000_000_000 - 90 * 86_400}`)), "startTime is built from the max age");
});

for (const code of ["unauthorized", "forbidden", "bad_request"] as const) {
  test(`the sampler stops on a ${code} Riot error instead of skipping the player`, async () => {
    const dir = tempDir();
    const urls: string[] = [];
    await assert.rejects(runSample(options(dir, fakeRiot(() => new RiotApiError("rejected", code), urls))), (error) => error instanceof RiotApiError && error.code === code);
    assert.equal(urls.filter((url) => url.includes("/matches/NA1_")).length, 1, "the second player is never asked");
    assert.equal(existsSync(path.join(dir, MANIFEST_FILE)), false, "a run that saved nothing leaves no manifest");
  });
}

test("the sampler fails when every player was skipped for a transient error", async () => {
  const dir = tempDir();
  const logs: string[] = [];
  await assert.rejects(
    runSample(options(dir, fakeRiot(() => new RiotApiError("slow", "timeout")), { log: (line) => logs.push(line) })),
    /Nothing was saved and 2 player\(s\) failed/);
  assert.ok(logs.some((line) => line.includes("skipped (slow)")));
  assert.equal(existsSync(path.join(dir, MANIFEST_FILE)), false);
});

test("the sampler keeps going and succeeds when some players are skipped but something was saved", async () => {
  const dir = tempDir();
  const result = await runSample(options(dir, fakeRiot((id) => id === "NA1_1" ? new RiotApiError("gone", "not_found") : { metadata: { matchId: id } })));
  assert.deepEqual(result, { saved: 1, skipped: 1 });
  assert.deepEqual(readSampleManifest(dir), { maxAgeDays: 90 });
});

test("an aborted run that already saved matches still records the window they were collected for", async () => {
  const dir = tempDir();
  await assert.rejects(runSample(options(dir, fakeRiot((id) => id === "NA1_1" ? { metadata: { matchId: id } } : new RiotApiError("key", "forbidden")))), RiotApiError);
  assert.deepEqual(readSampleManifest(dir), { maxAgeDays: 90 });
});

function runScript(script: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", path.join("scripts", script), ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, RIOT_API_KEY: "", RIOT_API_MODE: "" } });
}

test("both scripts exit 1 with one clear line on a bad flag, before any Riot call or write", () => {
  const benchmarks = path.join(ROOT, "src", "data", "roleBenchmarks.json");
  const before = statSync(benchmarks).mtimeMs;
  for (const [script, args] of [
    ["build-benchmarks.ts", ["--max-age=90"]],
    ["build-benchmarks.ts", ["--max-age-days", "90"]],
    ["build-benchmarks.ts", ["--max-age-days=90d"]],
    ["sample-matches.ts", ["--per-division=forty"]],
    ["sample-matches.ts", ["--out"]],
  ] as const) {
    const result = runScript(script, [...args]);
    assert.equal(result.status, 1, `${script} ${args.join(" ")}`);
    assert.match(result.stderr, /^error: /, `${script} ${args.join(" ")}`);
    assert.doesNotMatch(result.stderr, /\n\s+at /, "no stack trace");
  }
  assert.equal(statSync(benchmarks).mtimeMs, before);
});

test("the build refuses a --max-age-days that differs from the sample's manifest", () => {
  const dir = tempDir();
  writeSampleManifest(dir, { maxAgeDays: 120 });
  const result = runScript("build-benchmarks.ts", [`--sample=${dir}`, "--max-age-days=60"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /differs from the 120 days/);
});

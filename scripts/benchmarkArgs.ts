// Shared by scripts/sample-matches.ts and scripts/build-benchmarks.ts so both read their flags the same strict way
// and the build keeps the age window the sample was collected with. Nothing here calls Riot.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RiotApiError } from "../src/services/riotData";

/** The window both scripts use when neither a flag nor a sample manifest says otherwise. */
export const DEFAULT_MAX_AGE_DAYS = 60;
/** The sampler writes this next to the matches; the build skips it when it lists the sample. */
export const MANIFEST_FILE = "sample-manifest.json";

export class BenchmarkArgsError extends Error {}

export type FlagSpec = { kind: "string" } | { kind: "positiveInt" } | { kind: "list"; allowed: readonly string[] };
export type FlagSpecs = Record<string, FlagSpec>;
export type FlagValue = string | number | string[];

const POSITIVE_INTEGER = /^[1-9]\d*$/;

function parseValue(name: string, raw: string, spec: FlagSpec): FlagValue {
  if (spec.kind === "string") return raw;
  if (spec.kind === "positiveInt") {
    const value = Number(raw);
    if (!POSITIVE_INTEGER.test(raw) || !Number.isSafeInteger(value)) throw new BenchmarkArgsError(`--${name} must be a positive whole number, got "${raw}".`);
    return value;
  }
  const items = raw.split(",");
  if (items.some((item) => !item)) throw new BenchmarkArgsError(`--${name} must be a comma-separated list without empty items, got "${raw}".`);
  const unknown = items.find((item) => !spec.allowed.includes(item));
  if (unknown) throw new BenchmarkArgsError(`--${name} does not accept "${unknown}"; use ${spec.allowed.join(", ")}.`);
  return items;
}

/**
 * Reads `--name=value` arguments and nothing else.
 * Unknown flags, the space form (`--name value`), bare words, repeated flags and empty or malformed values throw.
 * The value is everything after the first `=`, so paths may contain `=`.
 */
export function parseFlags(argv: readonly string[], specs: FlagSpecs): Map<string, FlagValue> {
  const allowed = Object.keys(specs).map((name) => `--${name}=`).join(", ");
  const flags = new Map<string, FlagValue>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) throw new BenchmarkArgsError(`Unexpected argument "${arg}"; flags are written --name=value. Allowed: ${allowed}`);
    const equals = arg.indexOf("=");
    if (equals < 0) throw new BenchmarkArgsError(`Flag "${arg}" needs a value in the form ${arg}=value (the space form is not supported).`);
    const name = arg.slice(2, equals);
    const spec = Object.hasOwn(specs, name) ? specs[name] : undefined;
    if (!spec) throw new BenchmarkArgsError(`Unknown flag "--${name}". Allowed: ${allowed}`);
    if (flags.has(name)) throw new BenchmarkArgsError(`--${name} was given more than once.`);
    const raw = arg.slice(equals + 1);
    if (!raw) throw new BenchmarkArgsError(`--${name} needs a value.`);
    flags.set(name, parseValue(name, raw, spec));
  }
  return flags;
}

export interface SampleManifest {
  maxAgeDays: number;
}

/** Writes the manifest atomically (temp file, then rename), so a crash never leaves half a file the build would reject. */
export function writeSampleManifest(dir: string, manifest: SampleManifest): void {
  const file = path.join(dir, MANIFEST_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(manifest)}\n`);
  renameSync(temp, file);
}

/** The manifest of a sample directory, or undefined for a directory sampled before manifests existed. */
export function readSampleManifest(dir: string): SampleManifest | undefined {
  const file = path.join(dir, MANIFEST_FILE);
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new BenchmarkArgsError(`${file} is not valid JSON; delete it or sample again.`);
  }
  const maxAgeDays = (parsed as { maxAgeDays?: unknown } | null)?.maxAgeDays;
  if (typeof maxAgeDays !== "number" || !Number.isSafeInteger(maxAgeDays) || maxAgeDays < 1) {
    throw new BenchmarkArgsError(`${file} has no positive whole maxAgeDays; delete it or sample again.`);
  }
  return { maxAgeDays };
}

/**
 * The age window the build filters by.
 * An explicit flag must agree with the manifest, because the sample on disk was collected for the manifest's window.
 * Without a manifest the flag, or else the default, applies.
 */
export function resolveMaxAgeDays(flag: number | undefined, manifest: SampleManifest | undefined): { maxAgeDays: number; source: "flag" | "manifest" | "default" } {
  if (manifest && flag !== undefined && flag !== manifest.maxAgeDays) {
    throw new BenchmarkArgsError(`--max-age-days=${flag} differs from the ${manifest.maxAgeDays} days this sample was collected with (${MANIFEST_FILE}). Drop the flag, or sample again with --max-age-days=${flag}.`);
  }
  if (flag !== undefined) return { maxAgeDays: flag, source: "flag" };
  if (manifest) return { maxAgeDays: manifest.maxAgeDays, source: "manifest" };
  return { maxAgeDays: DEFAULT_MAX_AGE_DAYS, source: "default" };
}

/** The match files of a sample directory listing: every .json except the manifest. */
export function sampleMatchFiles(names: readonly string[]): string[] {
  return names.filter((name) => name.endsWith(".json") && name !== MANIFEST_FILE).sort();
}

/** A key or request problem hits every later request too, so the sampler stops instead of skipping the player. */
export function isFatalSampleError(error: unknown): boolean {
  return error instanceof RiotApiError && (error.code === "unauthorized" || error.code === "forbidden" || error.code === "bad_request");
}

/** A run that saved nothing while skipping players failed, even if every skip was a transient error. */
export function sampleExitCode(saved: number, skipped: number): 0 | 1 {
  return saved === 0 && skipped > 0 ? 1 : 0;
}

export interface SampleOptions {
  /** Fetches one Riot URL as JSON; the script paces it, tests fake it. */
  riot: <T>(url: string) => Promise<T>;
  tiers: readonly string[];
  divisions: readonly string[];
  perDivision: number;
  maxAgeDays: number;
  outDir: string;
  /** Seconds since the epoch; defaults to now. */
  now?: number;
  log?: (line: string) => void;
}

/**
 * Collects one recent ranked solo match per player into `outDir` and records the age window in the manifest.
 * A rejected key or request (unauthorized, forbidden, bad_request) aborts the run; other per-player failures are skipped.
 * Throws when nothing was saved and a player failed, so the script exits 1.
 */
export async function runSample(options: SampleOptions): Promise<{ saved: number; skipped: number }> {
  const { riot, outDir, maxAgeDays, log = console.log } = options;
  const startTime = (options.now ?? Math.floor(Date.now() / 1000)) - maxAgeDays * 86_400;
  mkdirSync(outDir, { recursive: true });
  let saved = 0;
  let skipped = 0;
  let completed = false;
  try {
    for (const tier of options.tiers) {
      for (const division of options.divisions) {
        const entries = await riot<Array<{ puuid?: string }>>(
          `https://na1.api.riotgames.com/lol/league/v4/entries/RANKED_SOLO_5x5/${tier}/${division}?page=1`);
        for (const { puuid } of entries.filter((entry) => entry.puuid).slice(0, options.perDivision)) {
          try {
            const [matchId] = await riot<string[]>(
              `https://americas.api.riotgames.com/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid!)}/ids?queue=420&count=1&startTime=${startTime}`);
            const file = path.join(outDir, `${matchId}.json`);
            if (!matchId || existsSync(file)) continue;
            const match = await riot<Record<string, unknown>>(`https://americas.api.riotgames.com/lol/match/v5/matches/${matchId}`);
            writeFileSync(file, JSON.stringify({ ...match, _tier: tier }));
            saved++;
            log(`${tier} ${division}: ${matchId} (${saved} saved)`);
          } catch (error) {
            // A rejected key or request would fail every later player the same way, so stop instead of skipping it.
            if (isFatalSampleError(error)) throw error;
            skipped++;
            log(`${tier} ${division}: skipped (${error instanceof Error ? error.message : String(error)})`);
          }
        }
      }
    }
    completed = true;
  } finally {
    // The files on disk were collected for this window, so the build must filter by it too.
    // A run that failed before saving anything leaves the earlier manifest alone.
    if (saved > 0 || (completed && skipped === 0)) writeSampleManifest(outDir, { maxAgeDays });
  }
  log(`Saved ${saved} new matches to ${outDir}.`);
  if (sampleExitCode(saved, skipped) === 1) throw new Error(`Nothing was saved and ${skipped} player(s) failed; see the skipped lines above.`);
  return { saved, skipped };
}

/** Runs a script's argument handling; a usage error prints one clear line and exits 1 instead of a stack trace. */
export function parseOrExit<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof BenchmarkArgsError)) throw error;
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}

import type { RankedEntry, RankedQueueType } from "../types";
import { classifyRankChange, entryForQueue, rankedQueueFor } from "./rankMath";
import type { RankChange } from "./rankMath";
import { RiotApiError } from "./riotData";

/** A retry of an after-read waits at least this long after the account's previous read. */
export const RANK_RETRY_FLOOR_MS = 60_000;
/** At most this many reads per account per match: the first at detection, then the retries. */
export const MAX_RANK_READS = 4;
/**
 * The tracker's own limit on one read, above the league requester's 5 second timeout, so a stuck dependency can never
 * hold the serialized queue. A read that hits it counts as a timeout.
 */
export const RANK_READ_GUARD_MS = 10_000;
/** At most this many accounts' match reads are remembered; the oldest is forgotten first. */
const MATCH_READS_LIMIT = 200;

/**
 * What a row of the 段位变化 field shows for one account in one match.
 * - `pending`: league-v4 has not caught up yet (or the first read has not run), and more reads are coming.
 * - `stale`: it had not caught up after MAX_RANK_READS reads, so nothing more is coming.
 * - `unavailable`: the read failed for another reason than a rate limit or a timeout.
 * - the rest are classifyRankChange results that show a row.
 */
export type RankRowState =
  | { kind: "pending" }
  | { kind: "stale" }
  | { kind: "unavailable" }
  | Extract<RankChange, { kind: "change" | "promoted" | "demoted" | "unattributable" | "placed" }>;

export interface RankRow {
  queueType: RankedQueueType;
  state: RankRowState;
}

/** A bound account of a finished match, with a label for log lines (its Riot ID). */
export interface RankAccount {
  puuid: string;
  label: string;
}

export interface FinishedRankedMatch {
  matchId: string;
  queueId: number;
  gameEndTimestamp: number | null;
  accounts: readonly RankAccount[];
}

/** The first sighting of a ranked game by the game start watcher. */
export interface GameStartMark {
  matchId: string;
  /** When the game was first seen; a read sent before it may hold a dodge or decay that is not part of the game. */
  since: number;
}

/** What the monitor and the game start watcher need from the tracker; tests may pass a fake. */
export interface RankTracking {
  /**
   * Reads the accounts' entries as their before-value: at the monitoring baseline and at a ranked game's start.
   * A game's start names the game and the time it was first seen, so that once the game finishes an account with no
   * successful read from that time on is not given a normal LP change from an older read.
   */
  snapshot(puuids: readonly string[], start?: GameStartMark): void;
  /**
   * Whether a read of the account that succeeded was sent at or after `since`. A game's start asks it to retry a failed
   * snapshot until there is one newer than the first sighting. Optional: a tracker without it gets one attempt per game.
   */
  hasReadSince?(puuid: string, since: number): boolean;
  /** Starts the after-reads of a finished ranked match (not a remake, not aborted). */
  matchFinished(match: FinishedRankedMatch): void;
  /** Settles once the first after-read of every account of the match has settled. Never rejects. */
  firstReads(matchId: string): Promise<void>;
  /** The row of one account in one match, or undefined when it shows no row. */
  row(matchId: string, puuid: string): RankRow | undefined;
  /** Settles once none of these accounts' rows in the match is pending any more. Never rejects. */
  settled(matchId: string, puuids: readonly string[]): Promise<void>;
}

export interface RankTrackerDependencies {
  /** The account's league-v4 entries; an unranked account has none. Throws a RiotApiError on failure. */
  readEntries: (puuid: string) => Promise<readonly RankedEntry[]>;
  mock: () => boolean;
  log: (error: unknown) => void;
  info: (message: string) => void;
  /** The clock; Date.now by default. */
  now?: () => number;
  /** RANK_RETRY_FLOOR_MS by default; monitor tests shorten it. */
  retryFloorMs?: number;
  /** RANK_READ_GUARD_MS by default. */
  readGuardMs?: number;
}

type Mode = "mock" | "real";

interface Snapshot {
  entries: readonly RankedEntry[];
  /** When the read was sent, compared with a match's end time to pick its before-value. */
  at: number;
}

/** Successful reads kept per account. */
const SNAPSHOT_HISTORY = 4;

/** One account in one data mode. Snapshots are keyed by mode, so a mock read is never a real before-value. */
interface AccountReads {
  /**
   * The latest successful reads, oldest first, at most SNAPSHOT_HISTORY. More than one is kept because the next game's
   * start can be read before the poll detects the previous game: its before-value is the newest read from before it ended.
   */
  snapshots: Snapshot[];
  /** When the latest read of any kind started: no read but a match's first after-read comes sooner than the floor after it. */
  lastReadAt?: number;
  /** A snapshot read is already queued, so another one is not. */
  snapshotQueued?: boolean;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

/** One account's after-reads for one match. */
interface MatchRead {
  matchId: string;
  puuid: string;
  label: string;
  mode: Mode;
  queueType: RankedQueueType;
  gameEndTimestamp: number | null;
  reads: number;
  /** The before-value, taken when the first after-read runs so any snapshot read queued before it counts; null when there is none. */
  before?: Snapshot | null;
  /** The game was seen at its start but no read followed that sighting, so a change is not given to the game. Set with `before`. */
  untrusted?: boolean;
  /** What the row shows once no more reads are coming; null for no row. Undefined while pending. */
  outcome?: RankRowState | null;
  firstRead: Deferred;
  settled: Deferred;
  timer?: NodeJS.Timeout;
}

type ReadOutcome = { entries: readonly RankedEntry[] } | { error: unknown };

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : "Unknown error";
const errorKey = (error: unknown): string => error instanceof RiotApiError ? `${error.code}:${error.status ?? ""}` : "other";
const isAuthError = (error: unknown) => error instanceof RiotApiError && (error.code === "unauthorized" || error.code === "forbidden");
const isRateLimit = (error: unknown) => error instanceof RiotApiError && error.code === "rate_limited";
const isTimeout = (error: unknown) => error instanceof RiotApiError && error.code === "timeout";

/**
 * Rank snapshots around ranked games, process-wide and shared by every guild, so an account bound in two servers
 * costs one read. Everything is in memory: a restart drops pending reads, and the next baseline starts over.
 * Reads are serialized one at a time. A failure never escapes: it is logged, and the row says so or shows nothing.
 */
export class RankTracker implements RankTracking {
  private readonly accounts = new Map<string, AccountReads>();
  private readonly matches = new Map<string, MatchRead>();
  /** Ranked games seen at their start, by `mode:matchId`, with the time of the first sighting. At most MATCH_READS_LIMIT. */
  private readonly gameStarts = new Map<string, number>();
  private readonly loggedErrors = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private disabled = false;
  private stopped = false;

  constructor(private readonly dependencies: RankTrackerDependencies) {}

  /** Whether Riot rejected the key for league-v4, which turns LP off until the bot restarts. */
  get isDisabled(): boolean {
    return this.disabled;
  }

  /** Whether the bot is shutting down: nothing is read any more. */
  get isStopped(): boolean {
    return this.stopped;
  }

  /**
   * At shutdown: queued reads do nothing, retry timers are cleared and every pending row settles with no row.
   * A read already sent is ignored when it answers.
   */
  stop(): void {
    this.stopped = true;
    for (const read of this.matches.values()) this.finish(read, null);
  }

  /** No read happens after a stop or once Riot rejected the key. */
  private off(): boolean {
    return this.disabled || this.stopped;
  }

  private now(): number {
    return (this.dependencies.now ?? Date.now)();
  }

  private mode(): Mode {
    return this.dependencies.mock() ? "mock" : "real";
  }

  private account(mode: Mode, puuid: string): AccountReads {
    const key = `${mode}:${puuid}`;
    let account = this.accounts.get(key);
    if (!account) {
      account = { snapshots: [] };
      this.accounts.set(key, account);
    }
    return account;
  }

  private remember(account: AccountReads, snapshot: Snapshot): void {
    account.snapshots.push(snapshot);
    if (account.snapshots.length > SNAPSHOT_HISTORY) account.snapshots.shift();
  }

  /**
   * The before-value of a match: the newest read sent at or before its end, so a read of the next game's start that
   * already holds this game's result is never compared with it. With no known end time, the newest read.
   */
  private beforeOf(account: AccountReads, gameEndTimestamp: number | null): Snapshot | null {
    const { snapshots } = account;
    if (gameEndTimestamp === null) return snapshots.at(-1) ?? null;
    for (let index = snapshots.length - 1; index >= 0; index--) if (snapshots[index].at <= gameEndTimestamp) return snapshots[index];
    return null;
  }

  /** Too soon after the account's previous read: every read but a match's first after-read waits for the floor. */
  private tooSoon(account: AccountReads): boolean {
    return account.lastReadAt !== undefined && this.now() - account.lastReadAt < this.floor();
  }

  /** In real mode a saved mock account never reaches Riot. */
  private skipped(mode: Mode, puuid: string): boolean {
    return mode === "real" && puuid.startsWith("MOCK-");
  }

  hasReadSince(puuid: string, since: number): boolean {
    // Nothing more will be read for an account that is skipped, or once LP is off, so there is nothing to wait for.
    if (this.off() || this.skipped(this.mode(), puuid)) return true;
    return this.account(this.mode(), puuid).snapshots.some((snapshot) => snapshot.at >= since);
  }

  snapshot(puuids: readonly string[], start?: GameStartMark): void {
    if (this.off()) return;
    const mode = this.mode();
    if (start) this.markStart(mode, start);
    for (const puuid of new Set(puuids)) {
      if (this.skipped(mode, puuid)) continue;
      const account = this.account(mode, puuid);
      // A hard cap of one snapshot read per floor per account, failed reads included: LP cannot move between two reads
      // less than a minute apart without a finished game, whose after-read covers it.
      if (account.snapshotQueued || this.tooSoon(account)) continue;
      account.snapshotQueued = true;
      this.enqueue(async () => {
        account.snapshotQueued = false;
        // Checked again when its turn comes: an after-read may have run while it waited.
        if (this.off() || this.tooSoon(account)) return;
        const startedAt = this.now();
        account.lastReadAt = startedAt;
        const outcome = await this.read(puuid);
        if (this.stopped) return;
        if ("entries" in outcome) {
          this.recovered();
          this.remember(account, { entries: outcome.entries, at: startedAt });
          return;
        }
        if (isAuthError(outcome.error)) {
          this.disable(outcome.error);
          return;
        }
        // A rate limit or a timeout leaves the older snapshot; the next game start or after-read reads again.
        if (isRateLimit(outcome.error) || isTimeout(outcome.error)) return;
        this.failed(outcome.error);
      });
    }
  }

  /** The earliest sighting of a game counts, so a second guild's later sighting never tightens it. */
  private markStart(mode: Mode, { matchId, since }: GameStartMark): void {
    const key = `${mode}:${matchId}`;
    const known = this.gameStarts.get(key);
    if (known !== undefined && known <= since) return;
    this.gameStarts.delete(key);
    this.gameStarts.set(key, since);
    if (this.gameStarts.size > MATCH_READS_LIMIT) this.gameStarts.delete(this.gameStarts.keys().next().value!);
  }

  /**
   * Whether the before-value of a match was read after the game was first seen at its start, and so holds no dodge or
   * decay. A game the watcher never saw (monitoring started after it) and mock data, whose entries only move when a
   * test moves them, are trusted as they are.
   */
  private trusted(read: MatchRead): boolean {
    if (read.mode === "mock") return true;
    const since = this.gameStarts.get(`${read.mode}:${read.matchId}`);
    return since === undefined || (read.before !== null && read.before !== undefined && read.before.at >= since);
  }

  /**
   * Mock mode only, for /simulate: forgets the accounts' earlier reads, reads their entries again now and settles once
   * that is done, so a mock entry that was just set is the before-value of the next simulated game. Without it a second
   * /simulate would compare the new entry with the previous game's after-read. Does nothing in real mode, where the
   * 60 second floor and the history protect the Riot rate limit.
   */
  async rebase(puuids: readonly string[]): Promise<void> {
    if (this.off() || this.mode() !== "mock") return;
    for (const puuid of new Set(puuids)) {
      const account = this.account("mock", puuid);
      account.snapshots = [];
      account.lastReadAt = undefined;
    }
    this.snapshot(puuids);
    await this.queue;
  }

  matchFinished(match: FinishedRankedMatch): void {
    if (this.off()) return;
    const queueType = rankedQueueFor(match.queueId);
    if (!queueType) return;
    const mode = this.mode();
    for (const { puuid, label } of match.accounts) {
      if (this.skipped(mode, puuid)) continue;
      const key = `${mode}:${match.matchId}:${puuid}`;
      if (this.matches.has(key)) continue;
      const read: MatchRead = {
        matchId: match.matchId, puuid, label, mode, queueType, gameEndTimestamp: match.gameEndTimestamp, reads: 0,
        firstRead: deferred(), settled: deferred(),
      };
      this.matches.set(key, read);
      if (this.matches.size > MATCH_READS_LIMIT) {
        const [oldestKey, oldest] = this.matches.entries().next().value!;
        this.matches.delete(oldestKey);
        this.finish(oldest, oldest.outcome === undefined ? { kind: "stale" } : oldest.outcome);
      }
      this.enqueue(() => this.afterRead(read));
    }
  }

  async firstReads(matchId: string): Promise<void> {
    await Promise.all(this.readsOf(matchId).map((read) => read.firstRead.promise));
  }

  row(matchId: string, puuid: string): RankRow | undefined {
    const read = this.matches.get(`${this.mode()}:${matchId}:${puuid}`);
    if (!read) return undefined;
    if (read.outcome === undefined) return { queueType: read.queueType, state: { kind: "pending" } };
    return read.outcome ? { queueType: read.queueType, state: read.outcome } : undefined;
  }

  async settled(matchId: string, puuids: readonly string[]): Promise<void> {
    const wanted = new Set(puuids);
    await Promise.all(this.readsOf(matchId).filter((read) => wanted.has(read.puuid)).map((read) => read.settled.promise));
  }

  private readsOf(matchId: string): MatchRead[] {
    const mode = this.mode();
    return [...this.matches.values()].filter((read) => read.mode === mode && read.matchId === matchId);
  }

  private floor(): number {
    return this.dependencies.retryFloorMs ?? RANK_RETRY_FLOOR_MS;
  }

  /** Runs reads one at a time. A task never rejects, but the chain survives one that does. */
  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      this.dependencies.log(new Error(`An LP read broke off: ${errorMessage(error)}`));
    });
  }

  /** One league-v4 read, bounded by the tracker's own guard. Never rejects. */
  private async read(puuid: string): Promise<ReadOutcome> {
    let timer: NodeJS.Timeout | undefined;
    const guardMs = this.dependencies.readGuardMs ?? RANK_READ_GUARD_MS;
    try {
      const guard = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RiotApiError(`The league-v4 read did not settle within ${guardMs / 1000} s.`, "timeout")), guardMs);
      });
      const entries = await Promise.race([Promise.resolve().then(() => this.dependencies.readEntries(puuid)), guard]);
      return { entries };
    } catch (error) {
      return { error };
    } finally {
      clearTimeout(timer);
    }
  }

  /** One after-read of a match: classify it, or schedule the next read while league-v4 lags. */
  private async afterRead(read: MatchRead): Promise<void> {
    if (read.outcome !== undefined) return;
    if (this.off()) {
      this.finish(read, null);
      return;
    }
    const account = this.account(read.mode, read.puuid);
    // Only the first after-read may come sooner than the floor; a retry that another read overtook waits again.
    if (read.reads > 0 && this.tooSoon(account)) {
      this.schedule(read, account);
      return;
    }
    if (read.before === undefined) {
      read.before = this.beforeOf(account, read.gameEndTimestamp);
      read.untrusted = !this.trusted(read);
    }
    read.reads++;
    const startedAt = this.now();
    account.lastReadAt = startedAt;
    const outcome = await this.read(read.puuid);
    if (read.outcome !== undefined) return;
    if (!("entries" in outcome)) {
      const { error } = outcome;
      if (isAuthError(error)) {
        this.disable(error);
        return;
      }
      // A rate limit is quiet and a timeout is a lagging answer: both are pending, and the next read follows.
      if (isRateLimit(error) || isTimeout(error)) {
        this.retryLater(read, account, startedAt);
        return;
      }
      this.failed(error);
      this.finish(read, { kind: "unavailable" });
      return;
    }
    this.recovered();
    const after: Snapshot = { entries: outcome.entries, at: startedAt };
    if (!read.before) {
      // Nothing to compare with, so no row; this read is the next game's before-value.
      this.remember(account, after);
      this.dependencies.info(`LP of match ${read.matchId} for ${read.label} has no before-read, so the report shows no row.`);
      this.finish(read, null);
      return;
    }
    let change = classifyRankChange(entryForQueue(read.before.entries, read.queueType), entryForQueue(after.entries, read.queueType));
    if (read.untrusted && (change.kind === "change" || change.kind === "promoted" || change.kind === "demoted")) {
      // The only older read may hold a dodge or decay, so the difference belongs to no single game.
      this.dependencies.info(`LP of match ${read.matchId} for ${read.label}: no read followed the game start, so the change is unattributable.`);
      change = { kind: "unattributable", after: change.after };
    }
    if (change.kind === "pending") {
      this.retryLater(read, account, startedAt);
      return;
    }
    // A read that caught up is the next game's before-value.
    this.remember(account, after);
    if (change.kind === "none") {
      if (change.reason !== "no_entry") {
        this.dependencies.info(`LP of match ${read.matchId} for ${read.label} shows no row: none/${change.reason}.`);
      }
      this.finish(read, null);
      return;
    }
    this.dependencies.info(`LP of match ${read.matchId} for ${read.label}: league-v4 caught up ${this.lag(read, startedAt)} (read ${read.reads}).`);
    this.finish(read, change);
  }

  private lag(read: MatchRead, at: number): string {
    return read.gameEndTimestamp === null ? "at an unknown time after game end" : `${Math.round((at - read.gameEndTimestamp) / 1000)} s after game end`;
  }

  /** League-v4 has not caught up yet: read again no sooner than the floor after this account's last read, up to the cap. */
  private retryLater(read: MatchRead, account: AccountReads, startedAt: number): void {
    read.firstRead.resolve();
    if (read.reads >= MAX_RANK_READS) {
      this.dependencies.info(`LP of match ${read.matchId} for ${read.label}: league-v4 had not caught up ${this.lag(read, startedAt)} `
        + `after ${read.reads} reads, so the row stays not updated.`);
      this.finish(read, { kind: "stale" });
      return;
    }
    this.schedule(read, account);
  }

  /** The next after-read of a match, no sooner than the floor after the account's last read. */
  private schedule(read: MatchRead, account: AccountReads): void {
    const wait = Math.max(0, (account.lastReadAt ?? this.now()) + this.floor() - this.now());
    read.timer = setTimeout(() => {
      read.timer = undefined;
      this.enqueue(() => this.afterRead(read));
    }, wait);
    read.timer.unref?.();
  }

  private finish(read: MatchRead, outcome: RankRowState | null): void {
    if (read.timer) clearTimeout(read.timer);
    read.timer = undefined;
    if (read.outcome === undefined) read.outcome = outcome;
    read.firstRead.resolve();
    read.settled.resolve();
  }

  /** Riot rejected the key for league-v4: LP is off until the bot restarts, with one log line. */
  private disable(error: unknown): void {
    if (this.disabled) return;
    this.disabled = true;
    this.dependencies.log(new Error(`Riot rejected the key for league-v4 (${errorMessage(error)}), so LP reads are off until the bot `
      + "restarts. If RIOT_API_KEY expired, paste a new key into .env and restart."));
    for (const read of this.matches.values()) this.finish(read, null);
  }

  /** Logs a failure once per kind until a read works again. */
  private failed(error: unknown): void {
    const key = errorKey(error);
    if (this.loggedErrors.has(key)) return;
    this.loggedErrors.add(key);
    this.dependencies.log(new Error(`An LP read failed: ${errorMessage(error)} (logged once until a read works again)`));
  }

  private recovered(): void {
    if (this.loggedErrors.size === 0) return;
    this.dependencies.info(`LP reads work again after ${[...this.loggedErrors].join(", ")} failures.`);
    this.loggedErrors.clear();
  }
}

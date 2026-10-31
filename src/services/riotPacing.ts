import { isStopping } from "./shutdownState";

/**
 * `normal` is every request that the bot's own work or a single command needs: finished-match polling, its match
 * detail and timeline, league and spectator reads, `/profile`, `/bind` and the key check.
 * `bulk` is interactive work that sends many requests at once, which today is only `/recent`. It gets a smaller share
 * of each window, so it can never take the requests a poll needs.
 */
export type RiotPriority = "normal" | "bulk";

/** One rate-limit window that the pacer keeps a host under. */
export interface PacingWindow {
  /** Riot's window length in seconds, as `X-App-Rate-Limit-Count` names it, so Riot's own count can be matched to it. */
  riotSeconds: number;
  /** Our window length, a little longer than Riot's, so a request that reaches Riot late still falls in the window we counted it in. */
  windowMs: number;
  /** Requests of any priority sent in one window: below Riot's limit for the window. */
  limit: number;
  /** Bulk requests sent in one window. `limit - bulkLimit` is the share no bulk request can take. */
  bulkLimit: number;
}

/**
 * The windows every Riot host is paced under. Riot's development key allows 20 requests per 1 s and 100 per 120 s on
 * each routing host (`X-App-Rate-Limit: 100:120,20:1`, counted separately on na1 and americas).
 * The pacer stays under both, on count and on time, and Riot's own count (see `RiotPacer.observe`) keeps it honest
 * about requests it did not send. Bulk requests (`/recent`) get at most 10 of 16 and 55 of 95, so normal requests
 * always have 6 per short window and 40 per long one that bulk cannot take.
 */
export const RIOT_PACING_WINDOWS: readonly PacingWindow[] = [
  { riotSeconds: 1, windowMs: 1_200, limit: 16, bulkLimit: 10 },
  { riotSeconds: 120, windowMs: 125_000, limit: 95, bulkLimit: 55 },
];

/** While a request waits, the pacer looks at least this often whether the bot started stopping. */
export const PACING_STOP_CHECK_MS = 1_000;

/**
 * How long a request is remembered after it leaves the longest window, so that a slow answer is compared with what
 * was counted when its request was sent (see `RiotPacer.observe`). Longer than any request timeout.
 */
export const PACING_MEMORY_MS = 15_000;

export interface RiotPacerOptions {
  windows?: readonly PacingWindow[];
  now?: () => number;
  /**
   * Keeps the process alive while a request waits. Off in the bot, whose shutdown must not wait on Riot; on for a
   * one-shot script, which would otherwise exit in the middle of a wait as if it had finished.
   */
  keepAlive?: boolean;
  /** Schedules the next check; the default timer is unref'd unless `keepAlive` is set. */
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  /** Whether the bot is stopping; a waiting request is then rejected instead of sent. */
  stopping?: () => boolean;
  stopCheckMs?: number;
}

export interface AcquireOptions {
  priority?: RiotPriority;
  /** The longest this request may wait for its turn; past it, it is rejected as `rate_limited` and never sent. */
  maxWaitMs?: number;
}

/** A granted turn: when it was granted, and `refund` to give it back when the request was not sent after all. */
export interface PacingSlot { sentAt: number; refund(): void }

interface Sent { at: number; bulk: boolean }
interface Waiter {
  priority: RiotPriority;
  deadline: number;
  resolve: (slot: PacingSlot) => void;
  reject: (error: PacingRejection) => void;
}
interface HostState {
  host: string;
  /** Requests counted in the longest window, oldest first. */
  sent: Sent[];
  /** Waiting requests by priority, first come first served within each. */
  normal: Waiter[];
  bulk: Waiter[];
  timer?: unknown;
}

/**
 * Why a request was not given a turn: the bot is stopping, or the turn would come later than the request may wait.
 * The requester turns it into a `RiotApiError`; the request was never sent.
 */
export class PacingRejection extends Error {
  constructor(readonly reason: "stopping" | "budget", readonly waitMs = 0) {
    super(reason === "stopping" ? "The bot is stopping, so the Riot request was not sent." : "The Riot request budget for this host is used up, so the request was not sent.");
    this.name = "PacingRejection";
  }
}

const stoppedError = (): PacingRejection => new PacingRejection("stopping");
const budgetError = (waitMs: number): PacingRejection => new PacingRejection("budget", Math.max(1, Math.ceil(waitMs)));

/** Parses Riot's `X-App-Rate-Limit-Count`, such as `3:1,57:120`, into the count per window length in seconds. */
function parseCounts(header: string | null): Map<number, number> {
  const counts = new Map<number, number>();
  for (const part of header?.split(",") ?? []) {
    const match = /^\s*(\d+):(\d+)\s*$/.exec(part);
    if (match) counts.set(Number(match[2]), Number(match[1]));
  }
  return counts;
}

/**
 * Paces requests per host so they wait for room in every window instead of being sent and rejected with a 429.
 * One pacer is shared by every requester in the process (see `riotData.ts`), so all callers draw on one budget per host.
 */
export class RiotPacer {
  private readonly windows: readonly PacingWindow[];
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly stopping: () => boolean;
  private readonly stopCheckMs: number;
  private readonly longestMs: number;
  private readonly hosts = new Map<string, HostState>();
  private closed = false;

  constructor(options: RiotPacerOptions = {}) {
    this.windows = [...(options.windows ?? RIOT_PACING_WINDOWS)].sort((left, right) => left.windowMs - right.windowMs);
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? (options.keepAlive
      ? (callback, delayMs) => setTimeout(callback, delayMs)
      : (callback, delayMs) => setTimeout(callback, delayMs).unref());
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
    this.stopping = options.stopping ?? isStopping;
    this.stopCheckMs = options.stopCheckMs ?? PACING_STOP_CHECK_MS;
    this.longestMs = Math.max(0, ...this.windows.map((window) => window.windowMs));
  }

  /** Waits for this request's turn on `host` and counts it as sent once it is granted. */
  acquire(host: string, options: AcquireOptions = {}): Promise<PacingSlot> {
    if (this.closed || this.stopping()) return Promise.reject(stoppedError());
    const state = this.state(host);
    const priority = options.priority ?? "normal";
    const maxWaitMs = options.maxWaitMs ?? Infinity;
    return new Promise<PacingSlot>((resolve, reject) => {
      (priority === "bulk" ? state.bulk : state.normal).push({ priority, deadline: this.now() + maxWaitMs, resolve, reject });
      this.pump(host);
    });
  }

  /**
   * Takes Riot's own count for the longest window from a response's `X-App-Rate-Limit-Count`. When Riot has counted
   * more than the pacer, such as requests from before a restart or from another process on the same key, the
   * difference is counted as sent. `sentAt` is when the answered request was sent: Riot counted only requests that
   * reached it before that one did, so the pacer compares with what it counted from `sentAt` back.
   *
   * Only the longest window is synced. Riot's short window is a fixed second from its first request, which a round trip
   * of a few hundred milliseconds shifts against the pacer's, so its count would look higher than the pacer's even when
   * nothing is missing. The extras would then also fill the long window and eat the share bulk requests cannot take.
   * The short window empties itself within 1.2 s anyway; the long one is where unknown requests do harm.
   */
  observe(host: string, countHeader: string | null, sentAt = this.now()): void {
    const longest = this.windows.at(-1);
    const riotCount = longest && parseCounts(countHeader).get(longest.riotSeconds);
    if (!longest || riotCount === undefined) return;
    const state = this.state(host);
    const now = this.now();
    this.prune(state, now);
    const counted = state.sent.filter((sent) => sent.at > sentAt - longest.windowMs).length;
    // A count far above the limit can only mean the window is full; anything past the limit adds nothing.
    const missing = Math.min(riotCount, longest.limit) - counted;
    // Riot does not say when its requests were sent. They are counted as sent just before every shorter window
    // began, so they fill the long window without also filling the shorter ones.
    const at = now - (this.windows.at(-2)?.windowMs ?? 0);
    if (missing > 0) this.record(state, ...Array.from({ length: missing }, () => ({ at, bulk: false })));
  }

  /** Rejects every waiting request and every later one, for shutdown. */
  close(): void {
    this.closed = true;
    for (const host of this.hosts.keys()) this.rejectAll(host, stoppedError());
  }

  /** How many requests are waiting on `host`, for tests and diagnostics. */
  waiting(host: string): number {
    const state = this.hosts.get(host);
    return state ? state.normal.length + state.bulk.length : 0;
  }

  private state(host: string): HostState {
    let state = this.hosts.get(host);
    if (!state) {
      state = { host, sent: [], normal: [], bulk: [] };
      this.hosts.set(host, state);
    }
    return state;
  }

  private prune(state: HostState, now: number): void {
    // After the wall clock steps back, a request "sent in the future" counts as sent now, so it cannot hold a window
    // for longer than the window itself.
    for (let index = state.sent.length - 1; index >= 0 && state.sent[index].at > now; index--) state.sent[index].at = now;
    const cutoff = now - this.longestMs - PACING_MEMORY_MS;
    let expired = 0;
    while (expired < state.sent.length && state.sent[expired].at <= cutoff) expired++;
    if (expired > 0) state.sent.splice(0, expired);
  }

  private inWindow(state: HostState, window: PacingWindow, now: number): Sent[] {
    const cutoff = now - window.windowMs;
    return state.sent.filter((sent) => sent.at > cutoff);
  }

  /** Adds requests sent at `at`, keeping the list oldest first even if the wall clock stepped back. */
  private record(state: HostState, ...entries: Sent[]): void {
    const at = entries[0].at;
    const index = state.sent.findIndex((sent) => sent.at > at);
    state.sent.splice(index < 0 ? state.sent.length : index, 0, ...entries);
  }

  /** The earliest time a request of this priority could be sent if nothing else is; `now` when it can go at once. */
  private freeAt(state: HostState, priority: RiotPriority, now: number): number {
    let at = now;
    for (const window of this.windows) {
      const all = this.inWindow(state, window, now);
      if (all.length >= window.limit) at = Math.max(at, all[all.length - window.limit].at + window.windowMs);
      if (priority === "bulk") {
        const bulk = all.filter((sent) => sent.bulk);
        if (bulk.length >= window.bulkLimit) at = Math.max(at, bulk[bulk.length - window.bulkLimit].at + window.windowMs);
      }
    }
    return at;
  }

  private rejectAll(host: string, error: PacingRejection): void {
    const state = this.hosts.get(host);
    if (!state) return;
    if (state.timer !== undefined) this.clearTimer(state.timer);
    state.timer = undefined;
    for (const waiter of [...state.normal.splice(0), ...state.bulk.splice(0)]) waiter.reject(error);
  }

  private grant(state: HostState, waiter: Waiter, now: number): void {
    const sent: Sent = { at: now, bulk: waiter.priority === "bulk" };
    this.record(state, sent);
    waiter.resolve({
      sentAt: now,
      refund: () => {
        const index = state.sent.indexOf(sent);
        if (index < 0) return;
        state.sent.splice(index, 1);
        // The turn it held may be the one a waiting request needs.
        this.pump(state.host);
      },
    });
  }

  private pump(host: string): void {
    const state = this.state(host);
    if (state.timer !== undefined) this.clearTimer(state.timer);
    state.timer = undefined;
    if (this.closed || this.stopping()) {
      this.rejectAll(host, stoppedError());
      return;
    }
    const now = this.now();
    this.prune(state, now);
    // Normal requests go first. A waiting normal request is blocked by a full window, which blocks bulk too,
    // so a bulk request never goes ahead of a normal one.
    for (const queue of [state.normal, state.bulk]) {
      while (queue.length > 0 && this.freeAt(state, queue[0].priority, now) <= now) this.grant(state, queue.shift()!, now);
    }
    // A request that cannot get a turn before its deadline is rejected now rather than at the deadline.
    for (const queue of [state.normal, state.bulk]) {
      for (let index = queue.length - 1; index >= 0; index--) {
        const freeAt = this.freeAt(state, queue[index].priority, now);
        if (freeAt > queue[index].deadline) queue.splice(index, 1)[0].reject(budgetError(freeAt - now));
      }
    }
    const heads = [state.normal[0], state.bulk[0]].filter((waiter): waiter is Waiter => waiter !== undefined);
    if (heads.length === 0) return;
    const next = Math.min(...heads.map((waiter) => this.freeAt(state, waiter.priority, now)), ...heads.map((waiter) => waiter.deadline));
    state.timer = this.setTimer(() => {
      state.timer = undefined;
      this.pump(host);
    }, Math.max(0, Math.min(next - now, this.stopCheckMs)));
  }
}

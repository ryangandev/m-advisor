/** A clock with timers that only move when a test moves them, for code that takes `now`, `setTimer` and `clearTimer`. */
export interface FakeClock {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (timer: unknown) => void;
  /** Timers still scheduled. */
  pending: () => number;
  /** Moves the clock forward, running every timer that falls due on the way, in order. */
  advance: (ms: number) => void;
  /** Moves to the earliest timer and runs it; false when none is scheduled. */
  runNext: () => boolean;
}

export function fakeClock(start = 0): FakeClock {
  let time = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const earliest = (): [number, { at: number; callback: () => void }] | undefined =>
    [...timers].sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0];
  const run = (id: number, timer: { at: number; callback: () => void }): void => {
    timers.delete(id);
    time = Math.max(time, timer.at);
    timer.callback();
  };
  return {
    now: () => time,
    setTimer: (callback, delayMs) => {
      const id = nextId++;
      timers.set(id, { at: time + Math.max(0, delayMs), callback });
      return id;
    },
    clearTimer: (timer) => { timers.delete(timer as number); },
    pending: () => timers.size,
    advance: (ms) => {
      const end = time + ms;
      for (let next = earliest(); next && next[1].at <= end; next = earliest()) run(...next);
      time = end;
    },
    runNext: () => {
      const next = earliest();
      if (!next) return false;
      run(...next);
      return true;
    },
  };
}

/** Lets pending promise chains, including a fake fetch's response body, run to their next wait. */
export async function idle(turns = 10): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Settles `work` on the fake clock: whenever nothing else can run, the clock moves to its next timer.
 * Fails instead of hanging when the work waits on something that is not a timer of this clock.
 */
export async function settle<T>(clock: FakeClock, work: Promise<T>): Promise<T> {
  let done = false;
  const tracked = work.finally(() => { done = true; });
  tracked.catch(() => undefined);
  while (!done) {
    await idle();
    if (done) break;
    if (!clock.runNext()) {
      await idle();
      if (!done) throw new Error("The work is waiting on something other than the fake clock.");
    }
  }
  return tracked;
}

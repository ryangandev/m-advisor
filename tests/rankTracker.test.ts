import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { MAX_RANK_READS, RANK_RETRY_FLOOR_MS, RankTracker } from "../src/services/rankTracker";
import type { RankRow, RankRowState, RankTrackerDependencies } from "../src/services/rankTracker";
import { queueLabel, rankName, rankRowText, spokenRankName } from "../src/services/rankText";
import { RiotApiError } from "../src/services/riotData";
import { rankTracker, stopAllPolling } from "../src/services/gameMonitor";
import type { RankedEntry } from "../src/types";

afterEach(() => { mock.timers.reset(); });

const SOLO = "RANKED_SOLO_5x5";
const FLEX = "RANKED_FLEX_SR";
const MEMBER = "300000000000000001";

function entry(tier: string, rank: string, leaguePoints: number, wins = 10, losses = 10, queueType = SOLO): RankedEntry {
  return { queueType, tier, rank, leaguePoints, wins, losses };
}

/** Lets queued promise callbacks run without real time passing; setImmediate is never faked here. */
async function flush(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round++) await new Promise<void>((resolve) => setImmediate(resolve));
}

type Answer = readonly RankedEntry[] | Error | (() => Promise<readonly RankedEntry[]>);

/** A fake league-v4: each account answers what `league` holds for it now, and every read is counted with its time. */
function setup(overrides: Partial<RankTrackerDependencies> = {}) {
  const league = new Map<string, Answer>();
  const reads: Array<{ puuid: string; at: number }> = [];
  const logs: string[] = [];
  const infos: string[] = [];
  const state = { mock: false };
  const tracker = new RankTracker({
    readEntries: async (puuid) => {
      reads.push({ puuid, at: Date.now() });
      const answer = league.get(puuid) ?? [];
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer() : answer;
    },
    mock: () => state.mock,
    log: (error) => { logs.push(error instanceof Error ? error.message : String(error)); },
    info: (message) => { infos.push(message); },
    ...overrides,
  });
  /** Snapshot, then the game: league-v4 answers `after` once the match is finished. */
  const play = async (matchId: string, puuid: string, before: Answer, after: Answer, queueId = 420) => {
    league.set(puuid, before);
    tracker.snapshot([puuid]);
    await flush();
    league.set(puuid, after);
    tracker.matchFinished({ matchId, queueId, gameEndTimestamp: Date.now(), accounts: [{ puuid, label: `${puuid}#NA1` }] });
    await tracker.firstReads(matchId);
    return tracker.row(matchId, puuid);
  };
  return { tracker, league, reads, logs, infos, state, play };
}

const text = (row: RankRow | undefined) => row ? rankRowText(MEMBER, row) : null;

test("a ranked win is a change row with the game's LP, and the after-read is the next game's before-value", async () => {
  const { play, infos, reads, tracker, league } = setup();
  const first = await play("NA1_1", "acct", [entry("GOLD", "II", 64)], [entry("GOLD", "II", 86, 11, 10)]);
  assert.equal(first?.state.kind, "change");
  assert.equal(text(first), `<@${MEMBER}> 单双排 黄金 II · 86 LP · 本局 +22`);
  assert.ok(infos.some((line) => /^LP of match NA1_1 for acct#NA1: league-v4 caught up \d+ s after game end \(read 1\)\.$/.test(line)), infos.join("\n"));

  // No game-start read this time: the next match compares with the after-read of NA1_1, not with GOLD II 64.
  league.set("acct", [entry("GOLD", "I", 8, 12, 10)]);
  tracker.matchFinished({ matchId: "NA1_2", queueId: 420, gameEndTimestamp: null, accounts: [{ puuid: "acct", label: "acct#NA1" }] });
  await tracker.firstReads("NA1_2");
  const second = tracker.row("NA1_2", "acct");
  assert.equal(text(second), `<@${MEMBER}> 单双排 黄金 I · 8 LP · 本局 +22 · 晋级！`);
  assert.equal(reads.length, 3, "one snapshot and one read per match");
  assert.ok(infos.some((line) => line.includes("caught up at an unknown time after game end (read 1)")));
});

test("a demotion shows the new rank and its LP without a change; flex rows say 灵活组排", async () => {
  const { play } = setup();
  const row = await play("NA1_3", "acct", [entry("GOLD", "IV", 5)], [entry("SILVER", "I", 86, 10, 11)]);
  assert.equal(row?.state.kind, "demoted");
  assert.equal(text(row), `<@${MEMBER}> 单双排 白银 I · 86 LP · 本局掉段`);
  assert.doesNotMatch(text(row)!, /本局 [-+±]|-\d/, "no change: the ladder distance is not what Riot took");

  const flex = await play("NA1_4", "flexer", [entry("SILVER", "I", 31, 5, 5, FLEX)], [entry("SILVER", "I", 12, 5, 6, FLEX)], 440);
  assert.equal(text(flex), `<@${MEMBER}> 灵活组排 白银 I · 12 LP · 本局 -19`);
});

test("apex tiers show no division, and a cutoff move between them is a plain change", async () => {
  const { play } = setup();
  const master = await play("NA1_5", "a", [entry("DIAMOND", "I", 90)], [entry("MASTER", "I", 15, 11, 10)]);
  assert.equal(text(master), `<@${MEMBER}> 单双排 大师 · 15 LP · 本局 +25 · 晋级！`);
  const grandmaster = await play("NA1_6", "b", [entry("MASTER", "I", 300)], [entry("GRANDMASTER", "I", 320, 11, 10)]);
  assert.equal(grandmaster?.state.kind, "change");
  assert.equal(text(grandmaster), `<@${MEMBER}> 单双排 宗师 · 320 LP · 本局 +20`);
});

test("several games, placements, no entry, a lost entry and a missing before-read", async () => {
  const { play, tracker, league, infos } = setup();
  const several = await play("NA1_7", "a", [entry("GOLD", "II", 64)], [entry("GOLD", "II", 30, 12, 11)]);
  assert.equal(text(several), `<@${MEMBER}> 单双排 黄金 II · 30 LP · 中间隔了几局，本局变化算不出来`);
  const placed = await play("NA1_8", "b", [], [entry("GOLD", "IV", 0, 6, 4)]);
  assert.equal(text(placed), `<@${MEMBER}> 单双排 · 定级完成：黄金 IV`);
  assert.equal(await play("NA1_9", "c", [], []), undefined, "unranked before and after: no row");
  assert.equal(await play("NA1_10", "d", [entry("GOLD", "II", 64)], []), undefined, "a lost entry: no row");
  assert.ok(infos.includes("LP of match NA1_10 for d#NA1 shows no row: none/entry_lost."));
  assert.ok(!infos.some((line) => line.includes("none/no_entry")), "an unranked account is routine");

  // No snapshot at all is not "unranked": it shows nothing, and the read becomes the before-value.
  league.set("e", [entry("GOLD", "II", 64, 11, 10)]);
  tracker.matchFinished({ matchId: "NA1_11", queueId: 420, gameEndTimestamp: null, accounts: [{ puuid: "e", label: "e#NA1" }] });
  await tracker.firstReads("NA1_11");
  assert.equal(tracker.row("NA1_11", "e"), undefined);
  assert.ok(infos.includes("LP of match NA1_11 for e#NA1 has no before-read, so the report shows no row."));
  assert.equal(tracker.row("NA1_11", "unknown-account"), undefined);
});

test("queues without LP read nothing", async () => {
  const { tracker, reads } = setup();
  tracker.matchFinished({ matchId: "NA1_12", queueId: 400, gameEndTimestamp: null, accounts: [{ puuid: "a", label: "a#NA1" }] });
  await flush();
  assert.deepEqual(reads, []);
  assert.equal(tracker.row("NA1_12", "a"), undefined);
});

test("a mock snapshot is never a real before-value, and the reverse; a saved mock account is never read in real mode", async () => {
  const { tracker, league, reads, state } = setup();
  state.mock = true;
  league.set("acct", [entry("GOLD", "II", 64)]);
  tracker.snapshot(["acct"]);
  await flush();
  state.mock = false;
  league.set("acct", [entry("GOLD", "II", 86, 11, 10)]);
  tracker.matchFinished({ matchId: "NA1_13", queueId: 420, gameEndTimestamp: null, accounts: [{ puuid: "acct", label: "acct#NA1" }] });
  await tracker.firstReads("NA1_13");
  assert.equal(tracker.row("NA1_13", "acct"), undefined, "the mock snapshot is not used in real mode");

  // Now there is a real snapshot (GOLD II 86); a mock match of the same ID never sees it either.
  state.mock = true;
  league.set("acct", [entry("GOLD", "I", 8, 12, 10)]);
  tracker.matchFinished({ matchId: "NA1_14", queueId: 420, gameEndTimestamp: null, accounts: [{ puuid: "acct", label: "acct#NA1" }] });
  await tracker.firstReads("NA1_14");
  // The mock before-value is still GOLD II 64 with 20 games, so 22 games later is two games: unattributable.
  assert.equal(tracker.row("NA1_14", "acct")?.state.kind, "unattributable");
  state.mock = false;
  assert.equal(tracker.row("NA1_14", "acct"), undefined, "a mock match's row is not shown in real mode");

  const before = reads.length;
  tracker.snapshot(["MOCK-saved"]);
  tracker.matchFinished({ matchId: "NA1_15", queueId: 420, gameEndTimestamp: null, accounts: [{ puuid: "MOCK-saved", label: "x#NA1" }] });
  await flush();
  assert.equal(reads.length, before);
});

test(`a lagging league-v4 is read again ${RANK_RETRY_FLOOR_MS / 1000} s after the last read, at most ${MAX_RANK_READS} times per match`, async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_900_000_000_000 });
  const { tracker, league, reads, infos } = setup();
  league.set("acct", [entry("GOLD", "II", 64)]);
  tracker.snapshot(["acct"]);
  await flush();
  mock.timers.tick(30 * 60_000);
  // The game ended, but league-v4 still answers the old record.
  tracker.matchFinished({ matchId: "NA1_20", queueId: 420, gameEndTimestamp: Date.now(), accounts: [{ puuid: "acct", label: "acct#NA1" }] });
  await tracker.firstReads("NA1_20");
  const after = () => reads.slice(1).map((read) => read.at - reads[1].at);
  assert.deepEqual(after(), [0], "the first after-read goes at once");
  assert.equal(text(tracker.row("NA1_20", "acct")), `<@${MEMBER}> 单双排 · 段位还没更新，稍后补上`);

  mock.timers.tick(RANK_RETRY_FLOOR_MS - 1);
  await flush();
  assert.equal(after().length, 1, "not before the floor");
  mock.timers.tick(1);
  await flush();
  assert.equal(after().length, 2);
  for (let minute = 0; minute < 10; minute++) {
    mock.timers.tick(RANK_RETRY_FLOOR_MS);
    await flush();
  }
  assert.deepEqual(after(), [0, 60_000, 120_000, 180_000], `exactly ${MAX_RANK_READS} reads, each a floor apart`);
  assert.equal(tracker.row("NA1_20", "acct")?.state.kind, "stale");
  assert.equal(text(tracker.row("NA1_20", "acct")), `<@${MEMBER}> 单双排 · 段位一直没更新，本局变化算不出来`);
  assert.ok(infos.includes("LP of match NA1_20 for acct#NA1: league-v4 had not caught up 180 s after game end after 4 reads, so the row stays not updated."));
  await tracker.settled("NA1_20", ["acct"]);
});

test("league-v4 catching up on a later read fills the row and logs which read it was", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_900_000_000_000 });
  const { tracker, league, infos } = setup();
  league.set("acct", [entry("GOLD", "II", 64)]);
  tracker.snapshot(["acct"]);
  await flush();
  mock.timers.tick(30 * 60_000);
  tracker.matchFinished({ matchId: "NA1_21", queueId: 420, gameEndTimestamp: Date.now() - 20_000, accounts: [{ puuid: "acct", label: "acct#NA1" }] });
  await flush();
  mock.timers.tick(RANK_RETRY_FLOOR_MS);
  await flush();
  league.set("acct", [entry("GOLD", "II", 86, 11, 10)]);
  let settled = false;
  void tracker.settled("NA1_21", ["acct"]).then(() => { settled = true; });
  await flush();
  assert.equal(settled, false);
  mock.timers.tick(RANK_RETRY_FLOOR_MS);
  await flush();
  assert.equal(settled, true);
  assert.equal(text(tracker.row("NA1_21", "acct")), `<@${MEMBER}> 单双排 黄金 II · 86 LP · 本局 +22`);
  assert.ok(infos.includes("LP of match NA1_21 for acct#NA1: league-v4 caught up 140 s after game end (read 3)."), infos.join("\n"));
});

test("a snapshot is not read again within the floor, and reads run one at a time", async () => {
  const { tracker, league, reads } = setup();
  let running = 0;
  let most = 0;
  const slow = (answer: readonly RankedEntry[]) => async () => {
    running++;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    return answer;
  };
  for (const puuid of ["a", "b", "c"]) league.set(puuid, slow([entry("GOLD", "II", 64)]));
  tracker.snapshot(["a", "b", "c", "a"]);
  tracker.snapshot(["a"]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(reads.map((read) => read.puuid), ["a", "b", "c"], "once per account");
  tracker.snapshot(["a"]);
  await flush();
  assert.equal(reads.length, 3, "a fresh snapshot is not read again within the floor");

  for (const puuid of ["a", "b", "c"]) league.set(puuid, slow([entry("GOLD", "II", 86, 11, 10)]));
  tracker.matchFinished({
    matchId: "NA1_22", queueId: 420, gameEndTimestamp: null,
    accounts: ["a", "b", "c"].map((puuid) => ({ puuid, label: `${puuid}#NA1` })),
  });
  await tracker.firstReads("NA1_22");
  assert.equal(most, 1, "never two reads at once");
  assert.deepEqual(["a", "b", "c"].map((puuid) => tracker.row("NA1_22", puuid)?.state.kind), ["change", "change", "change"]);
  tracker.matchFinished({ matchId: "NA1_22", queueId: 420, gameEndTimestamp: null, accounts: [{ puuid: "a", label: "a#NA1" }] });
  await flush();
  assert.equal(reads.length, 6, "a match announced in two servers is read once");
});

test("a 401 or 403 turns LP off for the run with one log line, and nothing is read after it", async () => {
  const { tracker, league, reads, logs, play } = setup();
  const row = await play("NA1_30", "acct", new RiotApiError("Riot API error 403: access denied.", "forbidden", 403), []);
  assert.equal(row, undefined, "no row");
  assert.equal(tracker.isDisabled, true);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^Riot rejected the key for league-v4 \(Riot API error 403: access denied\.\), so LP reads are off until the bot restarts\. Finished matches are still announced\.$/);
  const before = reads.length;
  league.set("other", [entry("GOLD", "II", 64)]);
  tracker.snapshot(["other"]);
  tracker.matchFinished({ matchId: "NA1_31", queueId: 420, gameEndTimestamp: null, accounts: [{ puuid: "other", label: "other#NA1" }] });
  await tracker.firstReads("NA1_31");
  await tracker.settled("NA1_31", ["other"]);
  assert.equal(reads.length, before);
  assert.equal(tracker.row("NA1_31", "other"), undefined);
  assert.equal(logs.length, 1);
});

test("a 403 during a pending match ends its row quietly", async () => {
  const { tracker, league } = setup({ retryFloorMs: 1 });
  league.set("acct", [entry("GOLD", "II", 64)]);
  tracker.snapshot(["acct"]);
  await flush();
  tracker.matchFinished({ matchId: "NA1_32", queueId: 420, gameEndTimestamp: null, accounts: [{ puuid: "acct", label: "acct#NA1" }] });
  await tracker.firstReads("NA1_32");
  assert.equal(tracker.row("NA1_32", "acct")?.state.kind, "pending");
  league.set("acct", new RiotApiError("Riot API error 401: authentication required.", "unauthorized", 401));
  await tracker.settled("NA1_32", ["acct"]);
  assert.equal(tracker.row("NA1_32", "acct"), undefined);
});

test("a rate limit and a timeout are pending and quiet, and the scheduled read follows", async () => {
  const { tracker, league, logs } = setup({ retryFloorMs: 1 });
  league.set("acct", [entry("GOLD", "II", 64)]);
  tracker.snapshot(["acct"]);
  await flush();
  const answers: Answer[] = [
    new RiotApiError("Riot API error 429: rate limit exceeded.", "rate_limited", 429),
    new RiotApiError("Riot API request timed out.", "timeout"),
    [entry("GOLD", "II", 86, 11, 10)],
  ];
  league.set("acct", async () => {
    const answer = answers.shift()!;
    if (answer instanceof Error) throw answer;
    return answer as readonly RankedEntry[];
  });
  tracker.matchFinished({ matchId: "NA1_33", queueId: 420, gameEndTimestamp: null, accounts: [{ puuid: "acct", label: "acct#NA1" }] });
  await tracker.firstReads("NA1_33");
  assert.equal(tracker.row("NA1_33", "acct")?.state.kind, "pending");
  await tracker.settled("NA1_33", ["acct"]);
  assert.equal(tracker.row("NA1_33", "acct")?.state.kind, "change");
  assert.deepEqual(logs, []);
});

test("a read that never settles counts as a timeout and never holds the queue", async () => {
  const { tracker, league, reads } = setup({ readGuardMs: 20, retryFloorMs: 1 });
  league.set("stuck", [entry("GOLD", "II", 64)]);
  league.set("fine", [entry("GOLD", "II", 64)]);
  tracker.snapshot(["stuck", "fine"]);
  await flush();
  league.set("stuck", () => new Promise(() => {}));
  league.set("fine", [entry("GOLD", "II", 86, 11, 10)]);
  tracker.matchFinished({
    matchId: "NA1_34", queueId: 420, gameEndTimestamp: null,
    accounts: [{ puuid: "stuck", label: "stuck#NA1" }, { puuid: "fine", label: "fine#NA1" }],
  });
  await tracker.firstReads("NA1_34");
  assert.equal(tracker.row("NA1_34", "stuck")?.state.kind, "pending");
  assert.equal(tracker.row("NA1_34", "fine")?.state.kind, "change", "the stuck read did not hold the next one");
  await tracker.settled("NA1_34", ["stuck"]);
  assert.equal(tracker.row("NA1_34", "stuck")?.state.kind, "stale");
  assert.equal(reads.filter((read) => read.puuid === "stuck").length, 1 + MAX_RANK_READS);
});

test("other failures show 段位暂时查不到, are logged once per kind, and a working read says so once", async () => {
  const { tracker, league, logs, infos } = setup();
  for (const puuid of ["a", "b"]) league.set(puuid, [entry("GOLD", "II", 64)]);
  tracker.snapshot(["a", "b"]);
  await flush();
  for (const puuid of ["a", "b"]) league.set(puuid, new RiotApiError("Riot API error 503: service unavailable.", "unavailable", 503));
  tracker.matchFinished({
    matchId: "NA1_35", queueId: 420, gameEndTimestamp: null,
    accounts: [{ puuid: "a", label: "a#NA1" }, { puuid: "b", label: "b#NA1" }],
  });
  await tracker.settled("NA1_35", ["a", "b"]);
  assert.equal(text(tracker.row("NA1_35", "a")), `<@${MEMBER}> 单双排 · 段位暂时查不到`);
  assert.equal(tracker.row("NA1_35", "b")?.state.kind, "unavailable");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^An LP read failed: Riot API error 503: service unavailable\. \(logged once until a read works again\)$/);

  league.set("c", [entry("GOLD", "II", 64)]);
  tracker.snapshot(["c"]);
  await flush();
  assert.ok(infos.includes("LP reads work again after unavailable:503 failures."));
  league.set("d", () => { throw new TypeError("readEntries broke"); });
  tracker.snapshot(["d"]);
  await flush();
  assert.equal(logs.length, 2, "a thrown non-Riot error is logged and never escapes");
});

test("a next game's start read before the poll detects the last game is not that game's before-value", async () => {
  let clock = 1_900_000_000_000;
  const { tracker, league, infos } = setup({ now: () => clock });
  const accounts = [{ puuid: "acct", label: "acct#NA1" }];
  league.set("acct", [entry("GOLD", "II", 64)]);
  tracker.snapshot(["acct"]);
  await flush();
  // Game 1 ends and league-v4 updates; the player requeues, and game 2 loads before the poll detects game 1.
  clock += 30 * 60_000;
  const firstEnd = clock;
  league.set("acct", [entry("GOLD", "II", 86, 11, 10)]);
  clock += 3 * 60_000;
  tracker.snapshot(["acct"]);
  await flush();
  clock += 60_000;
  tracker.matchFinished({ matchId: "NA1_40", queueId: 420, gameEndTimestamp: firstEnd, accounts });
  await tracker.firstReads("NA1_40");
  assert.equal(text(tracker.row("NA1_40", "acct")), `<@${MEMBER}> 单双排 黄金 II · 86 LP · 本局 +22`);
  assert.ok(infos.includes("LP of match NA1_40 for acct#NA1: league-v4 caught up 240 s after game end (read 1)."), infos.join("\n"));
  assert.ok(!infos.some((line) => line.includes("had not caught up")), "no false lag line");

  // Game 2 compares with the newest read from before it ended, which already holds game 1.
  clock += 25 * 60_000;
  const secondEnd = clock;
  league.set("acct", [entry("GOLD", "I", 8, 12, 10)]);
  clock += 30_000;
  tracker.matchFinished({ matchId: "NA1_41", queueId: 420, gameEndTimestamp: secondEnd, accounts });
  await tracker.firstReads("NA1_41");
  assert.equal(text(tracker.row("NA1_41", "acct")), `<@${MEMBER}> 单双排 黄金 I · 8 LP · 本局 +22 · 晋级！`);

  // A read sent after the game ended is never its before-value, so with nothing older there is no row.
  clock += 5 * 60_000;
  const lateEnd = clock - 60_000;
  league.set("late", [entry("GOLD", "II", 86, 11, 10)]);
  tracker.snapshot(["late"]);
  await flush();
  clock += 60_000;
  tracker.matchFinished({ matchId: "NA1_42", queueId: 420, gameEndTimestamp: lateEnd, accounts: [{ puuid: "late", label: "late#NA1" }] });
  await tracker.firstReads("NA1_42");
  assert.equal(tracker.row("NA1_42", "late"), undefined);
});

test("snapshot reads are capped at one per floor per account, failed reads included; only a first after-read is sooner", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_900_000_000_000 });
  const { tracker, league, reads, logs } = setup();
  league.set("acct", new RiotApiError("Riot API error 503: service unavailable.", "unavailable", 503));
  tracker.snapshot(["acct"]);
  await flush();
  tracker.snapshot(["acct"]);
  mock.timers.tick(RANK_RETRY_FLOOR_MS - 1);
  tracker.snapshot(["acct"]);
  await flush();
  assert.equal(reads.length, 1, "a failed read still counts for the floor");
  mock.timers.tick(1);
  tracker.snapshot(["acct"]);
  await flush();
  assert.equal(reads.length, 2);
  assert.equal(logs.length, 1, "logged once");

  league.set("acct", [entry("GOLD", "II", 64)]);
  tracker.matchFinished({ matchId: "NA1_43", queueId: 420, gameEndTimestamp: null, accounts: [{ puuid: "acct", label: "acct#NA1" }] });
  await flush();
  assert.equal(reads.length, 3, "the first after-read goes at once");
  tracker.snapshot(["acct"]);
  mock.timers.tick(RANK_RETRY_FLOOR_MS - 1);
  tracker.snapshot(["acct"]);
  await flush();
  assert.equal(reads.length, 3, "and the floor counts from it");
  const gaps = reads.slice(1).map((read, index) => read.at - reads[index].at);
  assert.deepEqual(gaps, [RANK_RETRY_FLOOR_MS, 0]);
});

test("a retry that another read overtook waits for the floor again", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_900_000_000_000 });
  const { tracker, league, reads } = setup();
  league.set("acct", [entry("GOLD", "II", 64)]);
  tracker.snapshot(["acct"]);
  await flush();
  mock.timers.tick(30 * 60_000);
  const start = Date.now();
  const accounts = [{ puuid: "acct", label: "acct#NA1" }];
  // League-v4 lags for two matches of the same account; the second's first read goes out between the first's retries.
  tracker.matchFinished({ matchId: "NA1_44", queueId: 420, gameEndTimestamp: null, accounts });
  await flush();
  mock.timers.tick(30_000);
  tracker.matchFinished({ matchId: "NA1_45", queueId: 420, gameEndTimestamp: null, accounts });
  await flush();
  for (let step = 0; step < 40; step++) {
    mock.timers.tick(10_000);
    await flush();
  }
  const times = reads.slice(1).map((read) => read.at - start);
  assert.deepEqual(times.slice(0, 2), [0, 30_000], "both first after-reads go at once");
  for (let index = 2; index < times.length; index++) {
    assert.ok(times[index] - times[index - 1] >= RANK_RETRY_FLOOR_MS, `read ${index} came ${times[index] - times[index - 1]} ms after the previous one`);
  }
  assert.equal(times.length, 2 * MAX_RANK_READS);
});

test("stop at shutdown: queued reads do nothing, retries are cleared and pending rows settle with no row", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_900_000_000_000 });
  const { tracker, league, reads } = setup();
  league.set("lagging", [entry("GOLD", "II", 64)]);
  tracker.snapshot(["lagging"]);
  await flush();
  mock.timers.tick(30 * 60_000);
  tracker.matchFinished({ matchId: "NA1_50", queueId: 420, gameEndTimestamp: null, accounts: [{ puuid: "lagging", label: "lagging#NA1" }] });
  await tracker.firstReads("NA1_50");
  assert.equal(tracker.row("NA1_50", "lagging")?.state.kind, "pending", "a retry is scheduled");

  // One read in flight, one queued behind it.
  let answer!: (entries: readonly RankedEntry[]) => void;
  league.set("busy", () => new Promise((resolve) => { answer = resolve; }));
  league.set("queued", [entry("GOLD", "II", 64)]);
  tracker.snapshot(["busy", "queued"]);
  await flush();
  assert.deepEqual(reads.map((read) => read.puuid), ["lagging", "lagging", "busy"]);

  tracker.stop();
  assert.equal(tracker.isStopped, true);
  let settled = false;
  void tracker.settled("NA1_50", ["lagging"]).then(() => { settled = true; });
  await flush();
  assert.equal(settled, true, "the pending row settles at once");
  assert.equal(tracker.row("NA1_50", "lagging"), undefined, "with no row");
  answer([entry("GOLD", "II", 64)]);
  mock.timers.tick(10 * 60_000);
  await flush();
  tracker.snapshot(["new"]);
  tracker.matchFinished({ matchId: "NA1_51", queueId: 420, gameEndTimestamp: null, accounts: [{ puuid: "new", label: "new#NA1" }] });
  await flush();
  assert.deepEqual(reads.map((read) => read.puuid), ["lagging", "lagging", "busy"], "nothing queued, retried or new is read");
});

test("stopAllPolling stops the production tracker", () => {
  assert.equal(rankTracker.isStopped, false);
  stopAllPolling();
  assert.equal(rankTracker.isStopped, true);
});

test("rank names: 黄金 II in text, 黄金二 in voice, apex without a division, unknown ranks show nothing", () => {
  assert.equal(rankName(entry("GOLD", "II", 0)), "黄金 II");
  assert.equal(spokenRankName(entry("GOLD", "II", 0)), "黄金二");
  assert.equal(rankName(entry("EMERALD", "IV", 0)), "翡翠 IV");
  assert.equal(spokenRankName(entry("IRON", "I", 0)), "黑铁一");
  for (const [tier, name] of [["MASTER", "大师"], ["GRANDMASTER", "宗师"], ["CHALLENGER", "王者"]]) {
    assert.equal(rankName(entry(tier, "I", 0)), name);
    assert.equal(spokenRankName(entry(tier, "I", 0)), name);
  }
  assert.equal(rankName(entry("UNOBTAINIUM", "I", 0)), null);
  assert.equal(rankName(entry("GOLD", "V", 0)), null);
  assert.equal(spokenRankName(entry("GOLD", "V", 0)), null);
  assert.equal(queueLabel(SOLO), "单双排");
  assert.equal(queueLabel(FLEX), "灵活组排");
  assert.equal(queueLabel("CHERRY"), null);
  assert.equal(rankRowText(MEMBER, { queueType: SOLO, state: { kind: "placed", after: entry("UNOBTAINIUM", "I", 0) } }), null);
});

test("every row wording is plain Chinese without an em dash", () => {
  const before = entry("GOLD", "II", 64);
  const states: RankRowState[] = [
    { kind: "pending" }, { kind: "stale" }, { kind: "unavailable" },
    { kind: "placed", after: before },
    { kind: "unattributable", after: before },
    { kind: "change", delta: 0, before, after: before },
    { kind: "change", delta: -19, before, after: before },
    { kind: "promoted", delta: 22, before, after: entry("GOLD", "I", 8) },
    { kind: "demoted", delta: -24, before, after: entry("GOLD", "III", 80) },
  ];
  for (const queueType of [SOLO, FLEX]) {
    for (const state of states) {
      const line = rankRowText(MEMBER, { queueType, state } as RankRow)!;
      assert.ok(line.startsWith(`<@${MEMBER}> `), line);
      assert.ok(!line.includes("\u2014"), line);
    }
  }
  assert.match(rankRowText(MEMBER, { queueType: SOLO, state: states[5] } as RankRow)!, /本局 ±0$/);
});

test("rebase makes a freshly set mock entry the next game's before-value even within the floor, and does nothing in real mode", async () => {
  const mockRun = setup();
  mockRun.state.mock = true;
  // A game just played: its after-read is the before-value of the next one, and the floor has not passed.
  await mockRun.play("NA1_1", "acct", [entry("GOLD", "II", 64)], [entry("GOLD", "II", 86, 11, 10)]);
  const readsBefore = mockRun.reads.length;
  // /simulate places the account at GOLD I 90 and rebases; the next game's win then crosses the line.
  mockRun.league.set("acct", [entry("GOLD", "I", 90, 11, 10)]);
  await mockRun.tracker.rebase(["acct"]);
  assert.equal(mockRun.reads.length, readsBefore + 1, "read again at once, inside the floor");
  mockRun.league.set("acct", [entry("PLATINUM", "IV", 12, 12, 10)]);
  mockRun.tracker.matchFinished({ matchId: "NA1_2", queueId: 420, gameEndTimestamp: Date.now(), accounts: [{ puuid: "acct", label: "acct#NA1" }] });
  await mockRun.tracker.firstReads("NA1_2");
  assert.equal(mockRun.tracker.row("NA1_2", "acct")?.state.kind, "promoted");

  // Real mode never rebases: the floor and the history protect the rate limit.
  const realRun = setup();
  await realRun.play("NA1_1", "acct", [entry("GOLD", "II", 64)], [entry("GOLD", "II", 86, 11, 10)]);
  const realReads = realRun.reads.length;
  await realRun.tracker.rebase(["acct"]);
  assert.equal(realRun.reads.length, realReads);
});

test("hasReadSince is true only for a successful read sent at or after the time asked", async () => {
  let clock = 1_900_000_000_000;
  const { tracker, league, state } = setup({ now: () => clock });
  const start = clock;
  assert.equal(tracker.hasReadSince("acct", start), false, "never read");

  // A read that times out is not a read.
  league.set("acct", new RiotApiError("Riot API request timed out.", "timeout"));
  tracker.snapshot(["acct"]);
  await flush();
  assert.equal(tracker.hasReadSince("acct", start), false, "a failed read does not count");

  clock += RANK_RETRY_FLOOR_MS;
  league.set("acct", [entry("GOLD", "II", 59)]);
  const retryAt = clock;
  tracker.snapshot(["acct"]);
  await flush();
  assert.equal(tracker.hasReadSince("acct", start), true);
  assert.equal(tracker.hasReadSince("acct", retryAt), true, "sent exactly then");
  assert.equal(tracker.hasReadSince("acct", retryAt + 1), false, "a read older than the sighting does not count");
  assert.equal(tracker.hasReadSince("other", start), false, "per account");

  // A mock read is never a real read.
  state.mock = true;
  assert.equal(tracker.hasReadSince("acct", start), false);
  state.mock = false;

  // Nothing more is read for a saved mock account in real mode, or once the bot is stopping, so there is nothing to wait for.
  assert.equal(tracker.hasReadSince("MOCK-saved", clock + 1), true);
  tracker.stop();
  assert.equal(tracker.hasReadSince("never", clock + 1), true);
});

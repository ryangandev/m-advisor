import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyRankChange, entryForQueue, entryFromLadderValue, ladderValue, lpDelta, rankedQueueFor, shiftEntry } from "../src/services/rankMath";
import type { RankedEntry } from "../src/types";

const SOLO = "RANKED_SOLO_5x5";

function entry(tier: string, rank: string, leaguePoints: number, wins = 10, losses = 10, queueType = SOLO): RankedEntry {
  return { queueType, tier, rank, leaguePoints, wins, losses };
}

/** The same account one game later: `games` more games on the record. */
function later(before: RankedEntry, tier: string, rank: string, leaguePoints: number, games = 1): RankedEntry {
  return { ...before, tier, rank, leaguePoints, wins: before.wins + games, losses: before.losses };
}

test("the ladder value counts tiers by 400, divisions by 100 and puts IV below I", () => {
  assert.equal(ladderValue(entry("IRON", "IV", 0)), 0);
  assert.equal(ladderValue(entry("IRON", "I", 99)), 399);
  assert.equal(ladderValue(entry("BRONZE", "IV", 0)), 400);
  assert.equal(ladderValue(entry("GOLD", "IV", 90)), 1290);
  assert.equal(ladderValue(entry("EMERALD", "II", 5)), 2205);
  assert.equal(ladderValue(entry("DIAMOND", "I", 99)), 2799);
});

test("GOLD IV 90 to GOLD III 10 is +20, so a higher division counts as more", () => {
  const before = entry("GOLD", "IV", 90);
  assert.equal(lpDelta(before, later(before, "GOLD", "III", 10)), 20);
  assert.equal(lpDelta(later(before, "GOLD", "III", 10), before), -20);
});

test("a delta across a tier is the LP distance, in both directions", () => {
  const before = entry("PLATINUM", "I", 95);
  assert.equal(lpDelta(before, later(before, "EMERALD", "IV", 17)), 22);
  assert.equal(lpDelta(later(before, "EMERALD", "IV", 17), before), -22);
});

test("the apex tiers have no divisions: DIAMOND I 90 to MASTER 15 is +25 and apex tiers share one ladder", () => {
  const diamond = entry("DIAMOND", "I", 90);
  assert.equal(ladderValue(entry("MASTER", "I", 15)), 2815);
  assert.equal(lpDelta(diamond, later(diamond, "MASTER", "I", 15)), 25);
  // Riot's rank string for an apex entry is "I" and carries no meaning.
  assert.equal(ladderValue(entry("MASTER", "IV", 15)), 2815);
  assert.equal(ladderValue(entry("GRANDMASTER", "I", 15)), 2815);
  assert.equal(ladderValue(entry("CHALLENGER", "I", 600)), 3400);
});

test("a tier, division or LP this code does not know has no ladder value", () => {
  assert.equal(ladderValue(entry("UNOBTAINIUM", "I", 10)), null);
  assert.equal(ladderValue(entry("GOLD", "V", 10)), null);
  assert.equal(ladderValue(entry("GOLD", "I", -1)), null);
  assert.equal(ladderValue(entry("GOLD", "I", Number.NaN)), null);
  assert.equal(lpDelta(entry("GOLD", "I", 10), entry("UNOBTAINIUM", "I", 10)), null);
});

test("queue 420 is solo, 440 is flex and no other queue has LP", () => {
  assert.equal(rankedQueueFor(420), "RANKED_SOLO_5x5");
  assert.equal(rankedQueueFor(440), "RANKED_FLEX_SR");
  for (const queue of [0, 400, 430, 450, 480, 490, 700, 1700]) assert.equal(rankedQueueFor(queue), null);
});

test("one more game with the same record of LP is attributed to the game", () => {
  const before = entry("GOLD", "II", 64);
  const win = classifyRankChange(before, later(before, "GOLD", "II", 86));
  assert.deepEqual(win, { kind: "change", delta: 22, before, after: later(before, "GOLD", "II", 86) });
  const after = { ...before, leaguePoints: 45, losses: before.losses + 1 };
  assert.deepEqual(classifyRankChange(before, after), { kind: "change", delta: -19, before, after });
});

test("two or more games between the reads cannot be attributed to this game", () => {
  const before = entry("GOLD", "II", 64);
  for (const games of [2, 3, 7]) {
    const after = later(before, "GOLD", "II", 90, games);
    assert.deepEqual(classifyRankChange(before, after), { kind: "unattributable", after });
  }
  // A record that went backwards (a reset) belongs to no game either.
  const reset = { ...before, wins: 0, losses: 0 };
  assert.deepEqual(classifyRankChange(before, reset), { kind: "unattributable", after: reset });
});

test("no new game yet is pending, even when the LP looks different", () => {
  const before = entry("GOLD", "II", 64);
  assert.deepEqual(classifyRankChange(before, { ...before }), { kind: "pending" });
  assert.deepEqual(classifyRankChange(before, { ...before, leaguePoints: 30 }), { kind: "pending" });
  assert.deepEqual(classifyRankChange(before, { ...before, tier: "PLATINUM", rank: "IV" }), { kind: "pending" });
});

test("a delta of 0 across one game is a change of 0, not a pending read", () => {
  const before = entry("GOLD", "II", 64);
  const after = { ...before, wins: before.wins + 1 };
  assert.deepEqual(classifyRankChange(before, after), { kind: "change", delta: 0, before, after });
});

test("every division or tier change over one game is a promotion or a demotion", () => {
  const divisionUp = entry("GOLD", "IV", 90);
  assert.equal(classifyRankChange(divisionUp, later(divisionUp, "GOLD", "III", 10)).kind, "promoted");
  const tierUp = entry("GOLD", "I", 90);
  assert.equal(classifyRankChange(tierUp, later(tierUp, "PLATINUM", "IV", 12)).kind, "promoted");
  const divisionDown = entry("GOLD", "III", 0);
  const demoted = { ...divisionDown, tier: "GOLD", rank: "IV", leaguePoints: 81, losses: divisionDown.losses + 1 };
  assert.deepEqual(classifyRankChange(divisionDown, demoted), { kind: "demoted", delta: -19, before: divisionDown, after: demoted });
  const tierDown = entry("SILVER", "IV", 5);
  assert.equal(classifyRankChange(tierDown, { ...tierDown, tier: "BRONZE", rank: "I", leaguePoints: 86, losses: tierDown.losses + 1 }).kind, "demoted");
});

test("DIAMOND I to MASTER is a promotion and back is a demotion", () => {
  const diamond = entry("DIAMOND", "I", 90);
  const master = later(diamond, "MASTER", "I", 15);
  assert.deepEqual(classifyRankChange(diamond, master), { kind: "promoted", delta: 25, before: diamond, after: master });
  const back = { ...master, tier: "DIAMOND", rank: "I", leaguePoints: 92, losses: master.losses + 1 };
  assert.equal(classifyRankChange(master, back).kind, "demoted");
});

test("a move between MASTER, GRANDMASTER and CHALLENGER is a change, never a promotion", () => {
  const master = entry("MASTER", "I", 300);
  assert.deepEqual(classifyRankChange(master, later(master, "GRANDMASTER", "I", 320)), {
    kind: "change", delta: 20, before: master, after: later(master, "GRANDMASTER", "I", 320),
  });
  const grandmaster = entry("GRANDMASTER", "I", 500);
  assert.equal(classifyRankChange(grandmaster, { ...grandmaster, tier: "MASTER", losses: grandmaster.losses + 1 }).kind, "change");
  assert.equal(classifyRankChange(grandmaster, later(grandmaster, "CHALLENGER", "I", 520)).kind, "change");
});

test("an unchanged rank with more LP inside one division is a plain change", () => {
  const before = entry("PLATINUM", "III", 10);
  assert.equal(classifyRankChange(before, later(before, "PLATINUM", "III", 33)).kind, "change");
});

test("no entry before and none after is no row", () => {
  assert.deepEqual(classifyRankChange(null, null), { kind: "none", reason: "no_entry" });
});

test("no entry before and one after is a placed row without a delta", () => {
  const after = entry("GOLD", "IV", 42, 5, 5);
  assert.deepEqual(classifyRankChange(null, after), { kind: "placed", after });
});

test("an entry that disappeared (a season reset) is no row", () => {
  assert.deepEqual(classifyRankChange(entry("GOLD", "IV", 42), null), { kind: "none", reason: "entry_lost" });
});

test("an unknown tier or a mismatched queue is no row and never an error", () => {
  const known = entry("GOLD", "II", 64);
  assert.deepEqual(classifyRankChange(known, later(known, "UNOBTAINIUM", "I", 5)), { kind: "none", reason: "unknown_rank" });
  assert.deepEqual(classifyRankChange(null, entry("UNOBTAINIUM", "I", 5)), { kind: "none", reason: "unknown_rank" });
  const odd = entry("UNOBTAINIUM", "I", 5);
  assert.deepEqual(classifyRankChange(odd, later(odd, "GOLD", "II", 5)), { kind: "none", reason: "unknown_rank" });
  assert.deepEqual(classifyRankChange(known, { ...known, queueType: "RANKED_FLEX_SR", wins: known.wins + 1 }), { kind: "none", reason: "queue_mismatch" });
});

test("entryForQueue picks the entry of that queue", () => {
  const solo = entry("GOLD", "II", 64);
  const flex = entry("SILVER", "I", 12, 3, 3, "RANKED_FLEX_SR");
  assert.equal(entryForQueue([flex, solo], SOLO), solo);
  assert.equal(entryForQueue([flex], SOLO), null);
  assert.equal(entryForQueue([], SOLO), null);
});

test("shifting an entry rolls over divisions and tiers and keeps the record given", () => {
  const record = { wins: 11, losses: 10 };
  assert.deepEqual(shiftEntry(entry("GOLD", "II", 90), 22, record), { queueType: SOLO, tier: "GOLD", rank: "I", leaguePoints: 12, ...record });
  assert.deepEqual(shiftEntry(entry("GOLD", "I", 90), 22, record), { queueType: SOLO, tier: "PLATINUM", rank: "IV", leaguePoints: 12, ...record });
  assert.deepEqual(shiftEntry(entry("GOLD", "IV", 5), -19, record), { queueType: SOLO, tier: "SILVER", rank: "I", leaguePoints: 86, ...record });
  assert.deepEqual(shiftEntry(entry("DIAMOND", "I", 90), 22, record), { queueType: SOLO, tier: "MASTER", rank: "I", leaguePoints: 12, ...record });
  assert.deepEqual(shiftEntry(entry("MASTER", "I", 10), -19, record), { queueType: SOLO, tier: "DIAMOND", rank: "I", leaguePoints: 91, ...record });
  assert.deepEqual(shiftEntry(entry("IRON", "IV", 5), -19, record), { queueType: SOLO, tier: "IRON", rank: "IV", leaguePoints: 0, ...record });
  // An apex entry stays in its tier while it stays above the line.
  assert.equal(shiftEntry(entry("CHALLENGER", "I", 600), -19, record).tier, "CHALLENGER");
  assert.equal(entryFromLadderValue(2800, SOLO, record).tier, "MASTER");
});

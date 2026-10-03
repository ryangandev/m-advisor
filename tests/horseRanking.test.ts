import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_BENCHMARKS, HORSE_TIERS, ROLE_WEIGHTS, buildBenchmarks, extractFeatures, percentile, quantiles, rankTeam, scoreParticipant,
} from "../src/services/horseRanking";
import type { MatchDetail, MatchParticipant } from "../src/types";
import { testMatch } from "./helpers/matches";

test("percentile interpolates, clamps and centers ties", () => {
  const q = [0, 0, 0, 10, 20];
  assert.equal(percentile(-1, q), 0);
  assert.equal(percentile(25, q), 1);
  assert.equal(percentile(0, q), 0.25, "three tied quantiles average to the middle one");
  assert.equal(percentile(15, q), 0.875);
  assert.equal(percentile(5, [0]), undefined);
  assert.equal(percentile(Number.NaN, q), undefined);
});

test("quantiles are evenly spaced over the sorted sample", () => {
  assert.deepEqual(quantiles([4, 0, 2, 1, 3], 5), [0, 1, 2, 3, 4]);
  assert.deepEqual(quantiles([], 5), []);
  assert.deepEqual(quantiles([7], 3), [7, 7, 7]);
});

test("every position's dimension weights sum to one", () => {
  for (const [role, weights] of Object.entries(ROLE_WEIGHTS)) {
    const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `${role} weights sum to ${total}`);
  }
});

test("only the tracked team is ranked, once per tier from 特等马 to 没有马", () => {
  const detail = testMatch("RANK-ORDER", ["tracked"], "win");
  const ranking = rankTeam(detail, "tracked");
  assert.equal(ranking.won, true);
  assert.deepEqual(ranking.horses.map((horse) => horse.tier), [...HORSE_TIERS]);
  assert.deepEqual(ranking.horses.map((horse) => horse.rank), [1, 2, 3, 4, 5]);
  assert.ok(ranking.horses.every((horse) => horse.participant.teamId === 100));
  for (let index = 1; index < ranking.horses.length; index++) {
    assert.ok(ranking.horses[index - 1].score >= ranking.horses[index].score);
  }
  assert.ok(ranking.horses.every((horse) => horse.score >= 0 && horse.score <= 10));
});

test("mock matches have consistent kills, deaths and kill participation", () => {
  for (const outcome of ["win", "loss"] as const) {
    const players = testMatch(`CONSISTENT-${outcome}`, ["tracked"], outcome).info.participants;
    const total = (teamId: number, key: "kills" | "deaths") =>
      players.filter((player) => player.teamId === teamId).reduce((sum, player) => sum + player[key], 0);
    assert.equal(total(100, "kills"), total(200, "deaths"), outcome);
    assert.equal(total(200, "kills"), total(100, "deaths"), outcome);
    for (const player of players) assert.ok(player.kills + player.assists < total(player.teamId, "kills"), `${outcome} ${player.puuid}`);
  }
});

test("a sacrificing support outranks a feeding carry instead of following KDA", () => {
  for (const outcome of ["win", "loss"] as const) {
    const ranking = rankTeam(testMatch(`SUPPORT-${outcome}`, ["tracked"], outcome), "tracked");
    const tierOf = (position: string) => ranking.horses.find((horse) => horse.participant.position === position)!.tier;
    // The fixture support has 0 kills but excellent vision and protection.
    assert.notEqual(tierOf("UTILITY"), "没有马");
    assert.equal(tierOf("BOTTOM"), "没有马");
    const support = ranking.horses.find((horse) => horse.participant.position === "UTILITY")!;
    assert.ok(["vision", "utility", "teamfight"].includes(support.strengths[0]), `support excels in ${support.strengths[0]}`);
  }
});

test("the same statistics are judged against the player's own position", () => {
  const detail = testMatch("SAME-STATS", ["tracked"]);
  const copy = (position: MatchParticipant["position"]) => {
    const match: MatchDetail = structuredClone(detail);
    const player = match.info.participants[0];
    player.position = position;
    player.stats = { ...player.stats, visionScore: 60, totalMinionsKilled: 20, neutralMinionsKilled: 0 };
    return scoreParticipant(match, player).dimensions;
  };
  // Sixty vision in thirty minutes is outstanding for a carry but routine for a support.
  assert.ok(copy("BOTTOM").vision! > copy("UTILITY").vision!);
  assert.ok(copy("UTILITY").economy! > copy("BOTTOM").economy!);
});

test("missing statistics and positions still produce a bounded score", () => {
  const detail = testMatch("SPARSE", ["tracked"]);
  for (const player of detail.info.participants) {
    player.stats = {};
    player.position = null;
  }
  detail.info.teams = [];
  const ranking = rankTeam(detail, "tracked");
  assert.equal(ranking.horses.length, 5);
  assert.ok(ranking.horses.every((horse) => horse.score >= 0 && horse.score <= 10));
  assert.ok(ranking.horses.every((horse) => horse.features.goldPerMinute === undefined));
});

test("features are normalized by game length and team totals", () => {
  const detail = testMatch("FEATURES", ["tracked"], "win");
  const tracked = detail.info.participants[0];
  const features = extractFeatures(detail, tracked);
  assert.equal(features.goldPerMinute, tracked.stats.goldEarned! / 30);
  assert.equal(features.deathsPerMinute, tracked.deaths / 30);
  const teamDamage = detail.info.participants.filter((player) => player.teamId === 100)
    .reduce((sum, player) => sum + player.stats.totalDamageDealtToChampions!, 0);
  assert.equal(features.damageShare, tracked.stats.totalDamageDealtToChampions! / teamDamage);
  const opponent = detail.info.participants.find((player) => player.teamId === 200 && player.position === "MIDDLE")!;
  assert.equal(features.goldDiffPerMinute, (tracked.stats.goldEarned! - opponent.stats.goldEarned!) / 30);
  assert.deepEqual(extractFeatures({ ...detail, info: { ...detail.info, gameDuration: 0 } }, tracked), {});
});

test("ties are ordered deterministically", () => {
  const detail = testMatch("TIES", ["tracked"]);
  const allies = detail.info.participants.filter((player) => player.teamId === 100);
  for (const player of allies) {
    player.position = "MIDDLE";
    player.kills = 3; player.deaths = 3; player.assists = 3;
    player.stats = { ...allies[0].stats };
  }
  const order = rankTeam(detail, "tracked").horses.map((horse) => horse.participant.puuid);
  assert.deepEqual(order, [...order].sort());
});

test("benchmarks built from matches calibrate each position to the full 0-10 range", () => {
  const matches = Array.from({ length: 30 }, (_, index) => {
    const match = testMatch(`BENCH-${index}`, ["tracked"], index % 2 ? "win" : "loss");
    for (const player of match.info.participants) {
      for (const key of Object.keys(player.stats) as Array<keyof typeof player.stats>) {
        player.stats[key] = player.stats[key]! * (0.5 + ((index * 7 + player.championId) % 11) / 10);
      }
    }
    return match;
  });
  const benchmarks = buildBenchmarks(matches, { matches: 30, tiers: [], patches: [], collectedAt: "test" }, 21);
  assert.equal(benchmarks.roles.UTILITY.samples, 60);
  assert.equal(benchmarks.roles.ALL.samples, 300);
  assert.equal(benchmarks.roles.TOP.composite.length, 21);
  const scores = matches.flatMap((match) => rankTeam(match, "tracked", benchmarks).horses.map((horse) => horse.score));
  assert.ok(Math.min(...scores) < 1 && Math.max(...scores) > 9);
});

test("the committed benchmarks come from a real multi-tier sample", () => {
  assert.ok(DEFAULT_BENCHMARKS.sample.matches >= 150);
  assert.ok(DEFAULT_BENCHMARKS.sample.tiers.length >= 3);
  for (const role of ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY", "ALL"] as const) {
    assert.ok(DEFAULT_BENCHMARKS.roles[role].samples > 0);
    assert.equal(DEFAULT_BENCHMARKS.roles[role].composite.length, 41);
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { extractMatchEvents, fetchMatchEvents, strongestEvent } from "../src/services/matchEvents";
import type { MatchEvent } from "../src/services/matchEvents";
import { parseMatchTimeline } from "../src/utils/matchTimeline";
import type { MatchTimeline, TimelineEvent } from "../src/utils/matchTimeline";
import { testMatch, testMatchWithTimeline } from "./helpers/matches";

// Participant IDs follow the fixture order: 1 tracked mid, 2 top, 3 jungle, 4 ADC, 5 support; 6-10 the enemy mid, top, jungle, ADC, support.
const detail = testMatch("EVENTS", ["tracked"], "win");
const PUUIDS = detail.metadata.participants;
const timeline = (events: TimelineEvent[], matchId = "EVENTS"): MatchTimeline => ({
  matchId, participants: new Map(PUUIDS.map((puuid, index) => [index + 1, puuid])), events,
});
const kill = (seconds: number, killerId: number, victimId: number, assistIds: number[] = [], shutdownBounty = 0): TimelineEvent =>
  ({ type: "kill", timestamp: seconds * 1000, killerId, victimId, assistIds, shutdownBounty });
const monster = (seconds: number, teamId: number, kind: "BARON" | "DRAGON" | "ELDER" | "HERALD" = "DRAGON"): TimelineEvent =>
  ({ type: "monster", timestamp: seconds * 1000, killerId: teamId === 100 ? 3 : 8, teamId, monster: kind });
const events = (...timelineEvents: TimelineEvent[]) => extractMatchEvents(detail, timeline(timelineEvents));
const kinds = (list: MatchEvent[], puuid: string) => list.filter((event) => event.puuid === puuid).map((event) => event.kind);

test("mock timelines account for every kill, death, assist and epic monster in the match", () => {
  for (const outcome of ["win", "loss"] as const) {
    const { detail: match, timeline: mock } = testMatchWithTimeline(`TIMELINE-${outcome}`, ["tracked"], outcome);
    for (const [participantId, puuid] of mock.participants) {
      const player = match.info.participants.find((participant) => participant.puuid === puuid)!;
      const kills = mock.events.filter((event) => event.type === "kill");
      assert.equal(kills.filter((event) => event.killerId === participantId).length, player.kills, `${outcome} kills of ${participantId}`);
      assert.equal(kills.filter((event) => event.victimId === participantId).length, player.deaths, `${outcome} deaths of ${participantId}`);
      assert.equal(kills.filter((event) => event.assistIds.includes(participantId)).length, player.assists, `${outcome} assists of ${participantId}`);
    }
    for (const team of match.info.teams) {
      const taken = (kind: string) => mock.events.filter((event) => event.type === "monster" && event.teamId === team.teamId && event.monster === kind).length;
      assert.deepEqual([taken("DRAGON"), taken("BARON"), taken("HERALD")], [team.dragon, team.baron, team.riftHerald], `${outcome} team ${team.teamId}`);
    }
  }
});

test("mock games give the support a won objective fight and the ADC the first death of a lost one", () => {
  const win = testMatchWithTimeline("MOMENTS-WIN", ["tracked"], "win");
  const winEvents = extractMatchEvents(win.detail, win.timeline);
  assert.deepEqual(strongestEvent(winEvents, "MOCK-ALLY-4", "praise"), { puuid: "MOCK-ALLY-4", timestamp: 1_470_000, kind: "wonFight", takedowns: 4, monster: "BARON" });
  assert.deepEqual(strongestEvent(winEvents, "MOCK-ALLY-3", "roast"), { puuid: "MOCK-ALLY-3", timestamp: 850_000, kind: "lostFightFirstDeath", monster: "DRAGON" });
  // A triple kill outranks the same player's won fight.
  assert.deepEqual(strongestEvent(winEvents, "tracked", "praise"), { puuid: "tracked", timestamp: 1_481_000, kind: "multiKill", kills: 3 });

  const loss = testMatchWithTimeline("MOMENTS-LOSS", ["tracked"], "loss");
  const lossEvents = extractMatchEvents(loss.detail, loss.timeline);
  assert.deepEqual(strongestEvent(lossEvents, "MOCK-ALLY-4", "praise"), { puuid: "MOCK-ALLY-4", timestamp: 730_000, kind: "wonFight", takedowns: 3, monster: "DRAGON" });
  assert.deepEqual(strongestEvent(lossEvents, "MOCK-ALLY-3", "roast"), { puuid: "MOCK-ALLY-3", timestamp: 1_360_000, kind: "lostFightFirstDeath", monster: "BARON" });
  assert.deepEqual(kinds(lossEvents, "MOCK-ALLY-2"), ["wonFight", "objectiveDeath", "shutdown"]);
  assert.deepEqual(kinds(lossEvents, "tracked"), ["firstBloodGiven", "objectiveDeath"]);
  assert.deepEqual(extractMatchEvents(loss.detail, loss.timeline), lossEvents, "deterministic");
});

test("a fight needs three deaths no more than 15 seconds apart", () => {
  assert.deepEqual(kinds(events(kill(600, 6, 4), kill(610, 7, 5)), "MOCK-ALLY-3").filter((kind) => kind.includes("Fight")), []);
  assert.deepEqual(kinds(events(kill(600, 6, 4), kill(610, 7, 5), kill(626, 8, 2)), "MOCK-ALLY-3").filter((kind) => kind.includes("Fight")), []);
  assert.ok(kinds(events(kill(600, 6, 4), kill(610, 7, 5), kill(625, 8, 2)), "MOCK-ALLY-3").includes("lostFightFirstDeath"));
});

test("the first to fall is roasted only when their team did not win the fight", () => {
  const lost = events(kill(600, 6, 4), kill(605, 1, 8), kill(610, 7, 5), monster(650, 200));
  assert.deepEqual(lost.find((event) => event.kind === "lostFightFirstDeath"), { puuid: "MOCK-ALLY-3", timestamp: 600_000, kind: "lostFightFirstDeath", monster: "DRAGON" });
  const won = events(kill(600, 6, 4), kill(605, 1, 8, [5]), kill(610, 1, 9, [5]));
  assert.equal(won.find((event) => event.kind === "lostFightFirstDeath"), undefined);
  // A monster taken more than 45 seconds after the last death is not tied to the fight.
  const late = events(kill(600, 6, 4), kill(605, 1, 8), kill(610, 7, 5), monster(656, 200));
  assert.equal(late.find((event) => event.kind === "lostFightFirstDeath" && "monster" in event && event.monster), undefined);
});

test("a won fight is praised from three takedowns for a teammate who survived it", () => {
  const fight = [kill(600, 1, 6, [5]), kill(604, 1, 7, [5]), kill(608, 3, 8, [1, 5]), kill(612, 9, 2), monster(640, 100, "BARON")];
  assert.deepEqual(events(...fight).filter((event) => event.kind === "wonFight"), [
    { puuid: "tracked", timestamp: 600_000, kind: "wonFight", takedowns: 3, monster: "BARON" },
    { puuid: "MOCK-ALLY-4", timestamp: 600_000, kind: "wonFight", takedowns: 3, monster: "BARON" },
  ]);
  assert.deepEqual(events(kill(600, 1, 6, [5]), kill(604, 1, 7, [5]), kill(608, 3, 8), kill(612, 9, 5)).filter((event) => event.kind === "wonFight"), [],
    "the support died and the mid has only two takedowns");
});

test("multi-kills count from a triple kill and shutdowns from 400 gold", () => {
  const multi = (length: number): TimelineEvent => ({ type: "multiKill", timestamp: 900_000 + length, killerId: 1, length });
  assert.deepEqual(events(multi(2)).filter((event) => event.kind === "multiKill"), []);
  assert.deepEqual(strongestEvent(events(multi(2), multi(3), multi(4)), "tracked", "praise"), { puuid: "tracked", timestamp: 900_004, kind: "multiKill", kills: 4 });
  assert.deepEqual(events(kill(300, 6, 2), kill(900, 1, 6, [], 399)).filter((event) => event.kind.startsWith("shutdown")), []);
  assert.deepEqual(events(kill(300, 6, 2), kill(900, 1, 6, [], 400)).filter((event) => event.kind.startsWith("shutdown")), [
    { puuid: "tracked", timestamp: 900_000, kind: "shutdown", bounty: 400, enemy: "MIDDLE" },
    { puuid: "MOCK-ENEMY-1", timestamp: 900_000, kind: "shutdownGiven", bounty: 400, enemy: "MIDDLE" },
  ]);
});

test("first blood is the first death, and an execution awards none", () => {
  assert.deepEqual(events(kill(200, 2, 7), kill(260, 6, 1, [8])).filter((event) => event.kind.startsWith("firstBlood")), [
    { puuid: "MOCK-ALLY-1", timestamp: 200_000, kind: "firstBlood", solo: true, enemy: "TOP" },
    { puuid: "MOCK-ENEMY-2", timestamp: 200_000, kind: "firstBloodGiven", enemy: "TOP" },
  ]);
  assert.deepEqual(events(kill(150, 0, 4), kill(200, 2, 7)).filter((event) => event.kind.startsWith("firstBlood")), []);
});

test("a death the enemy turns into an epic monster within 45 seconds is an objective death", () => {
  assert.deepEqual(events(kill(1000, 0, 4), monster(1045, 200, "ELDER")).filter((event) => event.kind === "objectiveDeath"),
    [{ puuid: "MOCK-ALLY-3", timestamp: 1_000_000, kind: "objectiveDeath", monster: "ELDER" }]);
  assert.deepEqual(events(kill(1000, 6, 4), monster(1046, 200)).filter((event) => event.kind === "objectiveDeath"), []);
  assert.deepEqual(events(kill(1000, 6, 4), monster(1020, 100)).filter((event) => event.kind === "objectiveDeath"), [], "own team took it");
});

test("the strongest moment wins by kind, then monster, then size, then time", () => {
  const list: MatchEvent[] = [
    { puuid: "p", timestamp: 1, kind: "firstBloodGiven", enemy: "TOP" },
    { puuid: "p", timestamp: 5, kind: "lostFightFirstDeath" },
    { puuid: "p", timestamp: 9, kind: "objectiveDeath", monster: "DRAGON" },
    { puuid: "p", timestamp: 7, kind: "objectiveDeath", monster: "BARON" },
    { puuid: "p", timestamp: 3, kind: "objectiveDeath", monster: "BARON" },
    { puuid: "p", timestamp: 2, kind: "multiKill", kills: 5 },
    { puuid: "q", timestamp: 0, kind: "lostFightFirstDeath", monster: "BARON" },
  ];
  assert.deepEqual(strongestEvent(list, "p", "roast"), { puuid: "p", timestamp: 3, kind: "objectiveDeath", monster: "BARON" });
  assert.deepEqual(strongestEvent(list, "p", "praise"), { puuid: "p", timestamp: 2, kind: "multiKill", kills: 5 });
  assert.equal(strongestEvent(list, "r", "roast"), undefined);
  assert.equal(strongestEvent(null, "p", "roast"), undefined);
  assert.deepEqual(extractMatchEvents(detail, timeline([kill(200, 2, 7)], "OTHER")), [], "a timeline for another match is ignored");
});

test("timeline parsing keeps supported events, maps participants and rejects broken shapes", () => {
  const parsed = parseMatchTimeline({
    metadata: { matchId: "NA1_TL", participants: ["a", "b"] },
    info: {
      frames: [
        { timestamp: 0, events: [{ type: "PAUSE_END", timestamp: 0 }] },
        { timestamp: 60_000, events: [
          { type: "CHAMPION_KILL", timestamp: 59_000, killerId: 2, victimId: 1, assistingParticipantIds: [3, 3, 11, "x"], shutdownBounty: 450, bounty: 300 },
          { type: "CHAMPION_KILL", timestamp: 58_000, killerId: 0, victimId: 2 },
          { type: "CHAMPION_KILL", timestamp: 57_000, victimId: 2 },
          { type: "CHAMPION_SPECIAL_KILL", killType: "KILL_MULTI", timestamp: 59_000, killerId: 2, multiKillLength: 6 },
          { type: "CHAMPION_SPECIAL_KILL", killType: "KILL_FIRST_BLOOD", timestamp: 59_000, killerId: 2 },
          { type: "ELITE_MONSTER_KILL", timestamp: 59_500, killerId: 2, killerTeamId: 100, monsterType: "DRAGON", monsterSubType: "ELDER_DRAGON" },
          { type: "ELITE_MONSTER_KILL", timestamp: 59_600, killerId: 2, killerTeamId: 100, monsterType: "HORDE" },
          { type: "ELITE_MONSTER_KILL", timestamp: 59_700, killerId: 7, monsterType: "RIFTHERALD" },
          null,
        ] },
        { timestamp: 120_000 },
      ],
    },
  }, "NA1_TL");
  assert.deepEqual([...parsed.participants], [[1, "a"], [2, "b"]], "falls back to metadata order");
  assert.deepEqual(parsed.events, [
    { type: "kill", timestamp: 58_000, killerId: 0, victimId: 2, assistIds: [], shutdownBounty: 0 },
    { type: "kill", timestamp: 59_000, killerId: 2, victimId: 1, assistIds: [3], shutdownBounty: 450 },
    { type: "multiKill", timestamp: 59_000, killerId: 2, length: 5 },
    { type: "monster", timestamp: 59_500, killerId: 2, teamId: 100, monster: "ELDER" },
    { type: "monster", timestamp: 59_700, killerId: 7, teamId: 0, monster: "HERALD" },
  ]);
  const withParticipants = parseMatchTimeline({
    metadata: { matchId: "NA1_TL", participants: ["ignored"] },
    info: { frames: [], participants: [{ participantId: 1, puuid: "p1" }, { participantId: 12, puuid: "bad" }] },
  }, "NA1_TL");
  assert.deepEqual([...withParticipants.participants], [[1, "p1"]]);
  assert.throws(() => parseMatchTimeline({ metadata: { matchId: "OTHER" }, info: { frames: [] } }, "NA1_TL"), { code: "invalid_response" });
  assert.throws(() => parseMatchTimeline({ metadata: { matchId: "NA1_TL", participants: ["a"] }, info: {} }, "NA1_TL"), { code: "invalid_response" });
  assert.throws(() => parseMatchTimeline({ metadata: { matchId: "NA1_TL" }, info: { frames: [] } }, "NA1_TL"), { code: "invalid_response" });
});

test("fetching moments returns null and logs instead of failing the announcement", async () => {
  const { detail: match, timeline: mock } = testMatchWithTimeline("FETCH", ["tracked"], "win");
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  assert.ok((await fetchMatchEvents("FETCH", match, { timeline: async () => mock, warn }))!.length > 0);
  assert.equal(await fetchMatchEvents("FETCH", match, { timeline: async () => { throw new Error("upstream broke"); }, warn }), null);
  const keepAlive = setTimeout(() => undefined, 100);
  try {
    assert.equal(await fetchMatchEvents("FETCH", match, { timeline: () => new Promise(() => undefined), warn, timeoutMs: 10 }), null);
  } finally { clearTimeout(keepAlive); }
  assert.match(warnings[0], /FETCH is unavailable \(upstream broke\); the report uses end-of-game statistics only/);
  assert.match(warnings[1], /timeout: Riot API timeline request timed out/);
  const remake = testMatch("FETCH-REMAKE", ["tracked"]);
  remake.info.earlySurrender = true;
  assert.equal(await fetchMatchEvents("FETCH-REMAKE", remake, { timeline: async () => assert.fail("remakes are not judged"), warn }), null);
  assert.equal(warnings.length, 2);
});

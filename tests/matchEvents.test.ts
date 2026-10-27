import assert from "node:assert/strict";
import { test } from "node:test";
import { extractMatchEvents, fetchMatchEvents, MONSTER_PITS, strongestEvent } from "../src/services/matchEvents";
import type { MatchEvent } from "../src/services/matchEvents";
import { parseMatchTimeline } from "../src/utils/matchTimeline";
import type { MapPoint, MatchTimeline, TimelineEvent } from "../src/utils/matchTimeline";
import { testMatch, testMatchWithTimeline } from "./helpers/matches";

// Participant IDs follow the fixture order: 1 tracked mid, 2 top, 3 jungle, 4 ADC, 5 support; 6-10 the enemy mid, top, jungle, ADC, support.
const detail = testMatch("EVENTS", ["tracked"], "win");
const PUUIDS = detail.metadata.participants;
const DRAGON = MONSTER_PITS.DRAGON;
const BARON = MONSTER_PITS.BARON;
const TOP_LANE = { x: 1500, y: 12500 };
const MID_LANE = { x: 7400, y: 7400 };
const timeline = (events: TimelineEvent[], matchId = "EVENTS"): MatchTimeline => ({
  matchId, participants: new Map(PUUIDS.map((puuid, index) => [index + 1, puuid])), events,
});
/** A champion kill, by default at the dragon pit. */
const kill = (seconds: number, killerId: number, victimId: number, assistIds: number[] = [], extra: { bounty?: number; at?: MapPoint | null } = {}): TimelineEvent =>
  ({ type: "kill", timestamp: seconds * 1000, killerId, victimId, assistIds, shutdownBounty: extra.bounty ?? 0, position: extra.at === undefined ? DRAGON : extra.at });
const monster = (seconds: number, teamId: number, kind: "BARON" | "DRAGON" | "ELDER" | "HERALD" = "DRAGON"): TimelineEvent =>
  ({ type: "monster", timestamp: seconds * 1000, killerId: teamId === 100 ? 3 : 8, teamId, monster: kind });
const firstBlood = (seconds: number, killerId: number): TimelineEvent => ({ type: "firstBlood", timestamp: seconds * 1000, killerId });
const events = (...timelineEvents: TimelineEvent[]) => extractMatchEvents(detail, timeline(timelineEvents));
const kinds = (list: MatchEvent[], puuid: string) => list.filter((event) => event.puuid === puuid).map((event) => event.kind);
const fightKinds = (list: MatchEvent[]) => list.filter((event) => event.kind.includes("Fight"));

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
    assert.ok(mock.events.every((event) => event.type !== "kill" || event.position), "every mock death has a position");
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
  // Only the first teammate down at the dragon is told they fell first.
  assert.deepEqual(kinds(winEvents, "MOCK-ALLY-4"), ["wonFight"]);
  assert.deepEqual(kinds(winEvents, "MOCK-ALLY-1"), []);

  const loss = testMatchWithTimeline("MOMENTS-LOSS", ["tracked"], "loss");
  const lossEvents = extractMatchEvents(loss.detail, loss.timeline);
  assert.deepEqual(strongestEvent(lossEvents, "MOCK-ALLY-4", "praise"), { puuid: "MOCK-ALLY-4", timestamp: 730_000, kind: "wonFight", takedowns: 3, monster: "DRAGON" });
  assert.deepEqual(strongestEvent(lossEvents, "MOCK-ALLY-3", "roast"), { puuid: "MOCK-ALLY-3", timestamp: 1_360_000, kind: "lostFightFirstDeath", monster: "BARON" });
  assert.deepEqual(kinds(lossEvents, "MOCK-ALLY-2"), ["wonFight", "shutdown"]);
  assert.deepEqual(kinds(lossEvents, "tracked"), ["firstBloodGiven"]);
  assert.deepEqual(extractMatchEvents(loss.detail, loss.timeline), lossEvents, "deterministic");
});

test("a fight needs three deaths close in time and place, within one minute", () => {
  assert.deepEqual(fightKinds(events(kill(600, 6, 4), kill(610, 7, 5))), []);
  assert.deepEqual(fightKinds(events(kill(600, 6, 4), kill(610, 7, 5), kill(626, 8, 2))), [], "a 16 second gap splits the deaths");
  assert.equal(fightKinds(events(kill(600, 6, 4), kill(610, 7, 5), kill(625, 8, 2))).length, 1);
  // Deaths in three lanes at the same moment are not one fight.
  assert.deepEqual(fightKinds(events(kill(600, 7, 2, [], { at: TOP_LANE }), kill(604, 6, 1, [], { at: MID_LANE }), kill(608, 9, 4))), []);
  // A death far from the fight's previous death and centroid does not join it.
  assert.deepEqual(fightKinds(events(kill(600, 6, 4), kill(605, 7, 5), kill(610, 8, 2, [], { at: { x: DRAGON.x - 3100, y: DRAGON.y } }))), []);
  assert.deepEqual(fightKinds(events(kill(600, 6, 4), kill(605, 7, 5), kill(610, 8, 2, [], { at: null }))), [], "no position, no fight");
  // Six deaths 14 seconds apart: the sixth is more than a minute after the first, so it starts a new run.
  const long = events(kill(600, 6, 4), kill(614, 1, 7), kill(628, 8, 5), kill(642, 3, 9), kill(656, 6, 2), kill(670, 10, 1));
  assert.deepEqual(fightKinds(long).map((event) => [event.kind, event.puuid]), [["lostFightFirstDeath", "MOCK-ALLY-3"]]);
});

test("repro: only the first teammate down before an enemy dragon is told they fell first", () => {
  // Support 15:00, ADC 15:05, jungle 15:10, enemy dragon 15:30.
  const list = events(kill(900, 9, 5), kill(905, 10, 4), kill(910, 8, 3), monster(930, 200));
  assert.deepEqual(list.filter((event) => event.puuid !== "MOCK-ALLY-4"), [], "ADC and jungle get nothing");
  assert.deepEqual(kinds(list, "MOCK-ALLY-4"), ["objectiveDeath", "lostFightFirstDeath"]);
});

test("repro: a top lane death never becomes the first death of a dragon fight", () => {
  // Top dies in top lane 15:00, ADC and support near dragon 15:10 and 15:20, enemy dragon 15:50.
  const list = events(kill(900, 7, 2, [], { at: TOP_LANE }), kill(910, 9, 4), kill(920, 10, 5), monster(950, 200));
  assert.deepEqual(kinds(list, "MOCK-ALLY-1"), []);
  assert.deepEqual(fightKinds(list), []);
  assert.deepEqual(list, [{ puuid: "MOCK-ALLY-3", timestamp: 910_000, kind: "objectiveDeath", monster: "DRAGON" }]);
});

test("the first to fall is roasted only when their team did not win, and named after a monster only at its pit", () => {
  const lost = events(kill(600, 6, 4), kill(605, 1, 8), kill(610, 7, 5), monster(650, 200));
  assert.deepEqual(lost.find((event) => event.kind === "lostFightFirstDeath"), { puuid: "MOCK-ALLY-3", timestamp: 600_000, kind: "lostFightFirstDeath", monster: "DRAGON" });
  const won = events(kill(600, 6, 4), kill(605, 1, 8, [5]), kill(610, 1, 9, [5]));
  assert.equal(won.find((event) => event.kind === "lostFightFirstDeath"), undefined);
  // A monster taken more than 45 seconds after the last death is not tied to the fight.
  const late = events(kill(600, 6, 4), kill(605, 1, 8), kill(610, 7, 5), monster(656, 200));
  assert.deepEqual(late.find((event) => event.kind === "lostFightFirstDeath"), { puuid: "MOCK-ALLY-3", timestamp: 600_000, kind: "lostFightFirstDeath" });
  // A mid lane fight is a plain fight even when the enemy takes the dragon right after.
  const mid = events(kill(600, 6, 4, [], { at: MID_LANE }), kill(605, 1, 8, [], { at: MID_LANE }), kill(610, 7, 5, [], { at: MID_LANE }), monster(630, 200));
  assert.deepEqual(fightKinds(mid), [{ puuid: "MOCK-ALLY-3", timestamp: 600_000, kind: "lostFightFirstDeath" }]);
});

test("a won fight is praised from three takedowns for a teammate who survived it", () => {
  const at = { at: BARON };
  const fight = [kill(600, 1, 6, [5], at), kill(604, 1, 7, [5], at), kill(608, 3, 8, [1, 5], at), kill(612, 9, 2, [], at), monster(640, 100, "BARON")];
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
  assert.deepEqual(events(kill(900, 1, 6, [], { bounty: 399, at: MID_LANE })).filter((event) => event.kind.startsWith("shutdown")), []);
  assert.deepEqual(events(kill(900, 1, 6, [], { bounty: 400, at: MID_LANE })).filter((event) => event.kind.startsWith("shutdown")), [
    { puuid: "tracked", timestamp: 900_000, kind: "shutdown", bounty: 400, enemy: "MIDDLE" },
    { puuid: "MOCK-ENEMY-1", timestamp: 900_000, kind: "shutdownGiven", bounty: 400, enemy: "MIDDLE" },
  ]);
});

test("first blood comes from Riot's first blood award, not from the first death", () => {
  const top = { at: TOP_LANE };
  // An execution comes first; Riot awards first blood for the later champion kill.
  assert.deepEqual(events(kill(150, 0, 4, [], top), kill(200, 2, 7, [], top), firstBlood(200, 2), kill(260, 6, 1, [8], top))
    .filter((event) => event.kind.startsWith("firstBlood")), [
    { puuid: "MOCK-ALLY-1", timestamp: 200_000, kind: "firstBlood", solo: true, enemy: "TOP" },
    { puuid: "MOCK-ENEMY-2", timestamp: 200_000, kind: "firstBloodGiven", enemy: "TOP" },
  ]);
  assert.deepEqual(events(kill(200, 2, 7, [], top)).filter((event) => event.kind.startsWith("firstBlood")), [], "no award, no first blood");
  // An award without its kill still praises the killer, without naming a victim position.
  assert.deepEqual(events(firstBlood(200, 2)).filter((event) => event.kind.startsWith("firstBlood")), [
    { puuid: "MOCK-ALLY-1", timestamp: 200_000, kind: "firstBlood", solo: false, enemy: null },
  ]);
});

test("an objective death is the team's first death at that pit within 45 seconds of the monster", () => {
  assert.deepEqual(events(kill(1000, 0, 4), monster(1045, 200, "ELDER")),
    [{ puuid: "MOCK-ALLY-3", timestamp: 1_000_000, kind: "objectiveDeath", monster: "ELDER" }], "an execution at the pit counts");
  assert.deepEqual(events(kill(1000, 6, 4), monster(1046, 200)).filter((event) => event.kind === "objectiveDeath"), [], "46 seconds is too early");
  assert.deepEqual(events(kill(1000, 6, 4), monster(1020, 100)).filter((event) => event.kind === "objectiveDeath"), [], "own team took it");
  assert.deepEqual(events(kill(1000, 6, 4, [], { at: MID_LANE }), monster(1020, 200)).filter((event) => event.kind === "objectiveDeath"), [], "away from the pit");
  assert.deepEqual(events(kill(1000, 6, 4, [], { at: BARON }), monster(1020, 200)).filter((event) => event.kind === "objectiveDeath"), [], "at the other pit");
  // The support fell at the pit 20 seconds before the ADC, just outside the window: the ADC did not fall first.
  assert.deepEqual(events(kill(980, 6, 5), kill(1000, 6, 4), monster(1030, 200)).filter((event) => event.kind === "objectiveDeath"), []);
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
  assert.deepEqual(extractMatchEvents(detail, timeline([kill(200, 2, 7), firstBlood(200, 2)], "OTHER")), [], "a timeline for another match is ignored");
});

test("timeline parsing keeps supported events, maps participants and rejects broken shapes", () => {
  const parsed = parseMatchTimeline({
    metadata: { matchId: "NA1_TL", participants: ["a", "b"] },
    info: {
      frames: [
        { timestamp: 0, events: [{ type: "PAUSE_END", timestamp: 0 }] },
        { timestamp: 60_000, events: [
          { type: "CHAMPION_KILL", timestamp: 59_000, killerId: 2, victimId: 1, assistingParticipantIds: [3, 3, 11, "x"], shutdownBounty: 450, bounty: 300,
            killStreakLength: 2, position: { x: 9800, y: 4400 }, victimDamageReceived: [] },
          { type: "CHAMPION_KILL", timestamp: 58_000, killerId: 0, victimId: 2, position: { x: "1", y: 2 } },
          { type: "CHAMPION_KILL", timestamp: 57_000, victimId: 2 },
          { type: "CHAMPION_SPECIAL_KILL", killType: "KILL_MULTI", timestamp: 59_000, killerId: 2, multiKillLength: 6 },
          { type: "CHAMPION_SPECIAL_KILL", killType: "KILL_FIRST_BLOOD", timestamp: 59_000, killerId: 2, position: { x: 9800, y: 4400 } },
          { type: "CHAMPION_SPECIAL_KILL", killType: "KILL_FIRST_BLOOD", timestamp: 59_000, killerId: 0 },
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
    { type: "kill", timestamp: 58_000, killerId: 0, victimId: 2, assistIds: [], shutdownBounty: 0, position: null },
    { type: "kill", timestamp: 59_000, killerId: 2, victimId: 1, assistIds: [3], shutdownBounty: 450, position: { x: 9800, y: 4400 } },
    { type: "multiKill", timestamp: 59_000, killerId: 2, length: 5 },
    { type: "firstBlood", timestamp: 59_000, killerId: 2 },
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
  assert.deepEqual(warnings, ["Timeline for match FETCH is unavailable (upstream broke); the report uses end-of-game statistics only."]);
  const remake = testMatch("FETCH-REMAKE", ["tracked"]);
  remake.info.earlySurrender = true;
  assert.equal(await fetchMatchEvents("FETCH-REMAKE", remake, { timeline: async () => assert.fail("remakes are not judged"), warn }), null);
  assert.equal(warnings.length, 1);
});

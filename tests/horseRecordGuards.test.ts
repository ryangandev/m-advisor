import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { removeTrackedMember, setMemberAccounts } from "../src/store/bindingStore";
import { closeDatabase } from "../src/store/database";
import { UntrackedMemberError, listHorseRecords, listMatchHorseRecords, recordHorseRecords } from "../src/store/horseRecordStore";
import { makeHorseRecord, recordTracked } from "./helpers/horseRecords";

let directory: string;
let savedDatabasePath: string | undefined;

beforeEach(() => {
  closeDatabase();
  savedDatabasePath = process.env.DATABASE_PATH;
  directory = mkdtempSync(join(tmpdir(), "m-advisor-horse-guards-"));
  process.env.DATABASE_PATH = join(directory, "bot.sqlite3");
});

afterEach(() => {
  closeDatabase();
  if (savedDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = savedDatabasePath;
  rmSync(directory, { recursive: true, force: true });
});

test("a record for a member who does not own that account is refused and the whole batch is dropped", () => {
  setMemberAccounts("guild-one", "member-one", [{ puuid: "account-a", gameName: "Player A", tagLine: "NA1" }]);
  const good = makeHorseRecord({ matchId: "NA1_BOUND" });

  // A stranger, a tracked member with someone else's account, and a tracked member in the wrong server.
  assert.throws(
    () => recordHorseRecords([good, makeHorseRecord({ matchId: "NA1_X", discordUserId: "stranger", puuid: "account-s" })]),
    (error: unknown) => error instanceof UntrackedMemberError && error.discordUserId === "stranger" && error.puuid === "account-s",
  );
  assert.throws(() => recordHorseRecords([makeHorseRecord({ matchId: "NA1_X", puuid: "account-other" })]), UntrackedMemberError);
  assert.throws(() => recordHorseRecords([makeHorseRecord({ matchId: "NA1_X", guildId: "guild-two" })]), UntrackedMemberError);
  assert.deepEqual(listHorseRecords("guild-one", { mock: false }), []);
  assert.deepEqual(listHorseRecords("guild-two", { mock: false }), []);

  assert.equal(recordHorseRecords([good]), 1);
  // Once the member is unbound nothing more is recorded for them, while the old record stays.
  removeTrackedMember("guild-one", "member-one");
  assert.throws(() => recordHorseRecords([makeHorseRecord({ matchId: "NA1_LATE" })]), UntrackedMemberError);
  assert.deepEqual(listHorseRecords("guild-one", { mock: false }).map((record) => record.matchId), ["NA1_BOUND"]);
});

test("a rebound member can only record through the account they own now", () => {
  setMemberAccounts("guild-one", "member-one", [{ puuid: "account-a", gameName: "Player A", tagLine: "NA1" }]);
  setMemberAccounts("guild-one", "member-one", [{ puuid: "account-new", gameName: "New", tagLine: "NA1" }]);
  assert.throws(() => recordHorseRecords([makeHorseRecord({ matchId: "NA1_OLD" })]), UntrackedMemberError);
  assert.equal(recordHorseRecords([makeHorseRecord({ matchId: "NA1_NEW", puuid: "account-new" })]), 1);
});

test("a mock and a real record of the same match ID cannot collide", () => {
  const real = makeHorseRecord({ matchId: "SAME_ID", tier: "特等马" });
  const mock = { ...real, mock: true, tier: "没有马" as const };
  assert.equal(recordTracked([real]), 1);
  assert.equal(recordTracked([mock]), 1);
  assert.equal(recordTracked([real, mock]), 0);
  assert.deepEqual(listHorseRecords("guild-one", { mock: false }).map((record) => record.tier), ["特等马"]);
  assert.deepEqual(listHorseRecords("guild-one", { mock: true }).map((record) => record.tier), ["没有马"]);
  assert.deepEqual(listMatchHorseRecords("guild-one", "SAME_ID", true).map((record) => record.tier), ["没有马"]);
});

test("a match's records come back grouped by team, best first, so opposite teams are never ranked together", () => {
  recordTracked([
    makeHorseRecord({ matchId: "NA1_TEAMS", discordUserId: "blue-low", puuid: "p-bl", teamId: 100, teamRank: 4 }),
    makeHorseRecord({ matchId: "NA1_TEAMS", discordUserId: "red-top", puuid: "p-rt", teamId: 200, teamRank: 1 }),
    makeHorseRecord({ matchId: "NA1_TEAMS", discordUserId: "blue-top", puuid: "p-bt", teamId: 100, teamRank: 1 }),
    makeHorseRecord({ matchId: "NA1_TEAMS", discordUserId: "red-low", puuid: "p-rl", teamId: 200, teamRank: 5 }),
  ]);
  assert.deepEqual(
    listMatchHorseRecords("guild-one", "NA1_TEAMS", false).map((record) => [record.teamId, record.discordUserId]),
    [[100, "blue-top"], [100, "blue-low"], [200, "red-top"], [200, "red-low"]],
  );
});

test("team, game version, commentary and the cited moment round-trip, and half-set commentary is refused", () => {
  const record = makeHorseRecord({
    matchId: "NA1_SAID", teamId: 200, gameVersion: "16.19.123.4567",
    tier: "特等马", teamRank: 1, scoreAbove: null,
    commentaryTone: "praise", commentary: "24分钟一波三杀，对面排着队来给你送人头。", momentKind: "multiKill",
  });
  recordTracked([record]);
  assert.deepEqual(listHorseRecords("guild-one", { mock: false })[0], record);
  recordTracked([makeHorseRecord({ matchId: "NA1_QUIET" })]);
  const quiet = listHorseRecords("guild-one", { mock: false }).find((stored) => stored.matchId === "NA1_QUIET")!;
  assert.deepEqual([quiet.commentary, quiet.commentaryTone, quiet.momentKind, quiet.gameVersion], [null, null, null, "16.19.100.1"]);
  for (const bad of [
    makeHorseRecord({ commentary: "line", commentaryTone: null }),
    makeHorseRecord({ commentary: null, commentaryTone: "roast" }),
    makeHorseRecord({ commentary: "line", commentaryTone: "shout" as never }),
    makeHorseRecord({ commentary: null, commentaryTone: null, momentKind: "multiKill" }),
    makeHorseRecord({ gameVersion: " " }),
  ]) {
    assert.throws(() => recordHorseRecords([bad]), TypeError);
  }
});

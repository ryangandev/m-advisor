import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HIERARCHY_PROBLEM,
  MISSING_MANAGE_ROLES,
  NONE_ROLE_NAME,
  TOP_ROLE_NAME,
  checkRoleSetup,
  ensureWeeklyRoles,
  RoleCreationError,
  releaseRoleHolders,
  releaseWeeklyRoles,
  rotateWeeklyRoles,
} from "../src/services/reportRoles";
import { FakeRoleGuild, discordError } from "./helpers/fakeRoleGuild";

const MISSING_PERMISSIONS = 50013;

function guildWithRoles(): FakeRoleGuild {
  const guild = new FakeRoleGuild();
  guild.addRole("role-top", TOP_ROLE_NAME, 3);
  guild.addRole("role-none", NONE_ROLE_NAME, 2);
  guild.addRole("role-other", "管理员", 4);
  for (const user of ["alice", "bob", "carol"]) guild.addMember(user, ["role-other"]);
  return guild;
}

const state = (overrides: Partial<Parameters<typeof rotateWeeklyRoles>[1]> = {}) => ({
  topRoleId: "role-top", noneRoleId: "role-none", topHolderIds: [], noneHolderIds: [], ...overrides,
});

test("the winners get the roles and nobody else is touched", async () => {
  const guild = guildWithRoles();
  const outcome = await rotateWeeklyRoles(guild, state(), { top: ["alice"], none: ["bob"] });
  assert.deepEqual(outcome.problems, []);
  assert.deepEqual([outcome.topHolderIds, outcome.noneHolderIds], [["alice"], ["bob"]]);
  assert.deepEqual(guild.changes, ["add:role-top:alice", "add:role-none:bob"]);
  assert.deepEqual([...guild.members.get("alice")!].sort(), ["role-other", "role-top"], "unrelated roles stay");
  assert.deepEqual([...guild.members.get("carol")!], ["role-other"]);
});

test("next week the roles move: old holders lose them, new winners gain them", async () => {
  const guild = guildWithRoles();
  guild.members.get("alice")!.add("role-top");
  guild.members.get("bob")!.add("role-none");
  const outcome = await rotateWeeklyRoles(guild, state({ topHolderIds: ["alice"], noneHolderIds: ["bob"] }), { top: ["bob"], none: ["carol"] });
  assert.deepEqual(outcome.problems, []);
  assert.deepEqual([outcome.topHolderIds, outcome.noneHolderIds], [["bob"], ["carol"]]);
  assert.deepEqual(guild.changes, ["remove:role-top:alice", "add:role-top:bob", "remove:role-none:bob", "add:role-none:carol"]);
  assert.deepEqual([...guild.members.get("alice")!], ["role-other"]);
  assert.deepEqual([...guild.members.get("bob")!].sort(), ["role-other", "role-top"]);
});

test("the same winner keeps the role without it being removed and given again", async () => {
  const guild = guildWithRoles();
  guild.members.get("alice")!.add("role-top");
  const outcome = await rotateWeeklyRoles(guild, state({ topHolderIds: ["alice"] }), { top: ["alice"], none: ["bob"] });
  assert.deepEqual(outcome.topHolderIds, ["alice"]);
  assert.ok(!guild.changes.some((change) => change.startsWith("remove:")), guild.changes.join(","));
  assert.ok(guild.members.get("alice")!.has("role-top"));
});

test("a week without a named champion takes the roles back and gives them to nobody", async () => {
  const guild = guildWithRoles();
  guild.members.get("alice")!.add("role-top");
  const outcome = await rotateWeeklyRoles(guild, state({ topHolderIds: ["alice"] }), { top: [], none: [] });
  assert.deepEqual([outcome.topHolderIds, outcome.noneHolderIds, outcome.problems], [[], [], []]);
  assert.deepEqual(guild.changes, ["remove:role-top:alice"]);
});

test("a previous holder who left the server is simply forgotten", async () => {
  const guild = guildWithRoles();
  const outcome = await rotateWeeklyRoles(guild, state({ topHolderIds: ["gone"] }), { top: ["alice"], none: [] });
  assert.deepEqual(outcome.problems, []);
  assert.deepEqual(outcome.topHolderIds, ["alice"]);
});

test("a winner who left the server gets nothing and causes no problem", async () => {
  const guild = guildWithRoles();
  const outcome = await rotateWeeklyRoles(guild, state(), { top: ["gone"], none: ["bob"] });
  assert.deepEqual(outcome.problems, []);
  assert.deepEqual(outcome.topHolderIds, []);
  assert.deepEqual(outcome.noneHolderIds, ["bob"]);
});

test("without Manage Roles nothing is attempted and the admin gets a clear explanation", async () => {
  const guild = guildWithRoles();
  guild.standing = { manageRoles: false, highestRolePosition: 10 };
  const outcome = await rotateWeeklyRoles(guild, state({ topHolderIds: ["alice"] }), { top: ["bob"], none: ["carol"] });
  assert.deepEqual(outcome.problems, [MISSING_MANAGE_ROLES]);
  assert.deepEqual(guild.changes, []);
  assert.deepEqual(outcome.topHolderIds, ["alice"], "the recorded holders are unchanged");
  assert.match(outcome.problems[0], /Manage Roles/);
});

test("roles above the bot are reported with the fix and nothing is changed", async () => {
  const guild = guildWithRoles();
  guild.standing = { manageRoles: true, highestRolePosition: 3 };
  const outcome = await rotateWeeklyRoles(guild, state(), { top: ["alice"], none: ["bob"] });
  assert.deepEqual(outcome.problems, [HIERARCHY_PROBLEM]);
  assert.deepEqual(guild.changes, []);
});

test("a role that was deleted is created again below the bot and its new id is returned", async () => {
  const guild = guildWithRoles();
  guild.roles.delete("role-none");
  const outcome = await rotateWeeklyRoles(guild, state(), { top: ["alice"], none: ["bob"] });
  assert.deepEqual(outcome.problems, []);
  assert.equal(outcome.topRoleId, "role-top");
  assert.equal(outcome.noneRoleId, "created-1");
  assert.equal(guild.roles.get("created-1")?.name, NONE_ROLE_NAME);
  assert.deepEqual(guild.changes, ["create:本周没有马", "add:role-top:alice", "add:created-1:bob"]);
});

test("a Discord refusal while giving a role is collected, not thrown, and the winner is not recorded as holder", async () => {
  const guild = guildWithRoles();
  guild.failures.add = discordError(MISSING_PERMISSIONS);
  const outcome = await rotateWeeklyRoles(guild, state(), { top: ["alice"], none: ["bob"] });
  assert.equal(outcome.problems.length, 1, "the same explanation is not repeated for each role");
  assert.match(outcome.problems[0], /权限|位置/);
  assert.deepEqual([outcome.topHolderIds, outcome.noneHolderIds], [[], []]);
});

test("a refusal while taking a role back keeps the holder so the next week tries again", async () => {
  const guild = guildWithRoles();
  guild.members.get("alice")!.add("role-top");
  guild.failures.remove = discordError(MISSING_PERMISSIONS);
  const outcome = await rotateWeeklyRoles(guild, state({ topHolderIds: ["alice"] }), { top: ["bob"], none: [] });
  assert.equal(outcome.problems.length, 1);
  assert.deepEqual(outcome.topHolderIds, ["alice", "bob"], "alice is kept for a retry and bob, who did get the role, is recorded");
  assert.ok(guild.members.get("alice")!.has("role-top"));
});

test("an unexpected failure anywhere in the rotation never throws", async () => {
  for (const operation of ["standing", "fetchRole", "fetchMember", "create"] as const) {
    const guild = guildWithRoles();
    guild.roles.delete("role-top");
    guild.failures[operation] = new Error(`${operation} exploded`);
    const outcome = await rotateWeeklyRoles(guild, state(), { top: ["alice"], none: ["bob"] });
    assert.ok(outcome.problems.length >= 1, operation);
    assert.deepEqual(guild.changes.filter((change) => change.startsWith("add:")), [], operation);
  }
});

test("the dry run changes nothing and lists every problem with an existing role", async () => {
  const guild = guildWithRoles();
  guild.addRole("role-managed", "Booster", 2, true);
  guild.addRole("role-high", "老大", 12);
  guild.addRole(guild.id, "@everyone", 0);
  const ok = await checkRoleSetup(guild, ["role-top", "role-none"]);
  assert.deepEqual(ok, { ok: true, problems: [] });
  const bad = await checkRoleSetup(guild, ["role-managed", "role-high", guild.id, "role-deleted"]);
  assert.equal(bad.ok, false);
  assert.equal(bad.problems.length, 4);
  assert.match(bad.problems.join("\n"), /管理|集成/);
  assert.match(bad.problems.join("\n"), /@everyone/);
  assert.match(bad.problems.join("\n"), /已被删除/);
  assert.deepEqual(guild.changes, []);
  guild.standing = null;
  assert.equal((await checkRoleSetup(guild)).ok, false);
  guild.standing = { manageRoles: false, highestRolePosition: 10 };
  assert.deepEqual((await checkRoleSetup(guild)).problems, [MISSING_MANAGE_ROLES]);
});

test("ensuring the roles reuses existing ones and creates only what is missing", async () => {
  const guild = guildWithRoles();
  const reused = await ensureWeeklyRoles(guild, { top: "role-top", none: "role-none" });
  assert.deepEqual([reused.top.id, reused.none.id, guild.changes], ["role-top", "role-none", []]);
  const partly = await ensureWeeklyRoles(guild, { top: "role-top", none: null });
  assert.equal(partly.none.id, "created-1");
  assert.deepEqual(guild.changes, ["create:本周没有马"]);
  const fresh = new FakeRoleGuild();
  const made = await ensureWeeklyRoles(fresh, { top: null, none: null });
  assert.deepEqual(fresh.changes, ["create:本周特等马", "create:本周没有马"]);
  assert.notEqual(made.top.id, made.none.id);
});

test("turning the feature off takes the roles back from the members the bot gave them to", async () => {
  const guild = guildWithRoles();
  guild.members.get("alice")!.add("role-top");
  guild.members.get("bob")!.add("role-none");
  guild.members.get("carol")!.add("role-top"); // given by hand, not by the bot
  const outcome = await releaseWeeklyRoles(guild, state({ topHolderIds: ["alice"], noneHolderIds: ["bob"] }));
  assert.deepEqual([outcome.topHolderIds, outcome.noneHolderIds, outcome.problems], [[], [], []]);
  assert.deepEqual(guild.changes, ["remove:role-top:alice", "remove:role-none:bob"]);
  assert.ok(guild.members.get("carol")!.has("role-top"), "a role someone else gave is not the bot's to take");
});

test("tied winners all get the role and a former holder who tied again keeps it", async () => {
  const guild = guildWithRoles();
  guild.members.get("alice")!.add("role-top");
  const outcome = await rotateWeeklyRoles(guild, state({ topHolderIds: ["alice"] }), { top: ["alice", "bob"], none: ["carol"] });
  assert.deepEqual(outcome.problems, []);
  assert.deepEqual([...outcome.topHolderIds].sort(), ["alice", "bob"]);
  assert.ok(guild.members.get("alice")!.has("role-top") && guild.members.get("bob")!.has("role-top"));
  assert.ok(!guild.changes.includes("remove:role-top:alice"));
});

test("a role created before a later step failed is kept in the returned ids", async () => {
  const guild = guildWithRoles();
  guild.roles.delete("role-top");
  guild.roles.delete("role-none");
  guild.createLimit = 1;
  const outcome = await rotateWeeklyRoles(guild, state({ topHolderIds: ["alice"], noneHolderIds: ["bob"] }), { top: ["alice"], none: ["bob"] });
  assert.equal(outcome.topRoleId, "created-1", "the role that was created is not lost");
  assert.equal(outcome.noneRoleId, "role-none", "the missing one keeps its old id until it can be created");
  assert.deepEqual(outcome.topHolderIds, [], "holders of a replaced role do not carry over");
  assert.deepEqual(outcome.noneHolderIds, ["bob"]);
  assert.equal(outcome.problems.length, 1);
  assert.deepEqual(guild.changes, ["create:本周特等马"]);
  // The next attempt reuses what exists and only creates the rest.
  guild.createLimit = undefined;
  const again = await ensureWeeklyRoles(guild, { top: outcome.topRoleId, none: null });
  assert.equal(again.top.id, "created-1");
  assert.equal(again.none.id, "created-2");
});

test("ensuring the roles reports what it had when a step fails", async () => {
  const guild = new FakeRoleGuild();
  guild.createLimit = 1;
  await assert.rejects(ensureWeeklyRoles(guild, { top: null, none: null }), (error: unknown) =>
    error instanceof RoleCreationError && error.partial.top?.id === "created-1" && error.partial.none === null);
});

test("a role that no longer exists counts as already released", async () => {
  const guild = guildWithRoles();
  guild.roles.delete("role-top");
  const outcome = await releaseWeeklyRoles(guild, state({ topHolderIds: ["alice"], noneHolderIds: [] }));
  assert.deepEqual([outcome.topHolderIds, outcome.problems], [[], []]);
  assert.deepEqual(guild.changes, []);
  // Discord can also say so only when the role is removed from a member.
  const racing = guildWithRoles();
  racing.members.get("alice")!.add("role-top");
  racing.failures.remove = discordError(10011, "Unknown Role");
  const released = await releaseRoleHolders(racing, "role-top", ["alice", "bob"]);
  assert.deepEqual([released.holders, released.problems], [[], []]);
  assert.deepEqual((await releaseRoleHolders(racing, "role-top", [])).holders, []);
});

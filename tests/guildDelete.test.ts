import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Events } from "discord.js";
import type { Guild } from "discord.js";
import guildDelete, { handleGuildRemoved } from "../src/events/guildDelete";

let lines: string[];
let savedLog: typeof console.log;

beforeEach(() => {
  savedLog = console.log;
  lines = [];
  console.log = (line: string) => { lines.push(String(line)); };
});
afterEach(() => {
  console.log = savedLog;
});

const guild = (fields: { id: string; name?: string }) => fields as unknown as Guild;

test("the bot logs once when it is removed from a server, and deletes nothing", () => {
  assert.equal(guildDelete.name, Events.GuildDelete);
  assert.notEqual((guildDelete as { once?: boolean }).once, true, "every removal is logged, not only the first");
  guildDelete.execute(guild({ id: "synthetic-guild-1", name: "Test Server" }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Removed from server Test Server \(synthetic-guild-1\); its stored data stays until the host deletes it\./);
});

test("a removal of an uncached server falls back to its ID", () => {
  guildDelete.execute(guild({ id: "synthetic-guild-2" }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Removed from server synthetic-guild-2;/);
});

test("a removal stops that server's monitoring, and only that server's", () => {
  const stopped: Array<[string, string]> = [];
  handleGuildRemoved(guild({ id: "synthetic-guild-3", name: "Gone" }), (guildId, reason) => { stopped.push([guildId, reason]); });
  assert.deepEqual(stopped, [["synthetic-guild-3", "the bot was removed from this server"]]);
  assert.equal(lines.length, 1, "still logged once");
});

test("the removal is logged before monitoring is stopped, so a failure there cannot hide it", () => {
  assert.throws(() => handleGuildRemoved(guild({ id: "synthetic-guild-4" }), () => { throw new Error("boom"); }), /boom/);
  assert.equal(lines.length, 1);
});

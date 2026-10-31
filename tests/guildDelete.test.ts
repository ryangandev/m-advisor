import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Events } from "discord.js";
import type { Client, Guild } from "discord.js";
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

const client = { guilds: { cache: new Map() } } as unknown as Client;
const guild = (fields: { id: string; name?: string }) => ({ ...fields, client }) as unknown as Guild;

test("the bot logs once when it is removed from a server, and deletes nothing", async () => {
  assert.equal(guildDelete.name, Events.GuildDelete);
  assert.notEqual((guildDelete as { once?: boolean }).once, true, "every removal is logged, not only the first");
  await guildDelete.execute(guild({ id: "synthetic-guild-1", name: "Test Server" }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Removed from server Test Server \(synthetic-guild-1\); its stored data stays until the host deletes it\./);
});

test("a removal of an uncached server falls back to its ID", async () => {
  await guildDelete.execute(guild({ id: "synthetic-guild-2" }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Removed from server synthetic-guild-2;/);
});

test("a removal reconciles that server's monitoring through the lifecycle, and only that server's", async () => {
  const reconciled: Array<[Client, string]> = [];
  await handleGuildRemoved(guild({ id: "synthetic-guild-3", name: "Gone" }), async (reconcileClient, guildId) => { reconciled.push([reconcileClient, guildId]); });
  assert.deepEqual(reconciled, [[client, "synthetic-guild-3"]]);
  assert.equal(lines.length, 1, "still logged once");
});

test("the removal is logged before monitoring is reconciled, so a failure there cannot hide it", () => {
  assert.throws(() => handleGuildRemoved(guild({ id: "synthetic-guild-4" }), () => { throw new Error("boom"); }), /boom/);
  assert.equal(lines.length, 1);
});

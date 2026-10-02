import assert from "node:assert/strict";
import { test } from "node:test";
import { REST, Routes } from "discord.js";
import { retireLegacyGlobalCommands } from "../src/services/commandMigration";

const app = "1048644967171625021";
const guild = "1048644967171625020";
const manifest = ["announcer", "bind", "bindings", "profile", "simulate", "testvoice", "unbind"];
const legacy = ["announcer", "bind", "bindings", "profile", "testvc", "unbind"].map((name, index) => ({ id: String(1048644967171625030n + BigInt(index)), name, type: 1 }));
function fixture(options: { guilds?: unknown; registered?: unknown; globals?: unknown; failDelete?: boolean } = {}) {
  const deleted: string[] = [];
  const api = {
    get: async (route: string) => {
      if (route === Routes.userGuilds()) return options.guilds ?? [{ id: guild }];
      if (route === Routes.applicationGuildCommands(app, guild)) return options.registered ?? manifest.map(name => ({ name, type: 1 }));
      if (route === Routes.applicationCommands(app)) return options.globals ?? legacy;
      throw new Error("Unexpected read route");
    },
    delete: async (route: string) => {
      if (options.failDelete) throw new Error("Simulated REST failure");
      deleted.push(route);
    },
  } as unknown as Pick<REST, "get" | "delete">;
  return { api, deleted };
}

test("single authorized server replaces all known legacy global controls after guild registration", async () => {
  const f = fixture();
  assert.deepEqual(await retireLegacyGlobalCommands(f.api, app, guild, manifest), legacy.map(command => command.name));
  assert.deepEqual(f.deleted, legacy.map(command => Routes.applicationCommand(app, command.id)));
});
test("multiple servers and a different sole server refuse all global mutations", async () => {
  for (const guilds of [[{ id: guild }, { id: "1048644967171625099" }], [{ id: "1048644967171625099" }], []]) {
    const f = fixture({ guilds });
    await assert.rejects(retireLegacyGlobalCommands(f.api, app, guild, manifest), /only to the authorized test server/);
    assert.deepEqual(f.deleted, []);
  }
});
test("missing replacement or malformed inventory refuses migration before any deletion", async () => {
  for (const registered of [[], {}, [{ name: "testvoice", type: 2 }]]) {
    const f = fixture({ registered });
    await assert.rejects(retireLegacyGlobalCommands(f.api, app, guild, manifest));
    assert.deepEqual(f.deleted, []);
  }
});
test("unknown commands and context-menu commands remain untouched", async () => {
  const f = fixture({ globals: [...legacy, { id: "1048644967171625088", name: "unrelated", type: 1 }, { id: "1048644967171625089", name: "profile", type: 2 }] });
  assert.deepEqual(await retireLegacyGlobalCommands(f.api, app, guild, manifest), legacy.map(command => command.name));
  assert.equal(f.deleted.length, legacy.length);
});
test("legacy voice control requires a registered testvoice replacement", async () => {
  const f = fixture();
  await assert.rejects(retireLegacyGlobalCommands(f.api, app, guild, manifest.filter(name => name !== "testvoice")), /no registered replacement/);
  assert.deepEqual(f.deleted, []);
});
test("invalid legacy ID in the final entry prevents earlier valid deletions", async () => {
  const f = fixture({ globals: [...legacy, { id: "invalid-id", name: "profile", type: 1 }] });
  await assert.rejects(retireLegacyGlobalCommands(f.api, app, guild, manifest), /identifier/);
  assert.deepEqual(f.deleted, []);
});
test("empty global inventory is an idempotent no-op", async () => {
  const f = fixture({ globals: [] });
  assert.deepEqual(await retireLegacyGlobalCommands(f.api, app, guild, manifest), []);
  assert.deepEqual(f.deleted, []);
});
test("REST failure stays visible instead of reporting a successful migration", async () => {
  const f = fixture({ failDelete: true });
  await assert.rejects(retireLegacyGlobalCommands(f.api, app, guild, manifest), /Simulated REST failure/);
  assert.deepEqual(f.deleted, []);
});
test("invalid IDs, empty manifests and duplicate manifest names fail before reads", async () => {
  const f = fixture();
  await assert.rejects(retireLegacyGlobalCommands(f.api, "bad", guild, manifest), /valid application/);
  await assert.rejects(retireLegacyGlobalCommands(f.api, app, guild, []), /nonempty/);
  await assert.rejects(retireLegacyGlobalCommands(f.api, app, guild, ["profile", "profile"]), /unique/);
  assert.deepEqual(f.deleted, []);
});

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Collection, MessageFlags } from "discord.js";
import type { Client, Interaction } from "discord.js";
import type { BotCommand } from "../src/types";
import handler from "../src/events/interactionCreate";
import { loadCommands } from "../src/handlers/commandHandler";

let originalMode: string | undefined;
let originalLog: typeof console.error;
const logs: unknown[][] = [];

beforeEach(() => {
  originalMode = process.env.RIOT_MODE;
  process.env.RIOT_MODE = "mock";
  originalLog = console.error;
  logs.length = 0;
  console.error = (...args: unknown[]) => { logs.push(args); };
});
afterEach(() => {
  if (originalMode === undefined) delete process.env.RIOT_MODE;
  else process.env.RIOT_MODE = originalMode;
  console.error = originalLog;
});

function interactionFixture(name: string, commands: Collection<string, BotCommand> = new Collection()) {
  const replies: unknown[] = [];
  const edits: unknown[] = [];
  const followUps: unknown[] = [];
  const interaction = {
    commandName: name,
    client: { commands },
    isChatInputCommand: () => true,
    replied: false,
    deferred: false,
    reply: async (payload: unknown) => { replies.push(payload); },
    editReply: async (payload: unknown) => { edits.push(payload); },
    followUp: async (payload: unknown) => { followUps.push(payload); },
  };
  return { interaction, replies, edits, followUps };
}

test("registered legacy /testvc is acknowledged with a private migration reply using the real command loader", async () => {
  const client = { commands: new Collection<string, BotCommand>() } as unknown as Client;
  await loadCommands(client);
  assert.ok(client.commands.has("testvoice"));
  assert.equal(client.commands.has("testvc"), false, "the retired control must not remain as an alias");
  const f = interactionFixture("testvc", client.commands);
  await handler.execute(f.interaction as unknown as Interaction);
  assert.equal(f.replies.length, 1);
  const reply = f.replies[0] as { content: string; flags: MessageFlags };
  assert.equal(reply.flags, MessageFlags.Ephemeral);
  assert.match(reply.content, /\/testvc 已停用/);
  assert.match(reply.content, /管理员.*\/testvoice/);
  assert.equal(f.edits.length, 0);
  assert.equal(f.followUps.length, 0);
});

test("other unknown registered slash commands receive a private administrator update message", async () => {
  const f = interactionFixture("removed-command");
  await handler.execute(f.interaction as unknown as Interaction);
  assert.deepEqual(f.replies, [{ content: "这个命令当前不可用。请让管理员更新此服务器的 Bot 命令后再试。", flags: MessageFlags.Ephemeral }]);
  assert.equal(logs.length, 0);
});

test("known commands dispatch once and retain their existing response flow", async () => {
  let calls = 0;
  const command = { execute: async (interaction: unknown) => {
    calls++;
    await (interaction as { reply: (payload: unknown) => Promise<void> }).reply({ content: "known command reply" });
  } } as BotCommand;
  const f = interactionFixture("existing", new Collection([["existing", command]]));
  await handler.execute(f.interaction as unknown as Interaction);
  assert.equal(calls, 1);
  assert.deepEqual(f.replies, [{ content: "known command reply" }]);
});

test("non-slash interactions are left to their own handlers", async () => {
  const f = interactionFixture("testvc");
  f.interaction.isChatInputCommand = () => false;
  await handler.execute(f.interaction as unknown as Interaction);
  assert.equal(f.replies.length, 0);
});

for (const state of ["fresh", "deferred", "replied"] as const) {
  test(`command failures use safe ${state} replies and never log interaction tokens or request bodies`, async () => {
    const secret = "private-interaction-token";
    const privateBody = "private-request-body";
    const error = Object.assign(new Error(privateBody), {
      name: "DiscordAPIError", url: `https://discord.com/api/v10/webhooks/application/${secret}`,
      requestBody: { json: { content: privateBody } }, status: 404,
    });
    const command = { execute: async () => { throw error; } } as unknown as BotCommand;
    const f = interactionFixture("existing", new Collection([["existing", command]]));
    f.interaction.deferred = state === "deferred";
    f.interaction.replied = state === "replied";
    await handler.execute(f.interaction as unknown as Interaction);
    const output = state === "fresh" ? f.replies : state === "deferred" ? f.edits : f.followUps;
    assert.equal(output.length, 1);
    if (state !== "deferred") assert.equal((output[0] as { flags: MessageFlags }).flags, MessageFlags.Ephemeral);
    const payload = output[0] as { embeds: Array<{ toJSON: () => unknown }> };
    assert.doesNotMatch(JSON.stringify(payload.embeds.map(embed => embed.toJSON())), /private-interaction-token|private-request-body/);
    assert.equal(logs.length, 1);
    assert.match(String(logs[0][0]), /^\[\d{2}:\d{2}:\d{2}\] Command execution failed for \/existing: DiscordAPIError$/);
    assert.doesNotMatch(JSON.stringify(logs), /private-interaction-token|private-request-body/);
  });
}

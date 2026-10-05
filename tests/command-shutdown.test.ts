import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

type Scenario = "voice-authorization" | "bind-lookup" | "simulate-authorization" | "simulate-member" | "simulate-baseline" | "simulate-result";

/** Isolate the irreversible process stopping flag and use no Discord, network, or GPU boundary. */
function runScenario(scenario: Scenario): {
  starts: number; mutations: number; storeReads: number; readsAfterShutdown: number;
  played: number; databaseReopened: boolean; reply: string;
} {
  const root = path.resolve(__dirname, "..");
  const code = String.raw`
const root = ${JSON.stringify(root)};
const scenario = ${JSON.stringify(scenario)};
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "command-stop-test-"));
process.env.DATABASE_PATH = path.join(directory, "bot.sqlite3");
process.env.RIOT_MODE = "mock";
delete process.env.RIOT_API_KEY;
const database = require(root + "/src/store/database.ts");
const bindingStore = require(root + "/src/store/bindingStore.ts");
const announcerStore = require(root + "/src/store/announcerStore.ts");
const provider = require(root + "/src/services/riotData.ts");
const stopping = require(root + "/src/services/shutdownState.ts");
const originalLoad = Module._load;
const originalConsoleError = console.error;
console.error = (message, ...args) => {
  if (!/^\[[\d:]+\] (Voice|Simulation) test failed: /.test(message)) originalConsoleError(message, ...args);
};
const account = { puuid: "MOCK-shutdown-account", gameName: "MockWin", tagLine: "NA1" };
if (scenario.startsWith("simulate")) bindingStore.setBinding("guild", { discordUserId: "tracked", accounts: [account] });
let release;
let entered;
const gate = new Promise(resolve => release = resolve);
const waiting = new Promise(resolve => entered = resolve);
let starts = 0, mutations = 0, storeReads = 0, readsAfterShutdown = 0, played = 0, polls = 0;
let reply = "", simulated;
const countRead = () => { storeReads++; if (stopping.isStopping()) readsAfterShutdown++; };
const pause = async () => { entered(); await gate; };
const channel = { id: "voice", guild: { id: "guild", members: {
  cache: new Map(),
  fetch: async () => {
    if (scenario === "simulate-member") await pause();
    return { voice: { channelId: "voice" } };
  },
} } };
Module._load = function(request, parent, ...args) {
  if (parent?.filename.startsWith(root + "/src/commands/")) {
    const overrides = {
      "../utils/testChannel": { getAuthorizedTestChannel: async () => {
        if (scenario.endsWith("authorization")) await pause();
        return channel;
      }, safeTestError: error => error.message },
      "../services/voiceAnnouncements": { announceTextInVoiceChannel: async () => { played++; } },
      "../utils/riotApi": { getAccountByRiotId: async () => { await pause(); return account; } },
      "../store/bindingStore": {
        getBinding: guildId => { countRead(); return bindingStore.getBinding(guildId); },
        setBinding: (...args) => { mutations++; return bindingStore.setBinding(...args); },
      },
      "../store/announcerStore": {
        getAnnouncerState: guildId => { countRead(); return announcerStore.getAnnouncerState(guildId); },
        getLastMatchId: () => { countRead(); return simulated?.matchId; },
      },
      "../services/riotData": { ...provider, simulateMockMatch: (...args) => {
        mutations++; simulated = provider.simulateMockMatch(...args); return simulated;
      } },
      "../services/gameMonitor": {
        startPolling: () => { starts++; },
        pollGuildNow: async () => {
          polls++;
          if ((scenario === "simulate-baseline" && polls === 1) || (scenario === "simulate-result" && polls === 2)) await pause();
          return { announced: polls === 1 ? 0 : 1, errors: 0 };
        },
      },
      "../services/monitorLifecycle": { reconcileGuildMonitoring: async () => {} },
    };
    if (overrides[request]) return overrides[request];
  }
  return originalLoad.call(this, request, parent, ...args);
};
global.fetch = async () => { throw new Error("Unexpected network request"); };
const name = scenario.startsWith("simulate") ? "simulate" : scenario.startsWith("voice") ? "testvoice" : "bind";
const interaction = { guildId: "guild", guild: channel.guild, client: {}, user: { id: "admin" },
  inGuild: () => true, memberPermissions: { has: () => true },
  options: { getUser: () => ({ id: "tracked" }), getString: key => key === "outcome" ? "win" : "MockWin#NA1" },
  deferReply: async () => {}, editReply: async value => { reply = typeof value === "string" ? value : JSON.stringify(value); },
};
(async () => {
  try {
    const pending = require(root + "/src/commands/" + name + ".ts").default.execute(interaction)
      .catch(error => { reply = error.message; });
    await waiting;
    stopping.beginShutdown();
    database.closeDatabase();
    release();
    await pending;
    let databaseReopened = false;
    const fileExists = fs.existsSync(process.env.DATABASE_PATH);
    if (!scenario.startsWith("simulate")) databaseReopened = fileExists;
    console.log(JSON.stringify({ starts, mutations, storeReads, readsAfterShutdown, played, databaseReopened, reply }));
  } finally {
    database.closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`;
  const output = execFileSync(process.execPath, ["--import", "tsx", "-e", code], {
    cwd: root, encoding: "utf8", timeout: 10_000,
  });
  return JSON.parse(output.trim().split("\n").at(-1)!);
}

test("/testvoice authorization finishing after shutdown cannot create a store or start speech", () => {
  const result = runScenario("voice-authorization");
  assert.equal(result.played, 0);
  assert.equal(result.storeReads, 0);
  assert.equal(result.databaseReopened, false);
  assert.match(result.reply, /当前 Bot 正在停止/);
});

test("/bind Riot lookup finishing after shutdown cannot read or write the database", () => {
  const result = runScenario("bind-lookup");
  assert.equal(result.storeReads, 0);
  assert.equal(result.mutations, 0);
  assert.equal(result.databaseReopened, false);
  assert.match(result.reply, /当前 Bot 正在停止/);
});

for (const scenario of ["simulate-authorization", "simulate-member", "simulate-baseline", "simulate-result"] as const) {
  test(`/simulate cannot continue after shutdown at ${scenario.slice("simulate-".length)}`, () => {
    const result = runScenario(scenario);
    assert.equal(result.readsAfterShutdown, 0);
    assert.equal(result.played, 0);
    assert.match(result.reply, /当前 Bot 正在停止/);
    assert.doesNotMatch(result.reply, /播报完成/);
    assert.equal(result.starts, ["simulate-baseline", "simulate-result"].includes(scenario) ? 1 : 0);
    assert.equal(result.mutations, scenario === "simulate-result" ? 1 : 0);
  });
}

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { after, test } from "node:test";
import type { BotCommand, TrackedMember } from "../src/types";
import { testMatch } from "./helpers/matches";

/**
 * /recent reads every bound account from Riot. The Riot side is replaced by a fake that counts how many accounts are
 * being read at the same moment, to prove a big server cannot burst past the americas rate limit.
 */
const loader = createRequire(__filename);
const savedModules = new Map<string, NodeJS.Module | undefined>();
function stubModule(relativePath: string, exports: Record<string, unknown>): void {
  const file = loader.resolve(relativePath);
  savedModules.set(file, loader.cache[file]);
  loader.cache[file] = { id: file, filename: file, path: dirname(file), loaded: true, exports, children: [], paths: [] } as unknown as NodeJS.Module;
}

const ACCOUNTS = 7;
const members: TrackedMember[] = Array.from({ length: ACCOUNTS }, (_, index) => ({
  discordUserId: `user-${index}`,
  accounts: [{ puuid: `puuid-${index}`, gameName: `Player${index}`, tagLine: "NA1" }],
}));
let reading = 0;
let mostReading = 0;
const started: string[] = [];

stubModule("../src/store/bindingStore.ts", { listTrackedMembers: () => members });
stubModule("../src/store/announcerStore.ts", { getLastMatchId: () => undefined });
stubModule("../src/services/gameMonitor.ts", {
  POLL_INTERVAL_MS: 45_000,
  getMonitorStatus: () => ({ active: false, announced: new Set(), presentMemberIds: [] }),
});
stubModule("../src/utils/riotMatchApi.ts", {
  ...loader("../src/utils/riotMatchApi.ts"),
  // An account is "being read" from its ID list to its last detail, so one account is one unit of concurrency.
  getRecentMatchIds: async (puuid: string) => {
    started.push(puuid);
    reading++;
    mostReading = Math.max(mostReading, reading);
    await new Promise((resolve) => setImmediate(resolve));
    return ["NA1_1", "NA1_2"];
  },
  getMatchDetail: async (matchId: string) => {
    await new Promise((resolve) => setImmediate(resolve));
    if (matchId === "NA1_2") reading--;
    return testMatch(matchId, ["tracked"], "win");
  },
});
const recent = loader("../src/commands/recent.ts").default as BotCommand;
after(() => {
  for (const [file, original] of savedModules) {
    if (original) loader.cache[file] = original;
    else delete loader.cache[file];
  }
  delete loader.cache[loader.resolve("../src/commands/recent.ts")];
});

test("/recent reads at most two accounts at a time and still lists them in bind order", async () => {
  const replies: Array<{ embeds: Array<{ toJSON: () => { fields?: Array<{ name: string }> } }> }> = [];
  const interaction = {
    guildId: "guild",
    guild: { members: { cache: new Map() } },
    options: { getUser: () => null, getInteger: () => null },
    deferReply: async () => undefined,
    editReply: async (payload: (typeof replies)[number]) => { replies.push(payload); },
  };
  await recent.execute(interaction as unknown as Parameters<BotCommand["execute"]>[0]);
  assert.equal(started.length, ACCOUNTS, "every account is read");
  assert.equal(mostReading, 2, "two at a time, never more");
  assert.deepEqual(replies[0].embeds[0].toJSON().fields!.map((field) => field.name),
    Array.from({ length: ACCOUNTS }, (_, index) => `${index + 1}. Player${index}#NA1`));
});

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import profileCommand from "../src/commands/profile";
import { RiotApiError, resetMockData } from "../src/services/riotData";
import { buildErrorEmbed, buildProfileEmbed, getProfileIconUrl } from "../src/utils/embeds";
import { captureConsole } from "./helpers/captureConsole";
import { AccountBoundToOtherMemberError, GuildAccountLimitError } from "../src/store/storeErrors";
import { getCommandUserErrorMessage, getRiotUserErrorMessage } from "../src/utils/userFacingErrors";

const originalMode = process.env.RIOT_MODE;
const originalKey = process.env.RIOT_API_KEY;
const originalVersion = process.env.DDRAGON_VERSION;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.RIOT_MODE = "mock";
  delete process.env.RIOT_API_KEY;
  delete process.env.DDRAGON_VERSION;
  resetMockData();
});
afterEach(() => {
  for (const [key, value] of [["RIOT_MODE", originalMode], ["RIOT_API_KEY", originalKey], ["DDRAGON_VERSION", originalVersion]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
});

async function runProfile(riotId: string): Promise<ReturnType<EmbedBuilder["toJSON"]>> {
  let deferred = false;
  let reply: { embeds: EmbedBuilder[] } | undefined;
  const interaction = {
    options: { getString: () => riotId },
    deferReply: async () => { deferred = true; },
    editReply: async (payload: { embeds: EmbedBuilder[] }) => { reply = payload; },
  } as unknown as ChatInputCommandInteraction;
  await profileCommand.execute(interaction);
  assert.equal(deferred, true);
  assert.ok(reply);
  return reply.embeds[0].toJSON();
}

test("profile slash-command reply visibly labels simulated statistics", async () => {
  globalThis.fetch = async () => { throw new Error("offline mock command must not call network"); };
  const profile = await runProfile("MockWin#NA1");
  assert.match(profile.title!, /模拟数据.*MockWin#NA1/);
  assert.match(profile.footer!.text, /模拟数据/);
  assert.match(profile.thumbnail!.url, /\/16\.19\.1\/img\/profileicon\/29\.png$/);
  assert.match(profile.fields!.find((field) => field.name === "Solo/Duo")!.value, /GOLD II.*42W 35L/);
  const unranked = await runProfile("MockUnranked#NA1");
  assert.equal(unranked.fields!.find((field) => field.name === "Solo/Duo")!.value, "Unranked");
});

test("mock authentication and input errors remain visibly simulated", async () => {
  const authError = await runProfile("MockAuth#NA1");
  assert.match(authError.title!, /模拟数据/);
  assert.match(authError.description!, /模拟数据/);
  assert.match(authError.description!, /configuration needs attention/);
  const invalidId = await runProfile("not-a-riot-id");
  assert.match(invalidId.title!, /模拟数据/);
  assert.match(invalidId.description!, /Invalid Riot ID/);
});

test("real profile authentication errors remain safe and are never labeled as simulated", async (t) => {
  const logged = captureConsole(t);
  process.env.RIOT_MODE = "real";
  process.env.RIOT_API_KEY = "do-not-show-this-key";
  globalThis.fetch = async () => new Response("do-not-show-this-key", { status: 403 });
  const error = await runProfile("RealPlayer#NA1");
  assert.equal(error.title, "Error");
  assert.doesNotMatch(error.description!, /模拟数据|do-not-show-this-key/);
  assert.match(error.description!, /configuration needs attention/);
  assert.ok(logged.lines.every((line) => !line.includes("do-not-show-this-key")));
});

test("a rejected real key is logged once without the key, and a simulated rejection logs nothing", async (t) => {
  const logged = captureConsole(t);
  process.env.RIOT_MODE = "real";
  process.env.RIOT_API_KEY = "do-not-show-this-key";
  globalThis.fetch = async () => new Response("do-not-show-this-key", { status: 401 });
  await runProfile("RealPlayer#NA1");
  assert.equal(logged.lines.length, 1);
  assert.match(logged.lines[0], /^\[\d\d:\d\d:\d\d\] Riot rejected RIOT_API_KEY \(401\); paste a new key into \.env and restart\.$/);
  process.env.RIOT_MODE = "mock";
  await runProfile("MockAuth#NA1");
  assert.equal(logged.lines.length, 1, "a mock 401 says nothing about the real key");
});

test("binding store errors get their own messages instead of the Riot substring rules", () => {
  const limit = getCommandUserErrorMessage(new GuildAccountLimitError());
  assert.equal(limit, "A server can track at most 10 Riot accounts. Use /unbind to remove a member first.");
  const owned = getCommandUserErrorMessage(new AccountBoundToOtherMemberError("secret-puuid", "owner-id"));
  assert.equal(owned, "That Riot account is already bound to another member of this server. Use /unbind on them first.");
  assert.doesNotMatch(owned, /secret-puuid|owner-id/);
  assert.match(getCommandUserErrorMessage(new Error("Riot lookup exploded")), /Unable to complete the Riot lookup right now\.$/);
});

test("structured errors preserve mock labels, precise retry delay, and command routing", () => {
  const rateLimit = new RiotApiError("private upstream diagnostic", "rate_limited", 429, 1200, true);
  assert.equal(getRiotUserErrorMessage(rateLimit), "模拟数据: The Riot API is rate-limiting requests. Please try again in 2 seconds.");
  assert.equal(getCommandUserErrorMessage(rateLimit), getRiotUserErrorMessage(rateLimit));
  assert.doesNotMatch(getRiotUserErrorMessage(rateLimit), /private/);
  process.env.RIOT_MODE = "real";
  assert.match(getRiotUserErrorMessage(rateLimit), /^模拟数据:/, "the error source remains labeled if configuration changes");
  assert.match(getRiotUserErrorMessage(new RiotApiError("arbitrary", "timeout")), /timed out/);
  process.env.RIOT_MODE = "invalid";
  const invalidMode = getRiotUserErrorMessage(new RiotApiError("arbitrary", "invalid_mode"));
  assert.match(invalidMode, /RIOT_MODE must be mock or real/);
  assert.equal(buildErrorEmbed(invalidMode).toJSON().title, "Error");
});

test("official profile icon version is configurable, with unsafe settings omitted", () => {
  process.env.DDRAGON_VERSION = "16.18.1";
  assert.equal(getProfileIconUrl(29), "https://ddragon.leagueoflegends.com/cdn/16.18.1/img/profileicon/29.png");
  process.env.DDRAGON_VERSION = "../../unknown";
  assert.equal(getProfileIconUrl(29), undefined);
  delete process.env.DDRAGON_VERSION;
  assert.equal(getProfileIconUrl(-1), undefined);
  assert.equal(getProfileIconUrl(Number.NaN), undefined);
});

test("the profile shows MASTER, GRANDMASTER and CHALLENGER without a division, and other tiers with one", () => {
  const summoner = { id: "s", accountId: "a", puuid: "p", name: "n", profileIconId: 29, summonerLevel: 300 };
  const embed = buildProfileEmbed("Apex#NA1", summoner, [
    { queueType: "RANKED_SOLO_5x5", tier: "MASTER", rank: "I", leaguePoints: 250, wins: 60, losses: 40 },
    { queueType: "RANKED_FLEX_SR", tier: "GOLD", rank: "II", leaguePoints: 40, wins: 5, losses: 5 },
  ]).toJSON();
  const value = (name: string) => embed.fields?.find((field) => field.name === name)?.value;
  assert.equal(value("Solo/Duo"), "MASTER - 250 LP | 60W 40L (60%)");
  assert.equal(value("Flex"), "GOLD II - 40 LP | 5W 5L (50%)");
});

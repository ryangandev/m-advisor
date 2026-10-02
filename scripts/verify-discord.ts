import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { Client, Events, GatewayIntentBits, PermissionFlagsBits, VoiceChannel } from "discord.js";
import { getVoiceConnections } from "@discordjs/voice";
import { getAccountByRiotId } from "../src/utils/riotApi";
import { setBinding } from "../src/store/bindingStore";
import { getLastMatchId, setVoiceStyle } from "../src/store/announcerStore";
import { closeDatabase } from "../src/store/database";
import { pollGuildNow, startPolling, stopAllPolling } from "../src/services/gameMonitor";
import { simulateMockMatch } from "../src/services/riotData";
import { prewarmTTS, shutdownTTS } from "../src/utils/tts";

dotenv.config({ quiet: true });

async function verify(): Promise<void> {
  if (process.argv.slice(2).length !== 1 || process.argv[2] !== "--confirm-live") throw new Error("This verifier joins Discord and sends simulated reports. Run with --confirm-live only for an authorized test channel, with the normal bot stopped.");
  const guildId = process.env.TEST_GUILD_ID?.trim();
  const channelId = process.env.TEST_VOICE_CHANNEL_ID?.trim();
  if (!guildId || !channelId || ![guildId, channelId].every(id => /^\d{17,20}$/.test(id))) throw new Error("Configure the authorized TEST_GUILD_ID and TEST_VOICE_CHANNEL_ID first.");
  const memberId = process.env.TEST_MEMBER_ID?.trim();
  if (memberId && !/^\d{17,20}$/.test(memberId)) throw new Error("TEST_MEMBER_ID must be a Discord member ID if configured.");
  if (!process.env.DISCORD_TOKEN) throw new Error("Configure DISCORD_TOKEN locally first.");
  process.env.RIOT_MODE = "mock";
  process.env.TTS_PROVIDER = "local";
  const directory = await mkdtemp(path.join(os.tmpdir(), "m-advisor-live-"));
  process.env.DATABASE_PATH = path.join(directory, "bot.sqlite3");
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const moves: Array<{ from: string | null; to: string | null }> = [];
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    if (newState.id === client.user?.id && newState.guild.id === guildId && oldState.channelId !== newState.channelId) {
      moves.push({ from: oldState.channelId, to: newState.channelId });
    }
  });
  const started = Date.now();
  try {
    const ready = once(client, Events.ClientReady, { signal: AbortSignal.timeout(30_000) });
    await Promise.all([client.login(process.env.DISCORD_TOKEN), ready]);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error("The bot cannot access the authorized server.");
    const channel = await guild.channels.fetch(channelId);
    if (!(channel instanceof VoiceChannel)) throw new Error("The configured channel is not a normal guild voice channel.");
    const member = await guild.members.fetch(memberId || guild.ownerId);
    if (member.user.bot || member.voice.channelId !== channelId) throw new Error("The test member must be in the authorized channel; TEST_MEMBER_ID defaults to the server owner.");
    const permissions = channel.permissionsFor(client.user!);
    if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.SendMessages])) throw new Error("The bot needs View Channel, Connect, Speak and Send Messages in the authorized channel.");
    console.log("Actual Discord Gateway is ready; preparing installed local speech.");
    await prewarmTTS();
    const account = await getAccountByRiotId("MockWin", "NA1");
    setBinding(guildId, { discordUserId: member.id, accounts: [account] });
    startPolling(client, guildId, channelId);
    assert.deepEqual(await pollGuildNow(client, guildId, channelId), { announced: 0, errors: 0 });
    const outcomes: Array<{ outcome: string; voice: string; matchId: string }> = [];
    for (const outcome of ["win", "loss"] as const) {
      const voice = outcome === "win" ? "sweet" : "old";
      setVoiceStyle(guildId, voice);
      const match = simulateMockMatch(account.puuid, outcome);
      console.log(`Running actual ${outcome} announcement with ${voice} voice in the authorized channel.`);
      assert.deepEqual(await pollGuildNow(client, guildId, channelId), { announced: 1, errors: 0 });
      assert.equal(getLastMatchId(guildId, account.puuid), match.matchId);
      assert.deepEqual(await pollGuildNow(client, guildId, channelId), { announced: 0, errors: 0 });
      assert.equal(getVoiceConnections().size, 0, "playback must leave no voice connection");
      outcomes.push({ outcome, voice, matchId: match.matchId });
    }
    const messages = await channel.messages.fetch({ limit: 10 });
    const reports = [...messages.values()].filter(message => message.author.id === client.user!.id && message.createdTimestamp >= started && message.content.includes("模拟战报"));
    assert.equal(reports.length, 2);
    assert.ok(reports.some(message => message.content.includes("本局胜利")));
    assert.ok(reports.some(message => message.content.includes("本局失利")));
    assert.ok(reports.every(message => !message.mentions.everyone));
    assert.equal(moves.filter(move => move.to === channelId).length, 2);
    assert.equal(moves.filter(move => move.from === channelId && move.to === null).length, 2);
    const report = {
      checkedAt: new Date().toISOString(), data: "mock", speech: "real local Qwen",
      discordTransport: "actual Discord Gateway, voice and message REST",
      interactionTransport: "direct monitor API; native slash-command tests are separate",
      isolatedDatabase: true, productionBindingsChanged: false,
      historicalBaselineNotSpoken: true, outcomes, duplicateNotSpoken: true,
      voiceJoins: 2, voiceLeaves: 2, remainingVoiceConnections: 0,
      actualReportMessages: reports.map(message => ({ id: message.id, content: message.content })),
      humanListening: "pending user confirmation", totalSeconds: (Date.now() - started) / 1000,
    };
    await mkdir("test-results", { recursive: true });
    await writeFile("test-results/discord-e2e.json", JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ ...report, actualReportMessages: reports.map(message => ({ id: message.id })) }, null, 2));
  } finally {
    let cleanupFailed = false;
    for (const cleanup of [
      async () => stopAllPolling(), async () => client.destroy(), shutdownTTS,
      async () => closeDatabase(), async () => rm(directory, { recursive: true, force: true }),
    ]) {
      try { await cleanup(); }
      catch (error) { cleanupFailed = true; console.error("Live verifier cleanup failed:", error instanceof Error ? error.name : "unknown error"); }
    }
    if (cleanupFailed) process.exitCode = 1;
  }
}
void verify().catch((error: unknown) => {
  console.error("Live Discord verification failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});

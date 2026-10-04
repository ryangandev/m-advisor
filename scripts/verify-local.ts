import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Client, VoiceChannel } from "discord.js";
import ffmpeg from "ffmpeg-static";
import { getAccountByRiotId } from "../src/utils/riotApi";
import { getLatestSRMatchId, getMatchDetail } from "../src/utils/riotMatchApi";
import { getBinding, setBinding } from "../src/store/bindingStore";
import { closeDatabase } from "../src/store/database";
import { getRiotMode, simulateMockMatch } from "../src/services/riotData";
import { GameMonitor } from "../src/services/gameMonitor";
import { VoiceAnnouncementService } from "../src/services/voiceAnnouncements";
import { generateTTS, shutdownTTS } from "../src/utils/tts";

const exec = promisify(execFile);
async function verify(): Promise<void> {
  const codec = ffmpeg;
  if (!codec) throw new Error("FFmpeg is unavailable.");
  // This verifier deliberately uses isolated mock data and no Discord connection.
  process.env.RIOT_MODE = "mock";
  process.env.TTS_PROVIDER = "local";
  const directory = await mkdtemp(path.join(os.tmpdir(), "m-advisor-e2e-"));
  process.env.DATABASE_PATH = path.join(directory, "bot.sqlite3");
  const evidenceDirectory = path.resolve("test-results");
  await mkdir(evidenceDirectory, { recursive: true });
  const started = performance.now();
  let opusBytes = 0;
  let speechSeconds = 0;
  let monitor: GameMonitor | undefined;
  const messages: Array<{ embeds: Array<{ toJSON: () => { title?: string; description?: string; fields?: Array<{ value: string }> } }> }> = [];
  const channel = { id: "local-test-channel", guild: { id: "local-test-guild" }, members: new Map([["local-test-member", {}]]), send: async (message: typeof messages[number]) => { messages.push(message); } } as unknown as VoiceChannel;
  let spokenText = "";
  const voice = new VoiceAnnouncementService({
    generate: async (text, style) => {
      console.log("Generating the simulated match announcement with the installed Qwen model...");
      spokenText = text;
      const startedSpeech = performance.now();
      const file = await generateTTS(text, style);
      speechSeconds = (performance.now() - startedSpeech) / 1000;
      await copyFile(file, path.join(evidenceDirectory, "local-e2e.wav"));
      return file;
    },
    play: async (_channel, file) => {
      const { stdout } = await exec(codec, ["-hide_banner", "-loglevel", "error", "-i", file, "-ar", "48000", "-ac", "2", "-c:a", "libopus", "-f", "ogg", "pipe:1"], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
      assert.equal(stdout.subarray(0, 4).toString(), "OggS");
      opusBytes = stdout.length;
      assert.ok(opusBytes > 100);
    },
    cleanup: file => rm(file, { force: true }),
  });
  try {
    const account = await getAccountByRiotId("MockLoss", "NA1");
    setBinding(channel.guild.id, { discordUserId: "local-test-member", accounts: [account] });
    monitor = new GameMonitor({ latest: getLatestSRMatchId, detail: getMatchDetail, binding: getBinding, resolveChannel: () => channel,
      announce: (guild, text, style, resolve, allowed, signal) => voice.announce(guild, text, style, resolve, allowed, signal),
      mock: () => getRiotMode() === "mock", log: error => { throw error; }, info: message => console.log(message) });
    const client = {} as Client;
    monitor.start(client, channel.guild.id, channel.id);
    assert.equal((await monitor.poll(client, channel.guild.id)).announced, 0);
    simulateMockMatch(account.puuid, "loss");
    assert.deepEqual(await monitor.poll(client, channel.guild.id), { announced: 1, errors: 0 });
    assert.deepEqual(await monitor.poll(client, channel.guild.id), { announced: 0, errors: 0 });
    assert.equal(messages.length, 1);
    const embed = messages[0].embeds[0].toJSON();
    assert.match(embed.title ?? "", /模拟战报/);
    assert.match(embed.description ?? "", /这局输了/);
    for (const tier of ["特等马", "上等马", "中等马", "下等马", "没有马"]) assert.ok(spokenText.includes(`${tier}，`), `speech ranks ${tier}`);
    const report = { checkedAt: new Date().toISOString(), data: "mock", speech: "real offline Qwen", spokenText, spokenCharacters: spokenText.length, codec: "real FFmpeg Opus", discordTransport: "simulated, not live", baselineNotSpoken: true, trackedDefeatCorrect: true, duplicateNotSpoken: true, opusBytes, speechSeconds, totalSeconds: (performance.now() - started) / 1000 };
    await writeFile(path.join(evidenceDirectory, "local-e2e.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    monitor?.stopAll();
    await shutdownTTS();
    closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
}
void verify().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Local verification failed."); process.exitCode = 1; });

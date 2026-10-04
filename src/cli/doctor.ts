import dotenv from "dotenv";
import { execFileSync } from "node:child_process";
import { getCiphers } from "node:crypto";
import Database from "better-sqlite3";
import { generateDependencyReport } from "@discordjs/voice";
import ffmpeg from "ffmpeg-static";
import { getRiotMode } from "../services/riotData";
import { getDatabasePath } from "../store/database";
import { checkTTS, shutdownTTS } from "../utils/tts";

dotenv.config({ quiet: true });
async function doctor(): Promise<void> {
  if (!ffmpeg) throw new Error("FFmpeg executable is unavailable.");
  execFileSync(ffmpeg, ["-version"], { stdio: "ignore" });
  const db = new Database(":memory:");
  try { db.prepare("SELECT 1").get(); } finally { db.close(); }
  console.log(JSON.stringify({ node: process.version, riotMode: getRiotMode(), ttsProvider: "local", discordConfigured: Boolean(process.env.DISCORD_TOKEN && process.env.CLIENT_ID), riotKeyPresent: Boolean(process.env.RIOT_API_KEY), testGuildConfigured: Boolean(process.env.TEST_GUILD_ID), testChannelConfigured: Boolean(process.env.TEST_VOICE_CHANNEL_ID), database: getDatabasePath(), ffmpegExecutable: true, sqliteReady: true, aes256gcm: getCiphers().includes("aes-256-gcm") }, null, 2));
  console.log(generateDependencyReport());
  if (process.argv.includes("--voice")) console.log(JSON.stringify(await checkTTS(), null, 2));
}
void doctor().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Runtime diagnostic failed.");
  process.exitCode = 1;
}).finally(shutdownTTS);

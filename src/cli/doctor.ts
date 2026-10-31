import dotenv from "dotenv";
import { execFileSync } from "node:child_process";
import { getCiphers } from "node:crypto";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { generateDependencyReport } from "@discordjs/voice";
import ffmpeg from "ffmpeg-static";
import { getRiotMode } from "../services/riotData";
import { closeDatabase, getDatabasePath } from "../store/database";
import { listAllTracking } from "../store/bindingStore";
import { skippedMockAccountWarnings } from "../utils/bindingAccounts";
import { getLogDirectory } from "../utils/log";
import { checkTTS, shutdownTTS } from "../utils/tts";

dotenv.config({ quiet: true });

/**
 * What would stop the bot from starting, using the same rules as startup in `src/index.ts`:
 * real mode needs a RIOT_API_KEY that is not blank after trimming, and DISCORD_TOKEN must be set.
 * CLIENT_ID is needed to register commands. Messages name the variable only, never a value.
 */
function startupProblems(mode: string, aesAvailable: boolean): string[] {
  const problems: string[] = [];
  if (mode === "real" && !process.env.RIOT_API_KEY?.trim()) problems.push("RIOT_MODE=real requires RIOT_API_KEY. Use mock mode to test without a key.");
  if (!process.env.DISCORD_TOKEN) problems.push("Missing DISCORD_TOKEN environment variable.");
  if (!process.env.CLIENT_ID) problems.push("Missing CLIENT_ID environment variable.");
  if (!aesAvailable) problems.push("The aes-256-gcm cipher is unavailable in this Node build.");
  return problems;
}

async function doctor(): Promise<void> {
  if (!ffmpeg) throw new Error("FFmpeg executable is unavailable.");
  execFileSync(ffmpeg, ["-version"], { stdio: "ignore" });
  const db = new Database(":memory:");
  try { db.prepare("SELECT 1").get(); } finally { db.close(); }
  const database = getDatabasePath();
  // Read saved bindings only from an existing file; the doctor never creates the bot's database,
  // but opening an older existing file upgrades it in place (after a .bak copy), like starting the bot.
  const tracking = database !== ":memory:" && existsSync(database) ? listAllTracking() : [];
  const aes256gcm = getCiphers().includes("aes-256-gcm");
  const problems = startupProblems(getRiotMode(), aes256gcm);
  const warnings = getRiotMode() === "real" ? skippedMockAccountWarnings(tracking) : [];
  console.log(JSON.stringify({ node: process.version, riotMode: getRiotMode(), ttsProvider: "local", discordConfigured: Boolean(process.env.DISCORD_TOKEN && process.env.CLIENT_ID), riotKeyPresent: Boolean(process.env.RIOT_API_KEY?.trim()), testGuildConfigured: Boolean(process.env.TEST_GUILD_ID), testChannelConfigured: Boolean(process.env.TEST_VOICE_CHANNEL_ID), database, savedBindings: tracking.reduce((total, guild) => total + guild.members.length, 0), logDirectory: getLogDirectory(), ffmpegExecutable: true, sqliteReady: true, aes256gcm }, null, 2));
  console.log(generateDependencyReport());
  if (process.argv.includes("--voice")) console.log(JSON.stringify(await checkTTS(), null, 2));
  // Not a failure: the fix is a /bind in the running bot.
  for (const warning of warnings) console.error(`Warning: ${warning}`);
  for (const problem of problems) console.error(`Error: ${problem}`);
  if (problems.length > 0) process.exitCode = 1;
}
void doctor().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Runtime diagnostic failed.");
  process.exitCode = 1;
}).finally(async () => {
  closeDatabase();
  await shutdownTTS();
});

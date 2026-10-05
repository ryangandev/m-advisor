import dotenv from "dotenv";
import { execFileSync } from "node:child_process";
import { getCiphers } from "node:crypto";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { generateDependencyReport } from "@discordjs/voice";
import ffmpeg from "ffmpeg-static";
import { getRiotMode } from "../services/riotData";
import { closeDatabase, getDatabasePath } from "../store/database";
import { listBindings } from "../store/bindingStore";
import { skippedMockAccountWarnings } from "../utils/bindingAccounts";
import { getLogDirectory } from "../utils/log";
import { checkTTS, shutdownTTS } from "../utils/tts";

dotenv.config({ quiet: true });
async function doctor(): Promise<void> {
  if (!ffmpeg) throw new Error("FFmpeg executable is unavailable.");
  execFileSync(ffmpeg, ["-version"], { stdio: "ignore" });
  const db = new Database(":memory:");
  try { db.prepare("SELECT 1").get(); } finally { db.close(); }
  const database = getDatabasePath();
  // Read saved bindings only from an existing file; the doctor never creates the bot's database.
  const bindings = database !== ":memory:" && existsSync(database) ? listBindings() : [];
  const warnings = getRiotMode() === "real" ? skippedMockAccountWarnings(bindings) : [];
  console.log(JSON.stringify({ node: process.version, riotMode: getRiotMode(), ttsProvider: "local", discordConfigured: Boolean(process.env.DISCORD_TOKEN && process.env.CLIENT_ID), riotKeyPresent: Boolean(process.env.RIOT_API_KEY), testGuildConfigured: Boolean(process.env.TEST_GUILD_ID), testChannelConfigured: Boolean(process.env.TEST_VOICE_CHANNEL_ID), database, savedBindings: bindings.length, logDirectory: getLogDirectory(), ffmpegExecutable: true, sqliteReady: true, aes256gcm: getCiphers().includes("aes-256-gcm") }, null, 2));
  console.log(generateDependencyReport());
  if (process.argv.includes("--voice")) console.log(JSON.stringify(await checkTTS(), null, 2));
  // Not a failure: the fix is a /bind in the running bot.
  for (const warning of warnings) console.error(`Warning: ${warning}`);
}
void doctor().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Runtime diagnostic failed.");
  process.exitCode = 1;
}).finally(async () => {
  closeDatabase();
  await shutdownTTS();
});

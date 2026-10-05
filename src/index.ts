import dotenv from "dotenv";
import { readdirSync } from "node:fs";
import path from "node:path";
import { Client, Collection, GatewayIntentBits } from "discord.js";
import { loadCommands } from "./handlers/commandHandler";
import { BotCommand, BotEvent } from "./types";
import { getRiotMode } from "./services/riotData";
import { stopAllPolling } from "./services/gameMonitor";
import { shutdownTTS } from "./utils/tts";
import { closeDatabase } from "./store/database";
import { getVoiceConnections } from "@discordjs/voice";
import { beginShutdown, isStopping } from "./services/shutdownState";
import { logError, logInfo, logToFileOnly, startFileLog } from "./utils/log";

dotenv.config({ quiet: true });
logInfo(`Bot starting; logs are also saved in ${startFileLog()}.`);
// Node prints these itself; the hooks only keep a copy in the log file and never change crash behavior.
process.on("uncaughtExceptionMonitor", (error: unknown, origin) => {
  logToFileOnly("ERROR", `Bot crashed (${origin}): ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
});
process.on("warning", (warning) => { logToFileOnly("WARN", `${warning.name}: ${warning.message}`); });

const RUNTIME_MODULE_EXTENSION = path.extname(__filename);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.commands = new Collection<string, BotCommand>();

async function loadEvents(): Promise<void> {
  const eventsPath = path.join(__dirname, "events");
  const eventFiles = readdirSync(eventsPath).filter((file) => file.endsWith(RUNTIME_MODULE_EXTENSION));

  for (const file of eventFiles) {
    const filePath = path.join(eventsPath, file);
    const eventModule = (await import(filePath)) as { default?: BotEvent };
    const event = eventModule.default;

    if (!event?.name || !event?.execute) {
      continue;
    }

    const listener = (...args: unknown[]): void => {
      void Promise.resolve().then(() => {
        if (!isStopping()) return event.execute(...args);
      }).catch(reportEventError);
    };
    if (event.once) client.once(event.name, listener);
    else client.on(event.name, listener);
  }
}

async function bootstrap(): Promise<void> {
  if (isStopping()) return;
  const mode = getRiotMode();
  if (mode === "real" && !process.env.RIOT_API_KEY?.trim()) {
    throw new Error("RIOT_MODE=real requires RIOT_API_KEY. Use mock mode to test without a key.");
  }
  await loadEvents();
  if (isStopping()) return;
  await loadCommands(client);
  if (isStopping()) return;

  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error("Missing DISCORD_TOKEN environment variable.");
  }

  await client.login(token);
  if (isStopping()) await client.destroy();
}

function reportEventError(error: unknown): void {
  logError(`Discord event failed: ${error instanceof Error ? error.message : "unknown error"}`);
}

let shutdownPromise: Promise<void> | undefined;
function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  beginShutdown();
  shutdownPromise = Promise.resolve().then(async () => {
    let failed = false;
    const cleanup = async (label: string, operation: () => unknown | Promise<unknown>): Promise<void> => {
      try { await operation(); }
      catch (error) {
        failed = true;
        process.exitCode = 1;
        logError(`Bot shutdown failed (${label}): ${error instanceof Error ? error.name : "unknown error"}`);
      }
    };
    await cleanup("match monitoring", stopAllPolling);
    await cleanup("voice connections", async () => {
      for (const connection of getVoiceConnections().values()) {
        await cleanup("voice connection", () => connection.destroy());
      }
    });
    await cleanup("Discord client", () => client.destroy());
    await cleanup("speech provider", shutdownTTS);
    await cleanup("database", closeDatabase);
    if (failed) logError("Bot stopped with cleanup errors; see the messages above.");
    else logInfo("Bot stopped; speech process and database closed.");
  });
  return shutdownPromise;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    const deadline = setTimeout(() => process.exit(1), 15_000).unref();
    void shutdown().then(() => { clearTimeout(deadline); }).catch(() => { process.exitCode = 1; });
  });
}

void bootstrap().catch(async (error: unknown) => {
  logError(`Bot startup failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
  await shutdown();
});

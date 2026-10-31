import dotenv from "dotenv";
import { readdirSync } from "node:fs";
import path from "node:path";
import { Client, Collection, GatewayIntentBits } from "discord.js";
import { loadCommands } from "./handlers/commandHandler";
import { BotCommand, BotEvent } from "./types";
import { getRiotMode } from "./services/riotData";
import { stopAllPolling } from "./services/gameMonitor";
import { finishReportScheduler, haltReportScheduler } from "./services/reportScheduler";
import { shutdownTTS } from "./utils/tts";
import { shutdownDatabase } from "./store/database";
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
  // A message that sets no allowedMentions of its own still pings nobody.
  allowedMentions: { parse: [], repliedUser: false },
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
    await cleanup("report scheduler halt", haltReportScheduler);
    await cleanup("match monitoring", stopAllPolling);
    await cleanup("voice connections", async () => {
      for (const connection of getVoiceConnections().values()) {
        await cleanup("voice connection", () => connection.destroy());
      }
    });
    await cleanup("Discord client", () => client.destroy());
    await cleanup("speech provider", shutdownTTS);
    // A report still being sent gets a few seconds to finish before the database closes under it.
    await cleanup("report scheduler", () => finishReportScheduler());
    await cleanup("database", shutdownDatabase);
    if (failed) logError("Bot stopped with cleanup errors; see the messages above.");
    else logInfo("Bot stopped; speech process and database closed.");
  });
  return shutdownPromise;
}

// Closing the launcher window removes the terminal. Initialise both streams while it is alive: opening stderr for the
// first time afterwards blocks the main thread, and a write to a dead terminal emits EIO that would crash the shutdown.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});

// A repeat of the signal that arrives this soon after the first is the same request, not a second one. Ctrl+C under
// `npm start` reaches the bot twice almost at once: the terminal signals the whole foreground process group, and npm
// also forwards it to its child. A person pressing Ctrl+C again takes longer than this.
const REPEAT_SIGNAL_WINDOW_MS = 1_000;
const SHUTDOWN_DEADLINE_MS = 15_000;
const firstArrival = new Map<NodeJS.Signals, number>();
let deadline: NodeJS.Timeout | undefined;

// SIGHUP is what closing the launcher's Terminal window sends; its default would exit without any cleanup.
// The listeners stay registered (`on`, not `once`): a signal with no listener takes its default action and would kill
// the process in the middle of cleanup.
// Arrivals are tracked per signal: a different signal (closing the window while Ctrl+C is cleaning up) joins the
// running shutdown, and only a repeat of the same signal after the window ends the process at once.
function handleStopSignal(signal: NodeJS.Signals): void {
  const now = performance.now();
  const earlier = firstArrival.get(signal);
  if (earlier !== undefined) {
    if (now - earlier < REPEAT_SIGNAL_WINDOW_MS) return;
    logError(`${signal} received again while stopping; ending the process now.`);
    process.exit(1);
  }
  firstArrival.set(signal, now);
  if (deadline) return;
  deadline = setTimeout(() => process.exit(1), SHUTDOWN_DEADLINE_MS).unref();
  void shutdown().then(() => { clearTimeout(deadline); }).catch(() => { process.exitCode = 1; });
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, handleStopSignal);

void bootstrap().catch(async (error: unknown) => {
  logError(`Bot startup failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
  await shutdown();
});

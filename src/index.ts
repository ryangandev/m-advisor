import dotenv from "dotenv";
import { readdirSync } from "node:fs";
import path from "node:path";
import { Client, Collection, GatewayIntentBits } from "discord.js";
import { loadCommands } from "./handlers/commandHandler";
import { BotCommand, BotEvent } from "./types";

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.commands = new Collection<string, BotCommand>();

async function loadEvents(): Promise<void> {
  const eventsPath = path.join(__dirname, "events");
  const eventFiles = readdirSync(eventsPath).filter((file) => file.endsWith(".ts"));

  for (const file of eventFiles) {
    const filePath = path.join(eventsPath, file);
    const eventModule = (await import(filePath)) as { default?: BotEvent };
    const event = eventModule.default;

    if (!event?.name || !event?.execute) {
      continue;
    }

    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args));
    } else {
      client.on(event.name, (...args) => event.execute(...args));
    }
  }
}

async function bootstrap(): Promise<void> {
  await loadEvents();
  await loadCommands(client);

  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error("Missing DISCORD_TOKEN environment variable.");
  }

  await client.login(token);
}

void bootstrap();

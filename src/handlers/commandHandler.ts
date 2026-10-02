import { readdirSync } from "node:fs";
import path from "node:path";
import { REST, Routes } from "discord.js";
import { BotCommand } from "../types";

const RUNTIME_MODULE_EXTENSION = path.extname(__filename);

export async function loadCommands(client: import("discord.js").Client): Promise<void> {
  const commandsPath = path.join(__dirname, "..", "commands");
  const commandFiles = readdirSync(commandsPath).filter((file) => file.endsWith(RUNTIME_MODULE_EXTENSION));

  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const commandModule = (await import(filePath)) as { default?: BotCommand };
    const command = commandModule.default;

    if (command?.data) {
      client.commands.set(command.data.name, command);
    }
  }
}

export async function registerCommands(guildId = process.env.TEST_GUILD_ID?.trim()): Promise<string[]> {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;

  if (!token || !clientId) {
    throw new Error("Missing DISCORD_TOKEN or CLIENT_ID environment variable.");
  }
  if (!guildId || !/^\d{17,20}$/.test(guildId)) {
    throw new Error("Set TEST_GUILD_ID to the authorized server ID before registering commands.");
  }

  const commandsPath = path.join(__dirname, "..", "commands");
  const commandFiles = readdirSync(commandsPath).filter((file) => file.endsWith(RUNTIME_MODULE_EXTENSION));
  const payload: ReturnType<BotCommand["data"]["toJSON"]>[] = [];

  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const commandModule = (await import(filePath)) as { default?: BotCommand };
    const command = commandModule.default;

    if (command?.data) {
      payload.push(command.data.toJSON());
    }
  }

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: payload });
  return payload.map(command => command.name);
}

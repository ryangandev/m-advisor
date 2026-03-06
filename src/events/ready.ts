import { Events } from "discord.js";
import { registerCommands } from "../handlers/commandHandler";

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client: import("discord.js").Client): Promise<void> {
    const tag = client.user?.tag ?? "unknown-user";
    console.log(`Logged in as ${tag}`);

    try {
      await registerCommands();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to register commands.";
      console.error(message);
    }
  },
};

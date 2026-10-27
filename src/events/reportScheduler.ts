import { Events } from "discord.js";
import { startReportScheduler } from "../services/reportScheduler";
import { isStopping } from "../services/shutdownState";

/**
 * Starts the daily and weekly 马报 scheduler once the bot is connected.
 * This is a second ClientReady listener of its own, so the main ready handler is not involved.
 * The scheduler's first check is the catch-up after a restart; src/index.ts stops it during shutdown.
 */
export default {
  name: Events.ClientReady,
  once: true,
  async execute(client: import("discord.js").Client): Promise<void> {
    if (isStopping()) return;
    startReportScheduler(client);
  },
};

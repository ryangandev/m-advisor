import { Events, Guild } from "discord.js";
import { handleGuildAvailable } from "../services/monitorLifecycle";

export default {
  name: Events.GuildAvailable,
  async execute(guild: Guild): Promise<void> {
    // At startup every guild becomes available before ClientReady; restoreMonitoring is the startup path.
    if (!guild.client.isReady()) return;
    await handleGuildAvailable(guild);
  },
};

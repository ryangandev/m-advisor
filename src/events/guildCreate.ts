import { Events } from "discord.js";
import type { Guild } from "discord.js";
import { handleGuildAvailable } from "../services/monitorLifecycle";

/**
 * Reconciles a server the bot has just joined. discord.js emits GuildCreate, not GuildAvailable, when the bot is invited
 * back after a removal, and that event carries the members' voice states without any VoiceStateUpdate, so without this
 * a re-added server would not be monitored until a tracked member joined, left or moved.
 * At startup every guild is created before ClientReady, and restoreMonitoring is the startup path, so nothing happens
 * until the client is ready. `reconcile` is injectable for tests.
 */
export async function handleGuildCreated(guild: Guild, reconcile: (guild: Guild) => Promise<void> = handleGuildAvailable): Promise<void> {
  if (!guild.client.isReady()) return;
  await reconcile(guild);
}

export default {
  name: Events.GuildCreate,
  async execute(guild: Guild): Promise<void> {
    await handleGuildCreated(guild);
  },
};

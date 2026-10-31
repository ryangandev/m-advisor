import { Events } from "discord.js";
import type { Client, Guild } from "discord.js";
import { reconcileGuildMonitoring } from "../services/monitorLifecycle";
import { logInfo } from "../utils/log";

/**
 * Handles the bot being removed from a server: logs once and stops that server's monitoring, so the match poll and the
 * game-start watcher stop calling Riot for a server the bot can no longer reach. Nothing is deleted: the server's stored
 * data stays until the host erases it. The report scheduler notices the removal by itself.
 * discord.js has already dropped the server from the client's cache when this fires, so the per-server reconcile stops
 * the session, and it does so behind any reconcile still reading voice states, which can then no longer restart it.
 * discord.js emits a Discord outage as GuildUnavailable, not as this event, so only a real removal stops anything.
 * `reconcile` is injectable for tests.
 */
export function handleGuildRemoved(
  guild: Pick<Guild, "id" | "name" | "client">,
  reconcile: (client: Client, guildId: string) => Promise<void> = reconcileGuildMonitoring,
): Promise<void> {
  logInfo(`Removed from server ${guild.name ? `${guild.name} (${guild.id})` : guild.id}; its stored data stays until the host deletes it.`);
  return reconcile(guild.client, guild.id);
}

export default {
  name: Events.GuildDelete,
  execute(guild: Guild): Promise<void> {
    return handleGuildRemoved(guild);
  },
};

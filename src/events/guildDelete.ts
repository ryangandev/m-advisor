import { Events } from "discord.js";
import type { Guild } from "discord.js";
import { stopPolling } from "../services/gameMonitor";
import { logInfo } from "../utils/log";

/**
 * Handles the bot being removed from a server: logs once and stops that server's monitoring, so the match poll and the
 * game-start watcher stop calling Riot for a server the bot can no longer reach. Nothing is deleted: the server's stored
 * data stays until the host erases it. The report scheduler notices the removal by itself.
 * discord.js emits a Discord outage as GuildUnavailable, not as this event, so only a real removal stops anything.
 * `stop` is injectable for tests.
 */
export function handleGuildRemoved(guild: Pick<Guild, "id" | "name">, stop: (guildId: string, reason: string) => void = stopPolling): void {
  logInfo(`Removed from server ${guild.name ? `${guild.name} (${guild.id})` : guild.id}; its stored data stays until the host deletes it.`);
  stop(guild.id, "the bot was removed from this server");
}

export default {
  name: Events.GuildDelete,
  execute(guild: Guild): void {
    handleGuildRemoved(guild);
  },
};

import { Events } from "discord.js";
import type { Guild } from "discord.js";
import { logInfo } from "../utils/log";

/**
 * Logs once when the bot is removed from a server. Nothing is deleted: the server's stored data stays until the host erases it.
 * discord.js emits a Discord outage as GuildUnavailable, not as this event.
 */
export default {
  name: Events.GuildDelete,
  execute(guild: Guild): void {
    logInfo(`Removed from server ${guild.name ? `${guild.name} (${guild.id})` : guild.id}; its stored data stays until the host deletes it.`);
  },
};

import { Events } from "discord.js";
import type { Guild } from "discord.js";
import { logInfo } from "../utils/log";

/**
 * Logs once when the bot is removed from a server. Nothing is deleted: the server's stored data stays until the host erases it.
 * A Discord outage also emits this event with the server marked unavailable, and the bot is still a member then.
 */
export default {
  name: Events.GuildDelete,
  execute(guild: Guild): void {
    if (!guild.available) return;
    logInfo(`Removed from server ${guild.name ? `${guild.name} (${guild.id})` : guild.id}; its stored data stays until the host deletes it.`);
  },
};

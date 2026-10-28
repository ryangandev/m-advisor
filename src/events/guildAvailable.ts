import { Events, Guild } from "discord.js";
import { handleGuildAvailable } from "../services/monitorLifecycle";

export default {
  name: Events.GuildAvailable,
  async execute(guild: Guild): Promise<void> {
    await handleGuildAvailable(guild);
  },
};

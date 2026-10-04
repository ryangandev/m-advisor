import { Client } from "discord.js";
import { getBinding, listBindings } from "../store/bindingStore";
import { startPolling, stopPolling } from "./gameMonitor";
import { isStopping } from "./shutdownState";

export async function reconcileGuildMonitoring(client: Client, guildId: string): Promise<void> {
  if (isStopping()) return;
  const binding = getBinding(guildId);
  const guild = client.guilds.cache.get(guildId);
  if (!binding || !guild) { stopPolling(guildId, "there is no binding in this server"); return; }
  const member = await guild.members.fetch(binding.discordUserId).catch(() => null);
  if (isStopping()) return;
  if (!member?.voice.channelId) { stopPolling(guildId, "the tracked member is not in voice"); return; }
  startPolling(client, guildId, member.voice.channelId);
}

export async function restoreMonitoring(client: Client): Promise<void> {
  for (const { guildId } of listBindings()) {
    if (isStopping()) return;
    await reconcileGuildMonitoring(client, guildId);
  }
}

import { Events, VoiceState } from "discord.js";
import { listTrackedMembers } from "../store/bindingStore";
import { setActiveVoiceChannel } from "../store/announcerStore";
import { startPolling, stopPolling } from "../services/gameMonitor";

export default {
  name: Events.VoiceStateUpdate,
  async execute(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const guildId = newState.guild.id;
    const binding = listTrackedMembers(guildId)[0];

    if (!binding) {
      return;
    }

    const isBoundMember =
      newState.id === binding.discordUserId || oldState.id === binding.discordUserId;

    if (!isBoundMember) {
      return;
    }

    if (!oldState.channelId && newState.channelId) {
      setActiveVoiceChannel(guildId, newState.channelId);
      startPolling(newState.client, guildId, newState.channelId);
      return;
    }

    if (
      oldState.channelId &&
      newState.channelId &&
      oldState.channelId !== newState.channelId
    ) {
      setActiveVoiceChannel(guildId, newState.channelId);
      return;
    }

    if (oldState.channelId && !newState.channelId) {
      setActiveVoiceChannel(guildId, null);
      stopPolling(guildId, "the tracked member left voice");
    }
  },
};

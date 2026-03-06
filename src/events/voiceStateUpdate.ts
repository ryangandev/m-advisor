import { Events, VoiceState } from "discord.js";
import { getBinding } from "../store/bindingStore";
import { setActiveVoiceChannel } from "../store/announcerStore";
import { startPolling, stopPolling } from "../services/gameMonitor";

export default {
  name: Events.VoiceStateUpdate,
  async execute(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const guildId = newState.guild.id;
    const binding = getBinding(guildId);

    if (!binding) {
      return;
    }

    const isBoundMember =
      newState.member?.id === binding.discordUserId || oldState.member?.id === binding.discordUserId;

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
      stopPolling(guildId);
    }
  },
};

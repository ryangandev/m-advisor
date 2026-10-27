import { Events, VoiceState } from "discord.js";
import { handleVoiceStateUpdate } from "../services/monitorLifecycle";

export default {
  name: Events.VoiceStateUpdate,
  async execute(oldState: VoiceState, newState: VoiceState): Promise<void> {
    await handleVoiceStateUpdate(oldState, newState);
  },
};

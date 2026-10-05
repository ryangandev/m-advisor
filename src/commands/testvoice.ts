import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { BotCommand } from "../types";
import { getAnnouncerState } from "../store/announcerStore";
import { announceTextInVoiceChannel } from "../services/voiceAnnouncements";
import { getAuthorizedTestChannel, safeTestError } from "../utils/testChannel";
import { assertRunning } from "../services/shutdownState";
import { logError } from "../utils/log";

const command: BotCommand = {
  data: new SlashCommandBuilder().setName("testvoice").setDescription("测试本地军师语音播报")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      assertRunning();
      const channel = await getAuthorizedTestChannel(interaction);
      assertRunning();
      const canPlay = () => channel.guild.members.cache.get(interaction.user.id)?.voice.channelId === channel.id;
      await announceTextInVoiceChannel(channel, "策马军师语音测试。今晚和朋友一起开黑，打完一局就来点评战绩。", getAnnouncerState(channel.guild.id).voiceStyle, canPlay);
      assertRunning();
      await interaction.editReply("语音播放流程已完成。请确认频道里实际听到了播报。");
    } catch (error) {
      logError(`Voice test failed: ${error instanceof Error ? error.name : "unknown error"}`);
      await interaction.editReply(safeTestError(error));
    }
  },
};
export default command;

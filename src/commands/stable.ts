import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { BotCommand } from "../types";
import { getMemberHorseProfile } from "../services/horseProfile";
import { isMockData } from "../services/riotData";
import { getTrackedMember } from "../store/bindingStore";
import { countMemberHorseRecords } from "../store/horseRecordStore";
import { buildErrorEmbed } from "../utils/embeds";
import { buildStableEmbed } from "../utils/stableEmbed";

const stableCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("stable")
    .setDescription("查看某位朋友的马厩档案：特等马率、没有马次数、强弱项和近况")
    .addUserOption((option) => option
      .setName("user")
      .setDescription("要查看的成员，默认是你自己")) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ embeds: [buildErrorEmbed("这个命令只能在服务器里使用。")], flags: MessageFlags.Ephemeral });
      return;
    }
    const memberId = (interaction.options.getUser("user") ?? interaction.user).id;
    const mock = isMockData();
    const counts = countMemberHorseRecords(guildId, memberId);
    // The public reply shows only the data mode the bot runs in, so mock games never count as real ones.
    const embed = buildStableEmbed({
      mock,
      memberId,
      tracked: getTrackedMember(guildId, memberId) !== undefined,
      profile: getMemberHorseProfile(guildId, memberId, mock),
      otherModeGames: mock ? counts.real : counts.mock,
    });
    await interaction.reply({ embeds: [embed], allowedMentions: { parse: [], roles: [], users: [], repliedUser: false } });
  },
};

export default stableCommand;

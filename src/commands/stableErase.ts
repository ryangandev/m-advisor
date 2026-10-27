import { ChatInputCommandInteraction, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { BotCommand } from "../types";
import { countMemberAppeals } from "../store/appealStore";
import { countMemberHorseRecords, eraseMemberHorseRecords } from "../store/horseRecordStore";
import { countMemberRankResults } from "../store/rankStore";
import { buildErrorEmbed } from "../utils/embeds";
import { logInfo } from "../utils/log";
import { isAdmin } from "../utils/permissions";

const noMentions = { parse: [], roles: [], users: [], repliedUser: false } as const;

const stableEraseCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("stable-erase")
    .setDescription("Erase one member's whole 马厩 history on request (Admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((option) => option
      .setName("user")
      .setDescription("Discord member whose history to erase")
      .setRequired(true))
    .addBooleanOption((option) => option
      .setName("confirm")
      .setDescription("Set to true to erase for real; otherwise only counts the records")) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAdmin(interaction)) {
      await interaction.reply({ content: "You need Administrator permission to use this command.", flags: MessageFlags.Ephemeral, allowedMentions: noMentions });
      return;
    }
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ embeds: [buildErrorEmbed("这个命令只能在服务器里使用。")], flags: MessageFlags.Ephemeral });
      return;
    }
    const user = interaction.options.getUser("user", true);
    const counts = countMemberHorseRecords(guildId, user.id);
    // Everything the erase deletes counts: a member with only appeal cases or LP results still has something to erase.
    const appeals = countMemberAppeals(guildId, user.id);
    const ranks = countMemberRankResults(guildId, user.id);
    if (counts.real + counts.mock + appeals + ranks === 0) {
      await interaction.reply({ content: `<@${user.id}> 没有马厩档案，没有什么可清除的。`, flags: MessageFlags.Ephemeral, allowedMentions: noMentions });
      return;
    }
    const extras = [appeals > 0 ? `${appeals} 个上诉案件` : "", ranks > 0 ? `${ranks} 条段位记录` : ""].filter(Boolean);
    const detail = `${counts.real} 局真实记录和 ${counts.mock} 局模拟记录${extras.length > 0 ? `，以及${extras.join("和")}` : ""}`;
    if (interaction.options.getBoolean("confirm") !== true) {
      await interaction.reply({
        content: `<@${user.id}> 有${detail}。清除后无法恢复，确认的话请重新执行并把 confirm 设为 true。`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: noMentions,
      });
      return;
    }
    const erased = eraseMemberHorseRecords(guildId, user.id);
    logInfo(`Erased ${erased} horse records of one member on request.`);
    await interaction.reply({ content: `已清除 <@${user.id}> 的全部马厩档案（${detail}）。`, flags: MessageFlags.Ephemeral, allowedMentions: noMentions });
  },
};

export default stableEraseCommand;

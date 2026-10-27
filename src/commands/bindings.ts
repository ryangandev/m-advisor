import {
  MessageFlags,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { getRiotDataLabel, isMockData } from "../services/riotData";
import { isSyntheticAccount } from "../utils/bindingAccounts";
import { BotCommand, RiotAccount } from "../types";
import { isAdmin } from "../utils/permissions";
import { NO_MENTIONS } from "../utils/embeds";
import { listTrackedMembers } from "../store/bindingStore";

function accountLine(account: RiotAccount): string {
  const label = isSyntheticAccount(account)
    ? (isMockData() ? "（模拟账号）" : "（模拟账号，真实模式下不监听；用 /bind 绑定真实 Riot ID 后会自动移除）")
    : "";
  return `• ${account.gameName}#${account.tagLine}${label}`;
}

const bindingsCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("bindings")
    .setDescription("View every tracked member of this server and their accounts (Admin only)"),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAdmin(interaction)) {
      await interaction.reply({
        content: "You need Administrator permission to use this command.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xE74C3C)
            .setTitle("Error")
            .setDescription("This command can only be used in a server."),
        ],
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    const embed = new EmbedBuilder().setTitle("Server Bindings").setColor(0x5865F2);
    const members = listTrackedMembers(guildId);
    if (members.length === 0) {
      embed.setDescription("No bindings set for this server.");
    } else {
      // One field per member in bind order; at most 10 accounts per server keeps this inside Discord's 25 fields.
      embed.addFields(members.map((member, index) => ({
        name: `Tracked Member ${index + 1}`,
        value: [`<@${member.discordUserId}>`, ...member.accounts.map(accountLine)].join("\n").slice(0, 1024),
        inline: false,
      })));
    }
    embed.setFooter({ text: `NA Server • M-Advisor • ${getRiotDataLabel()}` });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });
  },
};

export default bindingsCommand;

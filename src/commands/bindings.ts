import {
  MessageFlags,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { getRiotDataLabel, isMockData } from "../services/riotData";
import { isSyntheticAccount } from "../utils/bindingAccounts";
import { BotCommand } from "../types";
import { isAdmin } from "../utils/permissions";
import { getBinding } from "../store/bindingStore";

const bindingsCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("bindings")
    .setDescription("View the current server binding (Admin only)"),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAdmin(interaction)) {
      await interaction.reply({
        content: "You need Administrator permission to use this command.",
        flags: MessageFlags.Ephemeral,
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
      });
      return;
    }

    const binding = getBinding(guildId);
    if (!binding) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle("Server Bindings")
            .setDescription("No bindings set for this server.")
            .setFooter({ text: `NA Server • M-Advisor • ${getRiotDataLabel()}` }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const accountList = binding.accounts
      .map((account) => `• ${account.gameName}#${account.tagLine}${isSyntheticAccount(account) ? (isMockData() ? "（模拟账号）" : "（模拟账号，真实模式下不监听；用 /bind 绑定真实 Riot ID 后会自动移除）") : ""}`)
      .join("\n");

    const embed = new EmbedBuilder()
      .setTitle("Server Bindings")
      .setColor(0x5865F2)
      .addFields(
        { name: "Tracked Member", value: `<@${binding.discordUserId}>`, inline: false },
        { name: "Bound Accounts", value: accountList || "None", inline: false },
      )
      .setFooter({ text: `NA Server • M-Advisor • ${getRiotDataLabel()}` });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

export default bindingsCommand;

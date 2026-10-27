import { Events, Interaction, MessageFlags } from "discord.js";
import type { AutocompleteInteraction, ButtonInteraction, ChatInputCommandInteraction } from "discord.js";
import { buildErrorEmbed } from "../utils/embeds";
import { getCommandUserErrorMessage } from "../utils/userFacingErrors";
import { logError } from "../utils/log";

/** Error class only: DiscordAPIError carries interaction-token URLs and request bodies. */
const errorName = (error: unknown) => error instanceof Error ? error.name : "unknown error";

/** Tells the user privately that something failed, in whichever way the interaction still allows. */
async function replyWithError(interaction: ChatInputCommandInteraction | ButtonInteraction, error: unknown): Promise<void> {
  const errorEmbed = buildErrorEmbed(getCommandUserErrorMessage(error));
  if (interaction.replied) {
    await interaction.followUp({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
  } else if (interaction.deferred) {
    await interaction.editReply({ embeds: [errorEmbed] });
  } else {
    await interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
  }
}

async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const command = interaction.client.commands.get(interaction.commandName);
  try {
    if (command?.autocomplete) await command.autocomplete(interaction);
    else await interaction.respond([]);
  } catch (error) {
    logError(`Autocomplete failed for /${interaction.commandName}: ${errorName(error)}`);
    if (!interaction.responded) await interaction.respond([]).catch(() => undefined);
  }
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const prefix = interaction.customId.split(":", 1)[0];
  const command = interaction.client.commands.find((candidate) => candidate.componentPrefix === prefix && candidate.handleButton !== undefined);
  if (!command?.handleButton) {
    await interaction.reply({ content: "这个按钮已经失效了。", flags: MessageFlags.Ephemeral });
    return;
  }
  try {
    await command.handleButton(interaction);
  } catch (error) {
    // The custom ID names members and matches, so only its prefix is logged.
    logError(`Button handling failed for ${prefix}: ${errorName(error)}`);
    await replyWithError(interaction, error);
  }
}

export default {
  name: Events.InteractionCreate,
  async execute(interaction: Interaction): Promise<void> {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }
    if (interaction.isButton()) {
      await handleButton(interaction);
      return;
    }
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const command = interaction.client.commands.get(interaction.commandName);
    if (!command) {
      const content = interaction.commandName === "testvc"
        ? "旧的 /testvc 已停用。请让管理员更新此服务器的 Bot 命令，然后使用 /testvoice 测试语音。"
        : "这个命令当前不可用。请让管理员更新此服务器的 Bot 命令后再试。";
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      // Retain only the error class in logs; the reply uses the safe mapper.
      logError(`Command execution failed for /${interaction.commandName}: ${errorName(error)}`);
      await replyWithError(interaction, error);
    }
  },
};

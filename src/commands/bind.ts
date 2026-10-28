import {
  MessageFlags,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
} from "discord.js";
import { BotCommand } from "../types";
import { buildErrorEmbed, NO_MENTIONS } from "../utils/embeds";
import { isAdmin } from "../utils/permissions";
import { AccountBoundToOtherMemberError, getTrackedMember, setMemberAccounts } from "../store/bindingStore";
import { getAccountByRiotId } from "../utils/riotApi";
import { INVALID_RIOT_ID_MESSAGE, parseRiotId } from "../utils/riotId";
import { reconcileGuildMonitoring } from "../services/monitorLifecycle";
import { forgetMemberBaselines } from "../services/gameMonitor";
import { getRiotDataLabel, isMockData } from "../services/riotData";
import { isSyntheticAccount, mergeBoundAccount } from "../utils/bindingAccounts";
import { getBindingStoreErrorMessage, getRiotUserErrorMessage } from "../utils/userFacingErrors";
import { assertRunning } from "../services/shutdownState";
import { logInfo } from "../utils/log";

const bindCommand: BotCommand = {
  data: (new SlashCommandBuilder()
    .setName("bind")
    .setDescription("Bind a LoL account to a Discord member (Admin only)")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("Discord member to bind")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("riotid")
        .setDescription("Riot ID (e.g. Faker#KR1)")
        .setRequired(true),
    ) as SlashCommandOptionsOnlyBuilder) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAdmin(interaction)) {
      await interaction.reply({
        content: "You need Administrator permission to use this command.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    assertRunning();

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply({
        embeds: [buildErrorEmbed("This command can only be used in a server.")],
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    const user = interaction.options.getUser("user", true);
    const riotId = interaction.options.getString("riotid", true).trim();
    const parsedRiotId = parseRiotId(riotId);

    if (!parsedRiotId) {
      await interaction.editReply({
        embeds: [buildErrorEmbed(INVALID_RIOT_ID_MESSAGE)],
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    const { gameName, tagLine } = parsedRiotId;

    let account;
    try {
      account = await getAccountByRiotId(gameName, tagLine);
    } catch (error) {
      await interaction.editReply({ embeds: [buildErrorEmbed(getRiotUserErrorMessage(error))], allowedMentions: NO_MENTIONS });
      return;
    }

    assertRunning();
    // Binding adds the member after everyone already tracked, or adds an account to them; other members are untouched.
    // Real mode never monitors saved mock accounts, so binding a real account replaces this member's mock accounts only.
    const savedAccounts = getTrackedMember(guildId, user.id)?.accounts ?? [];
    const removedMocks = isMockData() ? [] : savedAccounts.filter(isSyntheticAccount);
    const duplicate = savedAccounts.some(
      (boundAccount) =>
        boundAccount.puuid === account.puuid &&
        boundAccount.gameName.toLowerCase() === account.gameName.toLowerCase() &&
        boundAccount.tagLine.toLowerCase() === account.tagLine.toLowerCase(),
    );

    if (duplicate && removedMocks.length === 0) {
      await interaction.editReply({ content: "This account is already bound.", allowedMentions: NO_MENTIONS });
      return;
    }

    const updatedAccounts = mergeBoundAccount(savedAccounts.filter((boundAccount) => !removedMocks.includes(boundAccount)), account);

    try {
      // Rejects an account another member owns and the per-server account limit, changing nothing.
      setMemberAccounts(guildId, user.id, updatedAccounts);
    } catch (error) {
      // The administrator sees who owns the account; the mention sits in an embed and notifies no one.
      const message = error instanceof AccountBoundToOtherMemberError
        ? `That Riot account is already bound to <@${error.ownerId}>; /unbind them first.`
        : getBindingStoreErrorMessage(error);
      if (!message) throw error;
      await interaction.editReply({ embeds: [buildErrorEmbed(message)], allowedMentions: NO_MENTIONS });
      return;
    }

    // At once, not in the queued reconciliation: a baseline kept from before an unbind must not come back.
    forgetMemberBaselines(guildId, user.id);
    await reconcileGuildMonitoring(interaction.client, guildId);
    assertRunning();

    const normalizedRiotId = `${account.gameName}#${account.tagLine}`;
    // A mock account with the same Riot ID was refreshed, not removed.
    const removedRiotIds = removedMocks.map((removed) => `${removed.gameName}#${removed.tagLine}`)
      .filter((riotId) => riotId.toLowerCase() !== normalizedRiotId.toLowerCase()).join(", ");
    logInfo(`Bound ${normalizedRiotId} to Discord member ${user.username}`
      + `${removedRiotIds ? `; removed the mock account ${removedRiotIds}, which real mode does not monitor` : ""}.`);
    const successEmbed = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle("Binding Updated")
      .setFooter({ text: getRiotDataLabel() })
      .setDescription(`Bound ${normalizedRiotId} to <@${user.id}>`
        + (removedRiotIds ? `\nRemoved the simulated account ${removedRiotIds}, which real mode does not monitor.` : ""));

    await interaction.editReply({ embeds: [successEmbed], allowedMentions: NO_MENTIONS });
  },
};

export default bindCommand;

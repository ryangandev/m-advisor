import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { BotCommand } from "../types";
import { getBinding } from "../store/bindingStore";
import { getLastMatchId } from "../store/announcerStore";
import { getMonitorStatus, POLL_INTERVAL_MS } from "../services/gameMonitor";
import { isMockData } from "../services/riotData";
import { getMatchDetail, getRecentMatchIds } from "../utils/riotMatchApi";
import { buildErrorEmbed, buildRecentMatchesEmbed, type RecentAccountView } from "../utils/embeds";
import { getRiotUserErrorMessage } from "../utils/userFacingErrors";

const recentCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("recent")
    .setDescription("查看绑定玩家最近的对局和监听状态")
    .addIntegerOption((option) => option
      .setName("count")
      .setDescription("每个账号显示几局，默认 5 局")
      .setMinValue(1)
      .setMaxValue(10)) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ embeds: [buildErrorEmbed("这个命令只能在服务器里使用。")], flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const binding = getBinding(guildId);
    if (!binding) {
      await interaction.editReply({ embeds: [buildErrorEmbed("这个服务器还没有绑定玩家，先用 /bind 绑定。")] });
      return;
    }

    const count = interaction.options.getInteger("count") ?? 5;
    const mock = isMockData();
    const accounts = [...new Map(binding.accounts.map((account) => [account.puuid, account])).values()];
    const views = await Promise.all(accounts.map(async (account): Promise<RecentAccountView> => {
      const view: RecentAccountView = { riotId: `${account.gameName}#${account.tagLine}`, puuid: account.puuid, matches: [] };
      if (!mock && account.puuid.startsWith("MOCK-")) {
        return { ...view, notice: "⚠️ 这是模拟账号，真实模式下监听会跳过它。请先 /unbind，再用 /bind 绑定真实 Riot ID。" };
      }
      try {
        // Details are fetched one at a time to stay well inside the Riot rate limit; repeated lookups hit the cache.
        for (const matchId of await getRecentMatchIds(account.puuid, count)) {
          view.matches.push({ matchId, detail: await getMatchDetail(matchId) });
        }
        return { ...view, lastMatchId: getLastMatchId(guildId, account.puuid) };
      } catch (error) {
        return { ...view, matches: [], notice: `⚠️ ${getRiotUserErrorMessage(error)}` };
      }
    }));

    const voiceChannelId = interaction.guild?.members.cache.get(binding.discordUserId)?.voice.channelId ?? null;
    await interaction.editReply({ embeds: [buildRecentMatchesEmbed({
      mock,
      memberId: binding.discordUserId,
      voiceChannelId,
      pollIntervalSeconds: POLL_INTERVAL_MS / 1000,
      status: getMonitorStatus(guildId),
      accounts: views,
    })] });
  },
};

export default recentCommand;

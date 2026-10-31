import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { BotCommand } from "../types";
import { listTrackedMembers } from "../store/bindingStore";
import { getLastMatchId } from "../store/announcerStore";
import { getMonitorStatus, POLL_INTERVAL_MS } from "../services/gameMonitor";
import { isMockData } from "../services/riotData";
import { getMatchDetail, getRecentMatchIds } from "../utils/riotMatchApi";
import { buildErrorEmbed, buildRecentMatchesEmbed, NO_MENTIONS, type RecentAccountView, type RecentMemberView } from "../utils/embeds";
import { isRiotKeyRejection, logRiotKeyRejection } from "../services/riotKey";
import { getRiotUserErrorMessage } from "../utils/userFacingErrors";

/** How many accounts /recent reads from Riot at once; each reads its matches one at a time. */
export const RECENT_ACCOUNT_CONCURRENCY = 2;

/** /recent sends many requests at once, so they take the bulk share of the Riot pacer (see src/services/riotPacing.ts). */
const RECENT_REQUESTS = { priority: "bulk" } as const;

/** Maps in order with at most `limit` calls running at once. `fn` must not reject. */
async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const recentCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("recent")
    .setDescription("查看绑定玩家最近的对局和监听状态")
    .addIntegerOption((option) => option
      .setName("count")
      .setDescription("每个账号显示几局，默认 5 局")
      .setMinValue(1)
      .setMaxValue(10))
    .addUserOption((option) => option
      .setName("user")
      .setDescription("只看这一位成员，默认看全服务器")) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ embeds: [buildErrorEmbed("这个命令只能在服务器里使用。")], flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const tracked = listTrackedMembers(guildId);
    if (tracked.length === 0) {
      await interaction.editReply({ embeds: [buildErrorEmbed("这个服务器还没有绑定玩家，先用 /bind 绑定。")], allowedMentions: NO_MENTIONS });
      return;
    }
    const filter = interaction.options.getUser("user");
    // Numbers follow the whole server's bind order, so a filtered reply uses the same numbers as the full one.
    const members = tracked.map((member, index) => ({ member, order: index + 1 }))
      .filter(({ member }) => !filter || member.discordUserId === filter.id);
    if (members.length === 0) {
      await interaction.editReply({ embeds: [buildErrorEmbed(`<@${filter!.id}> 不是这个服务器的被追踪成员，用 /bindings 查看都有谁。`)], allowedMentions: NO_MENTIONS });
      return;
    }

    const count = interaction.options.getInteger("count") ?? 5;
    const mock = isMockData();
    // Every account fails the same way when the key is dead; the log gets the line once per command.
    let keyRejectionLogged = false;
    const accounts = members.flatMap(({ member, order }) => member.accounts.map((account) => ({ account, order })));
    // At most RECENT_ACCOUNT_CONCURRENCY accounts at a time; the replies still come back in bind order.
    // Its requests are bulk: the shared pacer gives them a smaller share of each americas window, so a cold /recent
    // waits for its turns instead of using up the limit that finished-match polling needs.
    const views = await mapWithLimit(accounts, RECENT_ACCOUNT_CONCURRENCY, async ({ account, order }): Promise<RecentAccountView> => {
      const view: RecentAccountView = { memberOrder: order, riotId: `${account.gameName}#${account.tagLine}`, puuid: account.puuid, matches: [] };
      if (!mock && account.puuid.startsWith("MOCK-")) {
        return { ...view, notice: "⚠️ 这是模拟账号，真实模式下监听会跳过它。用 /bind 绑定真实 Riot ID 后会自动移除它。" };
      }
      try {
        // Details are fetched one at a time; repeated lookups hit the cache.
        for (const matchId of await getRecentMatchIds(account.puuid, count, RECENT_REQUESTS)) {
          view.matches.push({ matchId, detail: await getMatchDetail(matchId, RECENT_REQUESTS) });
        }
        return { ...view, lastMatchId: getLastMatchId(guildId, account.puuid) };
      } catch (error) {
        if (!keyRejectionLogged && isRiotKeyRejection(error)) {
          keyRejectionLogged = true;
          logRiotKeyRejection(error);
        }
        return { ...view, matches: [], notice: `⚠️ ${getRiotUserErrorMessage(error)}` };
      }
    });

    const status = getMonitorStatus(guildId);
    const memberViews: RecentMemberView[] = members.map(({ member, order }) => ({
      memberId: member.discordUserId,
      order,
      voiceChannelId: interaction.guild?.members.cache.get(member.discordUserId)?.voice.channelId ?? null,
      monitored: status.presentMemberIds.includes(member.discordUserId),
    }));
    await interaction.editReply({ embeds: [buildRecentMatchesEmbed({
      mock,
      members: memberViews,
      pollIntervalSeconds: POLL_INTERVAL_MS / 1000,
      status,
      accounts: views,
    })], allowedMentions: NO_MENTIONS });
  },
};

export default recentCommand;

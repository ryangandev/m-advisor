import { ChannelType, ChatInputCommandInteraction, Guild, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { BotCommand } from "../types";
import {
  HIERARCHY_PROBLEM,
  checkRoleSetup,
  ensureWeeklyRoles,
  explainRoleFailure,
  RoleCreationError,
  releaseRoleHolders,
  releaseWeeklyRoles,
  roleGuildFrom,
} from "../services/reportRoles";
import { skipFinishedPeriods } from "../services/reports";
import { isMockData } from "../services/riotData";
import {
  getReportSettings,
  rememberReportRoleIds,
  setReportChannel,
  setReportKindEnabled,
  setReportRoleHolders,
  setReportRoles,
} from "../store/reportStore";
import type { ReportKind } from "../store/reportStore";
import { buildErrorEmbed } from "../utils/embeds";
import { logError, logInfo } from "../utils/log";
import { isAdmin } from "../utils/permissions";
import { REPORT_ALLOWED_MENTIONS } from "../utils/reportEmbed";

const REPORT_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;
const onOff = (value: boolean) => (value ? "开" : "关");

const reportSettingsCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("report-settings")
    .setDescription("设置每日 / 每周马报的频道、开关和每周身份组 (Admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((subcommand) => subcommand.setName("show").setDescription("查看当前的马报设置"))
    .addSubcommand((subcommand) => subcommand
      .setName("channel")
      .setDescription("设置自动发马报的文字频道")
      .addChannelOption((option) => option
        .setName("channel")
        .setDescription("发马报的文字频道")
        .addChannelTypes(...REPORT_CHANNEL_TYPES)
        .setRequired(true)))
    .addSubcommand((subcommand) => subcommand.setName("channel-clear").setDescription("清除频道，停止自动发马报"))
    .addSubcommand((subcommand) => subcommand
      .setName("daily")
      .setDescription("开关每日马报（太平洋时间每天结算）")
      .addBooleanOption((option) => option.setName("enabled").setDescription("开或关").setRequired(true)))
    .addSubcommand((subcommand) => subcommand
      .setName("weekly")
      .setDescription("开关每周马报（太平洋时间周日结算）")
      .addBooleanOption((option) => option.setName("enabled").setDescription("开或关").setRequired(true)))
    .addSubcommand((subcommand) => subcommand
      .setName("roles")
      .setDescription("开关每周身份组：本周特等马 / 本周没有马（需要机器人有 Manage Roles）")
      .addBooleanOption((option) => option.setName("enabled").setDescription("开或关").setRequired(true))
      .addRoleOption((option) => option.setName("top-role").setDescription("可选：用已有的身份组当「本周特等马」，不填则自动创建"))
      .addRoleOption((option) => option.setName("none-role").setDescription("可选：用已有的身份组当「本周没有马」，不填则自动创建"))) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const reply = (content: string) => interaction.replied || interaction.deferred
      ? interaction.editReply({ content, allowedMentions: REPORT_ALLOWED_MENTIONS })
      : interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: REPORT_ALLOWED_MENTIONS });
    if (!isAdmin(interaction)) {
      await interaction.reply({ content: "You need Administrator permission to use this command.", flags: MessageFlags.Ephemeral, allowedMentions: REPORT_ALLOWED_MENTIONS });
      return;
    }
    const guild = interaction.guild;
    if (!interaction.guildId || !guild) {
      await interaction.reply({ embeds: [buildErrorEmbed("这个命令只能在服务器里使用。")], flags: MessageFlags.Ephemeral, allowedMentions: REPORT_ALLOWED_MENTIONS });
      return;
    }
    const guildId = interaction.guildId;
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "show") {
      await reply(describe(guildId));
      return;
    }

    if (subcommand === "channel") {
      const chosen = interaction.options.getChannel("channel", true);
      const channel = await guild.channels.fetch(chosen.id).catch(() => null);
      const me = guild.members.me;
      if (!channel || !channel.isTextBased() || channel.isDMBased() || channel.isThread()) {
        await reply("请选一个这个服务器里的文字频道。");
        return;
      }
      const permissions = me ? channel.permissionsFor(me) : null;
      const missing = [
        [PermissionFlagsBits.ViewChannel, "View Channel（查看频道）"],
        [PermissionFlagsBits.SendMessages, "Send Messages（发送消息）"],
        [PermissionFlagsBits.EmbedLinks, "Embed Links（嵌入链接，马报用的是卡片）"],
      ].filter(([flag]) => !permissions?.has(flag as bigint)).map(([, name]) => name);
      if (missing.length > 0) {
        await reply(`机器人在 <#${channel.id}> 缺少这些权限：${missing.join("、")}。请先在频道权限里给机器人打开，再重新设置。`);
        return;
      }
      const fresh = setReportChannel(guildId, channel.id);
      // A new setup starts from the next finished period; /report still shows earlier ones.
      if (fresh) skipFinishedPeriods(guildId, ["day", "week"], Date.now());
      logInfo(`Report channel ${fresh ? "set" : "moved"} in server ${guildId}.`);
      await reply(`${fresh ? "已设置" : "已改到"}马报频道 <#${channel.id}>。\n${describe(guildId)}`);
      return;
    }

    // The weekly roles change hands only when a weekly report is posted. Turning that off, by clearing the channel or
    // switching weekly reports off, would leave last week's holders wearing a stale role, so it also turns the roles off.
    if (subcommand === "channel-clear" || (subcommand === "weekly" && interaction.options.getBoolean("enabled", true) === false)) {
      if (getReportSettings(guildId)?.rolesEnabled) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      let roleNote = "";
      let rolesStopped = false;
      try {
        const stopped = await stopWeeklyRoles(guild, guildId);
        rolesStopped = stopped.active;
        if (stopped.active) {
          roleNote = stopped.problems.length === 0
            ? "\n每周身份组跟着每周马报换人，所以也一并关闭了，并从机器人发过身份组的成员身上收回了它们。身份组本身没有删除，要继续用请重新执行 /report-settings roles。"
            : `\n每周身份组也已关闭，但没能收回全部身份组，请管理员手动处理：\n${stopped.problems.map((problem) => `- ${problem}`).join("\n")}`;
        }
      } catch (error) {
        logError(`Releasing the weekly roles failed: ${error instanceof Error ? error.name : "unknown error"}`);
        roleNote = `\n每周身份组没能收回：${explainRoleFailure(error)}`;
      }
      if (subcommand === "weekly") {
        setReportKindEnabled(guildId, "week", false);
        await reply(`每周马报已关闭。${roleNote}\n${describe(guildId)}`);
        return;
      }
      const had = getReportSettings(guildId)?.channelId != null;
      setReportChannel(guildId, null);
      // "The other settings are kept" is only true when the weekly roles were not switched off along with the channel.
      const kept = rolesStopped ? "" : "其余设置保留。";
      await reply(`${had ? `已清除马报频道，不会再自动发马报。${kept}` : "本来就没有设置马报频道。"}${roleNote}`);
      return;
    }

    if (subcommand === "daily" || subcommand === "weekly") {
      const kind: ReportKind = subcommand === "daily" ? "day" : "week";
      const enabled = interaction.options.getBoolean("enabled", true);
      const before = getReportSettings(guildId);
      const wasOn = (kind === "day" ? before?.dailyEnabled : before?.weeklyEnabled) ?? true;
      setReportKindEnabled(guildId, kind, enabled);
      // Only an off-to-on switch skips the finished periods; saying "on" again must not drop a report that is due.
      if (enabled && !wasOn) skipFinishedPeriods(guildId, [kind], Date.now());
      await reply(`${subcommand === "daily" ? "每日" : "每周"}马报已${enabled ? (wasOn ? "是开启的" : "开启，从下一个结算时间开始发") : "关闭"}。\n${describe(guildId)}`);
      return;
    }

    // roles
    const enabled = interaction.options.getBoolean("enabled", true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const settings = getReportSettings(guildId);
    const roleGuild = roleGuildFrom(guild);
    try {
      if (!enabled) {
        if (!settings?.rolesEnabled) {
          await reply("每周身份组本来就是关闭的。");
          return;
        }
        const stopped = await stopWeeklyRoles(guild, guildId);
        await reply(stopped.problems.length === 0
          ? "已关闭每周身份组，并从机器人发过身份组的成员身上收回了它们。身份组本身没有删除。"
          : `已关闭每周身份组，但没能收回全部身份组，请管理员手动处理：\n${stopped.problems.map((problem) => `- ${problem}`).join("\n")}`);
        return;
      }

      const top = interaction.options.getRole("top-role");
      const none = interaction.options.getRole("none-role");
      if (top && none && top.id === none.id) {
        await reply("「本周特等马」和「本周没有马」必须是两个不同的身份组。");
        return;
      }
      const wantedTop = top?.id ?? settings?.topRoleId ?? null;
      const wantedNone = none?.id ?? settings?.noneRoleId ?? null;
      // A dry run first: nothing is created or changed unless the bot is actually allowed to do it.
      const check = await checkRoleSetup(roleGuild, [top?.id, none?.id].filter((id): id is string => id !== undefined));
      if (!check.ok) {
        await reply(`没能开启每周身份组，什么都没有改动。请管理员先处理：\n${check.problems.map((problem) => `- ${problem}`).join("\n")}`);
        return;
      }
      const roles = await ensureWeeklyRoles(roleGuild, { top: wantedTop, none: wantedNone });
      const standing = await roleGuild.botStanding();
      if (!standing || roles.top.id === roles.none.id || roles.top.position >= standing.highestRolePosition || roles.none.position >= standing.highestRolePosition
        || roles.top.managed || roles.none.managed || roles.top.id === guild.id || roles.none.id === guild.id) {
        await reply(`没能开启每周身份组：${HIERARCHY_PROBLEM}`);
        return;
      }
      // Roles that are being replaced stop being managed, so take them back from their holders first; otherwise those
      // members would keep a stale role that nothing would ever remove.
      const leftovers: string[] = [];
      for (const [oldId, newId, holders] of [
        [settings?.topRoleId, roles.top.id, settings?.topHolderIds ?? []],
        [settings?.noneRoleId, roles.none.id, settings?.noneHolderIds ?? []],
      ] as const) {
        if (!oldId || oldId === newId || holders.length === 0) continue;
        const released = await releaseRoleHolders(roleGuild, oldId, holders);
        if (released.holders.length > 0) leftovers.push(`这些成员还拿着换下来的身份组 <@&${oldId}>，请手动收回：${released.holders.map((id) => `<@${id}>`).join("、")}`);
      }
      setReportRoles(guildId, { enabled: true, topRoleId: roles.top.id, noneRoleId: roles.none.id });
      const after = getReportSettings(guildId)!;
      const notes = [
        ...leftovers,
        !after.channelId ? "还没有设置马报频道（/report-settings channel），身份组要等每周马报发出时才会换人。" : "",
        !after.weeklyEnabled ? "每周马报目前是关闭的，身份组跟着每周马报换人，请用 /report-settings weekly 开启。" : "",
        isMockData() ? "机器人现在用的是模拟数据，模拟模式下不会改动任何人的身份组。" : "",
      ].filter(Boolean);
      logInfo(`Weekly roles enabled in server ${guildId}.`);
      await reply([
        `已开启每周身份组：<@&${roles.top.id}> 和 <@&${roles.none.id}>。`,
        "每周马报发出后，机器人会把它们给上周的特等马和没有马，并从上周的得主身上收回；只会动这两个身份组。",
        `请保持机器人的最高身份组排在这两个身份组之上，并保留 Manage Roles 权限。`,
        ...notes,
      ].join("\n"));
    } catch (error) {
      logError(`Report roles command failed: ${error instanceof Error ? error.name : "unknown error"}`);
      // A role created before the failure is kept, so the next try reuses it instead of creating a second one.
      if (error instanceof RoleCreationError) {
        try { rememberReportRoleIds(guildId, { topRoleId: error.partial.top?.id, noneRoleId: error.partial.none?.id }); }
        catch { /* the explanation below is still the useful part */ }
      }
      await reply(`没能完成身份组设置：${explainRoleFailure(error)}`);
    }
  },
};

/**
 * Takes the weekly roles back from the members the bot gave them to and turns the feature off, keeping the role ids.
 * Holders Discord refused to change stay recorded so a later attempt can retry. `active` is false when roles were off.
 */
async function stopWeeklyRoles(guild: Guild, guildId: string): Promise<{ active: boolean; problems: string[] }> {
  const settings = getReportSettings(guildId);
  if (!settings?.rolesEnabled || !settings.topRoleId || !settings.noneRoleId) return { active: false, problems: [] };
  const released = await releaseWeeklyRoles(roleGuildFrom(guild), {
    topRoleId: settings.topRoleId, noneRoleId: settings.noneRoleId, topHolderIds: settings.topHolderIds, noneHolderIds: settings.noneHolderIds,
  });
  setReportRoleHolders(guildId, { top: released.topHolderIds, none: released.noneHolderIds });
  setReportRoles(guildId, { enabled: false });
  return { active: true, problems: released.problems };
}

/** The current settings in plain Chinese, for `/report-settings show` and after each change. */
function describe(guildId: string): string {
  const settings = getReportSettings(guildId);
  const channel = settings?.channelId ? `<#${settings.channelId}>` : "未设置（不会自动发马报）";
  return [
    `**马报设置**`,
    `频道：${channel}`,
    `每日马报：${onOff(settings?.dailyEnabled ?? true)} · 每周马报：${onOff(settings?.weeklyEnabled ?? true)}`,
    settings?.rolesEnabled ? `每周身份组：开（<@&${settings.topRoleId}>、<@&${settings.noneRoleId}>）` : "每周身份组：关",
    "结算按太平洋时间：每天 00:30 左右发前一天，周一 00:30 左右发上一周（周一到周日）。机器人没开时错过的，会在下次启动时补发最近的一天和一周。",
  ].join("\n");
}

export default reportSettingsCommand;

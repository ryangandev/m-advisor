import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { BotCommand } from "../types";
import { loadReport, periodOf } from "../services/reports";
import type { ReportKind } from "../services/reports";
import { isMockData } from "../services/riotData";
import { buildErrorEmbed } from "../utils/embeds";
import { REPORT_ALLOWED_MENTIONS, buildReportEmbed } from "../utils/reportEmbed";

/** The same builder the scheduler uses, run on demand for the period in progress or the one before it. */
const reportCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("report")
    .setDescription("马报：看看今天或本周谁是特等马、谁是没有马")
    .addSubcommand((subcommand) => subcommand
      .setName("day")
      .setDescription("每日马报（太平洋时间的一天）")
      .addStringOption((option) => option
        .setName("when")
        .setDescription("看哪一天，默认是进行中的今天")
        .addChoices({ name: "进行中的今天", value: "current" }, { name: "上一个完整的一天", value: "previous" })))
    .addSubcommand((subcommand) => subcommand
      .setName("week")
      .setDescription("每周马报（太平洋时间周一到周日）")
      .addStringOption((option) => option
        .setName("when")
        .setDescription("看哪一周，默认是进行中的本周")
        .addChoices({ name: "进行中的本周", value: "current" }, { name: "上一个完整的一周", value: "previous" }))) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ embeds: [buildErrorEmbed("这个命令只能在服务器里使用。")], flags: MessageFlags.Ephemeral, allowedMentions: REPORT_ALLOWED_MENTIONS });
      return;
    }
    const kind = interaction.options.getSubcommand() as ReportKind;
    const previous = interaction.options.getString("when") === "previous";
    const current = periodOf(kind, Date.now());
    const range = previous ? periodOf(kind, current.start - 1) : current;
    const embed = buildReportEmbed(loadReport(guildId, kind, range, isMockData()), { final: previous });
    await interaction.reply({ embeds: [embed], allowedMentions: REPORT_ALLOWED_MENTIONS });
  },
};

export default reportCommand;

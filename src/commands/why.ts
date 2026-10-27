import { AttachmentBuilder, MessageFlags, SlashCommandBuilder } from "discord.js";
import type { AutocompleteInteraction, ButtonInteraction, ChatInputCommandInteraction } from "discord.js";
import type { BotCommand } from "../types";
import { formatScore } from "../services/announcementText";
import { buildVerdict, findVerdictRecord, listVerdictChoices, pick } from "../services/horseVerdict";
import { isMockData } from "../services/riotData";
import { getTrackedMember } from "../store/bindingStore";
import { countMemberHorseRecords } from "../store/horseRecordStore";
import type { HorseRecord } from "../store/horseRecordStore";
import { buildErrorEmbed } from "../utils/embeds";
import { championLabel } from "../utils/stableEmbed";
import {
  APPEAL_PREFIX, RADAR_FILE_NAME, buildAppealEmbed, buildAppealRow, buildWhyEmbed, buildWhyEmptyEmbed, parseAppealCustomId,
} from "../utils/whyEmbed";
import { renderVerdictRadar } from "../utils/whyRadar";

const NO_MENTIONS = { parse: [], roles: [], users: [], repliedUser: false };
/** Discord shows at most 25 autocomplete choices. */
const CHOICE_LIMIT = 25;
const CHOICE_NAME_LIMIT = 100;
/** Bounds the closed-case memory; the oldest cases are forgotten first. */
const DOCKET_LIMIT = 5000;

/**
 * Cases already appealed in this process, so one member appeals one match once. Nothing is written to the database;
 * after a restart a repeat appeal is heard again and, being deterministic, gets the same ruling.
 */
const closedCases = new Set<string>();
const caseKey = (guildId: string, target: { mock: boolean; memberId: string; matchId: string }) =>
  `${guildId}:${target.mock ? "m" : "r"}:${target.memberId}:${target.matchId}`;

function closeCase(key: string): void {
  closedCases.add(key);
  if (closedCases.size > DOCKET_LIMIT) closedCases.delete(closedCases.values().next().value!);
}

/** Forgets every closed case. For tests. */
export function resetAppealDocket(): void {
  closedCases.clear();
}

const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "America/Los_Angeles", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** One autocomplete choice: enough to recognise the game without the match ID. */
export function choiceName(record: HorseRecord): string {
  const parts = [record.tier, championLabel(record), `${formatScore(record.score)} 分`, record.won ? "胜" : "负", dateFormat.format(record.playedAt)];
  return `${record.mock ? "模拟 · " : ""}${parts.join(" · ")}`.slice(0, CHOICE_NAME_LIMIT);
}

const whyCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("why")
    .setDescription("军师的判决书：为什么这局是这个马，雷达图看短板和差距，不服可以上诉")
    .addUserOption((option) => option
      .setName("user")
      .setDescription("要查看的成员，默认是你自己"))
    .addStringOption((option) => option
      .setName("match")
      .setDescription("要查看的对局，默认最近一局")
      .setAutocomplete(true)
      .setMaxLength(40)) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ embeds: [buildErrorEmbed("这个命令只能在服务器里使用。")], flags: MessageFlags.Ephemeral });
      return;
    }
    const memberId = (interaction.options.getUser("user") ?? interaction.user).id;
    const matchId = interaction.options.getString("match")?.trim() || null;
    const mock = isMockData();
    const record = findVerdictRecord(guildId, memberId, mock, matchId);
    if (!record) {
      const counts = countMemberHorseRecords(guildId, memberId);
      await interaction.reply({
        embeds: [buildWhyEmptyEmbed({
          mock,
          memberId,
          matchId,
          tracked: getTrackedMember(guildId, memberId) !== undefined,
          otherModeGames: mock ? counts.real : counts.mock,
        })],
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    // Rendering the radar can take a moment on a cold start, so acknowledge first.
    await interaction.deferReply();
    const verdict = buildVerdict(record);
    const image = await renderVerdictRadar(verdict);
    const row = buildAppealRow(record, closedCases.has(caseKey(guildId, { mock, memberId, matchId: record.matchId })));
    await interaction.editReply({
      embeds: [buildWhyEmbed({ verdict, self: memberId === interaction.user.id, champion: championLabel(record) })],
      files: [new AttachmentBuilder(image, { name: RADAR_FILE_NAME })],
      components: row ? [row] : [],
      allowedMentions: NO_MENTIONS,
    });
  },

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const guildId = interaction.guildId;
    const focused = interaction.options.getFocused(true);
    if (!guildId || focused.name !== "match") {
      await interaction.respond([]);
      return;
    }
    // Only the user's ID is known while typing; it is enough, since records are keyed by it.
    const chosen = interaction.options.get("user")?.value;
    const memberId = typeof chosen === "string" && chosen ? chosen : interaction.user.id;
    const typed = String(focused.value).trim().toLowerCase();
    const choices = listVerdictChoices(guildId, memberId, isMockData(), CHOICE_LIMIT)
      .map((record) => ({ name: choiceName(record), value: record.matchId }))
      .filter((choice) => !typed || choice.name.toLowerCase().includes(typed) || choice.value.toLowerCase().includes(typed));
    await interaction.respond(choices.slice(0, CHOICE_LIMIT));
  },

  componentPrefix: APPEAL_PREFIX,

  async handleButton(interaction: ButtonInteraction): Promise<void> {
    const target = parseAppealCustomId(interaction.customId);
    const guildId = interaction.guildId;
    if (!target || !guildId) {
      await interaction.reply({ content: "这个按钮已经失效了。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.user.id !== target.memberId) {
      const refusal = pick([
        `这不是你的案子，围观群众请保持肃静。只有当事人 <@${target.memberId}> 才能上诉。`,
        `代人上诉？军师不收代理费，请当事人 <@${target.memberId}> 亲自来。`,
        `军师只听当事人 <@${target.memberId}> 喊冤，你先回去管好自己的马。`,
      ], `${target.matchId}:${interaction.user.id}`);
      await interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });
      return;
    }
    const key = caseKey(guildId, target);
    if (closedCases.has(key)) {
      await interaction.reply({ content: "本案已结，维持原判。", flags: MessageFlags.Ephemeral });
      return;
    }
    const record = findVerdictRecord(guildId, target.memberId, target.mock, target.matchId);
    if (!record) {
      await interaction.reply({ content: "这一局的档案已经不在马厩里了，无案可审。", flags: MessageFlags.Ephemeral });
      return;
    }
    // Closed before any await, so a double click cannot be heard twice. The record itself is only read.
    closeCase(key);
    const verdict = buildVerdict(record);
    const row = buildAppealRow(record, true);
    await interaction.update({ components: row ? [row] : [] });
    await interaction.followUp({ embeds: [buildAppealEmbed(verdict)], allowedMentions: NO_MENTIONS });
  },
};

export default whyCommand;

import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { BotCommand } from "../types";
import { getBinding } from "../store/bindingStore";
import { getRiotMode, simulateMockMatch } from "../services/riotData";
import { pollGuildNow, startPolling } from "../services/gameMonitor";
import { getAuthorizedTestChannel, safeTestError } from "../utils/testChannel";
import { withSimulationLock } from "../services/simulationLock";
import { getLastMatchId } from "../store/announcerStore";
import { assertRunning } from "../services/shutdownState";
import { logError } from "../utils/log";

const command: BotCommand = {
  data: new SlashCommandBuilder().setName("simulate").setDescription("用模拟比赛验证完整赛后播报流程")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option => option.setName("outcome").setDescription("模拟赛果").setRequired(true)
      .addChoices({ name: "胜利", value: "win" }, { name: "失败", value: "loss" })) as SlashCommandBuilder,
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      assertRunning();
      const channel = await getAuthorizedTestChannel(interaction);
      assertRunning();
      await withSimulationLock(channel.guild.id, async () => {
        assertRunning();
        if (getRiotMode() !== "mock") throw new Error("模拟比赛只允许在 RIOT_MODE=mock 时使用。");
        const binding = getBinding(channel.guild.id);
        if (!binding) throw new Error("请先使用 /bind 绑定一个测试账号，例如 MockWin#NA1。");
        const member = await channel.guild.members.fetch(binding.discordUserId);
        assertRunning();
        if (member.voice.channelId !== channel.id) throw new Error("请先让被追踪成员进入同一个测试语音频道。");
        startPolling(interaction.client, channel.guild.id, channel.id);
        const baseline = await pollGuildNow(interaction.client, channel.guild.id, channel.id);
        assertRunning();
        if (baseline.errors > 0) throw new Error("模拟比赛暂未播报成功，请稍后重试或查看本地日志。");
        const outcome = interaction.options.getString("outcome", true) as "win" | "loss";
        const simulated = simulateMockMatch(binding.accounts[0].puuid, outcome);
        const result = await pollGuildNow(interaction.client, channel.guild.id, channel.id);
        assertRunning();
        if (result.announced < 1 || result.errors > 0 || getLastMatchId(channel.guild.id, binding.accounts[0].puuid) !== simulated.matchId) throw new Error("模拟比赛暂未播报成功，请稍后重试或查看本地日志。");
        await interaction.editReply(`模拟数据：${outcome === "win" ? "胜利" : "失败"}比赛播报完成。此结果不是实际战绩。`);
      });
    } catch (error) {
      logError(`Simulation test failed: ${error instanceof Error ? error.name : "unknown error"}`);
      await interaction.editReply(safeTestError(error));
    }
  },
};
export default command;
